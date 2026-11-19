#!/usr/bin/env node
/**
 * 保护规则交互式管理台（只依赖 Node 内置模块）
 *
 * 用法:
 *   node manage-rules.mjs                                  交互菜单
 *   node manage-rules.mjs list                             列出全部规则
 *   node manage-rules.mjs add [--scope s] [--pattern P] [--deny a,b] [--reason "..."]
 *   node manage-rules.mjs rm <RID>
 *   node manage-rules.mjs set <RID> [--scope s] [--pattern P] [--patterns P1,P2] [--deny a,b] [--reason "..."]
 *   node manage-rules.mjs check <路径>
 *   node manage-rules.mjs verify
 *   node manage-rules.mjs backup                           只生成 protected.json 的字节级快照（不改规则）
 *   node manage-rules.mjs help
 *
 * 统一判定语义（与 file-ops 一致的“语义约定”，本程序自己实现一遍判定）：
 *   - 普通（无通配）路径：只精确匹配该路径本身
 *   - 含 * / ** 的通配模式：按字面覆盖其匹配到的所有路径
 *   - deny 列出被拦的动作；denyMoveAsSourceOnly 表示 move 只看源侧
 *   - 敏感规则与保护规则分开登记（本程序按规则内容分栏展示）
 *
 * 注意: 本程序是独立实现，与 file-ops 是两套代码，请用 `verify` 对拍。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, renameSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline/promises';
import process from 'node:process';

const HERE = dirname(fileURLToPath(import.meta.url));
const RULE_FILE = join(HERE, 'protected.json');
const BACKUP_DIR = join(HERE, 'backups');

const ALLOWED_ACTIONS = ['read', 'list', 'write', 'edit', 'trash', 'move'];
// 展示顺序：破坏性动作在前，便于人读
const ACTION_ORDER = ['trash', 'move', 'edit', 'read', 'list', 'write'];
const ALLOWED_SCOPES = ['directory', 'file'];
// 不允许出现的 per-rule 例外开关字段
const FORBIDDEN_FIELDS = [
  'enabled', 'disabled', 'except', 'exceptions', 'exception', 'allow', 'allowed',
  'exclude', 'excludes', 'ignore', 'ignored', 'override', 'bypass', 'skip',
  'skipList', 'exempt', 'exemptions', 'off', 'allowExcept', 'exceptPaths',
];
// 敏感特征（用于判定「敏感规则」类别 → 现役敏感错误码）
const SENSITIVE_HINTS = ['.env', '.pem', '.key', '.ssh', '.aws', '.credentials'];
// 现役 file-ops 的错误码
const ERROR_CODES = {
  SENSITIVE_DENIED: 'sensitive_denied',
  PROTECTED_RULE_DENIED: 'protected_rule_denied',
  INVALID_ARGS: 'invalid_args',
  NOT_FOUND: 'not_found',
};
// 动作 × 规则类别 → 现役错误码（放行一律为 null）
const ERROR_CODE_BY_ACTION = {};
for (const a of ALLOWED_ACTIONS) {
  ERROR_CODE_BY_ACTION[a] = {
    sensitive: ERROR_CODES.SENSITIVE_DENIED,
    protected: ERROR_CODES.PROTECTED_RULE_DENIED,
  };
}
// 现役次序：参数校验(invalid_args)与存在性检查(not_found)在规则判定之前 → 本管理台不表达该次序
const ORDER_NOTE =
  '本判定不含参数校验与存在性检查；现役会先做这两步（invalid_args / not_found），再走规则判定';

// 管道被提前关闭（如 | Select-Object -First N）时安静退出
process.stdout.on('error', (e) => {
  if (e && e.code === 'EPIPE') process.exit(0);
});
const out = (s = '') => process.stdout.write(s + '\n');

// ---------------------------------------------------------------- 路径工具

function normPath(p) {
  let s = String(p == null ? '' : p).trim();
  if (!s) return '';
  s = s.replace(/\\/g, '/');
  s = s.replace(/\/{2,}/g, '/');
  if (s.length > 1) s = s.replace(/\/+$/, '');
  return s;
}
function segsOf(p) {
  const s = normPath(p);
  return s === '' ? [] : s.split('/');
}
function hasWildcard(p) {
  return /[*?]/.test(p);
}
function segMatch(patternSeg, pathSeg) {
  if (!hasWildcard(patternSeg)) {
    return patternSeg.toLowerCase() === pathSeg.toLowerCase();
  }
  const re = new RegExp(
    '^' +
      patternSeg
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '.') +
      '$',
    'i',
  );
  return re.test(pathSeg);
}
function globMatch(patternSegs, pathSegs) {
  const memo = new Map();
  const go = (pi, si) => {
    const key = pi + ':' + si;
    if (memo.has(key)) return memo.get(key);
    let res;
    if (pi === patternSegs.length) {
      res = si === pathSegs.length;
    } else {
      const p = patternSegs[pi];
      if (p === '**') {
        res = go(pi + 1, si) || (si < pathSegs.length && go(pi, si + 1));
      } else if (si === pathSegs.length) {
        res = false;
      } else if (segMatch(p, pathSegs[si])) {
        res = go(pi + 1, si + 1);
      } else {
        res = false;
      }
    }
    memo.set(key, res);
    return res;
  };
  return go(0, 0);
}

// ---------------------------------------------------------------- 规则工具

function rulePatterns(r) {
  const list = [];
  if (typeof r.pattern === 'string' && r.pattern.length) list.push(r.pattern);
  if (Array.isArray(r.patterns)) {
    for (const p of r.patterns) if (typeof p === 'string' && p.length) list.push(p);
  }
  return list;
}
function isSensitive(r) {
  return rulePatterns(r).some((p) => SENSITIVE_HINTS.some((h) => p.toLowerCase().includes(h)));
}
function ruleCovers(r, pathNorm) {
  const ps = segsOf(pathNorm);
  for (const p of rulePatterns(r)) {
    if (hasWildcard(p)) {
      if (globMatch(segsOf(p), ps)) return true;
    } else if (normPath(p) === pathNorm) {
      return true;
    }
  }
  return false;
}
// 某条规则“相关但不覆盖”的原因（用于解释为什么内部文件不受目录规则限制）
function relatedButNotCovered(r, pathNorm) {
  for (const p of rulePatterns(r)) {
    if (hasWildcard(p)) continue;
    const base = normPath(p);
    if (base && pathNorm.toLowerCase().startsWith(base.toLowerCase() + '/')) {
      return r.scope === 'directory'
        ? `${r.id} 只护目录本身，该路径在目录内部`
        : `${r.id} 只护该文件本身`;
    }
  }
  return null;
}
function denyActionsOf(r, action, asSource) {
  if (!Array.isArray(r.deny)) return [];
  if (action === 'move' && r.denyMoveAsSourceOnly && !asSource) return [];
  return r.deny.includes(action) ? [action] : [];
}

// ---------------------------------------------------------------- 读规则

function loadConfig() {
  const raw = readFileSync(RULE_FILE, 'utf8');
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (e) {
    throw new Error('protected.json 不是合法 JSON: ' + e.message);
  }
  if (!cfg || typeof cfg !== 'object') throw new Error('protected.json 顶层不是对象');
  if (!Array.isArray(cfg.rules)) throw new Error('protected.json 缺少 rules 数组');
  return cfg;
}
function loadRules() {
  return loadConfig().rules;
}
function ruleById(rules, id) {
  const key = String(id).toUpperCase();
  return rules.find((r) => String(r.id).toUpperCase() === key) || null;
}

// ---------------------------------------------------------------- 校验

function validateRules(rules) {
  const errors = [];
  const seen = new Set();
  if (!Array.isArray(rules)) return ['rules 不是数组'];
  rules.forEach((r, i) => {
    const at = `规则[${i}]${r && r.id ? ' ' + r.id : ''}`;
    if (!r || typeof r !== 'object') {
      errors.push(at + ' 不是对象');
      return;
    }
    if (!r.id || typeof r.id !== 'string') errors.push(at + ' 缺少 id');
    else {
      const key = r.id.toUpperCase();
      if (seen.has(key)) errors.push(at + ' id 重复');
      seen.add(key);
    }
    if (!ALLOWED_SCOPES.includes(r.scope)) {
      errors.push(at + ' scope 必须是 ' + ALLOWED_SCOPES.join(' / '));
    }
    const pats = rulePatterns(r);
    if (!pats.length) errors.push(at + ' 缺少 pattern 或 patterns');
    if (!Array.isArray(r.deny) || !r.deny.length) {
      errors.push(at + ' 缺少 deny 动作列表');
    } else {
      for (const a of r.deny) {
        if (!ALLOWED_ACTIONS.includes(a)) {
          errors.push(at + ' deny 含非法动作 "' + a + '"（允许：' + ALLOWED_ACTIONS.join(', ') + '）');
        }
      }
    }
    if (!r.reason || typeof r.reason !== 'string' || !r.reason.trim()) {
      errors.push(at + ' 缺少 reason');
    }
    for (const k of Object.keys(r)) {
      if (FORBIDDEN_FIELDS.includes(k)) {
        errors.push(at + ' 含不允许的 per-rule 例外开关字段 "' + k + '"');
      }
    }
  });
  return errors;
}

// ---------------------------------------------------------------- 写回

function tsName(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    d.getFullYear() +
    p(d.getMonth() + 1) +
    p(d.getDate()) +
    '-' +
    p(d.getHours()) +
    p(d.getMinutes()) +
    p(d.getSeconds())
  );
}
// --- 顶层键原文定位（用于「只改确实变化的键 + 其余字节原样保留」的外科式编辑）

function jsonSkipWs(t, i) {
  while (i < t.length) {
    const c = t[i];
    if (c === ' ' || c === '\n' || c === '\r' || c === '\t') {
      i += 1;
      continue;
    }
    break;
  }
  return i;
}
function jsonSkipString(t, i) {
  i += 1;
  while (i < t.length) {
    const c = t[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '"') return i + 1;
    i += 1;
  }
  throw new Error('JSON 字符串未闭合');
}
function jsonSkipValue(t, i) {
  i = jsonSkipWs(t, i);
  const c = t[i];
  if (c === '"') return jsonSkipString(t, i);
  if (c === '{' || c === '[') {
    const close = c === '{' ? '}' : ']';
    i = jsonSkipWs(t, i + 1);
    if (t[i] === close) return i + 1;
    for (;;) {
      if (c === '{') {
        i = jsonSkipWs(t, i);
        i = jsonSkipString(t, i);
        i = jsonSkipWs(t, i);
        if (t[i] !== ':') throw new Error('JSON 缺少冒号');
        i = jsonSkipWs(t, i + 1);
      }
      i = jsonSkipValue(t, i);
      i = jsonSkipWs(t, i);
      if (t[i] === ',') {
        i += 1;
        continue;
      }
      if (t[i] === close) return i + 1;
      throw new Error('JSON 结构异常：期望 , 或 ' + close);
    }
  }
  const start = i;
  while (i < t.length && !' \t\r\n,}]'.includes(t[i])) i += 1;
  if (i === start) throw new Error('JSON 值缺失');
  return i;
}
// 返回 Map<key, {keyStart, keyEnd, valueStart, valueEnd}>（字符偏移，value 区间为原文切片范围）
function topLevelSpans(t) {
  let i = jsonSkipWs(t, 0);
  if (t[i] !== '{') throw new Error('顶层不是对象');
  i = jsonSkipWs(t, i + 1);
  const spans = new Map();
  if (t[i] === '}') return spans;
  for (;;) {
    i = jsonSkipWs(t, i);
    const keyStart = i;
    const keyEnd = jsonSkipString(t, i);
    const key = JSON.parse(t.slice(keyStart, keyEnd));
    i = jsonSkipWs(t, keyEnd);
    if (t[i] !== ':') throw new Error('JSON 缺少冒号');
    i = jsonSkipWs(t, i + 1);
    const valueEnd = jsonSkipValue(t, i);
    spans.set(key, { keyStart, keyEnd, valueStart: i, valueEnd });
    i = jsonSkipWs(t, valueEnd);
    if (t[i] === ',') {
      i += 1;
      continue;
    }
    if (t[i] === '}') return spans;
    throw new Error('JSON 顶层结构异常');
  }
}
// 现役紧凑风格：容器内联，元素以 ", " 分隔（`{ "id": "R1", ... }` / `["trash", "move"]`）
function compactJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return v.length ? '[' + v.map(compactJson).join(', ') + ']' : '[]';
  const ks = Object.keys(v);
  return ks.length
    ? '{ ' + ks.map((k) => JSON.stringify(k) + ': ' + compactJson(v[k])).join(', ') + ' }'
    : '{}';
}
// 展开风格：容器每层换行，容器内的标量与对象仍按紧凑写（rules 即「每条规则一行」）
function expandedJson(v, indent) {
  const inner = indent + '  ';
  if (Array.isArray(v)) {
    if (!v.length) return '[]';
    return '[\n' + v.map((x) => inner + compactJson(x)).join(',\n') + '\n' + indent + ']';
  }
  if (v && typeof v === 'object') {
    const ks = Object.keys(v);
    if (!ks.length) return '{}';
    return (
      '{\n' + ks.map((k) => inner + JSON.stringify(k) + ': ' + compactJson(v[k])).join(',\n') +
      '\n' + indent + '}'
    );
  }
  return JSON.stringify(v);
}
// 值所在行的行首缩进（决定展开风格的缩进基准）
function lineIndentAt(t, pos) {
  const ls = t.lastIndexOf('\n', pos - 1) + 1;
  const m = /^[ \t]*/.exec(t.slice(ls, pos));
  return m ? m[0] : '';
}
// 用原文值反推该键的排版风格；未知风格返回 null（调用方按类型保守选择）
function detectValueStyle(rawVal, value, indent) {
  if (rawVal === compactJson(value)) return 'compact';
  if (rawVal === expandedJson(value, indent)) return 'expanded';
  return null;
}
function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  const aa = Array.isArray(a);
  if (aa !== Array.isArray(b)) return false;
  if (aa) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return (
    ka.length === kb.length &&
    ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]))
  );
}
function sha256Of(buf) {
  return createHash('sha256').update(buf).digest('hex');
}
// 把指定顶层键的「值区间」替换成同一枚遮罩（用于比对「其余字节是否逐字节相同」）
function maskValueSpans(t, spansMap, keys) {
  const regions = keys.map((k) => spansMap.get(k)).filter(Boolean).sort((a, b) => b.valueStart - a.valueStart);
  let s = t;
  for (const r of regions) s = s.slice(0, r.valueStart) + '\u0000EDIT\u0000' + s.slice(r.valueEnd);
  return s;
}

// 独立的快照能力：字节级复制现役 protected.json，不读写其它内容
function makeSnapshot({ silent = false } = {}) {
  const srcBuf = readFileSync(RULE_FILE);
  if (!existsSync(BACKUP_DIR)) mkdirSync(BACKUP_DIR, { recursive: true });
  const backupPath = join(BACKUP_DIR, 'protected-' + tsName() + '.json');
  copyFileSync(RULE_FILE, backupPath);
  const shaSrc = sha256Of(srcBuf);
  const shaBak = sha256Of(readFileSync(backupPath));
  if (shaSrc !== shaBak) throw new Error('快照与现役字节不一致: ' + shaBak + ' != ' + shaSrc);
  if (!silent) {
    out('源文件: ' + RULE_FILE + '（' + srcBuf.length + ' B, sha256=' + shaSrc + '）');
    out('快照:   ' + backupPath + '（' + srcBuf.length + ' B, sha256=' + shaBak + '）');
    out('protected.json 未改动：本次只生成字节级快照');
  }
  return { ok: true, backupPath, bytes: srcBuf.length, sha256: shaSrc };
}

function writeBack(cfg, { silent = false } = {}) {
  const errors = validateRules(cfg.rules);
  if (errors.length) {
    out('!! 规则自检未通过，已放弃写回:');
    for (const e of errors) out('   - ' + e);
    return { ok: false, errors };
  }
  // 1) 读现役原文（保留原排版），定位各顶层键的原文区间
  const rawText = readFileSync(RULE_FILE, 'utf8');
  let origCfg;
  let spans;
  try {
    origCfg = JSON.parse(rawText);
    spans = topLevelSpans(rawText);
  } catch (e) {
    out('!! 现役 protected.json 无法解析，已放弃写回: ' + e.message);
    return { ok: false, errors: ['现役文件不可解析: ' + e.message] };
  }
  for (const key of Object.keys(origCfg)) {
    if (!Object.prototype.hasOwnProperty.call(cfg, key)) {
      out('!! 不支持删除顶层键 "' + key + '"，已放弃写回');
      return { ok: false, errors: ['不支持删除顶层键: ' + key] };
    }
  }
  // 2) 只替换「内容确实变化」的顶层键，其余字节原样保留
  const edits = [];
  for (const key of Object.keys(cfg)) {
    const span = spans.get(key);
    if (!span) {
      out('!! 不支持新增顶层键 "' + key + '"，已放弃写回');
      return { ok: false, errors: ['不支持新增顶层键: ' + key] };
    }
    const rawVal = rawText.slice(span.valueStart, span.valueEnd);
    let origVal;
    try {
      origVal = JSON.parse(rawVal);
    } catch {
      origVal = undefined;
    }
    if (deepEqual(origVal, cfg[key])) continue; // 原文已是目标值 → 一个字节都不动
    const indent = lineIndentAt(rawText, span.valueStart);
    const style = detectValueStyle(rawVal, origVal, indent) || (Array.isArray(cfg[key]) ? 'expanded' : 'compact');
    const text = style === 'expanded' ? expandedJson(cfg[key], indent) : compactJson(cfg[key]);
    edits.push({ key, valueStart: span.valueStart, valueEnd: span.valueEnd, style, text });
  }
  const changedKeys = edits.map((e) => e.key);
  let newText = rawText;
  for (const e of [...edits].sort((a, b) => b.valueStart - a.valueStart)) {
    newText = newText.slice(0, e.valueStart) + e.text + newText.slice(e.valueEnd);
  }
  // 3) 写回前校验：深度相等 + 除被编辑键外其余字节逐字节相同
  const verifyErrors = [];
  let parsedNew = null;
  try {
    parsedNew = JSON.parse(newText);
  } catch (e) {
    verifyErrors.push('新文本不是合法 JSON: ' + e.message);
  }
  if (parsedNew !== null && !deepEqual(parsedNew, cfg)) {
    verifyErrors.push('新文本 parse 结果与目标 cfg 不深度相等');
  }
  let newSpans = null;
  try {
    newSpans = topLevelSpans(newText);
  } catch (e) {
    verifyErrors.push('新文本顶层结构无法解析: ' + e.message);
  }
  if (newSpans) {
    if (maskValueSpans(rawText, spans, changedKeys) !== maskValueSpans(newText, newSpans, changedKeys)) {
      verifyErrors.push('除被编辑的顶层键外，其余字节与写回前不一致');
    }
    for (const key of Object.keys(origCfg)) {
      if (changedKeys.includes(key)) continue;
      const a = spans.get(key);
      const b = newSpans.get(key);
      if (!a || !b) {
        verifyErrors.push('顶层键 "' + key + '" 区间丢失');
        continue;
      }
      if (rawText.slice(a.valueStart, a.valueEnd) !== newText.slice(b.valueStart, b.valueEnd)) {
        verifyErrors.push('未编辑的顶层键 "' + key + '" 字节发生变化');
      }
    }
  }
  if (verifyErrors.length) {
    out('!! 写回前校验未通过，已放弃写回（protected.json 未改动）:');
    for (const e of verifyErrors) out('   - ' + e);
    return { ok: false, errors: verifyErrors, changedKeys };
  }
  // 4) 保留写回时的快照（改为字节级副本，可作回滚锚点），再原子替换
  if (!existsSync(BACKUP_DIR)) mkdirSync(BACKUP_DIR, { recursive: true });
  const backupPath = join(BACKUP_DIR, 'protected-' + tsName() + '.json');
  copyFileSync(RULE_FILE, backupPath);
  const backupSha = sha256Of(readFileSync(backupPath));
  const tmp = RULE_FILE + '.tmp';
  writeFileSync(tmp, newText, 'utf8');
  renameSync(tmp, RULE_FILE);
  if (!silent) {
    out('备份: ' + backupPath + '（字节级副本, sha256=' + backupSha + '）');
    out('已生效（服务端每次判定前重载，无需重启）');
    out('当前规则数: ' + cfg.rules.length);
    out('本次编辑的顶层键: ' + (changedKeys.length ? changedKeys.join(', ') : '(无变更)'));
  }
  return { ok: true, backupPath, count: cfg.rules.length, changedKeys, backupSha };
}

// ---------------------------------------------------------------- 判定

function judge(rules, path) {
  const p = normPath(path);
  const ps = segsOf(p);
  const hits = [];
  const related = [];
  for (const r of rules) {
    if (ruleCovers(r, p)) hits.push(r);
    else {
      const why = relatedButNotCovered(r, p);
      if (why) related.push({ rule: r, why });
    }
  }
  const actions = {};
  for (const a of ALLOWED_ACTIONS) {
    let denied = false;
    let by = null;
    // 现役先做敏感检查再做保护规则检查 → 敏感规则优先
    for (const r of hits) {
      const d = denyActionsOf(r, a, true);
      if (!d.length) continue;
      if (!denied) {
        denied = true;
        by = r;
      }
      if (isSensitive(r)) {
        by = r;
        break;
      }
    }
    const category = denied ? (isSensitive(by) ? 'sensitive' : 'protected') : null;
    const errorCode = denied ? ERROR_CODE_BY_ACTION[a][category] : null;
    actions[a] = { denied, by, category, errorCode };
  }
  let headline;
  if (hits.length) {
    const r = hits[0];
    const extra = hits.length > 1 ? '（同时命中 ' + hits.slice(1).map((x) => x.id).join(', ') + '）' : '';
    headline = '命中 ' + r.id + extra + '（' + (r.scope === 'directory' ? '目录本身' : '文件') + '：' + (rulePatterns(r)[0] || '') + '）';
  } else if (related.length) {
    headline = '不受 ' + related[0].rule.id + ' 限制（' + related[0].why + '）';
  } else {
    headline = '没有任何规则命中该路径';
  }
  return { path: p, hits, related, actions, headline };
}
function actionLine(j) {
  return ACTION_ORDER.map(
    (a) => a + ' ' + (j.actions[a].denied ? '拒绝' : '放行') + '(' + (j.actions[a].errorCode || 'null') + ')',
  ).join(' / ');
}
// 「动作 × 规则类别 → 错误码」映射表（机器可读）
function errorCodesMap() {
  const byAction = {};
  for (const a of ALLOWED_ACTIONS) {
    byAction[a] = {
      sensitive: ERROR_CODE_BY_ACTION[a].sensitive,
      protected: ERROR_CODE_BY_ACTION[a].protected,
      allowed: null,
    };
  }
  return {
    sensitive_rule: ERROR_CODES.SENSITIVE_DENIED,
    protected_rule: ERROR_CODES.PROTECTED_RULE_DENIED,
    invalid_args: ERROR_CODES.INVALID_ARGS,
    not_found: ERROR_CODES.NOT_FOUND,
    byAction,
    note: ORDER_NOTE,
  };
}
// 判定结果 → 结构化 JSON（供对拍脚本消费）
function judgeJson(j) {
  const actions = {};
  for (const a of ACTION_ORDER) {
    actions[a] = {
      denied: j.actions[a].denied,
      errorCode: j.actions[a].denied ? j.actions[a].errorCode : null,
      ruleId: j.actions[a].by ? j.actions[a].by.id : null,
    };
  }
  return {
    path: j.path,
    headline: j.headline,
    actions,
    errorCodes: errorCodesMap(),
    note: ORDER_NOTE,
  };
}

// ---------------------------------------------------------------- 展示

function scopeLabel(r) {
  if (r.scope === 'directory') return '目录';
  if (r.scope === 'file') return '文件';
  return String(r.scope || '?');
}
function rangeLabel(r) {
  const pats = rulePatterns(r);
  const anyWild = pats.some(hasWildcard);
  if (anyWild) return '通配';
  if (pats.length > 1) return '目录(多路径)';
  return scopeLabel(r);
}
function reasonBrief(r, n = 46) {
  const s = String(r.reason || '');
  return s.length > n ? s.slice(0, n) + '…' : s;
}
// 显示层去重（不改 protected.json 的规则内容；pattern 与 patterns[0] 常重复）
function dedupePatterns(pats) {
  const seen = new Set();
  const res = [];
  for (const p of pats) {
    const k = normPath(p);
    if (seen.has(k)) continue;
    seen.add(k);
    res.push(p);
  }
  return res;
}
function printRules(rules) {
  out('共 ' + rules.length + ' 条规则');
  out('');
  for (const r of rules) {
    const pats = dedupePatterns(rulePatterns(r));
    const patStr = pats.join('  |  ');
    const extra = r.denyMoveAsSourceOnly ? '  [move 只看源侧]' : '';
    out(
      r.id.padEnd(5) +
        ' [' + rangeLabel(r) + ']'.padEnd(10) +
        ' 范围=' + scopeLabel(r).padEnd(4) +
        ' 路径=' + patStr +
        extra,
    );
    out('      deny: ' + (Array.isArray(r.deny) ? r.deny.join(',') : '(无)') + '   reason: ' + reasonBrief(r));
    const code = isSensitive(r) ? ERROR_CODES.SENSITIVE_DENIED : ERROR_CODES.PROTECTED_RULE_DENIED;
    const perAction = (Array.isArray(r.deny) ? r.deny : []).map((a) => a + '=' + code).join(', ');
    out('      errorCode: ' + (perAction || '(无)'));
  }
  out('');
  printErrorCodes();
}
function printErrorCodes() {
  out('=== errorCodes 映射表（动作 × 规则类别 → 现役错误码） ===');
  const ec = errorCodesMap();
  for (const a of ALLOWED_ACTIONS) {
    out(
      '  ' + a.padEnd(6) + ': 敏感规则→' + ec.byAction[a].sensitive +
        '  保护规则→' + ec.byAction[a].protected + '  放行→null',
    );
  }
  out('  invalid_args: 参数校验失败（现役在规则判定之前，如目标是目录）');
  out('  not_found:    路径不存在（现役在规则判定之前）');
  out('  note: ' + ORDER_NOTE);
}
function printCheck(rules, path) {
  const j = judge(rules, path);
  out(j.path + ' → ' + j.headline + ' → ' + actionLine(j));
  if (j.hits.length) {
    for (const r of j.hits) {
      out('    · ' + r.id + ' [' + scopeLabel(r) + '] deny=' + (r.deny || []).join(',') +
        (r.denyMoveAsSourceOnly ? ' (move 只看源侧)' : '') + ' — ' + reasonBrief(r, 80));
    }
  }
  for (const rel of j.related) {
    out('    · 相关但未命中: ' + rel.why);
  }
  const denied = ACTION_ORDER.filter((a) => j.actions[a].denied);
  out('    · 判定结果: ' + (denied.length ? denied.join('/') + ' 拒绝' : '全部放行'));
  out('    · errorCode: ' + ACTION_ORDER.map((a) => a + '=' + (j.actions[a].errorCode || 'null')).join(', '));
  out('    · errorCodes 映射表: ' + JSON.stringify(errorCodesMap()));
  out('    · note: ' + ORDER_NOTE);
  out('    · JSON: ' + JSON.stringify(judgeJson(j)));
  return j;
}

const VERIFY_SAMPLES = [
  ['C:/work/my-project', '你配置为受保护的那个目录本身'],
  ['C:/work/my-project/a.md', '该目录下的文件'],
  ['C:/work/core-config', '核心配置目录本身'],
  ['C:/work/core-config/main.conf', '核心配置文件'],
  ['C:/work/app/node_modules/pkg/index.js', 'node_modules 下的文件'],
  ['C:/work/app/.env', '环境变量文件'],
  ['C:/work/app/certs/server.pem', '证书文件'],
  ['C:/work/data', '你的数据目录本身'],
  ['C:/work/core-config/other.yml', '配置目录内的其它文件'],
];

function printVerify(rules) {
  out('=== 判定对拍样例（这是管理台的判定，file-ops 是另一套实现，请用 verify 对照） ===');
  out('');
  for (const [p, note] of VERIFY_SAMPLES) {
    const j = judge(rules, p);
    out('路径: ' + j.path);
    out('  说明: ' + note);
    out('  判定: ' + j.headline);
    out('  动作: ' + actionLine(j));
    out('');
  }
  out('对照方法: 同一路径同时用 file-ops 的 list_protected()/实际 trash|read 行为比对管理台 check 的结论。');
  out('');
  printErrorCodes();
}

// ---------------------------------------------------------------- 交互

async function ask(rl, q) {
  const a = (await rl.question(q)).trim();
  return a;
}
function parseList(s) {
  return String(s || '')
    .split(/[,，\s]+/)
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
}

async function interactiveAdd(rl, rules) {
  out('');
  out('--- 新增规则 ---');
  let scope = (await ask(rl, '范围 [1=目录 / 2=文件]: ')) || '1';
  scope = scope === '2' ? 'file' : 'directory';
  const pattern = await ask(rl, '路径' + (scope === 'directory' ? '（目录，如 C:/work/my_dir）' : '（文件，如 C:/work/my.conf）') + ': ');
  if (!pattern) {
    out('已取消（路径为空）');
    return null;
  }
  out('可拦动作: ' + ALLOWED_ACTIONS.join(', '));
  const denyRaw = await ask(rl, '拦哪些动作（多选，逗号分隔）: ');
  const deny = parseList(denyRaw);
  const bad = deny.filter((a) => !ALLOWED_ACTIONS.includes(a));
  if (bad.length) {
    out('非法动作: ' + bad.join(', ') + '（允许：' + ALLOWED_ACTIONS.join(', ') + '）');
    return null;
  }
  if (!deny.length) {
    out('至少要拦一个动作，已取消');
    return null;
  }
  const reason = await ask(rl, '理由文本: ');
  if (!reason) {
    out('已取消（理由为空）');
    return null;
  }
  let id = 'R' + (rules.length + 1);
  while (ruleById(rules, id)) {
    id = await ask(rl, 'id ' + id + ' 已存在，请换一个: ');
    if (!id) return null;
  }
  const rule = { id, scope, pattern: normPath(pattern), deny, reason };
  const preview = { id, scope, pattern: rule.pattern, deny, reason };
  const errs = validateRules([...rules, preview]);
  if (errs.length) {
    out('!! 自检未通过:');
    for (const e of errs) out('   - ' + e);
    return null;
  }
  out('');
  out('确认写入: ' + JSON.stringify(preview));
  const c = await ask(rl, '确认? [y/N]: ');
  if (!/^y(es)?$/i.test(c)) {
    out('已取消');
    return null;
  }
  const cfg = loadConfig();
  cfg.rules.push(preview);
  const res = writeBack(cfg);
  if (res.ok) out('新规则数: ' + res.count + '（已含本条）');
  return res;
}

async function interactiveSet(rl, rules) {
  out('');
  out('--- 修改规则 ---');
  const id = await ask(rl, '要改的规则 id: ');
  const r = ruleById(rules, id);
  if (!r) {
    out('没有 id 为 ' + id + ' 的规则');
    return null;
  }
  const cur = JSON.parse(JSON.stringify(r));
  out('当前: ' + JSON.stringify(cur));
  const field = await ask(rl, '改哪一项? [scope/pattern/patterns/deny/reason]: ');
  const key = field.toLowerCase();
  if (key === 'scope') {
    const s = await ask(rl, '新范围 [1=目录 / 2=文件]: ');
    cur.scope = s === '2' ? 'file' : 'directory';
  } else if (key === 'pattern') {
    const p = await ask(rl, '新路径: ');
    if (!p) return null;
    cur.pattern = normPath(p);
  } else if (key === 'patterns') {
    const p = await ask(rl, '新路径列表（逗号分隔）: ');
    cur.patterns = parseList(p).map(normPath);
    if (!cur.patterns.length) return null;
  } else if (key === 'deny') {
    out('可拦动作: ' + ALLOWED_ACTIONS.join(', '));
    const d = parseList(await ask(rl, '新动作列表: '));
    if (!d.length) return null;
    const bad = d.filter((a) => !ALLOWED_ACTIONS.includes(a));
    if (bad.length) {
      out('非法动作: ' + bad.join(', ') + '，已取消');
      return null;
    }
    cur.deny = d;
  } else if (key === 'reason') {
    const s = await ask(rl, '新理由: ');
    if (!s) return null;
    cur.reason = s;
  } else {
    out('未知字段，已取消');
    return null;
  }
  const next = rules.map((x) => (String(x.id).toUpperCase() === String(id).toUpperCase() ? cur : x));
  const errs = validateRules(next);
  if (errs.length) {
    out('!! 自检未通过:');
    for (const e of errs) out('   - ' + e);
    return null;
  }
  out('确认: ' + JSON.stringify(cur));
  const c = await ask(rl, '确认? [y/N]: ');
  if (!/^y(es)?$/i.test(c)) {
    out('已取消');
    return null;
  }
  const cfg = loadConfig();
  cfg.rules = next;
  return writeBack(cfg);
}

async function interactiveRm(rl, rules) {
  out('');
  out('--- 删除规则 ---');
  const id = await ask(rl, '要删的规则 id: ');
  const r = ruleById(rules, id);
  if (!r) {
    out('没有 id 为 ' + id + ' 的规则');
    return null;
  }
  out('将删除: ' + JSON.stringify(r));
  const c = await ask(rl, '确认? [y/N]: ');
  if (!/^y(es)?$/i.test(c)) {
    out('已取消');
    return null;
  }
  const cfg = loadConfig();
  cfg.rules = cfg.rules.filter((x) => String(x.id).toUpperCase() !== String(r.id).toUpperCase());
  return writeBack(cfg);
}

async function interactiveCheck(rl, rules) {
  out('');
  out('--- 试算路径 ---');
  const p = await ask(rl, '路径: ');
  if (!p) {
    out('已取消');
    return null;
  }
  printCheck(rules, p);
  return null;
}

async function menu() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      let cfg;
      let rules;
      try {
        cfg = loadConfig();
        rules = cfg.rules;
      } catch (e) {
        out('!! ' + e.message);
        break;
      }
      const mtime = statSync(RULE_FILE).mtime;
      const pad = (n) => String(n).padStart(2, '0');
      const stamp =
        mtime.getFullYear() + '-' + pad(mtime.getMonth() + 1) + '-' + pad(mtime.getDate()) +
        ' ' + pad(mtime.getHours()) + ':' + pad(mtime.getMinutes()) + ':' + pad(mtime.getSeconds());
      out('');
      out('=== 保护规则管理台 ===');
      out(
        '现役: ' + RULE_FILE + '   最后修改: ' + stamp + '   规则: ' + rules.length + ' 条',
      );
      out('[1] 列出全部规则          [2] 新增规则        [3] 修改规则');
      out('[4] 删除规则              [5] 试算路径         [6] 校验并写回');
      out('[7] 生成规则快照（不改规则）');
      out('[0] 退出');
      const c = await ask(rl, '选择: ');
      if (c === '0') {
        out('再见');
        break;
      } else if (c === '1') {
        out('');
        printRules(rules);
      } else if (c === '2') {
        await interactiveAdd(rl, rules);
      } else if (c === '3') {
        await interactiveSet(rl, rules);
      } else if (c === '4') {
        await interactiveRm(rl, rules);
      } else if (c === '5') {
        await interactiveCheck(rl, rules);
      } else if (c === '6') {
        const errs = validateRules(rules);
        if (errs.length) {
          out('!! 自检未通过，不写回:');
          for (const e of errs) out('   - ' + e);
        } else {
          out('自检通过（' + rules.length + ' 条规则）');
          writeBack(cfg);
        }
      } else if (c === '7') {
        try {
          makeSnapshot();
        } catch (e) {
          out('!! 快照失败: ' + (e && e.message ? e.message : String(e)));
        }
      } else {
        out('无效选项');
      }
    }
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------- CLI

function help() {
  out('保护规则交互式管理台');
  out('');
  out('用法:');
  out('  node manage-rules.mjs                     进入交互菜单');
  out('  node manage-rules.mjs list                列出全部规则');
  out('  node manage-rules.mjs add [选项]          新增规则（不给选项则走交互问答）');
  out('  node manage-rules.mjs rm <RID>            删除规则');
  out('  node manage-rules.mjs set <RID> [选项]    修改规则');
  out('  node manage-rules.mjs check <路径>        试算路径：命中哪些规则、拦什么动作');
  out('  node manage-rules.mjs verify              输出固定样例的判定表（用于与 file-ops 对拍）');
  out('  node manage-rules.mjs backup              只生成 protected.json 的字节级快照（不改规则）');
  out('  node manage-rules.mjs help                本帮助');
  out('');
  out('add / set 选项:');
  out('  --scope directory|file      范围：目录 / 文件');
  out('  --pattern <路径>            单条路径');
  out('  --patterns <p1,p2>          多条路径');
  out('  --deny <a,b,c>              拦哪些动作（允许：' + ALLOWED_ACTIONS.join(', ') + '）');
  out('  --reason "<文本>"           理由');
  out('');
  out('规则文件: ' + RULE_FILE);
  out('备份目录: ' + BACKUP_DIR + '\\protected-<YYYYMMDD-HHMMSS>.json');
  out('');
  out('统一语义: 普通路径只精确匹配该路径本身；含 * / ** 的通配按字面覆盖其匹配到的所有路径；');
  out('          deny 列出拦哪些动作；denyMoveAsSourceOnly 表示 move 只看源侧。');
}

function parseFlags(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      pos.push(a);
    }
  }
  return { flags, pos };
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd) {
    await menu();
    return;
  }
  const { flags, pos } = parseFlags(argv.slice(1));
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    help();
    return;
  }
  if (cmd === 'list') {
    printRules(loadRules());
    return;
  }
  if (cmd === 'check') {
    if (!pos[0]) {
      out('用法: node manage-rules.mjs check <路径>');
      process.exitCode = 1;
      return;
    }
    printCheck(loadRules(), pos[0]);
    return;
  }
  if (cmd === 'verify') {
    printVerify(loadRules());
    return;
  }
  if (cmd === 'backup') {
    try {
      makeSnapshot();
    } catch (e) {
      out('!! 快照失败: ' + (e && e.message ? e.message : String(e)));
      process.exitCode = 1;
    }
    return;
  }
  if (cmd === 'add') {
    const rules = loadRules();
    const scope = flags.scope === 'file' ? 'file' : flags.scope === 'directory' ? 'directory' : null;
    if (scope && flags.pattern && flags.deny && flags.reason) {
      const deny = parseList(flags.deny);
      const bad = deny.filter((a) => !ALLOWED_ACTIONS.includes(a));
      if (bad.length) {
        out('非法动作: ' + bad.join(', '));
        process.exitCode = 1;
        return;
      }
      let id = 'R' + (rules.length + 1);
      while (ruleById(rules, id)) id = 'R' + (rules.length + 2);
      const rule = { id, scope, pattern: normPath(flags.pattern), deny, reason: String(flags.reason) };
      const cfg = loadConfig();
      cfg.rules.push(rule);
      const res = writeBack(cfg);
      if (!res.ok) process.exitCode = 1;
      else out('新规则数: ' + res.count + '（已含本条）');
      return;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      await interactiveAdd(rl, rules);
    } finally {
      rl.close();
    }
    return;
  }
  if (cmd === 'rm') {
    const id = pos[0];
    if (!id) {
      out('用法: node manage-rules.mjs rm <RID>');
      process.exitCode = 1;
      return;
    }
    const rules = loadRules();
    const r = ruleById(rules, id);
    if (!r) {
      out('没有 id 为 ' + id + ' 的规则');
      process.exitCode = 1;
      return;
    }
    const cfg = loadConfig();
    cfg.rules = cfg.rules.filter((x) => String(x.id).toUpperCase() !== String(r.id).toUpperCase());
    writeBack(cfg);
    return;
  }
  if (cmd === 'set') {
    const id = pos[0];
    if (!id) {
      out('用法: node manage-rules.mjs set <RID> [--scope] [--pattern] [--patterns] [--deny] [--reason]');
      process.exitCode = 1;
      return;
    }
    const rules = loadRules();
    const r = ruleById(rules, id);
    if (!r) {
      out('没有 id 为 ' + id + ' 的规则');
      process.exitCode = 1;
      return;
    }
    const cur = JSON.parse(JSON.stringify(r));
    if (flags.scope) cur.scope = flags.scope === 'file' ? 'file' : 'directory';
    if (flags.pattern) cur.pattern = normPath(flags.pattern);
    if (flags.patterns) cur.patterns = parseList(flags.patterns).map(normPath);
    if (flags.deny) {
      const deny = parseList(flags.deny);
      const bad = deny.filter((a) => !ALLOWED_ACTIONS.includes(a));
      if (bad.length) {
        out('非法动作: ' + bad.join(', '));
        process.exitCode = 1;
        return;
      }
      cur.deny = deny;
    }
    if (flags.reason) cur.reason = String(flags.reason);
    const next = rules.map((x) => (String(x.id).toUpperCase() === String(r.id).toUpperCase() ? cur : x));
    const errs = validateRules(next);
    if (errs.length) {
      out('!! 自检未通过，不写回:');
      for (const e of errs) out('   - ' + e);
      process.exitCode = 1;
      return;
    }
    const cfg = loadConfig();
    cfg.rules = next;
    writeBack(cfg);
    return;
  }
  out('未知子命令: ' + cmd);
  help();
  process.exitCode = 1;
}

// 被 import（例如自测）时不跑 CLI 主流程，只导出可测函数；直接执行行为不变
const IS_MAIN = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return resolve(entry).replace(/\\/g, '/').toLowerCase() === fileURLToPath(import.meta.url).replace(/\\/g, '/').toLowerCase();
  } catch {
    return false;
  }
})();

if (IS_MAIN) {
  main().catch((e) => {
    out('!! 错误: ' + (e && e.message ? e.message : String(e)));
    process.exitCode = 1;
  });
}

export {
  loadConfig,
  writeBack,
  makeSnapshot,
  topLevelSpans,
  compactJson,
  expandedJson,
  detectValueStyle,
  deepEqual,
  sha256Of,
  maskValueSpans,
  RULE_FILE,
  BACKUP_DIR,
};
