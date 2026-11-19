#!/usr/bin/env node
// mcp-file-ops — 本地文件操作 MCP 服务器（stdio 传输）
// 单文件 ESM，零第三方依赖（除 @modelcontextprotocol/sdk）。
// 实现参考 @modelcontextprotocol/server-filesystem (MIT) 的公开行为；按行为自行实现，未复制其源码。
// 边界：file-ops 的写根限制只约束本 MCP 的写类操作，管不到 code-operator 的 pwsh——pwsh 的写边界由 DSH 沙箱（会话工作区）决定。
// 工具：trash / move / edit_text / read_text / find_files / convert_document / diff / list_protected / create_directory / get_file_info / list_directory / count_text
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

// iconv-lite（纯 JS）用于 gb18030 / big5 的编解码；装不上时降级为「只支持 UTF-8/UTF-16」。
let iconv = null;
try {
  const mod = await import('iconv-lite');
  iconv = mod && mod.default ? mod.default : mod;
  if (iconv && typeof iconv.decode !== 'function') iconv = null;
} catch { iconv = null; }
const HAS_ICONV = !!iconv;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROTECTED_FILE = process.env.FILEOPS_CONFIG ? path.resolve(process.env.FILEOPS_CONFIG) : path.join(HERE, 'protected.json');
const TMP_ROOT = path.join(HERE, '.tmp');
// 外部程序探测：环境变量优先，其次 PATH（whichOrFallback 会先扫 PATH，再用这里给的 fallback）。
// fallback 只放各平台的常规安装位置，不含任何个人目录。
const TYPST_FALLBACK = process.env.TYPST_PATH || null;
const PANDOC_FALLBACK = process.env.PANDOC_PATH || null;
const GIT_FALLBACK = process.env.GIT_PATH || 'C:/Program Files/Git/cmd/git.exe';
const MAX_DIFF_BYTES = 200 * 1024;
const HARD_CAP = 65536;              // 响应体总字节上限（正文 + 续读说明共享；max_bytes 只约束正文）

/* ------------------ 回收站能力探测（安全失败：删不掉就不删） ------------------ */
// 事实：受限进程（低完整性 / 可写域不含 $Recycle.Bin）里 SHFileOperation 仍返回 rc=0，
// 文件却被**静默永久删除**。所以「exit 0 + 文件消失」不足以证明进了回收站 → 必须真做一次删除才能判定。
let RECYCLE_BIN_OK = null;   // null = 未探测；true/false = 缓存结果（懒加载，进程内只真探一次）
let RECYCLE_BIN_PROBES = 0;  // 实际探测次数（缓存生效时不再增加；供自测断言）
let RECYCLE_BIN_DETAIL = {}; // 最近一次探测的原始事实（before/after $I 计数、跳过几个 SID 目录…）
const PERMANENT_EXIT_HINT = '如确需永久删除，请设环境变量 FOP_ALLOW_PERMANENT_DELETE=1 后重试。';
const allowPermanentDelete = () => process.env.FOP_ALLOW_PERMANENT_DELETE === '1';  // 语义：强制永久删（跳过回收站，即使能力可用）
const requireRecycleBin = () => process.env.FOP_REQUIRE_RECYCLE_BIN === '1';       // 语义：严格模式（能力不可用即拒绝，绝不降级）
const DEGRADED_RB_WARNING = '本进程无法使用回收站（可能受沙箱权限限制），文件已永久删除且不可恢复';
const DEGRADED_RB_WARNING_TARGET = '本进程无法使用回收站（可能受沙箱权限限制），覆盖时目标已永久删除且不可恢复';
const STRICT_RB_HINT = '如需继续，请取消环境变量 FOP_REQUIRE_RECYCLE_BIN=1（改为降级永久删除并如实标注），或改由用户在桌面会话中手工删除。';

/* --------------------------- 通用工具函数 --------------------------- */

function toPosix(p) { return String(p).replace(/\\/g, '/'); }

function resolvePath(p) {
  if (typeof p !== 'string' || p.trim() === '') throw new Error('路径不能为空');
  return path.resolve(p);
}

function ensureTmp() {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  return TMP_ROOT;
}

async function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(file);
    s.on('data', (d) => h.update(d));
    s.on('error', reject);
    s.on('end', () => resolve(h.digest('hex')));
  });
}

async function sha256Path(target) {
  const st = await fsp.stat(target);
  if (st.isFile()) return sha256File(target);
  const base = path.resolve(target);
  const entries = [];
  async function walk(dir) {
    for (const item of await fsp.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) await walk(full);
      else if (item.isFile()) {
        entries.push(`${toPosix(path.relative(base, full))}:${await sha256File(full)}`);
      }
    }
  }
  await walk(target);
  entries.sort();
  return crypto.createHash('sha256').update(entries.join('\n')).digest('hex');
}

async function dirSize(dir) {
  let total = 0;
  async function walk(d) {
    for (const item of await fsp.readdir(d, { withFileTypes: true })) {
      const full = path.join(d, item.name);
      if (item.isDirectory()) await walk(full);
      else if (item.isFile()) total += (await fsp.stat(full)).size;
    }
  }
  await walk(dir);
  return total;
}

/** 不用管道：以临时文件重定向 stdout/stderr，避免受限环境下的匿名管道限制。 */
function runCmd(cmd, args, opts = {}) {
  ensureTmp();
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'run-'));
  // run 目录是一次性重定向容器：读完全部输出后立即删除。清理失败不影响主流程（残留可由人工清理）。
  const cleanupRunDir = () => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不影响主流程 */ }
  };
  const outFile = path.join(dir, 'stdout.txt');
  const errFile = path.join(dir, 'stderr.txt');
  const outFd = fs.openSync(outFile, 'w');
  const errFd = fs.openSync(errFile, 'w');
  let inFd = null;
  if (opts.input != null) {
    const inFile = path.join(dir, 'stdin.txt');
    fs.writeFileSync(inFile, opts.input);
    inFd = fs.openSync(inFile, 'r');
  }
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: { ...process.env, ...(opts.env || {}) },
        stdio: [inFd == null ? 'ignore' : inFd, outFd, errFd],
        shell: false,
        windowsHide: true,
      });
    } catch (err) {
      try { fs.closeSync(outFd); fs.closeSync(errFd); } catch { /* ignore */ }
      cleanupRunDir();
      resolve({ code: -1, stdout: '', stderr: String(err && err.message || err), spawnError: true });
      return;
    }
    child.on('error', (err) => {
      try { fs.closeSync(outFd); fs.closeSync(errFd); } catch { /* ignore */ }
      cleanupRunDir();
      resolve({ code: -1, stdout: '', stderr: String(err && err.message || err), spawnError: true });
    });
    child.on('close', (code) => {
      try { fs.closeSync(outFd); fs.closeSync(errFd); if (inFd != null) fs.closeSync(inFd); } catch { /* ignore */ }
      const stdout = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : '';
      const stderr = fs.existsSync(errFile) ? fs.readFileSync(errFile, 'utf8') : '';
      cleanupRunDir();
      resolve({ code, stdout, stderr });
    });
  });
}

/* ------------- 配置（protected.json v2）/ 写根 / 设备路径 / 身份确认 ------------- */

const DEFAULT_BATCH_LIMITS = { trash: 500, move: 200, edits: 50, editPaths: 20, editTotalReplacements: 200, maxEditableBytes: 8388608, failureDetailFiles: 10 };
const DEFAULT_READ_CAPS = { maxLines: 2000, maxBytes: 65536 };
const SCAN_MAX_FILES = 20000;
const SCAN_MAX_MS = 15000;
const DEFAULT_SCAN_BUDGET = { maxFiles: SCAN_MAX_FILES, maxMs: SCAN_MAX_MS };
const DEFAULT_AUDIT = { enabled: false, logPath: null, retentionDays: 6, maxBytes: 20971520, summaryOnRotate: true };

/* --- 配置热加载：每次规则判定前比对 mtimeMs + size；变了才重新读取 / 解析 / 重算 sha256 --- */

let _configCache = null;          // 当前生效配置（配置写坏时保持旧配置继续服务）
let _configStamp = { mtimeMs: -1, size: -1 };
let _configSha256 = null;
let _configError = null;          // 最近一次配置错误 { ts, message, path }
let _configErrorMsg = null;       // 错误去重，避免同一错误反复刷屏
let _reloadInFlight = null;       // 并发去重：同一时刻只允许一次重载
let _writeRootsCache = null;

function _stampSync(p) {
  try { const st = fs.statSync(p); return { mtimeMs: st.mtimeMs, size: st.size }; }
  catch { return { mtimeMs: -1, size: -1 }; }
}

async function _stampAsync(p) {
  try { const st = await fsp.stat(p); return { mtimeMs: st.mtimeMs, size: st.size }; }
  catch { return { mtimeMs: -1, size: -1 }; }
}

function buildConfig(parsed) {
  const p = parsed && typeof parsed === 'object' ? parsed : {};
  return {
    version: p.version || 1,
    writeRoots: Array.isArray(p.writeRoots) ? p.writeRoots.map(String) : [],
    batchLimits: { ...DEFAULT_BATCH_LIMITS, ...(p.batchLimits || {}) },
    readCaps: { ...DEFAULT_READ_CAPS, ...(p.readCaps || {}) },
    scanBudget: { ...DEFAULT_SCAN_BUDGET, ...(p.scanBudget || {}) },
    rules: Array.isArray(p.rules) ? p.rules : [],
    audit: { ...DEFAULT_AUDIT, ...(p.audit || {}) },
  };
}

/** 记录配置错误：保留旧配置继续服务——绝不因为 JSON 坏了就变成「无保护」。 */
function recordConfigError(err, stamp) {
  const message = err && err.message ? err.message : String(err);
  _configError = { ts: new Date().toISOString(), message, path: toPosix(PROTECTED_FILE) };
  if (message !== _configErrorMsg) {
    _configErrorMsg = message;
    try { process.stderr.write(`[mcp-file-ops] protected.json 解析失败，保留旧配置继续服务：${message}\n`); } catch { /* ignore */ }
  }
  if (!_configCache) {
    _configCache = buildConfig({});
    _configStamp = stamp;
    _writeRootsCache = null;
  }
  return _configCache;
}

/** 重载配置：读取 + 解析 + 重算 sha256；失败时旧配置继续服务。 */
function reloadConfig(stamp) {
  let buf;
  try { buf = fs.readFileSync(PROTECTED_FILE); }
  catch (e) { return recordConfigError(e, stamp); }
  let parsed;
  try { parsed = JSON.parse(buf.toString('utf8').replace(/^\uFEFF/, '')); }
  catch (e) { return recordConfigError(e, stamp); }
  _configCache = buildConfig(parsed);
  _configStamp = stamp;
  _configSha256 = crypto.createHash('sha256').update(buf).digest('hex');
  _configError = null;
  _configErrorMsg = null;
  _writeRootsCache = null;
  return _configCache;
}

/** 同步新鲜度检查：未变化时零读取、零解析（只做一次 stat）。 */
function ensureConfigFreshSync() {
  const stamp = _stampSync(PROTECTED_FILE);
  if (_configCache && stamp.mtimeMs === _configStamp.mtimeMs && stamp.size === _configStamp.size) return _configCache;
  return reloadConfig(stamp);
}

/** 异步新鲜度检查：并发去重（共享 in-flight promise）。 */
async function ensureConfigFreshAsync() {
  const stamp = await _stampAsync(PROTECTED_FILE);
  if (_configCache && stamp.mtimeMs === _configStamp.mtimeMs && stamp.size === _configStamp.size) return _configCache;
  if (_reloadInFlight) return _reloadInFlight;
  _reloadInFlight = (async () => {
    try { return reloadConfig(stamp); }
    finally { _reloadInFlight = null; }
  })();
  return _reloadInFlight;
}

function loadConfig() {
  return ensureConfigFreshSync();
}

/** 配置指纹（供 list_protected 返回）。 */
function configFingerprint() {
  const cfg = ensureConfigFreshSync();
  return {
    configPath: toPosix(PROTECTED_FILE),
    mtime: _configStamp.mtimeMs,
    sha256: _configSha256,
    rules: cfg.rules.length,
    ruleCount: cfg.rules.length,
  };
}

/* --------------------- 通用小工具：二进制探测 / 时间窗 / 保护目录 / 审计 --------------------- */

/** 读取文件头（最多 8KB）；读取失败返回空缓冲（与历史行为一致）。 */
async function readHeadBytes(real, size = 8192) {
  let head = Buffer.alloc(0);
  let fh = null;
  try {
    fh = await fsp.open(real, 'r');
    const buf = Buffer.alloc(size);
    const { bytesRead } = await fh.read(buf, 0, size, 0);
    head = buf.subarray(0, bytesRead);
  } catch { head = Buffer.alloc(0); }
  finally { if (fh) { try { await fh.close(); } catch { /* ignore */ } } }
  return head;
}

/** 二进制判定：前 8KB 出现 NUL 字节（UTF-16 BOM 除外）→ 视为二进制。read_text / find_files / count_text 共用同一套逻辑。 */
function headLooksBinary(head) {
  const hasUtf16Bom = head.length >= 2 && ((head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff));
  return !hasUtf16Bom && head.includes(0);
}

/**
 * 二进制判定的统一入口：含 NUL 且**不是**无 BOM 的 UTF-16 文本。
 * read_text / find_files / count_text 三处必须走同一套探测，否则会出现
 * 「read_text 能读、find_files 却记成 skippedBy:{binary:2}」的不一致。
 */
function isBinaryHead(head) {
  return headLooksBinary(head) && !detectUtf16Heuristic(head);
}

/* ---------------------------- 编码识别辅助 ---------------------------- */

/** 显式 encoding 参数的合法别名（非法名 → invalid_args；不在 schema 里设 enum，避免协议层先拒）。 */
const ENCODING_ALIASES = {
  'utf-8': 'utf-8', 'utf8': 'utf-8',
  'utf-16le': 'utf-16le', 'utf16le': 'utf-16le',
  'utf-16be': 'utf-16be', 'utf16be': 'utf-16be',
  'gb18030': 'gb18030', 'gb-18030': 'gb18030',
  'big5': 'big5', 'big-5': 'big5',
};

/** GB18030 的 BOM 标记字节（84 31 95 33）。 */
const GB18030_BOM = Buffer.from([0x84, 0x31, 0x95, 0x33]);

/** 异常控制字符（\t \n \r 除外）：用于判定"解出来的是不是文本"。 */
const RE_BAD_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/;

/** 按检测结果解码（统一入口：UTF-16BE 走字节交换，不依赖 TextDecoder 的标签支持）。 */
function decodeDetected(det) {
  if (det.text !== undefined) return det.text;
  const body = det.body;
  if (det.enc === 'utf-8') return body.toString('utf8');
  if (det.enc === 'utf-16le') return body.toString('utf16le');
  if (det.enc === 'utf-16be') return swap16(body).toString('utf16le');
  return new TextDecoder(det.enc).decode(body);
}

/**
 * 无 BOM 的 UTF-16 启发式：按 2 字节配对统计 NUL 落在偶位/奇位的比例。
 * UTF-16LE 的 ASCII 文本 NUL 在奇位；UTF-16BE 在偶位。
 * 阈值：NUL 数 ≥ 2 且优势方占比 ≥ 60%；再解码校验（无 U+FFFD、无异常控制字符）才采信。
 */
function detectUtf16Heuristic(buf) {
  if (!buf || buf.length < 4) return null;
  let nulEven = 0; let nulOdd = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] !== 0) continue;
    if (i % 2 === 0) nulEven++; else nulOdd++;
  }
  const total = nulEven + nulOdd;
  if (total < 2) return null;
  const ratioEven = nulEven / total;
  const ratioOdd = nulOdd / total;
  let enc = null;
  if (ratioOdd >= 0.6) enc = 'utf-16le';
  else if (ratioEven >= 0.6) enc = 'utf-16be';
  if (!enc) return null;
  let text;
  try { text = decodeDetected({ enc, body: buf }); } catch { return null; }
  if (typeof text !== 'string' || text.length === 0) return null;
  if (text.includes('\uFFFD')) return null;
  if (RE_BAD_CONTROL.test(text)) return null;
  return enc;
}

/** 按字节预算截断 UTF-8 文本（不切断多字节字符）。 */
function truncateUtf8(str, maxBytes) {
  const b = Buffer.from(str, 'utf8');
  if (b.length <= maxBytes) return str;
  let cut = b.subarray(0, Math.max(0, maxBytes)).toString('utf8');
  if (cut.endsWith('\uFFFD')) cut = cut.slice(0, -1);
  return cut;
}

/* ---------------------- 字节区间读（read_text: start_byte / max_bytes） ---------------------- */

/** 单个码点的 UTF-8 字节长度。 */
function utf8CpLen(cp) {
  if (cp < 0x80) return 1;
  if (cp < 0x800) return 2;
  if (cp < 0x10000) return 3;
  return 4;
}

/** 从字符下标 start 起取最多 maxBytes 个 UTF-8 字节的子串（不切断多字节字符，也不切断代理对）。 */
function takeUtf8Budget(str, start, maxBytes) {
  let bytes = 0; let i = start;
  while (i < str.length) {
    const cp = str.codePointAt(i);
    const cl = cp > 0xFFFF ? 2 : 1;
    const b = utf8CpLen(cp);
    if (bytes + b > maxBytes) break;
    bytes += b; i += cl;
  }
  return { text: str.slice(start, i), endIndex: i, bytes };
}

/** 字符下标 → 源编码字节偏移（body 内偏移，不含 BOM）。非 UTF-8 且 iconv 失败时抛错——绝不静默退回 UTF-8 口径。 */
function sourceOffsetOfIndex(text, idx, enc) {
  if (enc === 'utf-16le' || enc === 'utf-16be') return idx * 2;
  if (enc === 'gb18030' || enc === 'big5') {
    if (!iconv) throw new Error(`缺少 iconv-lite，无法计算 ${enc} 的字节偏移`);
    try { return iconv.encode(text.slice(0, idx), enc).length; }
    catch (e) { throw new Error(`无法计算 ${enc} 的字节偏移：${e && e.message ? e.message : e}`); }
  }
  let bytes = 0; let i = 0;
  while (i < idx) {
    const cp = text.codePointAt(i);
    const cl = cp > 0xFFFF ? 2 : 1;
    bytes += utf8CpLen(cp); i += cl;
  }
  return bytes;
}

/**
 * 源字节偏移 → 字符下标。落在多字节字符中间时自动回退到字符边界，
 * 回退的字节数放在 backoff 里（用于 alignmentAdjusted / alignmentBackoffBytes）。
 * 非 UTF-8 必须由 iconv 精确定位：定位失败**抛错**，绝不静默退回 UTF-8 口径。
 */
function indexOfSourceOffset(text, off, enc, body) {
  const o = Math.max(0, Math.min(off, body.length));
  if (enc === 'utf-16le' || enc === 'utf-16be') {
    const idx = Math.floor(o / 2);
    return { index: idx, backoff: o - idx * 2 };
  }
  if (enc === 'gb18030' || enc === 'big5') {
    if (!iconv) throw new Error(`缺少 iconv-lite，无法在 ${enc} 中定位字符边界`);
    for (let back = 0; back <= 3; back++) {
      const cand = o - back;
      if (cand < 0) break;
      try {
        const prefix = iconv.decode(body.subarray(0, cand));
        if (iconv.encode(prefix, enc).length === cand) return { index: prefix.length, backoff: back };
      } catch { /* 试下一个回退位置 */ }
    }
    throw new Error(`无法在 ${enc} 的字节偏移 ${o} 处定位字符边界`);
  }
  let bytes = 0; let i = 0;
  while (i < text.length) {
    const cp = text.codePointAt(i);
    const cl = cp > 0xFFFF ? 2 : 1;
    const b = utf8CpLen(cp);
    if (bytes + b > o) return { index: i, backoff: o - bytes };
    bytes += b; i += cl;
  }
  return { index: text.length, backoff: 0 };
}

/** 第 lineNo 行（1 起）的起始字符下标。 */
function charIndexOfLine(text, lineNo) {
  if (lineNo <= 1) return 0;
  let seen = 1; let idx = 0;
  while (idx < text.length && seen < lineNo) {
    const nl = text.indexOf('\n', idx);
    if (nl < 0) return text.length;
    idx = nl + 1; seen++;
  }
  return Math.min(idx, text.length);
}

/** 字符下标 idx 之前（不含 idx）的换行个数。 */
function countLinesBefore(text, idx) {
  let n = 0;
  for (let i = 0; i < idx; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/* ---------------------- 区间参数集中校验（B1：单一入口） ---------------------- */

/**
 * 区间参数集中校验：read_text / count_text 的**所有**路径都必须先过这个函数。
 * 返回 { ok:true, requested, startByte, maxBytes, startLine, count }
 * 或 { ok:false, error:'invalid_args', reason, hint }。
 * 规则：
 * - start_byte：≥ 0 的整数
 * - max_bytes：≥ 1 的整数；> 65536 归一到 65536（不报错）
 * - start_line：≥ 1 的整数（不再「静默当 1」）
 * - count：≥ 1 的整数（count=0 不再两工具分裂）
 * - start_byte 与 start_line 互斥
 * - text 模式 + 任何区间参数 → invalid_args
 */
function validateRangeArgs(args, opts = {}) {
  const has = (v) => v != null && v !== '';
  const out = { ok: true, requested: false, startByte: null, maxBytes: null, startLine: null, count: null, maxBytesNormalized: false };
  const fail = (reason, hint) => ({ ok: false, error: 'invalid_args', reason, hint: hint || reason });
  const pick = (v, name, min) => {
    const n = Number(v);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < min) {
      return { err: `${name} 必须是 ≥ ${min} 的整数：${JSON.stringify(v)}` };
    }
    return { n };
  };
  if (has(args.start_byte)) { const c = pick(args.start_byte, 'start_byte', 0); if (c.err) return fail(c.err); out.startByte = c.n; }
  if (has(args.max_bytes)) {
    const c = pick(args.max_bytes, 'max_bytes', 1); if (c.err) return fail(c.err);
    out.maxBytesNormalized = c.n > HARD_CAP;
    out.maxBytes = out.maxBytesNormalized ? HARD_CAP : c.n;
  }
  if (has(args.start_line)) { const c = pick(args.start_line, 'start_line', 1); if (c.err) return fail(c.err); out.startLine = c.n; }
  if (has(args.count)) { const c = pick(args.count, 'count', 1); if (c.err) return fail(c.err); out.count = c.n; }
  if (out.startByte != null && out.startLine != null) {
    return fail('start_byte 与 start_line 不能同时使用（字节区间读与行分页互斥）');
  }
  out.requested = out.startByte != null || out.maxBytes != null || out.startLine != null || out.count != null;
  if (out.requested && opts.mode === 'text') {
    return fail('text 本身就是片段，不需要区间参数（start_byte / max_bytes / start_line / count）');
  }
  return out;
}

/**
 * 统一区间计算（A3：read_text 与 count_text 共用**同一份**实现）。
 * ctx: { text, enc, body, bomLen, startByte, maxBytes, startLine, count }
 * 负责：字节→字符索引换算、字符边界回退、字节/行双上限、nextByteOffset 计算。
 * 越界不做「夹取掩盖」：起点越界由调用方判定为 emptyRange / rangeOutOfBounds。
 */
function computeRangeWindow(ctx) {
  const { text, enc, body, bomLen } = ctx;
  const bodyLen = body.length;
  let sIdx = 0;
  let backoff = 0;
  if (ctx.startLine != null) {
    sIdx = charIndexOfLine(text, ctx.startLine);
  } else if (ctx.startByte != null && ctx.startByte > 0) {
    const off = Math.max(0, Math.min(ctx.startByte - bomLen, bodyLen));
    const r = indexOfSourceOffset(text, off, enc, body);
    sIdx = Math.min(r.index, text.length);
    backoff = r.backoff;
  }
  let eIdx = text.length;
  let cutByBytes = false;
  let cutByCount = false;
  if (ctx.maxBytes != null) {
    const sOff = sourceOffsetOfIndex(text, sIdx, enc);
    const endOff = Math.max(0, Math.min(sOff + ctx.maxBytes, bodyLen));
    const r2 = indexOfSourceOffset(text, endOff, enc, body);
    let cand = Math.min(r2.index, text.length);
    if (cand <= sIdx && sIdx < text.length) {
      // 预算装不下一个多字节字符时，至少给出 1 个字符（正文永不为空）
      const cp = text.codePointAt(sIdx);
      cand = sIdx + (cp > 0xFFFF ? 2 : 1);
    }
    if (cand < eIdx) { eIdx = cand; cutByBytes = true; }
  }
  if (ctx.count != null) {
    const segs = text.slice(sIdx, eIdx).split('\n');
    if (ctx.count < segs.length) {
      const kept = segs.slice(0, ctx.count).join('\n') + '\n';
      eIdx = Math.min(sIdx + kept.length, eIdx);
      cutByCount = true;
    }
  }
  const slice = text.slice(sIdx, eIdx);
  const startByteAbs = bomLen + sourceOffsetOfIndex(text, sIdx, enc);
  const endByteAbs = bomLen + sourceOffsetOfIndex(text, eIdx, enc);
  const firstLine = countLinesBefore(text, sIdx) + 1;
  const segs = slice.split('\n');
  const nLines = slice === '' ? 0 : (slice.endsWith('\n') ? segs.length - 1 : segs.length);
  const truncated = eIdx < text.length;
  const truncatedBy = cutByCount ? 'max_lines' : (cutByBytes ? 'max_bytes' : null);
  let nextStartLine;
  let lineTruncated = false; let truncatedLine = null; let truncatedLineBytes = 0;
  if (truncated) {
    if (cutByCount) {
      nextStartLine = firstLine + ctx.count;
    } else if (text[eIdx] === '\n') {
      nextStartLine = countLinesBefore(text, eIdx) + 2;
    } else {
      lineTruncated = true;
      truncatedLine = countLinesBefore(text, eIdx) + 1;
      const lineStart = text.lastIndexOf('\n', eIdx - 1) + 1;
      const nl = text.indexOf('\n', eIdx);
      const lineEnd = nl < 0 ? text.length : nl + 1;
      const fullLineBytes = sourceOffsetOfIndex(text, lineEnd, enc) - sourceOffsetOfIndex(text, lineStart, enc);
      const included = sourceOffsetOfIndex(text, eIdx, enc) - sourceOffsetOfIndex(text, lineStart, enc);
      truncatedLineBytes = Math.max(0, fullLineBytes - included);
      nextStartLine = truncatedLine + 1;
    }
  }
  return {
    slice, sIdx, eIdx, backoff,
    byteRange: { startByte: startByteAbs, endByte: endByteAbs },
    lineRange: { startLine: firstLine, endLine: nLines === 0 ? firstLine : firstLine + nLines - 1 },
    returnedLines: nLines, firstLine, truncated, truncatedBy, cutByBytes, cutByCount,
    nextByteOffset: endByteAbs, nextStartLine, lineTruncated, truncatedLine, truncatedLineBytes,
    actualBytes: Buffer.byteLength(slice, 'utf8'),
  };
}

/**
 * 字节区间窗口（read_text 用）：在 computeRangeWindow 之上做「正文 + 续读说明 ≤ HARD_CAP」的预算迭代。
 * 预算模型：**max_bytes 只约束正文**；续读说明**附加在外**，只从响应体硬上限（HARD_CAP = 65536）里扣。
 * 不再有「说明预留 / 压半」概念，也不再有极短说明：howToContinue 一律是完整的一行。
 */
function buildByteWindow(ctx) {
  const { text, enc, body, bomLen, startByte, maxBytes, count, startLine } = ctx;
  const noticeOf = (out) => {
    let msg = `已按字节上限截断：起点 ${startByte}，实际给出 ${out.actualBytes} 字节；续读请再调 read_text 并传 start_byte=${out.nextByteOffset}。`;
    if (out.cutByCount) msg += `（已按 count=${count} 截断）`;
    return msg;
  };
  const run = (budget) => {
    const out = computeRangeWindow({ text, enc, body, bomLen, startByte, maxBytes: budget, count, startLine });
    out.howToContinue = out.truncated ? noticeOf(out) : undefined;
    return out;
  };
  let budget = Math.max(1, Math.min(Math.floor(maxBytes), HARD_CAP));
  let out = run(budget);
  for (let iter = 0; iter < 8 && out.truncated; iter++) {
    const need = HARD_CAP - Buffer.byteLength(out.howToContinue || '', 'utf8');
    if (out.actualBytes <= need) break;         // 正文 + 说明 ≤ HARD_CAP
    const nb = Math.max(1, Math.min(budget, need));
    if (nb === budget) break;
    budget = nb;
    out = run(budget);
  }
  out.effMaxBytes = Math.max(1, Math.min(Math.floor(maxBytes), HARD_CAP));
  return out;
}

/* ------------------ 扫描预算（find_files / list_directory / treeStats） ------------------ */

function newScanBudget(overrides = {}) {
  const cfg = loadConfig().scanBudget || {};
  const maxFiles = Math.max(1, Number(overrides.maxFiles ?? cfg.maxFiles ?? SCAN_MAX_FILES));
  const maxMs = Math.max(1, Number(overrides.maxMs ?? cfg.maxMs ?? SCAN_MAX_MS));
  // E4：scanned 的口径 = **访问过的条目数（含随后被跳过的条目）**。
  // 受保护目录、二进制文件、被过滤器丢弃的文件都算“访问过”，会计入 scanned。
  // maxFiles 就是这个“访问条目数”的硬阈值：判定用 `scanned >= maxFiles`，
  // 即 scanned 计到 maxFiles 就停。返回体里的 limit.maxFiles 就是这个实际生效的阈值（以代码为准）。
  return { maxFiles, maxMs, scanned: 0, start: Date.now(), exceeded: null };
}

/** 每访问一个条目检查一次预算；超限后立即停止（不再挂死）。 */
function scanBudgetHit(b) {
  if (!b) return null;
  if (b.exceeded) return b.exceeded;
  const elapsed = Date.now() - b.start;
  if (b.scanned >= b.maxFiles) { b.exceeded = { kind: 'files' }; return b.exceeded; }
  if (elapsed >= b.maxMs) { b.exceeded = { kind: 'time' }; return b.exceeded; }
  return null;
}

/**
 * 超限时的统一结构化结论（C5：与 rg-search 对齐）。
 * ok 只表示「本次调用本身没出错」；结果是否完整看 truncated / truncatedBy。
 * 已扫到的部分结果照常返回。
 */
function scanLimitResult(b, partial = {}) {
  const elapsedMs = Date.now() - b.start;
  const reason = `已扫 ${b.scanned} 个条目、耗时 ${elapsedMs} ms、达到上限（条目数上限 ${b.maxFiles}、时间上限 ${b.maxMs} ms）`;
  const hint = `扫描达到预算上限（已扫 ${b.scanned} 个条目 / ${elapsedMs} ms），本次结果可能不完整；需要更全请缩小 root，或调大 protected.json 的 scanBudget。`;
  return {
    ok: true,
    truncated: true,
    truncatedBy: 'scan_limit',
    reason,
    hint,
    scanned: b.scanned,
    elapsedMs,
    ...partial,
    limit: { maxFiles: b.maxFiles, maxMs: b.maxMs },
  };
}

/** 解析相对时间窗："90s" / "15m" / "24h" / "7d" / "30d" / "2w"；解析失败返回 null。 */
function parseWithinSpec(spec) {
  const s = String(spec == null ? '' : spec).trim().toLowerCase();
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h|d|w)$/.exec(s);
  if (!m) return null;
  const mult = { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 }[m[2]];
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n * mult;
}

/** 目录是否被保护规则命中（find_files / count_text 的自动跳过用）。 */
function protectedDirSkip(dirPath) {
  const target = toPosix(path.resolve(dirPath));
  for (const rule of loadRules()) {
    if (rule.scope !== 'directory') continue;
    for (const pat of rulePatternList(rule)) {
      if (pat == null) continue;
      const p = String(pat);
      if (!p) continue;
      const base = p.endsWith('/**') ? p.slice(0, -3) : p;
      if (base.includes('*') || base.includes('?')) {
        const src = globToRegex(base, true).source.replace(/^\^/, '').replace(/\$$/, '');
        if (new RegExp('^' + src + '$', 'i').test(target)) return rule;
      } else if (normalizePathKey(base) === normalizePathKey(target)) {
        return rule;
      }
    }
  }
  return null;
}

/* --------------------------- 审计日志（可配置，默认关闭） --------------------------- */

function auditConfig() {
  const cfg = loadConfig();
  return cfg.audit || { ...DEFAULT_AUDIT };
}

/** 审计运行时状态：懒轮转缓存（最早一条时间 / 大小 / 上次检查时刻）与待播报的轮转信息。 */
const _auditState = {
  logPath: null,
  lastCheckAt: 0,
  writesSinceCheck: 0,
  oldestTs: null,
  size: null,
  pendingRotation: null,   // { previous }：轮转后由下一次工具返回体播报一次
};

const AUDIT_CHECK_INTERVAL_MS = 60 * 60 * 1000;  // 缓存刷新下限：1 小时
const AUDIT_CHECK_WRITES = 200;                   // 缓存刷新下限：200 次写

/** 重置审计内存状态（换日志路径 / 测试用）。 */
function auditResetState() {
  _auditState.logPath = null;
  _auditState.lastCheckAt = 0;
  _auditState.writesSinceCheck = 0;
  _auditState.oldestTs = null;
  _auditState.size = null;
  _auditState.pendingRotation = null;
}

/** 读取日志首行时间戳（只读前 4 KiB，不整读）。 */
function auditFirstTimestamp(logPath) {
  let fd = null;
  try { fd = fs.openSync(logPath, 'r'); } catch { return null; }
  try {
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    if (n <= 0) return null;
    const first = buf.toString('utf8', 0, n).split('\n')[0];
    if (!first.trim()) return null;
    const o = JSON.parse(first);
    return typeof o.ts === 'string' ? o.ts : null;
  } catch { return null; }
  finally { try { fs.closeSync(fd); } catch { /* ignore */ } }
}

/** 汇总一份日志：条数 / 时间范围 / 按动作 / 按错误 / 按规则。 */
function auditSummarize(logPath) {
  const summary = { from: null, to: null, entries: 0, byAction: {}, byError: {}, byRule: {} };
  let text;
  try { text = fs.readFileSync(logPath, 'utf8'); } catch { return summary; }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    summary.entries += 1;
    const ts = typeof o.ts === 'string' ? o.ts : null;
    if (ts) {
      if (!summary.from || ts < summary.from) summary.from = ts;
      if (!summary.to || ts > summary.to) summary.to = ts;
    }
    const a = o.action ? String(o.action) : 'unknown';
    summary.byAction[a] = (summary.byAction[a] || 0) + 1;
    if (o.error) { const e = String(o.error); summary.byError[e] = (summary.byError[e] || 0) + 1; }
    if (o.ruleId) { const rid = String(o.ruleId); summary.byRule[rid] = (summary.byRule[rid] || 0) + 1; }
  }
  return summary;
}

/** 轮转：.log → .log.1（覆盖旧 .1），写 .log.1.summary.json，再新建空 .log。 */
function auditRotate(logPath, cfg, reason) {
  const prev = logPath + '.1';
  const summaryPath = logPath + '.1.summary.json';
  const summary = auditSummarize(logPath);
  summary.rotatedAt = new Date().toISOString();
  summary.reason = reason;
  try { fs.rmSync(prev, { force: true }); } catch { /* ignore */ }
  try { fs.renameSync(logPath, prev); } catch { return null; }
  if (cfg.summaryOnRotate !== false) {
    try { fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + '\n', 'utf8'); } catch { /* ignore */ }
  }
  try { fs.writeFileSync(logPath, '', 'utf8'); } catch { /* ignore */ }
  _auditState.oldestTs = null;
  _auditState.size = 0;
  _auditState.lastCheckAt = Date.now();
  _auditState.writesSinceCheck = 0;
  _auditState.pendingRotation = { previous: toPosix(prev) };
  return { previous: toPosix(prev), summary };
}

/**
 * 懒轮转判定：缓存（最早一条时间 / 大小）每写都用于判定，但只在
 * 「距上次检查 ≥1 小时」或「累计 ≥200 次写」时才真正读文件刷新缓存。
 */
function auditMaybeRotate(logPath, cfg) {
  const now = Date.now();
  if (_auditState.logPath !== logPath) {
    _auditState.logPath = logPath;
    _auditState.lastCheckAt = 0;
    _auditState.writesSinceCheck = 0;
    _auditState.oldestTs = null;
    _auditState.size = null;
  }
  const needRefresh = _auditState.lastCheckAt === 0
    || (now - _auditState.lastCheckAt) >= AUDIT_CHECK_INTERVAL_MS
    || _auditState.writesSinceCheck >= AUDIT_CHECK_WRITES;
  if (needRefresh) {
    _auditState.lastCheckAt = now;
    _auditState.writesSinceCheck = 0;
    let st = null;
    try { st = fs.statSync(logPath); } catch { st = null; }
    if (st) {
      _auditState.size = st.size;
      const ts = auditFirstTimestamp(logPath);
      if (ts) _auditState.oldestTs = ts;
    } else {
      _auditState.size = 0;
      _auditState.oldestTs = null;
    }
  }
  const maxBytes = Number(cfg.maxBytes) > 0 ? Number(cfg.maxBytes) : DEFAULT_AUDIT.maxBytes;
  if (typeof _auditState.size === 'number' && _auditState.size > maxBytes) return auditRotate(logPath, cfg, 'max_bytes');
  const retentionDays = Number(cfg.retentionDays);
  if (Number.isFinite(retentionDays) && retentionDays >= 0 && _auditState.oldestTs) {
    const t = Date.parse(_auditState.oldestTs);
    if (Number.isFinite(t) && (now - t) >= retentionDays * 86400000) return auditRotate(logPath, cfg, 'retention');
  }
  return null;
}

/**
 * 写一条审计（JSONL）。写失败必须被吞掉，绝不影响主操作结果。
 * 返回 { attempted, logged }：attempted=false 表示审计未启用；logged=false 表示写失败。
 */
function auditWrite(entry) {
  const cfg = auditConfig();
  if (!cfg || cfg.enabled !== true) return { attempted: false, logged: false };
  if (!cfg.logPath) return { attempted: false, logged: false, reason: 'audit.enabled=true 但 audit.logPath 未配置' };
  const logPath = path.resolve(String(cfg.logPath));
  try { fs.mkdirSync(path.dirname(logPath), { recursive: true }); } catch { /* ignore */ }
  try { auditMaybeRotate(logPath, cfg); } catch { /* ignore */ }
  const record = { ts: new Date().toISOString(), ...entry };
  const line = JSON.stringify(record) + '\n';
  try {
    fs.appendFileSync(logPath, line, { encoding: 'utf8' });
    _auditState.writesSinceCheck += 1;
    if (_auditState.logPath === logPath) {
      if (!_auditState.oldestTs) _auditState.oldestTs = record.ts;
      _auditState.size = (typeof _auditState.size === 'number' ? _auditState.size : 0) + Buffer.byteLength(line, 'utf8');
    }
    return { attempted: true, logged: true };
  } catch { return { attempted: true, logged: false }; }
}

/** 兼容入口：追加一行 JSONL 审计日志（true=已写入）。 */
function appendAudit(entry) { return auditWrite(entry).logged; }

/**
 * 把审计结果挂到工具返回体：auditLogged（写成功/失败）+ auditRotated / auditPrevious（轮转播报一次）。
 */
function finalizeAudit(out, outcomes) {
  if (!out || typeof out !== 'object') return out;
  const list = (Array.isArray(outcomes) ? outcomes : [outcomes]).filter(Boolean);
  if (list.some((o) => o.attempted)) {
    out.auditLogged = list.every((o) => !o.attempted || o.logged === true);
  }
  if (_auditState.pendingRotation) {
    out.auditRotated = true;
    out.auditPrevious = _auditState.pendingRotation.previous;
    _auditState.pendingRotation = null;
  }
  return out;
}

const DEVICE_NAMES = /^(NUL|CON|PRN|AUX|COM[1-9]|LPT[1-9])(\..*)?$/i;

/** 设备路径阻断：在 realpath 之前按字面路径判定（大小写不敏感）。 */
function isDevicePath(p) {
  const s = String(p == null ? '' : p);
  if (/^\/dev(\/|$)/i.test(s)) return true;
  if (/^\\\\\.\\/.test(s)) return true;
  const parts = s.replace(/\//g, '\\').split('\\').filter((x) => x.length > 0);
  return parts.some((seg) => DEVICE_NAMES.test(seg));
}

/** realpath 解析：存在则取真实路径；不存在则取最近存在父目录的真实路径再拼回剩余段；解析失败直接抛错（不回退到词法判断）。 */
async function realPathOf(p) {
  const abs = path.resolve(p);
  let cur = abs;
  const tail = [];
  for (let i = 0; i < 64; i++) {
    try {
      const real = await fsp.realpath(cur);
      return tail.length ? path.join(real, ...tail) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) break;
      tail.unshift(path.basename(cur));
      cur = parent;
    }
  }
  throw new Error(`无法解析真实路径：${toPosix(abs)}`);
}

/** 判断 target 是否位于 root 之内：一律用 path.relative（绝不用 startswith，避免 C:\\Data2 误判）。 */
function isWithinRoot(root, target) {
  const rel = path.relative(root, target);
  if (rel === '') return true;
  if (rel.startsWith('..')) return false;
  if (path.isAbsolute(rel)) return false;
  return true;
}

async function writeRootPaths() {
  if (_writeRootsCache) return _writeRootsCache;
  const out = [];
  for (const r of loadConfig().writeRoots) {
    const abs = path.resolve(r);
    try { out.push(await fsp.realpath(abs)); } catch { out.push(abs); }
  }
  _writeRootsCache = out;
  return out;
}

function isSensitiveRule(rule) {
  const d = rule.deny || [];
  return d.includes('read') || d.includes('list');
}

/**
 * 统一路径判定：设备路径 → 写根 → 敏感规则 → 其它保护规则。
 * action: read / list / write / edit / trash / move；opts.write=true 表示这是写类动作，目标必须在 writeRoots 内。
 */
/* ------------------ B：空目录放行（仅树形规则 + 仅 trash） ------------------
 * 语义：命中的规则若是「树形规则」（scope=directory 且至少一条 pattern 以双星加斜杠结尾，例如
 *   R3（node_modules 及其内部）、R4（.git）、R9（.ssh）、R10（.aws）这类「保护整棵树」的规则），
 *   且本次动作是 trash、目标目录**为空** → 放行（继续判定下一条规则），并留下 waived 痕迹。
 * 不放行：① 动作不是 trash；② 目标不是目录；③ 目录非空；④ 命中规则不是树形规则
 *   （字面路径规则——例如你自己加的「某目录本身不可删/移」——意图就是「目录本身不可删/移」，照旧拒绝）。
 * TOCTOU：判空紧贴操作执行前（guardPath 在真正 I/O 之前调用），但 statSync/readdirSync 与随后的
 *   trash（把目录改名移入回收站）之间仍存在极小窗口，且此处无法持锁；因此判空一律 fail-closed——
 *   任何异常（不存在 / 无权限 / 不是目录）都按“非空”处理，仍返回拒绝。
 */
function isEmptyDirectoryStrict(real) {
  try {
    const st = fs.statSync(real);
    if (!st.isDirectory()) return false;
    return fs.readdirSync(real).length === 0;
  } catch {
    return false;
  }
}

/** 树形规则判定：只有 scope=directory 且存在以 /** 结尾的 pattern 的规则才参与空目录放行。 */
function isTreeRule(rule) {
  if (!rule || rule.scope !== 'directory') return false;
  return rulePatternList(rule).some((p) => typeof p === 'string' && p.endsWith('/**'));
}

/** 树形规则 + trash + 空目录 → 返回 waiver 记录（写进结果与审计）；否则返回 null。 */
function emptyDirWaiver(rule, action, real) {
  if (action !== 'trash') return null;
  if (!isTreeRule(rule)) return null;
  if (!isEmptyDirectoryStrict(real)) return null;
  return {
    ruleId: rule.id,
    rule_reason: rule.reason,
    waived_rule: rule.id,
    waived_reason: 'empty_directory',
  };
}

/* ------------------ C：祖先包含推理（受保护子树 → 父目录递归删除一律拒绝） ------------------
 * 背景（已确认的洞）：A 只让受保护目录「自身」不可删；它的「上一级」仍可被递归删除，
 *   例如 trash C:/work/my-project（recursive）会连带删掉整棵 node_modules，而 R3 完全不命中。
 * 语义（主人拍板，不得放宽）：
 *   ① 递归删除 / move 搬走一个目录时，只要子树里存在「命中树形保护规则」的路径 → 一律拒绝；
 *   ② 绝不因为「那个受保护子树是空的」而放行父目录——删父目录时未必知道其下有受保护内容；
 *      正确姿势是「两道程序」：先单独删掉其中的受保护目录（B 的空目录放行允许），再删父级；
 *   ③ 因此本判定只看「子树里有没有命中」，不区分该路径是否为空目录。
 * 参与判定的规则：scope=directory 且至少一条 pattern 以 双星加斜杠 结尾（R3/R4/R9/R10 这类树形规则）；
 *   它们的 patterns 里那条不带双星后缀的（例如 node_modules 本身那条）让「受保护目录自身」也算命中。
 *   非树形规则（R5/R8/R11/R12 这类按文件名匹配的，以及你自己加的字面路径规则）不参与：它们保护的是特定文件/目录本身，不是整棵树。
 * 预算与 fail-closed：条目上限 50000、深度上限 32；超预算 / 读目录失败 → 一律拒绝，绝不放行。
 * 性能：只对「目录 + 递归删除 / move 整树」调用；命中即停，不再进入命中的子树；不跟随符号链接。
 */
const PROTECTED_CONTENT_LIMITS = { maxEntries: 50000, maxDepth: 32 };

/** 参与子树判定的规则：树形规则 + 其 deny 含本次动作。 */
function treeRulesForAction(action) {
  return loadRules().filter((r) => isTreeRule(r) && (r.deny || []).includes(action));
}

/**
 * 扫描 realRoot 的子树，找第一条命中树形规则的路径。
 * 返回 { hit:{relativePath,ruleId,ruleReason,protectedPath}, scanned } 或 { hit:null, scanned, overBudget:true, budget, limit, detail }。
 * 预算超限 / 读目录失败一律 overBudget（调用方按 fail-closed 拒绝）。
 */
function protectedContentInside(realRoot, action, limits = PROTECTED_CONTENT_LIMITS) {
  const rules = treeRulesForAction(action);
  if (rules.length === 0) return { hit: null, scanned: 0 };
  const rootPosix = toPosix(realRoot);
  let scanned = 0;
  const stack = [{ dir: realRoot, depth: 0, rel: '' }];
  while (stack.length > 0) {
    const cur = stack.pop();
    let entries;
    try { entries = fs.readdirSync(cur.dir, { withFileTypes: true }); }
    catch (e) {
      return {
        hit: null, scanned, overBudget: true, budget: 'readdir_error', limit: null,
        detail: `${cur.rel || '.'}: ${e && e.message ? e.message : String(e)}`,
      };
    }
    for (const ent of entries) {
      scanned += 1;
      if (scanned > limits.maxEntries) {
        return { hit: null, scanned, overBudget: true, budget: 'entries', limit: limits.maxEntries };
      }
      const rel = cur.rel ? `${cur.rel}/${ent.name}` : ent.name;
      const childPosix = `${rootPosix}/${rel}`;
      for (const rule of rules) {
        if (!ruleMatches(rule, childPosix)) continue;
        // 命中即停：受保护子树的内部无需再扫
        return { hit: { relativePath: rel, ruleId: rule.id, ruleReason: rule.reason, protectedPath: childPosix }, scanned };
      }
      if (ent.isDirectory() && !ent.isSymbolicLink()) {
        if (cur.depth + 1 > limits.maxDepth) {
          return { hit: null, scanned, overBudget: true, budget: 'depth', limit: limits.maxDepth, detail: rel };
        }
        stack.push({ dir: path.join(cur.dir, ent.name), depth: cur.depth + 1, rel });
      }
    }
  }
  return { hit: null, scanned };
}

/** C 的拒绝体：独立错误码 protected_content_inside（与「目标本身受保护」的 protected_rule_denied 区分）。 */
function protectedContentReason(scan) {
  if (scan.overBudget) {
    const why = scan.budget === 'depth'
      ? `目录深度超过 ${scan.limit} 层`
      : scan.budget === 'entries'
        ? `条目数超过 ${scan.limit} 条`
        : `读取子目录失败（${scan.detail}）`;
    return {
      ok: false,
      error: 'protected_content_inside',
      denied_by: 'protected_content_inside',
      reason: `无法确认目标目录的子树内容（${why}），按 fail-closed 拒绝`,
      next_step: '请分步处理：先确认并逐个删除其中的子目录，再删除本目录；或由用户手工处理',
      budget_exceeded: scan.budget,
      scanned_entries: scan.scanned,
      scan_budget: { maxEntries: PROTECTED_CONTENT_LIMITS.maxEntries, maxDepth: PROTECTED_CONTENT_LIMITS.maxDepth },
    };
  }
  const hit = scan.hit;
  return {
    ok: false,
    error: 'protected_content_inside',
    denied_by: 'protected_content_inside',
    ruleId: hit.ruleId,
    protected_content: { relative_path: hit.relativePath, ruleId: hit.ruleId, rule_reason: hit.ruleReason },
    reason: `目标目录的子树内含受保护内容（规则 ${hit.ruleId}：${hit.ruleReason}）：${hit.relativePath}`,
    next_step: `先单独删除其中的 ${hit.relativePath}（若为空目录可直接删），再删除本目录`,
    scanned_entries: scan.scanned,
  };
}

/** 递归删 / move 整树前的守卫：目录且整棵会消失时才扫子树；命中或超预算 → 返回拒绝体，否则 null。 */
function guardProtectedContentInside(realDir, action) {
  const scan = protectedContentInside(realDir, action);
  if (scan.hit || scan.overBudget) return protectedContentReason(scan);
  return null;
}

async function guardPath(target, action, opts = {}) {
  const abs = path.resolve(target);
  if (isDevicePath(abs)) {
    return { ok: false, error: 'device_path', denied_by: 'device_path', reason: `拒绝访问设备路径：${toPosix(abs)}` };
  }
  let real;
  try { real = await realPathOf(abs); }
  catch (e) { return { ok: false, error: 'io_error', reason: e && e.message ? e.message : String(e) }; }
  if (opts.write) {
    const roots = await writeRootPaths();
    if (!roots.some((r) => isWithinRoot(r, real))) {
      return {
        ok: false,
        error: 'write_root_denied',
        denied_by: 'write_root_denied',
        reason: '路径不在允许写入的根目录内',
        writeRoots: loadConfig().writeRoots,
      };
    }
  }
  const posixReal = toPosix(real);
  await ensureConfigFreshAsync();
  const rules = loadRules();
  const waived = [];
  for (const rule of rules) {
    if (!isSensitiveRule(rule)) continue;
    if (!(rule.deny || []).includes(action)) continue;
    if (!ruleMatches(rule, posixReal)) continue;
    // B：敏感类树形规则（R9/R10）命中但目标是空目录 + trash → 放行并留痕（空目录无内容可泄露）
    const w = emptyDirWaiver(rule, action, real);
    if (w) { waived.push(w); continue; }
    return { ok: false, error: 'sensitive_denied', denied_by: 'sensitive_denied', ruleId: rule.id, reason: rule.reason };
  }
  for (const rule of rules) {
    if (isSensitiveRule(rule)) continue;
    if (!(rule.deny || []).includes(action)) continue;
    // 「仅作为 move 源时禁止」的规则：move 的目标侧不受影响（仍可移入这些目录）
    if (action === 'move' && rule.denyMoveAsSourceOnly === true && opts.side !== 'src') continue;
    if (!ruleMatches(rule, posixReal)) continue;
    // B：树形规则命中 + trash + 空目录 → 放行（继续看下一条规则，而不是直接放行整个操作）
    const w = emptyDirWaiver(rule, action, real);
    if (w) { waived.push(w); continue; }
    return { ok: false, error: 'protected_rule_denied', denied_by: 'protected_rule_denied', ruleId: rule.id, reason: rule.reason };
  }
  return waived.length > 0 ? { ok: true, abs, real, waived } : { ok: true, abs, real };
}

/** 身份确认：真正 I/O 之前重新 stat，比较 dev/ino。 */
async function verifyIdentity(target, snapshot) {
  if (!snapshot) return { ok: true };
  try {
    const st = await fsp.stat(target);
    if (st.dev !== snapshot.dev || st.ino !== snapshot.ino) {
      return { ok: false, error: 'identity_changed', reason: '目标在校验后发生了变化，请重试' };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: 'not_found', reason: '目标已不存在' };
  }
}

/* --------------------------- 保护规则 --------------------------- */

function loadRules() {
  return loadConfig().rules;
}

function globToRegex(pattern, dirScope) {
  let p = String(pattern);
  let suffix = '';
  if (p.endsWith('/**')) { suffix = '(?:/.*)?'; p = p.slice(0, -3); }
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*' && p[i + 1] === '*') {
      if (p[i + 2] === '/') { re += '(?:.*/)?'; i += 2; }
      else { re += '.*'; i += 1; }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if ('\\^$.|+()[]{}'.includes(c)) re += '\\' + c;
    else re += c;
  }
  void dirScope;
  return new RegExp('^' + re + suffix + '$', 'i');
}

const _regexCache = new Map();
/**
 * 通配模式（含 * 或 ?）的匹配：沿用既有通配语义。
 * scope=directory 且模式以 /** 结尾时，只覆盖该目录内部的项；其余情况按模式字面覆盖。
 */
function wildcardRegex(pattern, scope) {
  const key = `w::${scope}::${pattern}`;
  if (_regexCache.has(key)) return _regexCache.get(key);
  let re;
  if (scope === 'directory' && pattern.endsWith('/**')) {
    const base = pattern.replace(/\/\*\*$/, '');
    const src = globToRegex(base, true).source.replace(/^\^/, '').replace(/\$$/, '');
    re = new RegExp('^' + src + '/.+$', 'i');
  } else {
    re = globToRegex(pattern, scope === 'directory');
  }
  _regexCache.set(key, re);
  return re;
}

/** 路径规范化：统一正斜杠、去尾部斜杠（大小写不敏感比较）。 */
function normalizePathKey(p) {
  let t = String(p).replace(/\\/g, '/');
  while (t.length > 1 && t.endsWith('/')) t = t.slice(0, -1);
  return t.toLowerCase();
}

/**
 * 统一的规则匹配语义（无 per-rule 开关）：
 * 1) 普通路径（不含通配符）→ 精确匹配该路径本身：目录规则只保护目录自身，文件规则只保护该文件；
 * 2) 通配模式（含 * / ?）→ 按模式字面覆盖其匹配到的所有路径。
 */
function rulePatternList(rule) {
  const list = Array.isArray(rule.patterns) ? rule.patterns : null;
  if (list && list.length > 0) return list;
  return [rule.pattern];
}

function ruleMatches(rule, targetPosix) {
  for (const p of rulePatternList(rule)) {
    if (p === undefined || p === null) continue;
    const pat = String(p);
    if (!pat) continue;
    if (pat.includes('*') || pat.includes('?')) {
      if (wildcardRegex(pat, rule.scope).test(targetPosix)) return true;
    } else if (normalizePathKey(pat) === normalizePathKey(targetPosix)) {
      return true;
    }
  }
  return false;
}

/** 兼容入口：返回命中的规则或 null。 */
function checkProtected(targetPath, action) {
  const p = toPosix(path.resolve(targetPath));
  for (const rule of loadRules()) {
    if (!(rule.deny || []).includes(action)) continue;
    if (ruleMatches(rule, p)) return rule;
  }
  return null;
}

function protectedMessage(rule) {
  return `该路径受保护（规则 ${rule.id}：${rule.reason}），确需处理请由用户手工完成`;
}

/* ------------------------------ 工具实现 ------------------------------ */

/**
 * 纯动作：把 realPath 送进 Windows 回收站（可恢复）。**不做** guardPath / protected.json 检查——
 * 调用方（trash / move 的覆盖分支）自己已经检查过了。只负责「动作 + 失败如实上报」。
 * 失败时目标保持原样；**绝不** fallback 到 fsp.rm（那等于悄悄永久删除，违背「删除一律进回收站」）。
 * @returns {Promise<{ok:true,action:'sent-to-recycle-bin'}|{ok:false,error:'io_error',reason:string}>}
 */
async function sendToRecycleBin(realPath, isDirectory) {
  const ps = [
    'Add-Type -AssemblyName Microsoft.VisualBasic;',
    'if ($env:FOP_ISDIR -eq "1") {',
    '[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($env:FOP_PATH,[Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,[Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)',
    '} else {',
    '[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($env:FOP_PATH,[Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,[Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)',
    '}',
  ].join(' ');
  let r;
  try {
    r = await runCmd('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      env: { FOP_PATH: realPath, FOP_ISDIR: isDirectory === true ? '1' : '0' },
    });
  } catch (e) {
    return { ok: false, error: 'io_error', reason: `回收站操作失败：${e && e.message ? e.message : String(e)}` };
  }
  // 双重确认：退出码 0 且路径确实已不存在；只满足其一时仍是「没删掉」，不能算成功。
  if (r.code === 0 && !fs.existsSync(realPath)) {
    return { ok: true, action: 'sent-to-recycle-bin' };
  }
  const detail = (r.stderr || r.stdout || '').trim().slice(0, 800) || '目标仍存在';
  return { ok: false, error: 'io_error', reason: `回收站操作失败（exit ${r.code}）：${detail}` };
}

/**
 * 覆盖前处置目标：toRecycleBin === true → 送回收站（失败即放弃覆盖）；false → 直接永久删除（降级 / 强制永久删）。
 * 只负责「动作 + 失败如实上报」；调用方（move 的覆盖分支）已做过 guardPath / 受保护内容检查。
 * @returns {Promise<{ok:true}|{ok:false,reason:string}>}
 */
async function disposeOverwriteTarget(realPath, isDirectory, toRecycleBin) {
  if (toRecycleBin === true) {
    const rb = await sendToRecycleBin(realPath, isDirectory);
    return rb.ok === true ? { ok: true } : { ok: false, reason: rb.reason || '送回收站失败' };
  }
  try {
    await fsp.rm(realPath, { recursive: isDirectory === true, force: false });
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `永久删除失败：${e && e.message ? e.message : String(e)}` };
  }
}

/** 统计 <卷>:\$Recycle.Bin\ 下所有 SID 子目录的 $I* 文件总数（权限不足的 SID 目录跳过，不整体失败）。 */
async function recycleBinIndexCount(root) {
  const rbRoot = path.join(root, '$Recycle.Bin');
  const out = { root: rbRoot, total: 0, dirsReadable: 0, dirsSkipped: 0 };
  let entries;
  try { entries = await fsp.readdir(rbRoot, { withFileTypes: true }); }
  catch (e) { out.error = `无法枚举 ${rbRoot}：${e && e.message ? e.message : String(e)}`; return out; }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    try {
      const names = await fsp.readdir(path.join(rbRoot, ent.name));
      out.dirsReadable += 1;
      for (const n of names) if (n.startsWith('$I')) out.total += 1;
    } catch { out.dirsSkipped += 1; }  // 某个 SID 目录权限不足 → 跳过，不影响整体判定
  }
  return out;
}

/**
 * 回收站能力探测（懒加载，进程内只真探一次）：在 TMP_ROOT 建 1 字节探针 → 记录 $I* 数量 →
 * 用底层原始动作（不带能力检查，避免递归）把探针送回收站 → 再数一次。after > before 才算「能进回收站」。
 * 探测本身绝不抛异常：任何异常都按「不可用」处理（fail-closed），原因留在 RECYCLE_BIN_DETAIL 里。
 * 探针若还在（送不进去）用 fsp.rm 清掉——那是我们自己造的垃圾，允许永久删。
 * 测试钩子：FOP_TEST_RB_CAP=0 → 强制返回 false（不缓存，便于自测模拟低完整性进程）。
 */
async function ensureRecycleBinCapability() {
  if (process.env.FOP_TEST_RB_CAP === '0') {
    RECYCLE_BIN_DETAIL = { forced: true, reason: 'FOP_TEST_RB_CAP=0（测试钩子强制能力为 false）' };
    return false;
  }
  if (RECYCLE_BIN_OK !== null) return RECYCLE_BIN_OK;
  const detail = {};
  let probePath = null;
  try {
    ensureTmp();
    probePath = path.join(TMP_ROOT, `.rb-probe-${process.pid}-${Date.now()}`);
    fs.writeFileSync(probePath, 'x');
    RECYCLE_BIN_PROBES += 1;
    const root = path.parse(probePath).root;
    const before = await recycleBinIndexCount(root);
    detail.probePath = toPosix(probePath);
    detail.recycleBinRoot = toPosix(before.root);
    detail.before = before.total;
    detail.dirsReadable = before.dirsReadable;
    detail.dirsSkipped = before.dirsSkipped;
    if (before.error) detail.enumerateError = before.error;
    const sent = await sendToRecycleBin(probePath, false);
    const after = await recycleBinIndexCount(root);
    detail.after = after.total;
    detail.sentOk = sent.ok === true;
    if (!sent.ok) detail.sendError = sent.reason;
    RECYCLE_BIN_OK = after.total > before.total;
    if (RECYCLE_BIN_OK !== true) {
      detail.reason = `回收站 $I* 数量未增加（before ${before.total} / after ${after.total}，sendToRecycleBin.ok=${sent.ok === true}）：本进程可能无法写入回收站（低完整性 / 可写域受限），SHFileOperation 会静默永久删除 → 按不可用处理`;
    }
  } catch (e) {
    RECYCLE_BIN_OK = false;
    detail.reason = `探测异常（按不可用处理）：${e && e.message ? e.message : String(e)}`;
  } finally {
    if (probePath && fs.existsSync(probePath)) {
      try { await fsp.rm(probePath, { force: true }); } catch { /* 探测垃圾清不掉也不改判定 */ }
    }
    RECYCLE_BIN_DETAIL = detail;
  }
  return RECYCLE_BIN_OK;
}

/** 只读观察探测结果（不触发探测）：{ ok, cached, probes, detail }。 */
function recycleBinCapability() {
  return { ok: RECYCLE_BIN_OK, cached: RECYCLE_BIN_OK !== null, probes: RECYCLE_BIN_PROBES, detail: RECYCLE_BIN_DETAIL };
}

async function toolTrash(args) {
  const paths = Array.isArray(args.paths) ? args.paths : [];
  if (paths.length === 0) {
    const out0 = { ok: false, error: 'invalid_args', reason: 'paths 不能为空' };
    return finalizeAudit(out0, [auditWrite({ action: 'trash', paths: [], ok: false, error: 'invalid_args' })]);
  }
  const limit = loadConfig().batchLimits.trash;
  if (paths.length > limit) {
    const out0 = { ok: false, error: 'batch_limit', limit, given: paths.length };
    return finalizeAudit(out0, [auditWrite({ action: 'trash', paths: [], ok: false, error: 'batch_limit' })]);
  }
  const recursive = args.recursive === true;
  const results = [];
  const rbGate = { checked: false, ok: true, blocked: [] }; // 回收站能力闸：整批只判定一次
  let topError = null;
  for (const raw of paths) {
    let target;
    try { target = resolvePath(raw); } catch (e) { results.push({ path: String(raw), ok: false, error: 'invalid_args', reason: e.message }); continue; }
    const g = await guardPath(target, 'trash', { write: true });
    if (!g.ok) {
      results.push({ path: toPosix(target), ...g });
      if (!topError) topError = g;
      continue;
    }
    let st;
    try { st = fs.statSync(g.real); } catch (e) { results.push({ path: toPosix(target), ok: false, error: 'not_found', reason: `路径不存在：${toPosix(target)}` }); continue; }
    const id = await verifyIdentity(g.real, st);
    if (!id.ok) { results.push({ path: toPosix(target), ...id }); if (!topError) topError = id; continue; }
    if (st.isDirectory() && !recursive) {
      results.push({ path: toPosix(target), ok: false, error: 'invalid_args', reason: '目录删除需要 recursive=true' });
      continue;
    }
    // C：递归删除目录前先确认子树内没有受保护内容（即使其中只有空的 node_modules，也不放行父目录）
    if (st.isDirectory() && recursive) {
      const c = guardProtectedContentInside(g.real, 'trash');
      if (c) { results.push({ path: toPosix(target), ...c }); if (!topError) topError = c; continue; }
    }
    // 能力闸（懒加载探测，整批只判一次）——三态：
    //   ① 能力可用 → 送回收站（recyclable:true）；
    //   ② 能力不可用（默认）→ **降级**：直接永久删除，并如实标注 action:'deleted-permanently' / recyclable:false / warning；
    //   ③ 能力不可用 + FOP_REQUIRE_RECYCLE_BIN=1（严格模式）→ 整批拒绝 recycle_bin_unavailable（不逐条堆原因）。
    // 位置在 guardPath / 受保护内容检查之后：受保护文件仍优先报「受保护」，不会先报「回收站不可用」。
    // FOP_ALLOW_PERMANENT_DELETE=1 → 强制永久删（跳过回收站，调用方已明确表态，不打 warning）。
    if (!rbGate.checked) {
      rbGate.checked = true;
      rbGate.forcePermanent = allowPermanentDelete();
      rbGate.strict = requireRecycleBin();
      rbGate.cap = rbGate.forcePermanent ? true : (await ensureRecycleBinCapability()) === true;
      rbGate.ok = rbGate.forcePermanent || rbGate.cap === true || rbGate.strict !== true;
    }
    if (rbGate.ok !== true) {
      rbGate.blocked.push(toPosix(target));
      continue;
    }
    const waivedHit = Array.isArray(g.waived) && g.waived.length > 0 ? g.waived : null;
    const waivedFields = waivedHit ? { waived_rule: waivedHit.map((w) => w.ruleId).join(','), waived_reason: 'empty_directory' } : {};
    // 强制永久删 / 降级永久删：都不再白 spawn 一次 sendToRecycleBin（能力不可用时那要花几百毫秒）。
    if (rbGate.forcePermanent || rbGate.cap !== true) {
      try {
        await fsp.rm(g.real, { recursive: st.isDirectory(), force: false });
        results.push({
          path: toPosix(target),
          ok: true,
          action: 'deleted-permanently',
          recyclable: false,
          type: st.isDirectory() ? 'directory' : 'file',
          ...(rbGate.forcePermanent ? { permanentDelete: true } : { warning: DEGRADED_RB_WARNING }),
          ...waivedFields,
        });
      } catch (e2) {
        results.push({ path: toPosix(target), ok: false, error: 'io_error', reason: `永久删除失败：${e2 && e2.message ? e2.message : String(e2)}`, recyclable: false });
      }
      continue;
    }
    // 底层动作复用 sendToRecycleBin：trash 的对外行为（返回结构 / 审计 / 错误码）保持不变。
    const r = await sendToRecycleBin(g.real, st.isDirectory());
    if (r.ok) {
      results.push({
        path: toPosix(target),
        ok: true,
        action: 'sent-to-recycle-bin',
        recyclable: true,
        type: st.isDirectory() ? 'directory' : 'file',
        ...waivedFields,
      });
    } else if (allowPermanentDelete()) {
      // 逃生舱：显式允许永久删除 → 回收站送不进去时退回直接删除（调用方从 permanentDelete 得知）
      try {
        await fsp.rm(g.real, { recursive: st.isDirectory(), force: false });
        results.push({
          path: toPosix(target),
          ok: true,
          action: 'deleted-permanently',
          type: st.isDirectory() ? 'directory' : 'file',
          permanentDelete: true,
          ...waivedFields,
        });
      } catch (e2) {
        results.push({ path: toPosix(target), ok: false, error: 'io_error', reason: `永久删除失败：${e2 && e2.message ? e2.message : String(e2)}` });
      }
    } else {
      results.push({ path: toPosix(target), ok: false, error: 'io_error', reason: r.reason || '回收站操作失败' });
    }
  }
  // 能力闸整批失败：整批只返回一条错误（不逐条堆原因），审计留一条痕迹。
  if (rbGate.blocked.length > 0) {
    const blockedOut = {
      ok: false,
      error: 'recycle_bin_unavailable',
      reason: `本进程无法将文件送入回收站（可能受沙箱权限限制），且已设 FOP_REQUIRE_RECYCLE_BIN=1（严格模式）→ 拒绝删除，未删除任何文件。${STRICT_RB_HINT}`,
      succeeded: 0,
      failed: rbGate.blocked.length,
      paths: rbGate.blocked,
      ...(rbGate.blocked.length === 1 ? { path: rbGate.blocked[0] } : {}),
    };
    return finalizeAudit(blockedOut, [auditWrite({ action: 'trash', paths: rbGate.blocked, ok: false, error: 'recycle_bin_unavailable' })]);
  }
  // 顶层 ok 反映聚合结果：只有全部条目成功才为 true；逐条状态仍看 results[]。
  const succeeded = results.reduce((n, r) => n + (r.ok === true ? 1 : 0), 0);
  const failed = results.length - succeeded;
  const firstFailure = results.find((r) => r.ok !== true) || null;
  const out = { ok: failed === 0, succeeded, failed, results };
  // 降级标注（如实汇报、绝不谎报）：整批只要有一条走了「能力不可用 → 永久删」，顶层就带一条 warning。
  if (results.some((r) => r.ok === true && r.action === 'deleted-permanently' && r.permanentDelete !== true)) {
    out.warning = DEGRADED_RB_WARNING;
  }
  if (topError) {
    out.error = topError.error;
    if (topError.denied_by) out.denied_by = topError.denied_by;
    if (topError.ruleId) out.ruleId = topError.ruleId;
    if (topError.reason) out.reason = topError.reason;
    if (topError.writeRoots) out.writeRoots = topError.writeRoots;
  } else if (firstFailure && firstFailure.error) {
    out.error = firstFailure.error;
    if (firstFailure.reason) out.reason = firstFailure.reason;
  }
  // 审计：成功记一条；失败逐条记（ok:false + error + ruleId）——被拒 / 失败也必须留痕。
  const outcomes = [];
  const okResults = results.filter((r) => r.ok === true);
  // B：因空目录放行而成功的条目单独记一条审计（ok:true + waived_rule/waived_reason，便于 grep）；
  // 其余成功条目与失败条目的审计格式保持不变。
  const plainOkPaths = okResults.filter((r) => !r.waived_rule).map((r) => r.path);
  if (plainOkPaths.length > 0) {
    outcomes.push(auditWrite({ action: 'trash', paths: plainOkPaths, ok: true }));
  }
  for (const r of okResults.filter((x) => x.waived_rule)) {
    outcomes.push(auditWrite({
      action: 'trash',
      paths: [r.path],
      ok: true,
      waived_rule: r.waived_rule,
      waived_reason: r.waived_reason || 'empty_directory',
    }));
  }
  for (const r of results) {
    if (r.ok === true) continue;
    outcomes.push(auditWrite({
      action: 'trash',
      paths: [r.path],
      ok: false,
      error: r.error || 'io_error',
      ...(r.ruleId ? { ruleId: r.ruleId } : {}),
      ...(r.protected_content ? { protected_content: r.protected_content } : {}),
      ...(r.reason ? { reason: String(r.reason).slice(0, 200) } : {}),
    }));
  }
  return finalizeAudit(out, outcomes);
}

/** 闸 C：判定 realDst 是否为 realSrc 自身 / 源的后代 / 源的祖先（自噬类 move 一律拒绝）。返回人话原因或 null。 */
function selfNestingReason(realSrc, realDst) {
  const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const a = norm(realSrc);
  const b = norm(realDst);
  const inside = (child, parent) => {
    const rel = path.relative(parent, child);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  };
  if (a === b) return `目标与源是同一路径：${toPosix(realDst)}`;
  if (inside(b, a)) return `目标在源目录之内（自噬）：${toPosix(realDst)}`;
  if (inside(a, b)) return `源在目标目录之内：${toPosix(realSrc)}`;
  return null;
}

async function moveOne(rawSrc, rawDst, mode, overwrite = false) {
  const t0 = Date.now();
  let src;
  let dst;
  try { src = resolvePath(rawSrc); } catch (e) { return { ok: false, error: 'invalid_args', reason: e.message }; }
  try { dst = resolvePath(rawDst); } catch (e) { return { ok: false, error: 'invalid_args', reason: e.message }; }
  // mode=copy：源不限路径，目标必须在写根内；mode=move：源与目标都必须在写根内。
  const srcGuard = await guardPath(src, 'move', { write: mode !== 'copy', side: mode === 'copy' ? 'copy' : 'src' });
  if (!srcGuard.ok) return { ok: false, ...srcGuard, side: 'src', src: toPosix(src) };
  const dstGuard = await guardPath(dst, 'move', { write: true, side: 'dst' });
  if (!dstGuard.ok) return { ok: false, ...dstGuard, side: 'dst', dst: toPosix(dst) };
  const realSrc = srcGuard.real;
  const realDst = dstGuard.real;
  let st;
  try { st = fs.statSync(realSrc); } catch { return { ok: false, error: 'not_found', reason: `源路径不存在：${toPosix(src)}` }; }
  const dstExists = fs.existsSync(realDst);
  let dstStat = null;
  if (dstExists) {
    try { dstStat = fs.statSync(realDst); }
    catch (e) { return { ok: false, error: 'io_error', reason: `目标状态无法读取：${e && e.message ? e.message : String(e)}`, src: toPosix(src), dst: toPosix(dst) }; }
  }
  // 闸 C：目标不得是源自身或其祖先/后代（零副作用的路径关系判定，早于任何破坏性动作）
  if (overwrite === true) {
    const why = selfNestingReason(realSrc, realDst);
    if (why) return { ok: false, error: 'invalid_args', reason: `拒绝覆盖：${why}`, src: toPosix(src), dst: toPosix(dst) };
  }
  // 未显式传 overwrite:true：目标已存在一律拒绝覆盖（保持原有安全语义，向后兼容）
  if (dstExists && overwrite !== true) return { ok: false, error: 'invalid_args', reason: `目标已存在，拒绝覆盖：${toPosix(dst)}` };
  // 闸 B：覆盖目录 = 整棵树被删掉（等价 trash 语义）→ 必须先查目标子树内的受保护内容
  if (dstExists && dstStat && dstStat.isDirectory()) {
    const c = guardProtectedContentInside(realDst, 'trash');
    if (c) return { ...c, side: 'dst', reason: '目标目录内含受保护内容，拒绝覆盖', dst: toPosix(dst) };
  }
  const willOverwrite = dstExists && overwrite === true;
  const allowPermanent = allowPermanentDelete();
  // 覆盖目标的处置三态（rbin：true = 送回收站；false = 永久删）：
  //   ① 能力可用 → 送回收站；② 能力不可用（默认）→ 降级永久删并如实标注（不谎报、不阻碍覆盖）；
  //   ③ 能力不可用 + FOP_REQUIRE_RECYCLE_BIN=1（严格模式）→ 拒绝覆盖（源与目标均保持原样）。
  // FOP_ALLOW_PERMANENT_DELETE=1（强制永久删）→ 不探测能力，直接永久删目标。
  let rbin = null;
  if (willOverwrite) {
    if (allowPermanent) {
      rbin = false;
    } else if ((await ensureRecycleBinCapability()) === true) {
      rbin = true;
    } else if (requireRecycleBin()) {
      return {
        ok: false,
        error: 'recycle_bin_unavailable',
        reason: `本进程无法将目标送入回收站（可能受沙箱权限限制），且已设 FOP_REQUIRE_RECYCLE_BIN=1（严格模式）→ 已放弃覆盖，源与目标均保持原样。${STRICT_RB_HINT}`,
        src: toPosix(src),
        dst: toPosix(dst),
      };
    } else {
      rbin = false;   // 降级：覆盖照常完成，目标改为永久删除（结果里如实标注）
    }
  }
  // 删除目标前记录其 sha256（仅文件；目录无单一哈希 → null）
  const overwrittenSha256 = willOverwrite && dstStat && dstStat.isFile() ? await sha256Path(realDst) : null;
  // C：mode=move 把整棵树搬走等同于删除 → 子树内有受保护内容同样拒绝（copy 不删源，不触发）
  if (mode === 'move' && st.isDirectory()) {
    const c = guardProtectedContentInside(realSrc, 'move');
    if (c) return { ...c, side: 'src', src: toPosix(src), dst: toPosix(dst) };
  }
  const srcRoot = path.parse(realSrc).root.toLowerCase();
  const dstRoot = path.parse(realDst).root.toLowerCase();
  // FOP_FORCE_CROSS=1 为测试钩子：强制走「复制 → SHA-256 校验 → 删除源」的跨卷分支。
  const crossVolume = srcRoot !== dstRoot || process.env.FOP_FORCE_CROSS === '1';
  const bytes = st.isFile() ? st.size : await dirSize(realSrc);
  const shaBefore = await sha256Path(realSrc);
  try {
    if (!crossVolume && mode === 'move') {
      const id = await verifyIdentity(realSrc, st);
      if (!id.ok) return { ok: false, ...id, src: toPosix(src), dst: toPosix(dst) };
      // 分支 1（同卷 move 走 rename）：rename 本身即原子移动，无法插临时路径，窗口已最小化；
      // rename 失败时源仍在，不会出现「源与目标都消失」。
      if (willOverwrite) {
        // 覆盖 = 先处置目标（rbin:true → 回收站；false → 永久删，降级/强制）；处置失败即放弃覆盖。
        const ov = await disposeOverwriteTarget(realDst, !!(dstStat && dstStat.isDirectory()), rbin === true);
        if (!ov.ok) {
          return { ok: false, error: 'io_error', reason: `目标处置失败：${rbin === true ? '送回收站失败' : '回收站不可用，降级永久删除失败'}（${ov.reason}），已放弃覆盖，源与目标均未改动`, src: toPosix(src), dst: toPosix(dst) };
        }
      }
      await fsp.rename(realSrc, realDst);
    } else if (willOverwrite) {
      // 分支 2（copy / 跨卷）：先复制到目标同目录的临时路径 → 校验 sha256 → 才删目标 → rename 落位。
      // 关键：目标只在临时副本校验通过之后才被删除；任何中途失败都清理临时路径并保持目标原样。
      const tmpPath = path.join(path.dirname(realDst), `.fop-ov-${process.pid}-${Date.now()}`);
      try {
        await fsp.cp(realSrc, tmpPath, { recursive: true, force: false, errorOnExist: true });
        const tmpSha = await sha256Path(tmpPath);
        if (tmpSha !== shaBefore) {
          return { ok: false, error: 'io_error', reason: `校验失败：临时副本 SHA-256 不一致（源 ${shaBefore} / 临时 ${tmpSha}），已保留源与目标`, src: toPosix(src), dst: toPosix(dst) };
        }
        // 目标只在临时副本校验通过后才处置（回收站 / 降级永久删）；处置不了就放弃覆盖（finally 清临时副本）。
        const ov = await disposeOverwriteTarget(realDst, !!(dstStat && dstStat.isDirectory()), rbin === true);
        if (!ov.ok) {
          return { ok: false, error: 'io_error', reason: `目标处置失败：${rbin === true ? '送回收站失败' : '回收站不可用，降级永久删除失败'}（${ov.reason}），已放弃覆盖，源与目标均未改动`, src: toPosix(src), dst: toPosix(dst) };
        }
        await fsp.rename(tmpPath, realDst);
      } finally {
        if (fs.existsSync(tmpPath)) {
          try { await fsp.rm(tmpPath, { recursive: true, force: true }); } catch { /* 清理失败不掩盖原错误 */ }
        }
      }
      if (mode === 'move') await fsp.rm(realSrc, { recursive: true, force: false });
    } else {
      await fsp.cp(realSrc, realDst, { recursive: true, force: false, errorOnExist: true });
      const shaAfter = await sha256Path(realDst);
      if (shaAfter !== shaBefore) {
        return { ok: false, error: 'io_error', reason: `校验失败：SHA-256 不一致（源 ${shaBefore} / 目标 ${shaAfter}），已保留源文件`, src: toPosix(src), dst: toPosix(dst) };
      }
      if (mode === 'move') await fsp.rm(realSrc, { recursive: true, force: false });
    }
  } catch (err) {
    return { ok: false, error: 'io_error', reason: `移动失败：${err && err.message ? err.message : String(err)}`, src: toPosix(src), dst: toPosix(dst) };
  }
  const shaAfter = await sha256Path(realDst);
  const result = {
    ok: true,
    src: toPosix(src),
    dst: toPosix(dst),
    mode,
    bytes,
    sha256: shaAfter,
    sha256Verified: shaAfter === shaBefore,
    crossVolume,
    elapsedMs: Date.now() - t0,
  };
  if (willOverwrite) {
    result.overwrote = true;
    result.overwrittenToRecycleBin = rbin === true;   // 如实标注：降级 / 强制永久删时为 false
    result.recyclable = rbin === true;
    result.overwrittenSha256 = overwrittenSha256;
    if (allowPermanent) result.permanentDelete = true;
    if (rbin !== true && !allowPermanent) result.warning = DEGRADED_RB_WARNING_TARGET;
  }
  return result;
}

async function toolMove(args) {
  const limit = loadConfig().batchLimits.move;
  const mode = args.mode === 'copy' ? 'copy' : 'move';
  const overwriteDefault = args.overwrite === true;
  const itemOverwrite = (v) => (v === undefined ? overwriteDefault : v === true); // 项级覆盖全局
  const pairs = Array.isArray(args.paths) && args.paths.length
    ? args.paths.map((p) => ({ src: p.src, dst: p.dst, mode: p.mode === 'copy' ? 'copy' : mode, overwrite: itemOverwrite(p.overwrite) }))
    : [{ src: args.src, dst: args.dst, mode, overwrite: overwriteDefault }];
  if (pairs.length > limit) return { ok: false, error: 'batch_limit', limit, given: pairs.length };
  if (pairs.length === 1) {
    const one = await moveOne(pairs[0].src, pairs[0].dst, pairs[0].mode, pairs[0].overwrite);
    if (one.ok === true) {
      const a = auditWrite({
        action: 'move',
        paths: [{ src: one.src, dst: one.dst }],
        mode: one.mode,
        ok: true,
        bytes: one.bytes,
        ...(one.overwrote === true ? { overwrote: true } : {}),
        ...(typeof one.overwrittenSha256 === 'string' ? { overwrittenSha256: one.overwrittenSha256 } : {}),
      });
      return finalizeAudit(one, [a]);
    }
    const a = auditWrite({
      action: 'move',
      paths: [{ src: one.src || pairs[0].src, dst: one.dst || pairs[0].dst }],
      mode: pairs[0].mode,
      ok: false,
      error: one.error || 'io_error',
      ...(one.ruleId ? { ruleId: one.ruleId } : {}),
      ...(one.protected_content ? { protected_content: one.protected_content } : {}),
      ...(one.reason ? { reason: String(one.reason).slice(0, 200) } : {}),
    });
    return finalizeAudit(one, [a]);
  }
  const results = [];
  for (const pr of pairs) results.push(await moveOne(pr.src, pr.dst, pr.mode, pr.overwrite));
  const out = { ok: results.every((r) => r.ok), results };
  const outcomes = [];
  const okResults = results.filter((r) => r.ok === true);
  if (okResults.length > 0) {
    const ovHashes = okResults.filter((r) => typeof r.overwrittenSha256 === 'string').map((r) => r.overwrittenSha256);
    outcomes.push(auditWrite({
      action: 'move',
      paths: okResults.map((r) => ({ src: r.src, dst: r.dst })),
      mode,
      ok: true,
      bytes: okResults.reduce((n, r) => n + (r.bytes || 0), 0),
      ...(okResults.some((r) => r.overwrote === true) ? { overwrote: true } : {}),
      ...(okResults.some((r) => r.overwrittenToRecycleBin === true) ? { overwrittenToRecycleBin: true } : {}),
      ...(ovHashes.length === 1 ? { overwrittenSha256: ovHashes[0] } : {}),
    }));
  }
  for (const r of results) {
    if (r.ok === true) continue;
    outcomes.push(auditWrite({
      action: 'move',
      paths: [{ src: r.src, dst: r.dst }],
      mode,
      ok: false,
      error: r.error || 'io_error',
      ...(r.ruleId ? { ruleId: r.ruleId } : {}),
      ...(r.protected_content ? { protected_content: r.protected_content } : {}),
      ...(r.reason ? { reason: String(r.reason).slice(0, 200) } : {}),
    }));
  }
  return finalizeAudit(out, outcomes);
}

function countOccurrences(hay, needle) {
  if (needle === '') return 0;
  let count = 0;
  let idx = hay.indexOf(needle);
  while (idx !== -1) { count++; idx = hay.indexOf(needle, idx + needle.length); }
  return count;
}

function lineOfOffset(text, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text[i] === '\n') line++;
  return line;
}

/* ------------------------- 编码编解码（保真用） ------------------------- */

const BOM_UTF8 = Buffer.from([0xef, 0xbb, 0xbf]);
const BOM_UTF16LE = Buffer.from([0xff, 0xfe]);
const BOM_UTF16BE = Buffer.from([0xfe, 0xff]);

function swap16(buf) {
  const sw = Buffer.from(buf);
  for (let i = 0; i + 1 < sw.length; i += 2) { const t = sw[i]; sw[i] = sw[i + 1]; sw[i + 1] = t; }
  return sw;
}

/** 按编码解码字节（不含 BOM 处理，调用方需先剥离 BOM）。 */
function decodeBytes(buf, enc) {
  if (enc === 'utf-8') return buf.toString('utf8');
  if (enc === 'utf-16le') return buf.toString('utf16le');
  if (enc === 'utf-16be') return swap16(buf).toString('utf16le');
  if (enc === 'gb18030' || enc === 'big5') {
    if (!iconv) throw new Error(`ICONV_UNAVAILABLE:${enc}`);
    return iconv.decode(buf, enc);
  }
  throw new Error(`不支持的编码：${enc}`);
}

/** 剥离 BOM（按编码判断），返回 { body, bom }。 */
function stripBom(buf, enc) {
  if (enc === 'utf-8' && buf.length >= 3 && buf.subarray(0, 3).equals(BOM_UTF8)) return { body: buf.subarray(3), bom: true };
  if (enc === 'utf-16le' && buf.length >= 2 && buf.subarray(0, 2).equals(BOM_UTF16LE)) return { body: buf.subarray(2), bom: true };
  if (enc === 'utf-16be' && buf.length >= 2 && buf.subarray(0, 2).equals(BOM_UTF16BE)) return { body: buf.subarray(2), bom: true };
  if (enc === 'gb18030' && buf.length >= 4 && buf.subarray(0, 4).equals(GB18030_BOM)) return { body: buf.subarray(4), bom: true };
  return { body: buf, bom: false };
}

/** 用指定编码编码文本，按需补回 BOM。 */
function encodeBytes(text, enc, bom) {
  let body;
  if (enc === 'utf-8') body = Buffer.from(text, 'utf8');
  else if (enc === 'utf-16le') body = Buffer.from(text, 'utf16le');
  else if (enc === 'utf-16be') body = swap16(Buffer.from(text, 'utf16le'));
  else {
    if (!iconv) throw new Error(`ICONV_UNAVAILABLE:${enc}`);
    body = iconv.encode(text, enc);
  }
  if (!bom) return body;
  const bomBuf = enc === 'utf-8' ? BOM_UTF8 : enc === 'utf-16le' ? BOM_UTF16LE : BOM_UTF16BE;
  return Buffer.concat([bomBuf, body]);
}

/** 完整缓冲（含 BOM）解码成文本，用于往返校验。 */
function decodeFull(buf, enc) {
  const { body } = stripBom(buf, enc);
  return decodeBytes(body, enc);
}

function unsupportedEncodingMessage(enc) {
  return `本工具不支持 ${enc} 编码的文件写回（该文件是 ${enc}），请先转码或交由主代理改派 code-operator 处理`;
}

/* ------------- 编辑匹配：精确 → 字面量感知规范化 →（仅报告）近似候选 ------------- */

const PUNCT_ADJ = '()[]{},;:<>!?"\'`|';

/**
 * 在同一行内寻找字符串字面量区的配对闭合引号。
 * 反斜杠转义的字符跳过（\" 不是闭合引号）。
 */
function findClosingQuote(line, start, quote) {
  for (let i = start + 1; i < line.length; i++) {
    const c = line[i];
    if (c === '\\') { i += 1; continue; }
    if (c === quote) return i;
  }
  return -1;
}

/**
 * 字面量区扫描器（单行）：返回 [{ start, end }]（含端点）。
 * 定界符：' " `；必须在同一行内能配对闭合，否则该引号按普通字符处理；
 * 转义引号不作定界符；进入一种引号区后其余引号按普通字符处理。
 */
function findLiteralZones(line) {
  const zones = [];
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === '"' || c === "'" || c === '`') {
      if (i > 0 && line[i - 1] === '\\') { i += 1; continue; }
      const close = findClosingQuote(line, i, c);
      if (close === -1) { i += 1; continue; }
      zones.push({ start: i, end: close });
      i = close + 1;
      continue;
    }
    i += 1;
  }
  return zones;
}

/** 逐字符标记：字面量区内（literal）与行首缩进（indent）。 */
function buildProtectedMasks(text) {
  const n = text.length;
  const literal = new Uint8Array(n);
  const indent = new Uint8Array(n);
  let lineStart = 0;
  for (;;) {
    let lineEnd = text.indexOf('\n', lineStart);
    const last = lineEnd === -1;
    if (last) lineEnd = n;
    let contentEnd = lineEnd;
    if (contentEnd > lineStart && text[contentEnd - 1] === '\r') contentEnd -= 1;
    const line = text.slice(lineStart, contentEnd);
    for (const z of findLiteralZones(line)) {
      for (let k = z.start; k <= z.end; k++) literal[lineStart + k] = 1;
    }
    let k = 0;
    while (k < line.length && (line[k] === ' ' || line[k] === '\t')) { indent[lineStart + k] = 1; k += 1; }
    if (last) break;
    lineStart = lineEnd + 1;
  }
  return { literal, indent };
}

/**
 * 空白规范化：只动空白，不动任何字符。
 * opts.literalAware = true（默认，用于第二级正式匹配）：
 *   换行 CRLF/CR → LF；去行尾空白；行首缩进原样保留；字面量区内空白原样保留；
 *   其余连续空格/制表符折叠为一个空格；标点相邻的空白去除。
 * opts.literalAware = false（全折叠模式，仅用于近似候选扫描，不得用于实际替换）。
 * 返回 { text, map }，map[i] = 规范化后第 i 个字符在原文中的索引。
 */
function normalizeForMatch(text, opts = {}) {
  const literalAware = opts.literalAware !== false;
  const masks = literalAware ? buildProtectedMasks(text) : null;
  const chars = [];
  const map = [];
  const push = (ch, idx) => { chars.push(ch); map.push(idx); };
  let pending = -1;
  const flush = (nextChar) => {
    if (pending === -1) return;
    const p = pending;
    pending = -1;
    if (nextChar !== undefined && PUNCT_ADJ.includes(nextChar)) return;
    if (chars.length && PUNCT_ADJ.includes(chars[chars.length - 1])) return;
    push(' ', p);
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '\r' || c === '\n') {
      pending = -1; // 行尾空白丢弃
      if (c === '\r' && text[i + 1] === '\n') i += 2; else i += 1;
      push('\n', i - 1);
      continue;
    }
    if (c === ' ' || c === '\t') {
      if (literalAware && (masks.literal[i] || masks.indent[i])) {
        // 受保护的空白（行首缩进 / 字面量区内）原样保留，不折叠不去除
        flush(c);
        let j = i;
        while (j < text.length && (text[j] === ' ' || text[j] === '\t')) { push(text[j], j); j += 1; }
        i = j;
        continue;
      }
      if (pending === -1) pending = i;
      i++;
      continue;
    }
    flush(c);
    push(c, i);
    i++;
  }
  pending = -1;
  return { text: chars.join(''), map };
}

/* ---------------- 缩进保护：替换不得悄悄改变行首缩进 ---------------- */

/** 行首空白（空格/制表符）长度。 */
function leadingWsLen(s) {
  let i = 0;
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i += 1;
  return i;
}

/** offset 所在行的行首偏移。 */
function lineStartOffset(text, offset) {
  return text.lastIndexOf('\n', offset - 1) + 1;
}

/** offset 所在行的行尾偏移（不含 \n，可能含 \r）。 */
function lineEndOffset(text, offset) {
  const e = text.indexOf('\n', offset);
  return e === -1 ? text.length : e;
}

/**
 * 判定命中区间 [s,e) 是否会改变行首缩进。
 * 规则：
 *   ① oldText 自带前导空白，且命中起点 s 落在该行缩进内部（s > 行首 且 [行首,s) 全为空白）→ 违规；
 *   ② 多行 oldText：第 2 行及以后，文件中该行缩进比 oldText 对应行缩进更长 → 违规。
 * 返回违规行的行首偏移数组（空数组 = 不违规）。
 */
function indentViolations(text, s, e, oldText) {
  const out = [];
  const old = typeof oldText === 'string' ? oldText : '';
  const ls = lineStartOffset(text, s);
  if (old.length > 0 && (old[0] === ' ' || old[0] === '\t') && s > ls) {
    let allWs = true;
    for (let k = ls; k < s; k += 1) {
      if (text[k] !== ' ' && text[k] !== '\t') { allWs = false; break; }
    }
    if (allWs) out.push(ls);
  }
  const region = text.slice(s, e);
  const regionLines = region.split('\n');
  const oldLines = old.split('\n');
  const n = Math.min(regionLines.length, oldLines.length);
  let off = s;
  for (let k = 1; k < n; k += 1) {
    off += regionLines[k - 1].length + 1;
    if (leadingWsLen(regionLines[k]) > leadingWsLen(oldLines[k])) out.push(off);
  }
  return out;
}

const INDENT_HINT = '命中起点落在行首缩进中段，替换会悄悄改变缩进（YAML/Python 缩进即结构）。请改用完整缩进，或去掉 oldText 的前导空白后重试。';

/* ---------------- 缩进变化提示（只增报告，不改变任何匹配/替换逻辑） ---------------- */

/** 缩进样子的可读描述：4 个空格 / 2 个制表符 / N 个空白字符。 */
function describeIndent(indent) {
  const s = String(indent == null ? '' : indent);
  if (s.length === 0) return '0 个空格（空）';
  if (/^ +$/.test(s)) return `${s.length} 个空格`;
  if (/^\t+$/.test(s)) return `${s.length} 个制表符`;
  return `${s.length} 个空白字符`;
}

/**
 * 判定本次替换是否改变了命中行的行首缩进（纯报告，不影响匹配与替换）。
 * 规则：
 *   ① 命中起点必须正好落在行首（oldText 覆盖了整行的行首缩进）才可能改动缩进；
 *      起点不在行首 → 缩进未被触碰 → indentChanged=false。
 *   ② 多行命中 → 逐行比对「原文行首缩进」与「newText 对应行的行首缩进」，
 *      取第一处不同者作为 originalIndent / newIndent。
 *   ③ newText 行数少于命中行数 → 多出来的原文行被删除，其缩进同样算被改变。
 */
function indentChangeInfo(text, s, e, newText) {
  const ls = lineStartOffset(text, s);
  if (s !== ls) return { indentChanged: false };
  const region = text.slice(s, e);
  const regionLines = region.split('\n');
  const newLines = String(newText == null ? '' : newText).split('\n');
  for (let k = 0; k < regionLines.length; k += 1) {
    const origLine = k === 0 ? text.slice(ls, s + regionLines[0].length) : regionLines[k];
    const originalIndent = origLine.slice(0, leadingWsLen(origLine));
    const newLine = k < newLines.length ? newLines[k] : '';
    const newIndent = newLine.slice(0, leadingWsLen(newLine));
    if (originalIndent === newIndent) continue;
    const origDesc = describeIndent(originalIndent);
    const newDesc = describeIndent(newIndent);
    return {
      indentChanged: true,
      originalIndent,
      newIndent,
      indentWarning: `你替换的文本包含行首缩进（原文 ${origDesc}），而新文本${newIndent ? `带 ${newDesc}` : '不带缩进'} → 该行缩进已变为 ${newDesc}。若要保留层级，请让 newText 带上同样的缩进。`,
    };
  }
  return { indentChanged: false };
}

/** 违规行 → nearMiss 条目（diffKind='indent'，exactText 为该行完整原文，含完整缩进）。 */
function indentNearMissEntries(text, offsets) {
  const out = [];
  const seen = new Set();
  for (const off of offsets) {
    if (seen.has(off)) continue;
    seen.add(off);
    let exact = text.slice(off, lineEndOffset(text, off));
    if (exact.endsWith('\r')) exact = exact.slice(0, -1);
    out.push({
      line: lineOfOffset(text, off),
      exactText: exact,
      diffInsideLiteral: false,
      diffKind: 'indent',
      hint: INDENT_HINT,
    });
  }
  return out;
}

/** nearMisses 去重（按 line+diffKind+exactText），保持原有顺序。 */
function dedupeNearMisses(list) {
  const out = [];
  const seen = new Set();
  for (const n of list || []) {
    if (!n) continue;
    const key = `${n.line}|${n.diffKind}|${n.exactText}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(n);
  }
  return out;
}

function snippetAt(text, offset) {
  const ls = text.lastIndexOf('\n', offset - 1) + 1;
  let le = text.indexOf('\n', offset);
  if (le === -1) le = text.length;
  return text.slice(ls, le).trim().slice(0, 80);
}

function candidatesFor(text, offsets) {
  return offsets.slice(0, 20).map((o) => ({ line: lineOfOffset(text, o), snippet: snippetAt(text, o) }));
}

/**
 * 近似候选定位（全折叠模式）：返回候选在原文中的区间 [{ s, e }]。
 * 只做定位，不做替换。
 */
function foldedCandidates(text, oldText) {
  const ft = normalizeForMatch(text, { literalAware: false });
  const fOld = normalizeForMatch(oldText, { literalAware: false }).text;
  const positions = [];
  if (!fOld) return { ft, fOld, positions };
  let idx = ft.text.indexOf(fOld);
  while (idx !== -1 && positions.length < 10) {
    const s = ft.map[idx];
    const e = ft.map[idx + fOld.length - 1] + 1;
    positions.push({ s, e });
    idx = ft.text.indexOf(fOld, idx + fOld.length);
  }
  return { ft, fOld, positions };
}

/** LCS 对齐：返回差异段 [{ aStart, aEnd, bStart, bEnd }]（a = oldText，b = 精确原文 E）。 */
function diffSegments(a, b) {
  const n = a.length, m = b.length;
  if (n === 0 || m === 0) return [{ aStart: 0, aEnd: n, bStart: 0, bEnd: m }];
  if (n * m > 400000) return null;
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = a[i] === b[j]
        ? dp[(i + 1) * w + (j + 1)] + 1
        : Math.max(dp[(i + 1) * w + j], dp[i * w + (j + 1)]);
    }
  }
  const segs = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { i++; j++; continue; }
    const i0 = i, j0 = j;
    while (i < n && j < m && a[i] !== b[j]) {
      // 平局时优先跳过 b（把差异记到精确原文一侧，便于定位到文件偏移）
      if (dp[(i + 1) * w + j] > dp[i * w + (j + 1)]) i++; else j++;
    }
    segs.push({ aStart: i0, aEnd: i, bStart: j0, bEnd: j });
  }
  if (i < n || j < m) segs.push({ aStart: i, aEnd: n, bStart: j, bEnd: m });
  return segs;
}

function isWsOnly(s) { return s.length > 0 && /^[ \t\r\n]+$/.test(s); }

/**
 * 差异归类：
 *   'indent'     空白差异全部落在行首缩进处
 *   'literal'    空白差异全部落在字面量区内
 *   'whitespace' 其余情况（含无法归类时的兜底）
 */
function classifyDiffKind(oldText, exact, regionStart, masks) {
  const segs = diffSegments(oldText, exact);
  if (!segs || !segs.length) return 'whitespace';
  const wsSegs = [];
  for (const s of segs) {
    const aPart = oldText.slice(s.aStart, s.aEnd);
    const bPart = exact.slice(s.bStart, s.bEnd);
    const aWs = aPart.length === 0 || isWsOnly(aPart);
    const bWs = bPart.length === 0 || isWsOnly(bPart);
    if (aWs && bWs && (aPart.length + bPart.length) > 0) wsSegs.push(s);
  }
  if (!wsSegs.length) return 'whitespace';
  let allIndent = true, allLiteral = true;
  for (const s of wsSegs) {
    const from = regionStart + s.bStart;
    const to = regionStart + s.bEnd;
    if (to <= from) { allIndent = false; allLiteral = false; continue; }
    for (let k = from; k < to; k++) {
      if (!masks.indent[k]) allIndent = false;
      if (!masks.literal[k]) allLiteral = false;
    }
  }
  if (allIndent) return 'indent';
  if (allLiteral) return 'literal';
  return 'whitespace';
}

/**
 * 近似候选（只报告，不替换）：用全折叠模式再找一遍位置，取原文精确片段。
 * 返回 [{ line, exactText, diffInsideLiteral, diffKind }]，最多 10 条，精确原文最长 200 字符。
 */
function nearMissesFrom(text, oldText, folded) {
  const out = [];
  const indentOut = [];
  const fc = folded || foldedCandidates(text, oldText);
  if (!fc.positions.length) return out;
  const masks = buildProtectedMasks(text);
  for (const c of fc.positions) {
    const s = c.s;
    const e = c.e;
    const vio = indentViolations(text, s, e, oldText);
    if (vio.length) { indentOut.push(...indentNearMissEntries(text, vio)); continue; }
    let ls = s;
    while (ls > 0 && (text[ls - 1] === ' ' || text[ls - 1] === '\t')) ls -= 1;
    let exact = text.slice(ls, e);
    if (exact.length > 200) exact = exact.slice(0, 200) + '...';
    let inLiteral = false;
    for (let k = s; k < e; k++) { if (masks.literal[k]) { inLiteral = true; break; } }
    const region = text.slice(s, e);
    const differs = normalizeForMatch(region, { literalAware: true }).text !== normalizeForMatch(region, { literalAware: false }).text;
    const diffKind = classifyDiffKind(oldText, region, s, masks);
    out.push({ line: lineOfOffset(text, s), exactText: exact, diffInsideLiteral: inLiteral && differs, diffKind });
  }
  return [...indentOut, ...out];
}

function findNearMisses(text, oldText) {
  return nearMissesFrom(text, oldText, foldedCandidates(text, oldText));
}

/* --------------------- 进程内编辑记账（幂等证据①） --------------------- */

/** 键：文件绝对路径；值：[{ oldText, newText, sha256After, ts, seq }]。总容量上限 200 条，超限丢最旧的一条。 */
const appliedLedger = new Map();
const APPLIED_LEDGER_MAX = 200;
let ledgerSeq = 0;

function ledgerKey(p) {
  return path.resolve(String(p)).toLowerCase();
}

/** 记录一次成功写回。 */
function ledgerAppend(filePath, oldText, newText, sha256After) {
  const key = ledgerKey(filePath);
  let arr = appliedLedger.get(key);
  if (!arr) { arr = []; appliedLedger.set(key, arr); }
  arr.push({ oldText, newText, sha256After, ts: Date.now(), seq: ++ledgerSeq });
  let total = 0;
  for (const a of appliedLedger.values()) total += a.length;
  while (total > APPLIED_LEDGER_MAX) {
    let victimKey = null, victimIdx = -1, victimSeq = Infinity;
    for (const [k, a] of appliedLedger) {
      for (let i = 0; i < a.length; i++) {
        if (a[i].seq < victimSeq) { victimSeq = a[i].seq; victimKey = k; victimIdx = i; }
      }
    }
    if (victimKey === null) break;
    appliedLedger.get(victimKey).splice(victimIdx, 1);
    total -= 1;
  }
}

/**
 * 幂等证据①：同一 path 的账本中存在 oldText（相同或空白等价）、newText（相同）、
 * 且当时的 sha256After 等于当前文件 sha256 的记录 → 已应用过。
 */
function ledgerLookup(filePath, oldText, newText, sha256) {
  if (!filePath || !sha256) return false;
  const arr = appliedLedger.get(ledgerKey(filePath));
  if (!arr || !arr.length) return false;
  for (const rec of arr) {
    if (rec.newText !== newText) continue;
    if (rec.sha256After !== sha256) continue;
    if (rec.oldText === oldText || whitespaceEquivalent(rec.oldText, oldText)) return true;
  }
  return false;
}

function ledgerStats() {
  let total = 0;
  for (const a of appliedLedger.values()) total += a.length;
  return { total, paths: appliedLedger.size, max: APPLIED_LEDGER_MAX };
}

/** 空白等价（字面量感知）：只差空白差异时视为等价。 */
function whitespaceEquivalent(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a === b) return true;
  return normalizeForMatch(a, { literalAware: true }).text === normalizeForMatch(b, { literalAware: true }).text;
}

/**
 * 单个 edit 的匹配级联：精确 → 字面量感知规范化 → 幂等（证据①记账 / 证据②位置）→ not_found（附近似候选）。
 * 绝不模糊替换；幂等只认「位置一致」，不再用「newText 是否出现在文件任意位置」这种松散判据。
 */
function applyEditToText(text, oldText, newText, ctx = {}) {
  if (typeof oldText !== 'string' || oldText.length === 0) {
    return { ok: false, error: 'invalid_args', reason: 'oldText 不能为空' };
  }
  const indentHits = [];
  // ① 精确匹配（字节级）：命中起点落在行首缩进中段的候选一律作废（不得悄悄改变缩进）
  const exactPos = [];
  let ex = text.indexOf(oldText);
  while (ex !== -1) { exactPos.push(ex); ex = text.indexOf(oldText, ex + oldText.length); }
  const exactValid = [];
  for (const at of exactPos) {
    const vio = indentViolations(text, at, at + oldText.length, oldText);
    if (vio.length) { indentHits.push(...indentNearMissEntries(text, vio)); continue; }
    exactValid.push(at);
  }
  if (exactValid.length === 1) {
    const at = exactValid[0];
    return {
      ok: true,
      matchedBy: 'exact',
      text: text.slice(0, at) + newText + text.slice(at + oldText.length),
      start: at,
      end: at + oldText.length,
    };
  }
  if (exactValid.length > 1) {
    return { ok: false, error: 'ambiguous', occurrences: exactValid.length, candidates: candidatesFor(text, exactValid) };
  }
  // ② 字面量感知空白规范化匹配（正式匹配级别）
  const nt = normalizeForMatch(text, { literalAware: true });
  const nOld = normalizeForMatch(oldText, { literalAware: true }).text;
  if (nOld.length === 0) return { ok: false, error: 'invalid_args', reason: 'oldText 规范化后为空' };
  const nPos = [];
  let ni = nt.text.indexOf(nOld);
  while (ni !== -1) { nPos.push(ni); ni = nt.text.indexOf(nOld, ni + nOld.length); }
  const normValid = [];
  for (const p of nPos) {
    const s = nt.map[p];
    const e = nt.map[p + nOld.length - 1] + 1;
    const vio = indentViolations(text, s, e, oldText);
    if (vio.length) { indentHits.push(...indentNearMissEntries(text, vio)); continue; }
    normValid.push({ s, e });
  }
  if (normValid.length === 1) {
    const { s, e } = normValid[0];
    return {
      ok: true,
      matchedBy: 'normalized',
      matchedText: text.slice(s, e),
      text: text.slice(0, s) + newText + text.slice(e),
      start: s,
      end: e,
    };
  }
  if (normValid.length > 1) {
    const cands = normValid.map((v) => ({ line: lineOfOffset(text, v.s), snippet: snippetAt(text, v.s) }));
    return { ok: false, error: 'ambiguous', occurrences: normValid.length, candidates: cands, matchedBy: 'normalized' };
  }
  // ③ 幂等判定（两条证据，满足任一即 already_applied）
  const hasNew = typeof newText === 'string' && newText.length > 0;
  const folded = foldedCandidates(text, oldText);
  if (hasNew) {
    // 证据①：进程内记账（同一 path / 同一 (old,new) / 文件 sha256 未变）
    if (ctx && ctx.path && ctx.sha256 && ledgerLookup(ctx.path, oldText, newText, ctx.sha256)) {
      return { ok: true, status: 'already_applied', alreadyAppliedBy: 'ledger' };
    }
    // 证据②：位置证据（近似候选所在位置的精确原文已经等于 newText）
    for (const c of folded.positions) {
      if (indentViolations(text, c.s, c.e, oldText).length) continue;
      const E = text.slice(c.s, c.e);
      if (E === newText || whitespaceEquivalent(E, newText)) {
        return { ok: true, status: 'already_applied', alreadyAppliedBy: 'position' };
      }
    }
  }
  // ④ 近似候选（仅报告，不替换）：缩进类候选排最前
  const nearMisses = dedupeNearMisses([...indentHits, ...nearMissesFrom(text, oldText, folded)]);
  return {
    ok: false,
    error: 'not_found',
    occurrences: 0,
    reason: '未找到 oldText（精确匹配与字面量感知规范化匹配均无命中）',
    nearMisses,
    hint: indentHits.length ? INDENT_HINT : undefined,
  };
}

async function writeAtomic(target, out) {
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.fop-tmp-${process.pid}-${Date.now()}`);
  try {
    await fsp.writeFile(tmp, out);
    await fsp.rename(tmp, target);
  } catch (e) {
    try { await fsp.rm(tmp, { force: true }); } catch { /* ignore */ }
    throw e;
  }
}

/* ------------------------- 换行风格（EOL） ------------------------- */

/** 统计以 CRLF 结尾的行数与以裸 LF 结尾的行数。 */
function countEol(raw) {
  let crlfLines = 0;
  let lfOnlyLines = 0;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '\n') { if (i > 0 && raw[i - 1] === '\r') crlfLines++; else lfOnlyLines++; }
  }
  return { crlfLines, lfOnlyLines };
}

/** 文件换行风格：crlf / lf / mixed / none（无换行）。 */
function eolStyleOf(raw) {
  const c = countEol(raw);
  if (c.crlfLines > 0 && c.lfOnlyLines > 0) return 'mixed';
  if (c.crlfLines > 0) return 'crlf';
  if (c.lfOnlyLines > 0) return 'lf';
  return 'none';
}

/**
 * 统一「调用方 content」自身的行尾风格（只针对 content 的混用，不动原文件）：
 * 统计 CRLF 结尾行数与裸 LF 结尾行数，多数风格胜出（CRLF 多 → CRLF；LF 多或相等 → LF）。
 * 返回 { text（已统一为裸 LF）, eol, normalized }，normalized 仅在 content 确实混用时为 true。
 */
function normalizeContentEol(content) {
  const c = countEol(content);
  const mixed = c.crlfLines > 0 && c.lfOnlyLines > 0;
  const eol = c.crlfLines > c.lfOnlyLines ? 'crlf' : 'lf';
  return {
    text: content.replace(/\r\n/g, '\n'),
    eol,
    normalized: mixed,
    crlfLines: c.crlfLines,
    lfOnlyLines: c.lfOnlyLines,
  };
}

/* ------------------------- edit_text：单文件 / 批量 ------------------------- */

async function toolEditText(args, ctx = {}) {
  const hasPaths = Array.isArray(args.paths) && args.paths.length > 0;
  const hasPath = typeof args.path === 'string' && args.path.trim() !== '';
  if (hasPaths && hasPath) {
    const out0 = { ok: false, error: 'invalid_args', reason: 'path 与 paths 互斥：单文件形态用 path，批量形态用 paths' };
    return finalizeAudit(out0, [auditWrite({ action: 'edit_text', paths: [], ok: false, error: 'invalid_args' })]);
  }
  if (hasPaths) {
    const r = await toolEditTextBatch(args, ctx);
    if (r.ok === true) {
      const bytes = (r.files || []).reduce((n, f) => n + (f.bytesAfter || 0), 0);
      const a = auditWrite({ action: 'edit_text', paths: (r.files || []).map((f) => f.path), mode: 'replace', ok: true, bytes });
      return finalizeAudit(r, [a]);
    }
    const outcomes = [];
    const failedFiles = (r.files || []).filter((f) => f.ok !== true);
    if (failedFiles.length > 0) {
      for (const f of failedFiles) {
        outcomes.push(auditWrite({
          action: 'edit_text',
          paths: [f.path],
          mode: 'replace',
          ok: false,
          error: f.error || 'io_error',
          ...(f.ruleId ? { ruleId: f.ruleId } : {}),
          ...(f.reason ? { reason: String(f.reason).slice(0, 200) } : {}),
        }));
      }
    } else {
      outcomes.push(auditWrite({
        action: 'edit_text',
        paths: (Array.isArray(args.paths) ? args.paths : []).map((p) => String(p)),
        mode: 'replace',
        ok: false,
        error: r.error || 'io_error',
        ...(r.reason ? { reason: String(r.reason).slice(0, 200) } : {}),
      }));
    }
    return finalizeAudit(r, outcomes);
  }
  const r = await toolEditTextSingle(args, ctx);
  if (r.ok === true) {
    const a = auditWrite({ action: 'edit_text', path: r.file, mode: args.mode === 'overwrite' ? 'overwrite' : 'replace', ok: true, bytes: r.bytesAfter });
    return finalizeAudit(r, [a]);
  }
  const a = auditWrite({
    action: 'edit_text',
    path: r.file || (typeof args.path === 'string' ? toPosix(path.resolve(args.path)) : ''),
    mode: args.mode === 'overwrite' ? 'overwrite' : 'replace',
    ok: false,
    error: r.error || 'io_error',
    ...(r.ruleId ? { ruleId: r.ruleId } : {}),
    ...(r.reason ? { reason: String(r.reason).slice(0, 200) } : {}),
  });
  return finalizeAudit(r, [a]);
}

async function toolEditTextSingle(args, ctx = {}) {
  const dryRun = ctx.dryRun === true;
  let target;
  try { target = resolvePath(args.path); } catch (e) { return { ok: false, error: 'invalid_args', reason: e.message }; }
  const mode = args.mode === 'overwrite' ? 'overwrite' : 'replace';
  const edits = Array.isArray(args.edits) ? args.edits : [];
  const limits = loadConfig().batchLimits;
  if (edits.length > limits.edits) return { ok: false, error: 'batch_limit', limit: limits.edits, given: edits.length };
  if (mode === 'replace' && edits.length === 0) return { ok: false, error: 'invalid_args', reason: 'edits 不能为空' };
  if (mode === 'overwrite' && typeof args.content !== 'string') {
    return { ok: false, error: 'invalid_args', reason: 'mode=overwrite 时必须提供 content' };
  }
  const g = await guardPath(target, 'edit', { write: true });
  if (!g.ok) return g;
  const real = g.real;
  // 目录不是文本：明确报 invalid_args（与 read_text 口径一致），不得误报 target_missing / not_found
  try {
    const stDir = await fsp.stat(real);
    if (stDir.isDirectory()) {
      return { ok: false, error: 'invalid_args', reason: '目标是目录，不能按文本编辑', file: toPosix(target) };
    }
  } catch { /* 不存在 → 走下面的 target_missing / not_found 分支 */ }
  let buf = null;
  let exists = true;
  try { buf = await fsp.readFile(real); } catch { exists = false; }
  if (!exists) {
    if (mode === 'overwrite') {
      // 目标不存在：必须显式声明要新建，否则给出自解释错误
      if (args.createIfMissing !== true) {
        return {
          ok: false,
          error: 'target_missing',
          reason: `文件不存在：${toPosix(target)}。如需新建请传 \`createIfMissing:true\`；若要修改已存在文件请用 \`mode='replace'\`。`,
          file: toPosix(target),
        };
      }
      const nc = normalizeContentEol(String(args.content));
      let body = nc.text;
      if (nc.eol === 'crlf') body = body.replace(/\n/g, '\r\n');
      const out = Buffer.from(body, 'utf8');
      try { if (!dryRun) await writeAtomic(real, out); } catch (e) { return { ok: false, error: 'io_error', reason: `写入失败：${e.message}` }; }
      return {
        ok: true,
        status: 'applied',
        file: toPosix(target),
        editsApplied: 1,
        encoding: 'utf-8',
        encodingPreserved: true,
        bom: false,
        bytesBefore: 0,
        bytesAfter: out.length,
        sha256Before: null,
        sha256After: crypto.createHash('sha256').update(out).digest('hex'),
        affectedLines: { from: 1, to: nc.text.split('\n').length },
        originalEol: 'none',
        writtenEol: nc.eol,
        eolNormalized: nc.normalized,
        contentEolNormalizedTo: nc.eol,
        eolChanged: true,
        indentChanged: false,
      };
    }
    return { ok: false, error: 'not_found', reason: `文件不存在：${toPosix(target)}` };
  }
  const shaBefore = crypto.createHash('sha256').update(buf).digest('hex');
  // overwrite 覆盖已存在文件属于危险方向：必须显式声明 overwriteExisting=true
  if (mode === 'overwrite' && args.overwriteExisting !== true) {
    return {
      ok: false,
      error: 'target_exists',
      reason: `目标文件已存在：${toPosix(target)}。\`mode='overwrite'\` 会覆盖它；如确实要覆盖，请显式传 \`overwriteExisting:true\`（可同时传 expected_sha256 做版本校验）。`,
      file: toPosix(target),
      bytes: buf.length,
      sha256: shaBefore,
    };
  }
  if (args.expected_sha256 && String(args.expected_sha256).toLowerCase() !== shaBefore) {
    return {
      ok: false,
      error: 'version_mismatch',
      expected: String(args.expected_sha256),
      actual: shaBefore,
      file: toPosix(target),
    };
  }
  const det = detectEncoding(buf);
  if (!det.enc) return { ok: false, error: 'invalid_args', reason: '无法识别文本编码（UTF-8 / GB18030 / Big5 均解码失败）', file: toPosix(target) };
  if ((det.enc === 'gb18030' || det.enc === 'big5') && !HAS_ICONV) {
    return { ok: false, error: 'dependency_unavailable', reason: unsupportedEncodingMessage(det.enc), file: toPosix(target), encoding: det.enc, encodingPreserved: false };
  }
  let raw;
  try {
    raw = det.text !== undefined ? det.text : decodeBytes(det.body, det.enc);
  } catch (e) {
    if (String(e && e.message || e).startsWith('ICONV_UNAVAILABLE')) {
      return { ok: false, error: 'dependency_unavailable', reason: unsupportedEncodingMessage(det.enc), file: toPosix(target), encoding: det.enc, encodingPreserved: false };
    }
    return { ok: false, error: 'io_error', reason: `解码失败（${det.enc}）：${e && e.message ? e.message : String(e)}`, file: toPosix(target), encoding: det.enc };
  }
  const eol = countEol(raw);
  const originalEol = eolStyleOf(raw);
  const mixed = originalEol === 'mixed';
  // 混用换行 + 局部编辑 → 拒绝（局部编辑必然改动全文行尾）
  if (mode === 'replace' && mixed) {
    return {
      ok: false,
      error: 'mixed_eol',
      reason: `该文件混用 CRLF/LF（CRLF ${eol.crlfLines} 行 / LF ${eol.lfOnlyLines} 行）。局部编辑会让全文行尾发生变化，因此已拒绝。请读出全文、统一换行后用 \`mode='overwrite'\` 写回`,
      file: toPosix(target),
      originalEol,
    };
  }
  const useCrlf = originalEol === 'crlf';
  let finalText;
  let writtenEol = originalEol;
  let contentEolNormalized = false;
  let contentEolNormalizedTo = undefined;
  const details = [];
  const appliedPairs = [];
  let matchedBy = null;
  // 缩进变化提示（只增报告）：记录本次调用中第一处被改变的行首缩进
  let indentInfo = { indentChanged: false };
  if (mode === 'overwrite') {
    // 调用方 content 自身混用 CRLF/LF → 自动统一（多数风格胜出，相等 → LF），不再拒绝。
    const nc = normalizeContentEol(String(args.content));
    finalText = nc.text;
    // 写回风格（B-3）：一律听调用方 content 的换行风格 —— 统一后为 CRLF 则写 CRLF，否则 LF。
    // 原文件是纯 CRLF/LF 还是 mixed，都不再影响 overwrite 的写回风格。
    writtenEol = nc.eol;
    contentEolNormalized = nc.normalized;
    contentEolNormalizedTo = nc.eol;
    details.push({ mode: 'overwrite', bytes: Buffer.byteLength(finalText, 'utf8') });
  } else {
    let work = raw.replace(/\r\n/g, '\n');
    const failures = [];
    // 幂等证据①的上下文：文件绝对路径 + 当前文件 sha256（写回前磁盘上的 sha）
    let ledgerCtx = { path: real, sha256: shaBefore };
    for (let i = 0; i < edits.length; i++) {
      const ed = edits[i] || {};
      const oldText = typeof ed.oldText === 'string' ? ed.oldText : (typeof ed.old_text === 'string' ? ed.old_text : '');
      const newText = typeof ed.newText === 'string' ? ed.newText : (typeof ed.new_text === 'string' ? ed.new_text : '');
      const before = work;
      const res = applyEditToText(work, oldText, newText, ledgerCtx);
      if (!res.ok) {
        failures.push({ index: i, error: res.error, reason: res.reason, occurrences: res.occurrences, candidates: res.candidates, nearMisses: res.nearMisses, hint: res.hint });
        return {
          ok: false,
          error: res.error,
          reason: res.reason,
          occurrences: res.occurrences,
          candidates: res.candidates,
          nearMisses: res.nearMisses,
          hint: res.hint,
          failedIndex: i,
          failures,
          editsApplied: 0,
          file: toPosix(target),
        };
      }
      if (res.status === 'already_applied') {
        return {
          ok: true,
          status: 'already_applied',
          alreadyAppliedBy: res.alreadyAppliedBy || 'position',
          editsApplied: 0,
          file: toPosix(target),
          encoding: det.enc,
          encodingPreserved: true,
          bom: det.bom,
          bytesBefore: buf.length,
          bytesAfter: buf.length,
          sha256Before: shaBefore,
          sha256After: shaBefore,
          matchedBy: matchedBy || 'exact',
          affectedLines: { from: 1, to: 1 },
          originalEol,
          writtenEol: originalEol,
          eolChanged: false,
          indentChanged: false,
        };
      }
      work = res.text;
      appliedPairs.push({ oldText, newText });
      // 缩进变化提示：命中区间起点在行首时，比对原文与 newText 的行首缩进（只报告，不改行为）
      {
        const info = indentChangeInfo(before, res.start, res.end, newText);
        if (info.indentChanged === true && indentInfo.indentChanged !== true) indentInfo = info;
      }
      // 首个 edit 之后磁盘 sha 已不再代表 work 状态 → 关闭后续 edit 的记账证据①
      ledgerCtx = { path: real, sha256: null };
      matchedBy = res.matchedBy === 'normalized' ? 'normalized' : (matchedBy || 'exact');
      details.push({
        index: i,
        matchedBy: res.matchedBy,
        occurrences: 1,
        replacedAtLine: lineOfOffset(before, res.start),
        oldLength: res.end - res.start,
        newLength: newText.length,
        matchedText: res.matchedBy === 'normalized' ? res.matchedText : undefined,
      });
    }
    finalText = work;
    writtenEol = useCrlf ? 'crlf' : 'lf';
  }
  if (writtenEol === 'crlf') finalText = finalText.replace(/\n/g, '\r\n');
  // 用同一编码重新编码，并做往返校验：不一致则拒绝写入（不产出半损坏文件）
  let out;
  try {
    out = encodeBytes(finalText, det.enc, det.bom);
  } catch (e) {
    if (String(e && e.message || e).startsWith('ICONV_UNAVAILABLE')) {
      return { ok: false, error: 'dependency_unavailable', reason: unsupportedEncodingMessage(det.enc), file: toPosix(target), encoding: det.enc, encodingPreserved: false };
    }
    return { ok: false, error: 'io_error', reason: `编码失败（${det.enc}）：${e && e.message ? e.message : String(e)}`, file: toPosix(target), encoding: det.enc };
  }
  let roundTrip;
  try {
    roundTrip = decodeFull(out, det.enc);
  } catch (e) {
    return { ok: false, error: 'io_error', reason: `往返校验解码失败（${det.enc}），已拒绝写入：${e && e.message ? e.message : String(e)}`, file: toPosix(target), encoding: det.enc };
  }
  if (roundTrip !== finalText) {
    return {
      ok: false,
      error: 'io_error',
      reason: `往返校验失败：用 ${det.enc} 编码后再解码与替换后的文本不一致，已拒绝写入（原文件未改动）`,
      file: toPosix(target),
      encoding: det.enc,
      encodingPreserved: false,
      bytesBefore: buf.length,
    };
  }
  const stBefore = await fsp.stat(real);
  const id = await verifyIdentity(real, stBefore);
  if (!id.ok) return { ok: false, ...id, file: toPosix(target) };
  if (!dryRun) {
    try {
      await writeAtomic(real, out);
    } catch (e) {
      return { ok: false, error: 'io_error', reason: `写入失败：${e.message}` };
    }
  }
  const shaAfter = crypto.createHash('sha256').update(out).digest('hex');
  // 成功写回后记账（批量形态由 toolEditTextSingle 逐文件各记一条）
  if (!dryRun) {
    for (const p of appliedPairs) ledgerAppend(real, p.oldText, p.newText, shaAfter);
  }
  const detAfter = detectEncoding(out);
  const lineCount = finalText.split('\n').length;
  const affected = details.length && details[0].replacedAtLine
    ? { from: Math.min(...details.map((d) => d.replacedAtLine)), to: Math.max(...details.map((d) => d.replacedAtLine)) }
    : { from: 1, to: lineCount };
  return {
    ok: true,
    status: 'applied',
    file: toPosix(target),
    edits: details,
    editsApplied: mode === 'overwrite' ? 1 : details.length,
    encoding: det.enc,
    encodingPreserved: detAfter.enc === det.enc,
    bom: det.bom,
    bytesBefore: buf.length,
    bytesAfter: out.length,
    sha256Before: shaBefore,
    sha256After: shaAfter,
    affectedLines: affected,
    matchedBy: mode === 'overwrite' ? 'overwrite' : (matchedBy || 'exact'),
    originalEol,
    writtenEol,
    eolNormalized: contentEolNormalized,
    contentEolNormalizedTo,
    eolChanged: writtenEol !== (originalEol === 'none' ? 'lf' : originalEol),
    indentChanged: indentInfo.indentChanged === true,
    ...(indentInfo.indentChanged === true ? {
      originalIndent: indentInfo.originalIndent,
      newIndent: indentInfo.newIndent,
      indentWarning: indentInfo.indentWarning,
    } : {}),
  };
}

/** 批量形态：paths[] + edits[]（mode 只能是 replace）。 */
async function toolEditTextBatch(args, ctx = {}) {
  const mode = args.mode === 'overwrite' ? 'overwrite' : 'replace';
  if (mode === 'overwrite') {
    return { ok: false, error: 'invalid_args', reason: '批量形态只支持 mode=replace（overwrite 是整文件覆盖，跨多文件无意义）' };
  }
  const paths = (Array.isArray(args.paths) ? args.paths : []).map((p) => String(p));
  const limits = loadConfig().batchLimits;
  const editPaths = Number(limits.editPaths) || DEFAULT_BATCH_LIMITS.editPaths;
  const editsLimit = Number(limits.edits) || DEFAULT_BATCH_LIMITS.edits;
  const totalLimit = Number(limits.editTotalReplacements) || DEFAULT_BATCH_LIMITS.editTotalReplacements;
  const maxBytes = Number(limits.maxEditableBytes) || DEFAULT_BATCH_LIMITS.maxEditableBytes;
  const detailFiles = Number(limits.failureDetailFiles) || DEFAULT_BATCH_LIMITS.failureDetailFiles;
  if (paths.length > editPaths) return { ok: false, error: 'batch_limit', limit: editPaths, given: paths.length };
  const edits = Array.isArray(args.edits) ? args.edits : [];
  if (edits.length === 0) return { ok: false, error: 'invalid_args', reason: 'edits 不能为空' };
  if (edits.length > editsLimit) return { ok: false, error: 'batch_limit', limit: editsLimit, given: edits.length };
  const plannedTotal = paths.length * edits.length;
  if (plannedTotal > totalLimit) return { ok: false, error: 'batch_limit', limit: totalLimit, given: plannedTotal };
  const allOrNothing = args.all_or_nothing === true;
  const expectedMap = (args.expected_sha256 && typeof args.expected_sha256 === 'object' && !Array.isArray(args.expected_sha256))
    ? args.expected_sha256 : null;

  const runOne = async (rawPath, dryRun) => {
    let abs;
    try { abs = resolvePath(rawPath); } catch (e) {
      return { path: String(rawPath), ok: false, error: 'invalid_args', reason: e.message, candidates: [], nearMisses: [] };
    }
    let st = null;
    try { st = await fsp.stat(abs); } catch { st = null; }
    if (st && st.isDirectory()) {
      return { path: toPosix(abs), ok: false, error: 'invalid_args', reason: '目标是目录，不能按文本编辑', candidates: [], nearMisses: [] };
    }
    if (st && st.isFile() && st.size > maxBytes) {
      return { path: toPosix(abs), ok: false, error: 'file_too_large', reason: `文件大小 ${st.size} 字节超过可编辑上限 ${maxBytes} 字节，已跳过该文件`, candidates: [], nearMisses: [] };
    }
    const fileArgs = { ...args, path: rawPath };
    delete fileArgs.paths;
    delete fileArgs.all_or_nothing;
    if (expectedMap) {
      let found = null;
      for (const k of [rawPath, toPosix(abs)]) {
        if (Object.prototype.hasOwnProperty.call(expectedMap, k)) { found = k; break; }
      }
      if (found != null) fileArgs.expected_sha256 = expectedMap[found];
      else delete fileArgs.expected_sha256;
    }
    const r = await toolEditTextSingle(fileArgs, { dryRun });
    if (!r.ok) {
      return {
        path: toPosix(abs), ok: false, error: r.error, reason: r.reason, ruleId: r.ruleId,
        occurrences: r.occurrences, candidates: r.candidates || [], nearMisses: r.nearMisses || [], hint: r.hint,
        indentChanged: false,
      };
    }
    return {
      path: toPosix(abs),
      ok: true,
      status: r.status,
      alreadyAppliedBy: r.alreadyAppliedBy,
      editsApplied: r.editsApplied,
      matchedBy: r.matchedBy,
      encoding: r.encoding,
      encodingPreserved: r.encodingPreserved,
      bom: r.bom,
      bytesBefore: r.bytesBefore,
      bytesAfter: r.bytesAfter,
      sha256Before: r.sha256Before,
      sha256After: r.sha256After,
      affectedLines: r.affectedLines,
      originalEol: r.originalEol,
      writtenEol: r.writtenEol,
      eolChanged: r.eolChanged,
      indentChanged: r.indentChanged === true,
      ...(r.indentChanged === true ? {
        originalIndent: r.originalIndent,
        newIndent: r.newIndent,
        indentWarning: r.indentWarning,
      } : {}),
    };
  };

  const toFailure = (rec) => ({
    path: rec.path, error: rec.error, reason: rec.reason,
    occurrences: rec.occurrences, candidates: rec.candidates || [], nearMisses: rec.nearMisses || [], hint: rec.hint,
    indentChanged: false,
  });

  const finish = (recs) => {
    let succeeded = 0;
    let failed = 0;
    let skipped = 0;
    let totalReplacements = 0;
    const failures = [];
    for (const r of recs) {
      if (r.ok) { succeeded += 1; totalReplacements += r.editsApplied || 0; continue; }
      failed += 1;
      if (r.error === 'file_too_large') skipped += 1;
      if (failures.length < detailFiles) failures.push(toFailure(r));
    }
    return {
      // 顶层 ok 与 summary 一致：只要有失败条目就为 false（部分成功不再伪装成成功）。
      ok: failed === 0,
      mode: 'batch',
      files: recs,
      summary: { total: recs.length, succeeded, failed, totalReplacements, skipped },
      failures,
    };
  };

  if (allOrNothing) {
    const dry = [];
    for (const p of paths) dry.push(await runOne(p, true));
    const bad = dry.filter((r) => !r.ok);
    if (bad.length) {
      const failures = [];
      for (const r of dry) { if (!r.ok && failures.length < detailFiles) failures.push(toFailure(r)); }
      const files = dry.map((r) => (r.ok
        ? { path: r.path, ok: false, applied: false, error: 'aborted', reason: 'all_or_nothing 预校验失败，整批零写入' }
        : { ...r, applied: false }));
      return {
        ok: false,
        mode: 'batch',
        files,
        summary: {
          total: dry.length, succeeded: 0, failed: bad.length, totalReplacements: 0,
          skipped: dry.filter((r) => r.error === 'file_too_large').length,
          prevalidated: dry.length - bad.length,
        },
        failures,
        aborted: true,
      };
    }
    const recs = [];
    for (const p of paths) recs.push(await runOne(p, false));
    return finish(recs);
  }

  const recs = [];
  for (const p of paths) recs.push(await runOne(p, false));
  return finish(recs);
}

/**
 * 编码探测。顺序：BOM → UTF-8 strict → UTF-16 启发式 → GB18030 → Big5。
 * 说明：纯 ASCII 的 UTF-16 文本同时也是合法 UTF-8，因此 UTF-8 strict 与 UTF-16 启发式都算，
 *      UTF-16 命中时优先；UTF-16 必须排在 GB18030/Big5 之前，否则 41 00 42 00 会被 GB18030 静默解成垃圾。
 * GB18030 与 Big5 的字节常常能互相"无错"解码 → 不假装确定，附带 candidates / uncertain。
 */
function detectEncoding(buf) {
  // ① BOM
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return { enc: 'utf-8', body: buf.subarray(3), bom: true, candidates: ['utf-8'], uncertain: false };
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return { enc: 'utf-16le', body: buf.subarray(2), bom: true, candidates: ['utf-16le'], uncertain: false };
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return { enc: 'utf-16be', body: buf.subarray(2), bom: true, candidates: ['utf-16be'], uncertain: false };
  const gbBom = buf.length >= 4 && buf.subarray(0, 4).equals(GB18030_BOM);
  const body = gbBom ? buf.subarray(4) : buf;

  // ② UTF-8 strict
  let utf8Text = null;
  try { utf8Text = new TextDecoder('utf-8', { fatal: true }).decode(body); } catch { /* not utf-8 */ }

  // ③ 无 BOM 的 UTF-16 启发式（必须排在 GB18030 / Big5 之前）
  const u16 = detectUtf16Heuristic(body);
  if (u16) return { enc: u16, body, bom: false, text: decodeDetected({ enc: u16, body }), candidates: [u16], uncertain: false };

  if (!gbBom && utf8Text !== null) return { enc: 'utf-8', body, bom: false, text: utf8Text, candidates: ['utf-8'], uncertain: false };

  // ④ GB18030 / Big5：两者常能互相无错解码 → 给出候选，不假装确定
  for (const enc of ['gb18030', 'big5']) {
    try {
      const text = new TextDecoder(enc, { fatal: true }).decode(body);
      const other = enc === 'gb18030' ? 'big5' : 'gb18030';
      let ambiguous = false;
      try { new TextDecoder(other, { fatal: true }).decode(body); ambiguous = true; } catch { /* 对方解不了 → 可确定 */ }
      return { enc, body, bom: gbBom, text, candidates: ambiguous ? [enc, other] : [enc], uncertain: ambiguous };
    } catch { /* next */ }
  }
  return { enc: null, body, bom: gbBom, candidates: [], uncertain: false };
}

const READ_CACHE = new Map();
const READ_CACHE_MAX = 256;

// C1：缓存 key 必须能区分「是否给了区间参数」以及归一化后的区间参数，
// 否则 start_byte=0（显式）与「没传」会撞成同一个 key，命中缓存时拿不到续读偏移。
function readCacheKey(target, args, vr) {
  const enc = (args.encoding == null || args.encoding === '') ? 'auto' : String(args.encoding).trim().toLowerCase();
  const p = (v) => (v == null ? '-' : String(v));
  return `${target}|${enc}|${p(vr.startLine)}|${p(vr.count)}|${p(vr.startByte)}|${p(vr.maxBytes)}`;
}

function readCacheGet(key) {
  if (!READ_CACHE.has(key)) return null;
  const v = READ_CACHE.get(key);
  READ_CACHE.delete(key);
  READ_CACHE.set(key, v);
  return v;
}

function readCacheSet(key, val) {
  READ_CACHE.delete(key);
  READ_CACHE.set(key, val);
  while (READ_CACHE.size > READ_CACHE_MAX) READ_CACHE.delete(READ_CACHE.keys().next().value);
}

async function toolReadText(args) {
  let target;
  try { target = resolvePath(args.path); } catch (e) { return { ok: false, error: 'invalid_args', reason: e.message }; }
  // 设备路径阻断：在 realpath 之前按字面路径判定
  if (isDevicePath(target)) {
    return { ok: false, error: 'device_path', denied_by: 'device_path', reason: `拒绝访问设备路径：${toPosix(target)}` };
  }
  const g = await guardPath(target, 'read', {});
  if (!g.ok) return g;
  // B1：区间参数集中校验（read_text 的所有路径共用同一个入口）
  const vr = validateRangeArgs(args);
  if (!vr.ok) return { ok: false, error: vr.error, reason: vr.reason, hint: vr.hint, file: toPosix(target) };
  const rangeRequested = vr.requested;
  const byteParams = vr.startByte != null || vr.maxBytes != null;
  const real = g.real;
  let st;
  try { st = await fsp.stat(real); } catch { return { ok: false, error: 'not_found', reason: `文件不存在：${toPosix(target)}` }; }
  if (st.isDirectory()) return { ok: false, error: 'invalid_args', reason: '目标是目录，不能按文本读取' };
  const key = readCacheKey(real, args, vr);
  const cached = readCacheGet(key);
  if (cached && args.force_read !== true && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    const out = {
      ok: true,
      cached: true,
      unchanged: true,
      file: toPosix(target),
      sha256: cached.sha256,
      totalLines: cached.totalLines,
      totalBytes: cached.totalBytes,
    };
    const unchangedHint = '文件自上次读取后未变化，请直接引用之前的内容；需要完整内容请传 force_read=true';
    // E1：显式 encoding 下的二进制疑似提示也要能随缓存复现
    if (cached.binarySuspected) {
      out.binarySuspected = true;
      out.binarySuspectReason = 'binary_suspected';
    }
    // C1：命中缓存时也回显区间字段（续读链不能断）——byteRange / nextByteOffset /
    // alignmentAdjusted / range / fileBytes 全部要能从缓存复算出来。
    if (rangeRequested) {
      if (cached.rangeInfo) {
        Object.assign(out, cached.rangeInfo);
      } else if (cached.rangeParams) {
        // 兜底：缓存条目里参数不全时，用存下来的区间参数复算最基本的续读字段
        const rp = cached.rangeParams;
        const endByte = cached.fileBytes != null ? cached.fileBytes : (rp.startByte || 0);
        out.fileBytes = cached.fileBytes;
        out.byteRange = { startByte: rp.startByte != null ? rp.startByte : 0, endByte, maxBytes: rp.maxBytes != null ? rp.maxBytes : null };
        out.nextByteOffset = endByte;
        out.alignmentAdjusted = false;
        out.alignmentBackoffBytes = 0;
        out.range = {
          startByte: out.byteRange.startByte,
          endByte,
          maxBytes: rp.maxBytes != null ? rp.maxBytes : null,
          startLine: rp.startLine != null ? rp.startLine : null,
          count: rp.count != null ? rp.count : null,
          returnedCount: 0,
          truncated: false,
          truncatedBy: null,
        };
      }
      out.hint = out.hint || unchangedHint;
    } else {
      out.hint = unchangedHint;
    }
    return out;
  }
  // 显式 encoding：只按该编码解码（跳过候选尝试与二进制嗅探，绝不改判）
  const encSpec = args.encoding == null ? 'auto' : String(args.encoding).trim();
  let explicitEnc = null;
  if (encSpec !== '' && encSpec.toLowerCase() !== 'auto') {
    explicitEnc = ENCODING_ALIASES[encSpec.toLowerCase()];
    if (!explicitEnc) {
      return { ok: false, error: 'invalid_args', reason: `不支持的编码名：${encSpec}（支持 utf-8 / utf-16le / utf-16be / gb18030 / big5，或 auto）`, file: toPosix(target) };
    }
    if ((explicitEnc === 'gb18030' || explicitEnc === 'big5') && !HAS_ICONV) {
      return { ok: false, error: 'dependency_unavailable', reason: unsupportedEncodingMessage(explicitEnc), file: toPosix(target), encoding: explicitEnc, encodingPreserved: false };
    }
  }
  // 二进制嗅探：复用统一的二进制探测（read_text / find_files / count_text 共用同一套逻辑）。
  // E1：显式 encoding 时也照常嗅探，但**只提示、不改判**——编码判定与解码行为保持原样；
  // 未显式指定 encoding 时维持原行为：判为二进制直接返回 binary:true。
  const headBytes = await readHeadBytes(real);
  const binarySuspected = isBinaryHead(headBytes);
  if (!explicitEnc && binarySuspected) {
    const sha = await sha256File(real);
    return { ok: true, binary: true, file: toPosix(target), bytes: st.size, sha256: sha, reason: 'binary_detected' };
  }
  let buf;
  try { buf = await fsp.readFile(real); } catch (e) { return { ok: false, error: 'io_error', reason: `读取失败：${e.message}` }; }
  let det;
  if (explicitEnc) {
    const sb = stripBom(buf, explicitEnc);
    det = { enc: explicitEnc, body: sb.body, bom: sb.bom, candidates: [explicitEnc], uncertain: false };
  } else {
    det = detectEncoding(buf);
  }
  if (!det.enc) return { ok: false, error: 'binary', reason: '无法识别文本编码（UTF-8 / UTF-16 / GB18030 / Big5 均解码失败）', file: toPosix(target) };
  const text = decodeDetected(det);
  const all = text.split('\n');
  // 空文件：行数口径与 count_text 对齐（0 行，而不是 1 行）
  const contentLines = text === '' ? [] : (text.endsWith('\n') ? all.slice(0, -1) : all);
  const totalLines = contentLines.length;
  const totalBytes = buf.length;
  const fileBytes = buf.length;
  const bomLen = buf.length - det.body.length;
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  const caps = loadConfig().readCaps;
  const capsMaxBytes = Math.max(1, Number(caps.maxBytes) || DEFAULT_READ_CAPS.maxBytes);
  const capsMaxLines = Math.max(1, Number(caps.maxLines) || DEFAULT_READ_CAPS.maxLines);
  const total = text.length;
  const replacement = (text.match(/\uFFFD/g) || []).length;
  let res;
  let rangeInfo = null;

  if (byteParams) {
    // B3：字节区间读只支持 UTF-8/ASCII；非 UTF-8 一律 invalid_args（绝不静默换口径）
    if (det.enc !== 'utf-8') {
      const msg = `字节区间读仅支持 UTF-8/ASCII（该文件为 ${det.enc}）。请改用 start_line + count 按行读取——行区间对所有编码都支持。`;
      return { ok: false, error: 'invalid_args', reason: msg, hint: msg, file: toPosix(target), encoding: det.enc };
    }
    // C2：生效上限 = min(用户 max_bytes, readCaps.maxBytes, HARD_CAP)；被 caps 削过时回 cappedBy
    let effMaxBytes = vr.maxBytes != null ? vr.maxBytes : capsMaxBytes;
    let cappedBy = null;
    if (effMaxBytes > capsMaxBytes) { effMaxBytes = capsMaxBytes; cappedBy = 'readCaps'; }
    if (effMaxBytes > HARD_CAP) { effMaxBytes = HARD_CAP; cappedBy = cappedBy || 'readCaps'; }
    const bw = buildByteWindow({
      text,
      enc: det.enc,
      body: det.body,
      bomLen,
      startByte: vr.startByte != null ? vr.startByte : 0,
      maxBytes: effMaxBytes,
      count: vr.count,
      startLine: vr.startLine,
    });
    const rangeBytes = Math.max(0, bw.byteRange.endByte - bw.byteRange.startByte);
    res = {
      ok: true,
      file: toPosix(target),
      encoding: det.enc,
      encodingCandidates: det.candidates && det.candidates.length ? det.candidates : [det.enc],
      encodingUncertain: det.uncertain === true,
      bom: det.bom,
      bytes: rangeBytes,
      fileBytes,
      totalBytes,
      totalLines,
      returnedLines: bw.returnedLines,
      characters: total,
      returnedCharacters: bw.slice.length,
      replacementChars: replacement,
      sha256: sha,
      text: bw.slice,
      truncated: bw.truncated,
      nextByteOffset: bw.nextByteOffset,
      byteRange: { startByte: bw.byteRange.startByte, endByte: bw.nextByteOffset, maxBytes: effMaxBytes },
      alignmentAdjusted: bw.backoff > 0,
      alignmentBackoffBytes: bw.backoff,
      range: {
        startByte: bw.byteRange.startByte,
        endByte: bw.nextByteOffset,
        maxBytes: effMaxBytes,
        startLine: bw.firstLine,
        count: vr.count != null ? vr.count : null,
        returnedCount: bw.returnedLines,
        truncated: bw.truncated,
        truncatedBy: bw.truncatedBy,
      },
    };
    if (bw.truncated) res.truncatedBy = bw.truncatedBy;
    if (cappedBy) res.cappedBy = cappedBy;
    if (bw.lineTruncated) {
      res.lineTruncated = true;
      res.truncatedLine = bw.truncatedLine;
      res.truncatedLineBytes = bw.truncatedLineBytes;
    }
    if (bw.nextStartLine != null) res.nextStartLine = bw.nextStartLine;
    if (bw.howToContinue) res.howToContinue = bw.howToContinue;
    // B2：起点越界 → 空结果（ok:true + emptyRange + rangeOutOfBounds + hint；不是错误）
    if (vr.startByte != null && vr.startByte >= fileBytes) {
      res.text = '';
      res.bytes = 0;
      res.returnedLines = 0;
      res.returnedCharacters = 0;
      res.truncated = false;
      res.truncatedBy = undefined;
      res.emptyRange = true;
      res.rangeOutOfBounds = true;
      res.startByteOutOfRange = true;
      res.reason = `起点超出文件长度：start_byte=${vr.startByte} ≥ 文件长度 ${fileBytes} 字节`;
      res.hint = `文件仅 ${fileBytes} 字节；start_byte=${vr.startByte} 超出范围，本次没有内容可返回。`;
      res.nextByteOffset = fileBytes;
      res.byteRange = { startByte: vr.startByte, endByte: vr.startByte, maxBytes: effMaxBytes };
      res.range.startByte = vr.startByte;
      res.range.endByte = vr.startByte;
      res.range.returnedCount = 0;
      res.range.truncated = false;
      res.range.truncatedBy = null;
      delete res.howToContinue;
      delete res.nextStartLine;
    }
    if (det.uncertain === true) {
      res.warning = `编码存在歧义：${(det.candidates || []).join(' / ')} 都能无错解码，当前按 ${det.enc} 解码；若内容不对请显式传 encoding 参数指定`;
    }
    if (replacement > 0) res.warning = `文本含 ${replacement} 个 U+FFFD 替换字符，原始编码可能有损`;
    rangeInfo = {
      bytes: res.bytes,
      fileBytes,
      byteRange: res.byteRange,
      nextByteOffset: res.nextByteOffset,
      alignmentAdjusted: res.alignmentAdjusted,
      alignmentBackoffBytes: res.alignmentBackoffBytes,
      range: res.range,
      truncated: res.truncated,
    };
    if (res.truncatedBy) rangeInfo.truncatedBy = res.truncatedBy;
    if (res.emptyRange) { rangeInfo.emptyRange = true; rangeInfo.rangeOutOfBounds = true; rangeInfo.hint = res.hint; }
    if (res.cappedBy) rangeInfo.cappedBy = res.cappedBy;
  } else {
    // —— 行区间 / 旧路径：不传区间参数时行为与旧版逐字一致 ——
    const start = vr.startLine != null ? vr.startLine : 1;
    const maxLines = capsMaxLines;
    const maxBytes = capsMaxBytes;
    const fullRead = !rangeRequested;
    const trailingNewline = fullRead && text.endsWith('\n');
    // 字节硬上限：返回正文不得超过 readCaps.maxBytes（默认 64 KiB）——超长单行在行内截断
    const budgetBytes = trailingNewline ? Math.max(1, maxBytes - 1) : maxBytes;
    const lineBudget = vr.count != null ? vr.count : maxLines;
    const slice = [];
    let used = 0;
    let truncated = false;
    let truncatedBy = null;
    let nextStartLine = undefined;
    let lineTruncated = false;
    let truncatedLine = null;
    let truncatedLineBytes = 0;
    let lastCut = null;
    for (let i = start - 1; i < contentLines.length && slice.length < lineBudget; i++) {
      const line = contentLines[i];
      const lb = Buffer.byteLength(line, 'utf8');
      if (used + lb + 1 <= budgetBytes) { slice.push(line); used += lb + 1; continue; }
      const room = budgetBytes - used;
      if (room > 1) {
        const cut = truncateUtf8(line, room - 1);
        slice.push(cut);
        lastCut = cut;
        used += Buffer.byteLength(cut, 'utf8') + 1;
        lineTruncated = true;
        truncatedLine = i + 1;
        truncatedLineBytes = lb - Buffer.byteLength(cut, 'utf8');
      } else {
        truncatedLineBytes = lb;
      }
      truncated = true;
      truncatedBy = 'max_bytes';
      nextStartLine = lineTruncated ? (i + 2) : (i + 1);
      break;
    }
    if (!truncated && vr.count != null && slice.length >= lineBudget && start - 1 + slice.length < contentLines.length) {
      truncated = true;
      truncatedBy = 'max_lines';
      nextStartLine = start + slice.length;
    }
    if (!truncated && vr.count == null && slice.length < contentLines.length - (start - 1)) {
      truncated = true;
      truncatedBy = 'max_lines';
      nextStartLine = start + slice.length;
    }
    const outText = slice.join('\n') + (trailingNewline ? '\n' : '');
    res = {
      ok: true,
      file: toPosix(target),
      encoding: det.enc,
      encodingCandidates: det.candidates && det.candidates.length ? det.candidates : [det.enc],
      encodingUncertain: det.uncertain === true,
      bom: det.bom,
      bytes: buf.length,
      totalBytes,
      totalLines,
      returnedLines: slice.length,
      characters: total,
      replacementChars: replacement,
      sha256: sha,
      text: outText,
    };
    if (lineTruncated) {
      res.lineTruncated = true;
      res.truncatedLine = truncatedLine;
      res.truncatedLineBytes = truncatedLineBytes;
    }
    if (truncated) { res.truncated = true; res.nextStartLine = nextStartLine; }
    // 区间模式：补 range / bytes / fileBytes（不传区间参数时逐字不变）
    if (rangeRequested) {
      const sIdx = charIndexOfLine(text, start);
      let eIdx;
      if (slice.length === 0) eIdx = sIdx;
      else if (lineTruncated) eIdx = charIndexOfLine(text, start + slice.length - 1) + (lastCut ? lastCut.length : 0);
      else eIdx = charIndexOfLine(text, start + slice.length);
      const byteStart = bomLen + sourceOffsetOfIndex(text, sIdx, det.enc);
      const byteEnd = bomLen + sourceOffsetOfIndex(text, eIdx, det.enc);
      const rangeBytes = Math.max(0, byteEnd - byteStart);
      const outOfBounds = vr.startLine != null && vr.startLine > totalLines;
      res.bytes = rangeBytes;
      res.fileBytes = fileBytes;
      res.byteRange = { startByte: byteStart, endByte: byteEnd, maxBytes: null };
      res.lineRange = { startLine: start, endLine: slice.length === 0 ? start : start + slice.length - 1 };
      res.range = {
        startByte: byteStart,
        endByte: byteEnd,
        maxBytes: null,
        startLine: start,
        count: vr.count != null ? vr.count : null,
        returnedCount: slice.length,
        truncated: truncated,
        truncatedBy: truncatedBy,
      };
      if (truncated) res.truncatedBy = truncatedBy;
      if (outOfBounds) {
        // B2：起点越界 → 空结果（ok:true + emptyRange + rangeOutOfBounds + hint；不是错误）
        res.truncated = false;
        delete res.truncatedBy;
        delete res.nextStartLine;
        res.emptyRange = true;
        res.rangeOutOfBounds = true;
        res.hint = `文件仅 ${totalLines} 行；start_line=${vr.startLine} 超出范围，本次没有内容可返回。`;
        res.range.truncated = false;
        res.range.truncatedBy = null;
        res.range.returnedCount = 0;
      }
      rangeInfo = {
        bytes: res.bytes,
        fileBytes,
        byteRange: res.byteRange,
        nextByteOffset: byteEnd,
        alignmentAdjusted: false,
        alignmentBackoffBytes: 0,
        range: res.range,
        truncated: res.truncated,
      };
      if (res.truncatedBy) rangeInfo.truncatedBy = res.truncatedBy;
      if (res.emptyRange) { rangeInfo.emptyRange = true; rangeInfo.rangeOutOfBounds = true; rangeInfo.hint = res.hint; }
    }
    if (det.uncertain === true) {
      res.warning = `编码存在歧义：${(det.candidates || []).join(' / ')} 都能无错解码，当前按 ${det.enc} 解码；若内容不对请显式传 encoding 参数指定`;
    }
    if (replacement > 0) res.warning = `文本含 ${replacement} 个 U+FFFD 替换字符，原始编码可能有损`;
  }
  // E1：显式 encoding 下的二进制疑似提示（只提示，不改判编码与解码结果）
  if (binarySuspected) {
    res.binarySuspected = true;
    res.binarySuspectReason = 'binary_suspected';
  }
  readCacheSet(key, {
    mtimeMs: st.mtimeMs, size: st.size, sha256: sha,
    totalLines, totalBytes, fileBytes, encoding: det.enc, rangeInfo,
    binarySuspected,
    // C1：把区间参数一并存进缓存条目，命中缓存时可复算续读字段
    rangeParams: rangeRequested
      ? { startByte: vr.startByte, maxBytes: vr.maxBytes, startLine: vr.startLine, count: vr.count }
      : null,
  });
  return res;
}

/**
 * E3：统一的文件过滤谓词（find_files 的目录模式与单文件模式共用同一份语义）。
 * item: { name, ext, size, mtimeMs }；filters: { nameRe, exts, after, before, minSize, maxSize, withinMs }
 */
function matchesFileFilters(item, filters) {
  const f = filters || {};
  if (f.nameRe && !f.nameRe.test(item.name)) return false;   // C3：只匹配文件名（basename）
  if (f.exts && !f.exts.includes(item.ext)) return false;
  if (f.after != null && item.mtimeMs < f.after) return false;
  if (f.before != null && item.mtimeMs > f.before) return false;
  if (f.minSize != null && item.size < f.minSize) return false;
  if (f.maxSize != null && item.size > f.maxSize) return false;
  if (f.withinMs != null && item.mtimeMs < Date.now() - f.withinMs) return false;
  return true;
}

async function toolFindFiles(args) {
  const root = resolvePath(args.root);
  const limit = args.limit != null ? Math.max(1, Number(args.limit)) : 200;
  const f = args.filters || {};
  // modified_within：相对时间窗（"24h" / "7d" / "30d"）；与绝对时间区间（modified_after / modified_before）取交集。
  const withinSpec = args.modified_within != null ? args.modified_within : f.modified_within;
  let withinMs = null;
  if (withinSpec != null && withinSpec !== '') {
    withinMs = parseWithinSpec(withinSpec);
    if (withinMs == null) {
      return { ok: false, error: 'invalid_args', reason: `modified_within 无法解析：${JSON.stringify(String(withinSpec))}（示例 "24h" / "7d" / "30d"）` };
    }
  }
  const namePattern = f.name_pattern == null || f.name_pattern === '' ? null : String(f.name_pattern);
  // C3：name_pattern 只匹配文件名（basename）；带路径分隔符 → invalid_args
  if (namePattern != null && /[\\/]/.test(namePattern)) {
    const msg = 'name_pattern 只匹配文件名；想限定目录请用 root，想读某个已知路径请用 read_text。';
    return { ok: false, error: 'invalid_args', reason: msg, hint: msg };
  }
  // name_pattern 不含通配符 → 按裸子串匹配（敏感度与现有 glob 一致）；
  // 含通配符（* / ?）→ 走原有 glob 语义，行为不变。两者都只作用于文件名。
  const nameRe = namePattern == null ? null
    : (/[*?]/.test(namePattern)
      ? globToRegex(namePattern, false)
      : new RegExp(globToRegex(namePattern, false).source.replace(/^\^/, '').replace(/\$$/, ''), 'i'));
  const exts = Array.isArray(f.extensions) ? f.extensions.map((e) => String(e).replace(/^\./, '').toLowerCase()) : null;
  const after = f.modified_after ? Date.parse(f.modified_after) : null;
  const before = f.modified_before ? Date.parse(f.modified_before) : null;
  const minSize = f.min_size != null ? Number(f.min_size) : null;
  const maxSize = f.max_size != null ? Number(f.max_size) : null;
  const recursive = f.recursive !== false;
  // E3：统一的过滤谓词参数（目录模式与单文件模式共用）。
  const filters = { nameRe, exts, after, before, minSize, maxSize, withinMs };
  const results = [];
  let truncated = false;
  let skipped = 0;
  const budget = newScanBudget();
  const skippedBy = {};
  const skippedSamples = [];
  const skip = (reason, p, ruleId) => {
    skipped += 1;
    skippedBy[reason] = (skippedBy[reason] || 0) + 1;
    if (skippedSamples.length < 20) skippedSamples.push({ path: toPosix(p), reason, ruleId: ruleId || undefined });
  };
  async function walk(dir, depth) {
    if (depth > 24) return;
    if (budget.exceeded) return;
    let items;
    try { items = await fsp.readdir(dir, { withFileTypes: true }); } catch {
      // 不可读目录（EACCES/EPERM 等）不再静默：计入 skippedBy.unreadable；
      // 命中敏感规则的条目只记 reason，不带 path（README：敏感样本不得带路径）。
      skipped += 1;
      skippedBy.unreadable = (skippedBy.unreadable || 0) + 1;
      if (skippedSamples.length < 20) {
        skippedSamples.push(checkProtected(dir, 'read') ? { reason: 'unreadable' } : { path: toPosix(dir), reason: 'unreadable' });
      }
      return;
    }
    for (const item of items) {
      if (budget.exceeded) return;
      const full = path.join(dir, item.name);
      // E4：scanned = 访问过的条目数（含随后被跳过的条目：受保护目录 / 二进制 / 过滤不中）。
      budget.scanned += 1;
      if (scanBudgetHit(budget)) return;
      if (item.isDirectory()) {
        if (!recursive) continue;
        const hit = protectedDirSkip(full);
        if (hit) { skip('protected', full, hit.id); continue; }
        await walk(full, depth + 1);
        continue;
      }
      if (!item.isFile()) continue;
      let st;
      try { st = await fsp.stat(full); } catch { continue; }
      const posix = toPosix(full);
      const ext = path.extname(item.name).replace(/^\./, '').toLowerCase();
      // E3：目录模式与单文件模式共用同一个过滤谓词（name_pattern / 扩展名 / 大小 / 时间窗）。
      if (!matchesFileFilters({ name: item.name, ext, size: st.size, mtimeMs: st.mtimeMs }, filters)) continue;
      const prot = checkProtected(full, 'read');
      if (prot) { skip('protected', full, prot.id); continue; }
      const fhead = await readHeadBytes(full);
      if (isBinaryHead(fhead)) { skip('binary', full); continue; }
      if (results.length >= limit) { truncated = true; return; }
      results.push({ path: posix, bytes: st.size, mtime: st.mtime.toISOString(), extension: ext });
    }
  }
  if (!fs.existsSync(root)) return { ok: false, error: 'not_found', reason: `根路径不存在：${toPosix(root)}` };
  const rootGuard = await guardPath(root, 'list', {});
  if (!rootGuard.ok) return rootGuard;
  const rootStat = fs.statSync(root);
  if (rootStat.isFile()) {
    // E3：单文件模式与目录模式共用同一个过滤谓词；不匹配 → ok:true + count:0（不是报错）。
    const ext = path.extname(root).replace(/^\./, '').toLowerCase();
    // E4：单文件模式同样把“访问过的条目”计入 scanned。
    budget.scanned += 1;
    if (matchesFileFilters({ name: path.basename(root), ext, size: rootStat.size, mtimeMs: rootStat.mtimeMs }, filters)) {
      results.push({ path: toPosix(root), bytes: rootStat.size, mtime: rootStat.mtime.toISOString(), extension: ext });
    }
  } else {
    await walk(root, 0);
  }
  if (budget.exceeded) {
    return scanLimitResult(budget, {
      root: toPosix(root), count: results.length, resultLimit: limit, truncated: true,
      files: results, skipped, skippedBy, skippedSamples,
    });
  }
  return { ok: true, root: toPosix(root), count: results.length, limit, truncated, ...(truncated ? { truncatedBy: 'limit' } : {}), files: results, skipped, skippedBy, skippedSamples, scanned: budget.scanned };
}

/* --------------------------- count_text：文本统计 --------------------------- */

const COUNT_MAX_FILES = 200;
const COUNT_MAX_BYTES = 200 * 1024 * 1024;
const COUNT_DIMS = ['lines', 'paragraphs', 'sentences', 'words', 'graphemes', 'codepoints', 'utf16Units', 'han', 'kana', 'hangul', 'latin', 'letters', 'digits', 'spaces', 'punctuation', 'symbols', 'nonWhitespace'];
const COUNT_TEXT_EXTENSIONS = new Set(['md', 'markdown', 'txt', 'text', 'json', 'jsonc', 'json5', 'csv', 'tsv', 'log', 'ini', 'cfg', 'conf', 'toml', 'yaml', 'yml', 'xml', 'html', 'htm', 'css', 'scss', 'less', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'mts', 'cts', 'py', 'pyi', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'c', 'h', 'cc', 'cpp', 'hpp', 'hxx', 'cs', 'php', 'pl', 'pm', 'sh', 'bash', 'zsh', 'fish', 'bat', 'cmd', 'ps1', 'sql', 'vue', 'svelte', 'swift', 'scala', 'lua', 'tex', 'bib', 'patch', 'diff', 'rst']);

const CJK_CLASS = '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}';
const RE_CJK_ONLY = new RegExp('^[' + CJK_CLASS + ']+$', 'u');
const RE_TOKENS = new RegExp('[' + CJK_CLASS + ']+|[^\\s\\p{P}\\p{S}' + CJK_CLASS + ']+', 'gu');
const RE_HAN = /\p{Script=Han}/gu;
const RE_KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/gu;
const RE_HANGUL = /\p{Script=Hangul}/gu;
const RE_LATIN = /\p{Script=Latin}/gu;
const RE_LETTER = /\p{L}/gu;
const RE_DIGIT = /\p{Nd}/gu;
const RE_SPACE = /\s/gu;
const RE_PUNCT = /\p{P}/gu;
const RE_SYMBOL = /\p{S}/gu;
const RE_NONWS = /\S/gu;

function countMatches(re, s) { const m = s.match(re); return m ? m.length : 0; }

/** CJK 分词（Intl.Segmenter；不可用时退化为字符数）。 */
function segmentCjkWords(token, cache) {
  let locale = 'zh';
  if (/\p{Script=Hangul}/u.test(token)) locale = 'ko';
  else if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(token)) locale = 'ja';
  let seg = cache.get(locale);
  if (seg === undefined) {
    try { seg = new Intl.Segmenter(locale, { granularity: 'word' }); } catch { seg = null; }
    cache.set(locale, seg);
  }
  if (!seg) return token.length;
  let n = 0;
  for (const s of seg.segment(token)) if (s.isWordLike) n += 1;
  return n;
}

/** 统计一段文本的全部维度。 */
function countStats(rawText, opts = {}) {
  const wordsForCjk = opts.wordsForCjk === true;
  let text = String(rawText == null ? '' : rawText);
  const bom = text.startsWith('\uFEFF') ? 1 : 0;
  if (bom) text = text.slice(1);
  const norm = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const rawLines = norm.split('\n');
  const lines = norm.length === 0 ? 0 : (norm.endsWith('\n') ? rawLines.length - 1 : rawLines.length);
  const paragraphs = norm.split(/\n[ \t]*\n+/).filter((b) => b.trim() !== '').length;
  const flat = norm.replace(/\s+/g, ' ').trim();
  const sentences = flat ? flat.split(/(?<=[.!?。！？…])/u).map((s) => s.trim()).filter(Boolean).length : 0;
  const cache = new Map();
  let words = 0;
  for (const tok of (flat.match(RE_TOKENS) || [])) {
    if (RE_CJK_ONLY.test(tok)) { if (wordsForCjk) words += segmentCjkWords(tok, cache); }
    else words += 1;
  }
  let graphemes = 0;
  try {
    const gs = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    for (const _ of gs.segment(norm)) graphemes += 1;
  } catch { graphemes = Array.from(norm).length; }
  return {
    lines, paragraphs, sentences, words, graphemes,
    codepoints: Array.from(norm).length,
    utf16Units: norm.length,
    han: countMatches(RE_HAN, norm),
    kana: countMatches(RE_KANA, norm),
    hangul: countMatches(RE_HANGUL, norm),
    latin: countMatches(RE_LATIN, norm),
    letters: countMatches(RE_LETTER, norm),
    digits: countMatches(RE_DIGIT, norm),
    spaces: countMatches(RE_SPACE, norm),
    punctuation: countMatches(RE_PUNCT, norm),
    symbols: countMatches(RE_SYMBOL, norm),
    nonWhitespace: countMatches(RE_NONWS, norm),
    bom,
  };
}

/* ---------------------- count_text 区间统计：与 read_text 共用 computeRangeWindow（同一份实现） ---------------------- */

async function toolCountText(args) {
  const hasPaths = Array.isArray(args.paths) && args.paths.length > 0;
  const hasText = typeof args.text === 'string';
  if (hasPaths && hasText) return { ok: false, error: 'invalid_args', reason: 'paths 与 text 互斥：只能二选一' };
  if (!hasPaths && !hasText) return { ok: false, error: 'invalid_args', reason: '必须给 paths（文件或目录）或 text（文本段）之一' };
  // B1：区间参数集中校验（与 read_text 同一个入口）
  const vr = validateRangeArgs(args, { mode: hasText ? 'text' : 'files' });
  if (!vr.ok) return { ok: false, error: vr.error, reason: vr.reason, hint: vr.hint };
  const { startByte, maxBytes, startLine, count } = vr;
  const rangeRequested = vr.requested;
  const byteParams = startByte != null || maxBytes != null;
  // 不给区间参数 → 旧路径逐字不变
  if (!rangeRequested) return await toolCountTextBase(args);
  const wordsForCjk = args.wordsForCjk === true;
  // 目录模式不支持区间：先扫一遍 paths，发现目录即报 invalid_args
  for (const raw of args.paths) {
    let target;
    try { target = resolvePath(raw); } catch { continue; }
    let st;
    try { st = await fsp.stat(target); } catch { continue; }
    if (st.isDirectory()) {
      return { ok: false, error: 'invalid_args', reason: '目录模式不支持区间参数（start_byte / max_bytes / start_line / count），请对单个文件使用' };
    }
  }
  let skipped = 0;
  const skippedBy = {};
  const skippedDetails = [];
  const skip = (reason, p) => {
    skipped += 1;
    skippedBy[reason] = (skippedBy[reason] || 0) + 1;
    if (skippedDetails.length < 20) skippedDetails.push({ path: toPosix(p), reason });
  };
  const candidates = [];
  const seen = new Set();
  for (const raw of args.paths) {
    let target;
    try { target = resolvePath(raw); } catch (e) { skip('invalid_path', String(raw)); continue; }
    let st;
    try { st = await fsp.stat(target); } catch { skip('not_found', target); continue; }
    if (st.isDirectory()) {
      return { ok: false, error: 'invalid_args', reason: '目录模式不支持区间参数（start_byte / max_bytes / start_line / count），请对单个文件使用' };
    }
    const g = await guardPath(target, 'read', {});
    if (!g.ok) { skip('protected', target); continue; }
    const key = toPosix(g.real);
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(g.real);
  }
  if (candidates.length > COUNT_MAX_FILES) {
    return {
      ok: false, error: 'batch_limit',
      reason: `文件数超出上限：最多 ${COUNT_MAX_FILES} 个文件，实际 ${candidates.length} 个`,
      limit: COUNT_MAX_FILES, given: candidates.length, skipped, skippedBy,
    };
  }
  let totalBytes = 0;
  for (const p of candidates) { try { totalBytes += (await fsp.stat(p)).size; } catch { /* ignore */ } }
  if (totalBytes > COUNT_MAX_BYTES) {
    return {
      ok: false, error: 'file_too_large',
      reason: `总体积超出上限：最多 ${COUNT_MAX_BYTES} 字节，实际 ${totalBytes} 字节`,
      limit: COUNT_MAX_BYTES, given: totalBytes, skipped, skippedBy,
    };
  }
  const agg = {};
  for (const k of COUNT_DIMS) agg[k] = 0;
  let aggBytes = 0;
  let aggFileBytes = 0;
  const details = [];
  const encodings = {};
  for (const p of candidates) {
    let buf;
    try { buf = await fsp.readFile(p); } catch { skip('io_error', p); continue; }
    const head0 = buf.subarray(0, 8192);
    if (isBinaryHead(head0)) { skip('binary', p); continue; }
    const det = detectEncoding(buf);
    if (!det.enc) { skip('undecodable', p); continue; }
    // B3：字节区间只支持 UTF-8/ASCII；非 UTF-8 一律 invalid_args（绝不静默换口径）
    if (byteParams && det.enc !== 'utf-8') {
      const msg = `字节区间读仅支持 UTF-8/ASCII（该文件为 ${det.enc}）。请改用 start_line + count 按行读取——行区间对所有编码都支持。`;
      return { ok: false, error: 'invalid_args', reason: msg, hint: msg, file: toPosix(p), encoding: det.enc };
    }
    const text = decodeDetected(det);
    const bomLen = buf.length - det.body.length;
    // A3：与 read_text 共用同一套区间计算
    // 终审 #6：行区间起点越界的判定口径与 read_text 完全一致（totalLines = 不含末尾空行的实际行数）
    const fileTotalLines = text === '' ? 0 : (text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length);
    const w = computeRangeWindow({ text, enc: det.enc, body: det.body, bomLen, startByte, maxBytes, startLine, count });
    const dims = countStats(w.slice, { wordsForCjk });
    for (const k of COUNT_DIMS) agg[k] += dims[k];
    const rangeBytes = Math.max(0, w.byteRange.endByte - w.byteRange.startByte);
    aggBytes += rangeBytes;
    aggFileBytes += buf.length;
    const oob = startByte != null && startByte >= buf.length;
    // 终审 #6：start_line 越界 → 与 read_text 同款 emptyRange / rangeOutOfBounds / hint（不是错误、不夹取）
    const lineOob = startLine != null && startLine > fileTotalLines;
    const rec = {
      path: toPosix(p), encoding: det.enc,
      encodingCandidates: det.candidates && det.candidates.length ? det.candidates : [det.enc],
      encodingUncertain: det.uncertain === true,
      bytes: rangeBytes, fileBytes: buf.length, fileTotalLines,
      byteRange: w.byteRange, lineRange: w.lineRange,
      returnedLines: w.returnedLines,
      truncated: w.truncated, truncatedBy: w.truncatedBy,
      alignmentAdjusted: w.backoff > 0, alignmentBackoffBytes: w.backoff,
      replacementChars: (w.slice.match(/\uFFFD/g) || []).length,
    };
    if (oob) { rec.emptyRange = true; rec.rangeOutOfBounds = true; rec.oobKind = 'byte'; }
    if (lineOob) {
      rec.emptyRange = true;
      rec.rangeOutOfBounds = true;
      rec.oobKind = 'line';
      rec.hint = `文件仅 ${fileTotalLines} 行；start_line=${startLine} 超出范围，本次没有内容可统计。`;
      rec.lineRange = { startLine, endLine: startLine };
      rec.returnedLines = 0;
      rec.truncated = false;
      rec.truncatedBy = null;
    }
    for (const k of COUNT_DIMS) rec[k] = dims[k];
    rec.bom = det.bom ? 1 : 0;
    details.push(rec);
    encodings[toPosix(p)] = det.enc;
  }
  const encList = Object.values(encodings);
  const encoding = encList.length === 0 ? null : (new Set(encList).size === 1 ? encList[0] : 'mixed');
  agg.bom = details.reduce((n, d) => n + d.bom, 0);
  const truncDetail = details.find((d) => d.truncated);
  const anyTrunc = !!truncDetail;
  const out = {
    ok: true, mode: 'files', files: details.length,
    ...agg,
    bytes: aggBytes,
    fileBytes: aggFileBytes,
    encoding, encodings,
    wordsForCjk,
    skipped, skippedBy, skippedDetails,
    details,
    paths: details.map((d) => d.path),
    rangeApplied: true,
    range: {
      startByte: startByte != null ? startByte : null,
      endByte: details.length === 1 ? details[0].byteRange.endByte : null,
      maxBytes: maxBytes != null ? maxBytes : null,
      startLine: startLine != null ? startLine : null,
      count: count != null ? count : null,
      returnedCount: agg.lines,
      truncated: anyTrunc,
      truncatedBy: anyTrunc ? (truncDetail.truncatedBy || null) : null,
    },
  };
  if (anyTrunc) out.truncatedBy = truncDetail.truncatedBy || null;
  // E2：多文件时在顶层给出聚合信息（对齐信息 + 编码歧义警告），details 保留逐文件明细。
  if (details.length > 1) {
    out.alignmentAdjustedAny = details.some((d) => d.alignmentAdjusted === true);
  }
  const uncertainDetails = details.filter((d) => d.encodingUncertain === true);
  if (uncertainDetails.length > 0) {
    out.encodingUncertain = true;
    out.warning = uncertainDetails.length === 1
      ? `编码存在歧义：${(uncertainDetails[0].encodingCandidates || []).join(' / ')} 都能无错解码，当前按 ${uncertainDetails[0].encoding} 解码；若内容不对请显式传 encoding 参数指定`
      : `编码存在歧义：${uncertainDetails.length} 个文件存在编码歧义（如 ${[...new Set(uncertainDetails.flatMap((d) => d.encodingCandidates || []))].join(' / ')} 都能无错解码），当前按各文件检测结果解码；若内容不对请显式传 encoding 参数指定`;
  }
  if (details.length === 1) {
    out.byteRange = details[0].byteRange;
    out.lineRange = details[0].lineRange;
    out.alignmentAdjusted = details[0].alignmentAdjusted;
    out.alignmentBackoffBytes = details[0].alignmentBackoffBytes;
    out.replacementChars = details[0].replacementChars;
    out.rangeNote = `区间统计：字节 [${details[0].byteRange.startByte}, ${details[0].byteRange.endByte})，行 [${details[0].lineRange.startLine}, ${details[0].lineRange.endLine}]；各维度与 bytes 只针对该区间（bytes=区间字节数，fileBytes=整文件字节数）`;
    if (details[0].emptyRange) {
      out.emptyRange = true;
      out.rangeOutOfBounds = true;
      out.hint = details[0].oobKind === 'line'
        ? `文件仅 ${details[0].fileTotalLines} 行；start_line=${startLine} 超出范围，本次没有内容可统计。`
        : `文件仅 ${details[0].fileBytes} 字节；start_byte=${startByte} 超出范围，本次没有内容可统计。`;
      if (details[0].oobKind === 'line') {
        out.truncated = false;
        out.truncatedBy = undefined;
        if (out.range) { out.range.truncated = false; out.range.truncatedBy = null; out.range.returnedCount = 0; }
      }
    }
  } else {
    out.rangeNote = '区间统计：各维度与 bytes 只针对命中区间（bytes=区间字节数，fileBytes=整文件字节数）；每个文件的 byteRange / lineRange 见 details';
  }
  return out;
}

/* ---------------------- count_text 基础实现（无区间参数时逐字不变） ---------------------- */

async function toolCountTextBase(args) {
  const hasPaths = Array.isArray(args.paths) && args.paths.length > 0;
  const hasText = typeof args.text === 'string';
  if (hasPaths && hasText) return { ok: false, error: 'invalid_args', reason: 'paths 与 text 互斥：只能二选一' };
  if (!hasPaths && !hasText) return { ok: false, error: 'invalid_args', reason: '必须给 paths（文件或目录）或 text（文本段）之一' };
  const wordsForCjk = args.wordsForCjk === true;
  if (hasText) {
    const dims = countStats(args.text, { wordsForCjk });
    return {
      ok: true, mode: 'text', files: 0,
      ...dims,
      bytes: Buffer.byteLength(args.text, 'utf8'),
      encoding: 'utf-8',
      wordsForCjk,
      skipped: 0, skippedBy: {}, skippedDetails: [],
    };
  }
  const recursive = args.recursive !== false;
  let skipped = 0;
  const skippedBy = {};
  const skippedDetails = [];
  const skip = (reason, p) => {
    skipped += 1;
    skippedBy[reason] = (skippedBy[reason] || 0) + 1;
    if (skippedDetails.length < 20) skippedDetails.push({ path: toPosix(p), reason });
  };
  const candidates = [];
  const seen = new Set();
  const pushFile = (p) => {
    const key = toPosix(p);
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(p);
  };
  async function collectDir(dir) {
    let list;
    try { list = await fsp.readdir(dir, { withFileTypes: true }); } catch {
      // 不可读目录不再静默：计入 skippedBy.unreadable；敏感条目样本不带 path。
      skipped += 1;
      skippedBy.unreadable = (skippedBy.unreadable || 0) + 1;
      if (skippedDetails.length < 20) {
        skippedDetails.push(checkProtected(dir, 'read') ? { reason: 'unreadable' } : { path: toPosix(dir), reason: 'unreadable' });
      }
      return;
    }
    list.sort((a, b) => a.name.localeCompare(b.name));
    for (const item of list) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) {
        if (!recursive) continue;
        const hit = protectedDirSkip(full);
        if (hit) { skip('protected', full); continue; }
        await collectDir(full);
        continue;
      }
      if (!item.isFile()) continue;
      const ext = path.extname(item.name).replace(/^\./, '').toLowerCase();
      if (!COUNT_TEXT_EXTENSIONS.has(ext)) { skip('unsupported_extension', full); continue; }
      pushFile(full);
    }
  }
  for (const raw of args.paths) {
    let target;
    try { target = resolvePath(raw); } catch (e) { skip('invalid_path', String(raw)); continue; }
    let st;
    try { st = await fsp.stat(target); } catch { skip('not_found', target); continue; }
    if (st.isDirectory()) {
      const g = await guardPath(target, 'list', {});
      if (!g.ok) { skip('protected', target); continue; }
      await collectDir(g.real);
      continue;
    }
    const g = await guardPath(target, 'read', {});
    if (!g.ok) { skip('protected', target); continue; }
    pushFile(g.real);
  }
  if (candidates.length > COUNT_MAX_FILES) {
    return {
      ok: false, error: 'batch_limit',
      reason: `文件数超出上限：最多 ${COUNT_MAX_FILES} 个文件，实际 ${candidates.length} 个`,
      limit: COUNT_MAX_FILES, given: candidates.length, skipped, skippedBy,
    };
  }
  let totalBytes = 0;
  for (const p of candidates) { try { totalBytes += (await fsp.stat(p)).size; } catch { /* ignore */ } }
  if (totalBytes > COUNT_MAX_BYTES) {
    return {
      ok: false, error: 'file_too_large',
      reason: `总体积超出上限：最多 ${COUNT_MAX_BYTES} 字节，实际 ${totalBytes} 字节`,
      limit: COUNT_MAX_BYTES, given: totalBytes, skipped, skippedBy,
    };
  }
  const agg = {};
  for (const k of COUNT_DIMS) agg[k] = 0;
  let aggBytes = 0;
  const details = [];
  const encodings = {};
  for (const p of candidates) {
    let buf;
    try { buf = await fsp.readFile(p); } catch { skip('io_error', p); continue; }
    const head0 = buf.subarray(0, 8192);
    if (isBinaryHead(head0)) { skip('binary', p); continue; }
    const det = detectEncoding(buf);
    if (!det.enc) { skip('undecodable', p); continue; }
    const text = decodeDetected(det);
    const dims = countStats(text, { wordsForCjk });
    for (const k of COUNT_DIMS) agg[k] += dims[k];
    aggBytes += buf.length;
    const rec = {
      path: toPosix(p), encoding: det.enc,
      encodingCandidates: det.candidates && det.candidates.length ? det.candidates : [det.enc],
      encodingUncertain: det.uncertain === true,
      bytes: buf.length, fileBytes: buf.length,
    };
    for (const k of COUNT_DIMS) rec[k] = dims[k];
    rec.bom = det.bom ? 1 : 0;
    details.push(rec);
    encodings[toPosix(p)] = det.enc;
  }
  const encList = Object.values(encodings);
  const encoding = encList.length === 0 ? null : (new Set(encList).size === 1 ? encList[0] : 'mixed');
  agg.bom = details.reduce((n, d) => n + d.bom, 0);
  const out = {
    ok: true, mode: 'files', files: details.length,
    ...agg,
    bytes: aggBytes,
    fileBytes: aggBytes,
    encoding, encodings,
    wordsForCjk,
    skipped, skippedBy, skippedDetails,
    details,
    paths: details.map((d) => d.path),
  };
  // E2：多文件时在顶层给出聚合信息（对齐信息 + 编码歧义警告），details 保留逐文件明细。
  if (details.length > 1) {
    out.alignmentAdjustedAny = details.some((d) => d.alignmentAdjusted === true);
  }
  const uncertainDetails = details.filter((d) => d.encodingUncertain === true);
  if (uncertainDetails.length > 0) {
    out.encodingUncertain = true;
    out.warning = uncertainDetails.length === 1
      ? `编码存在歧义：${(uncertainDetails[0].encodingCandidates || []).join(' / ')} 都能无错解码，当前按 ${uncertainDetails[0].encoding} 解码；若内容不对请显式传 encoding 参数指定`
      : `编码存在歧义：${uncertainDetails.length} 个文件存在编码歧义（如 ${[...new Set(uncertainDetails.flatMap((d) => d.encodingCandidates || []))].join(' / ')} 都能无错解码），当前按各文件检测结果解码；若内容不对请显式传 encoding 参数指定`;
  }
  return out;
}

async function toolCreateDirectory(args) {
  let target;
  try { target = resolvePath(args.path); } catch (e) { return { ok: false, error: 'invalid_args', reason: e.message }; }
  const g = await guardPath(target, 'write', { write: true });
  if (!g.ok) return g;
  const existed = fs.existsSync(g.real);
  try {
    await fsp.mkdir(g.real, { recursive: args.recursive !== false });
  } catch (e) {
    return { ok: false, error: 'io_error', reason: `创建目录失败：${e.message}` };
  }
  return { ok: true, created: !existed, path: toPosix(target) };
}

async function toolGetFileInfo(args) {
  let target;
  try { target = resolvePath(args.path); } catch (e) { return { ok: false, error: 'invalid_args', reason: e.message }; }
  const g = await guardPath(target, 'read', {});
  if (!g.ok) return g;
  let st;
  let lst = null;
  try { st = await fsp.stat(g.real); lst = await fsp.lstat(g.real); } catch (e) {
    return { ok: false, error: 'not_found', reason: `路径不存在：${toPosix(target)}` };
  }
  const type = lst.isSymbolicLink() ? 'symlink' : (st.isDirectory() ? 'directory' : (st.isFile() ? 'file' : 'other'));
  return {
    ok: true,
    path: toPosix(target),
    realPath: toPosix(g.real),
    size: st.size,
    mtimeMs: st.mtimeMs,
    ctimeMs: st.ctimeMs,
    atimeMs: st.atimeMs,
    isDirectory: st.isDirectory(),
    isSymbolicLink: lst.isSymbolicLink(),
    type,
  };
}

/** 整棵子树的统计（目录数 / 文件数 / 字节数）；with_stats 的数据源。 */
async function treeStats(dir, budget = null, skipCollect = null) {
  const out = { totalDirs: 0, totalFiles: 0, totalBytes: 0 };
  async function walk(d) {
    if (budget && budget.exceeded) return;
    let list;
    try { list = await fsp.readdir(d, { withFileTypes: true }); } catch {
      // 不可读子目录计入调用方传入的收集容器（treeStats 自身不自造返回字段）。
      if (skipCollect) {
        skipCollect.skipped += 1;
        skipCollect.skippedBy.unreadable = (skipCollect.skippedBy.unreadable || 0) + 1;
        if (skipCollect.skippedSamples.length < 20) {
          skipCollect.skippedSamples.push(checkProtected(d, 'read') ? { reason: 'unreadable' } : { path: toPosix(d), reason: 'unreadable' });
        }
      }
      return;
    }
    for (const item of list) {
      if (budget && budget.exceeded) return;
      const full = path.join(d, item.name);
      if (item.isDirectory()) { out.totalDirs += 1; await walk(full); continue; }
      if (!item.isFile()) continue;
      if (budget) {
        budget.scanned += 1;
        if (scanBudgetHit(budget)) return;
      }
      out.totalFiles += 1;
      try { out.totalBytes += (await fsp.stat(full)).size; } catch { /* ignore */ }
    }
  }
  await walk(dir);
  return out;
}

async function toolListDirectory(args) {
  let target;
  try { target = resolvePath(args.path); } catch (e) { return { ok: false, error: 'invalid_args', reason: e.message }; }
  const g = await guardPath(target, 'list', {});
  if (!g.ok) return g;
  let items;
  try { items = await fsp.readdir(g.real, { withFileTypes: true }); } catch (e) {
    return { ok: false, error: 'io_error', reason: `读取目录失败：${e.message}` };
  }
  const limit = Math.max(1, Number(args.limit) || 500);
  const withSizes = args.with_sizes === true;
  items.sort((a, b) => a.name.localeCompare(b.name));
  const total = items.length;
  const typeOf = (item) => (item.isDirectory() ? 'directory' : (item.isFile() ? 'file' : (item.isSymbolicLink() ? 'symlink' : 'other')));
  // 新参数：递归 / 限深 / 只列目录 / 含隐藏项 / 统计
  const recursive = args.recursive === true;
  const depthArg = args.depth != null ? Number(args.depth) : null;
  const dirsOnly = args.dirs_only === true;
  const withStats = args.with_stats === true;
  const extended = recursive || depthArg != null;
  const budget = newScanBudget();
  // 不可读子目录收集容器：只有真的遇到不可读目录才并入返回体（不传新参数时输出逐字不变）。
  const skipCollect = { skipped: 0, skippedBy: {}, skippedSamples: [] };
  const skippedOut = () => (skipCollect.skipped > 0
    ? { skipped: skipCollect.skipped, skippedBy: skipCollect.skippedBy, skippedSamples: skipCollect.skippedSamples }
    : {});
  // include_hidden 未指定时：扁平列举保持既有行为（含 . 开头项）；进入递归/限深模式后默认不含 . 开头项。
  const includeHidden = args.include_hidden === undefined ? !extended : args.include_hidden === true;

  if (!extended && !withStats) {
    // —— 既有扁平列举：不传新参数时行为逐字不变 ——
    const out = [];
    for (const item of items.slice(0, limit)) {
      const full = path.join(g.real, item.name);
      const rec = {
        name: item.name,
        path: toPosix(full),
        type: typeOf(item),
      };
      if (withSizes) {
        try { rec.size = (await fsp.stat(full)).size; } catch { rec.size = null; }
      }
      out.push(rec);
    }
    return { ok: true, path: toPosix(target), entries: out, total, truncated: total > limit, ...(total > limit ? { truncatedBy: 'limit' } : {}), limit };
  }

  const stats = withStats ? await treeStats(g.real, budget, skipCollect) : { totalDirs: 0, totalFiles: 0, totalBytes: 0 };
  if (!extended) {
    // —— 扁平 + 统计 ——
    const out = [];
    for (const item of items.slice(0, limit)) {
      const full = path.join(g.real, item.name);
      const rec = { name: item.name, path: toPosix(full), type: typeOf(item) };
      if (withSizes) {
        try { rec.size = (await fsp.stat(full)).size; } catch { rec.size = null; }
      }
      out.push(rec);
    }
    if (budget.exceeded) {
      // E6：scan_limit 契约 —— ok:true + truncated:true + truncatedBy:'scan_limit' + hint + 已扫到的部分结果。
      return scanLimitResult(budget, {
        path: toPosix(target), entries: out, total, truncated: true, resultLimit: limit, ...skippedOut(),
        totalDirs: stats.totalDirs, totalFiles: stats.totalFiles, totalBytes: stats.totalBytes, stats,
      });
    }
    return {
      ok: true, path: toPosix(target), entries: out, total, truncated: total > limit, ...(total > limit ? { truncatedBy: 'limit' } : {}), limit,
      totalDirs: stats.totalDirs, totalFiles: stats.totalFiles, totalBytes: stats.totalBytes, stats, ...skippedOut(),
    };
  }
  if (budget.exceeded) {
    // E6：scan_limit 契约 —— ok:true + truncated:true + truncatedBy:'scan_limit' + hint + 已扫到的部分结果。
    return scanLimitResult(budget, {
      path: toPosix(target), entries: [], total: items.length, truncated: true, resultLimit: limit, ...skippedOut(),
      totalDirs: stats.totalDirs, totalFiles: stats.totalFiles, totalBytes: stats.totalBytes, stats,
    });
  }

  // —— 递归列举 ——
  let hiddenExcluded = 0;
  const collected = [];
  const maxDepth = depthArg != null ? Math.max(1, Math.floor(depthArg)) : 24;
  async function walk(dir, level) {
    if (budget.exceeded) return;
    let list;
    try { list = await fsp.readdir(dir, { withFileTypes: true }); } catch {
      // 不可读目录不再静默：并入 skipCollect（敏感条目样本不带 path）。
      skipCollect.skipped += 1;
      skipCollect.skippedBy.unreadable = (skipCollect.skippedBy.unreadable || 0) + 1;
      if (skipCollect.skippedSamples.length < 20) {
        skipCollect.skippedSamples.push(checkProtected(dir, 'read') ? { reason: 'unreadable' } : { path: toPosix(dir), reason: 'unreadable' });
      }
      return;
    }
    list.sort((a, b) => a.name.localeCompare(b.name));
    for (const item of list) {
      if (budget.exceeded) return;
      if (!includeHidden && item.name.startsWith('.')) { hiddenExcluded += 1; continue; }
      const full = path.join(dir, item.name);
      const type = typeOf(item);
      const rec = { name: item.name, path: toPosix(full), type, depth: level };
      if (withSizes) {
        try { rec.size = (await fsp.stat(full)).size; } catch { rec.size = null; }
      }
      collected.push(rec);
      // E4：scanned = 访问过的条目数（文件与目录条目都计），含随后被跳过的条目。
      budget.scanned += 1;
      if (scanBudgetHit(budget)) return;
      if (type === 'directory' && level < maxDepth) await walk(full, level + 1);
    }
  }
  await walk(g.real, 1);
  if (budget.exceeded) {
    return scanLimitResult(budget, {
      path: toPosix(target), entries: collected.slice(0, limit), total: collected.length,
      truncated: true, resultLimit: limit, recursive: true, depth: depthArg != null ? Math.max(1, Math.floor(depthArg)) : null,
      ...(hiddenExcluded > 0 ? { hiddenExcluded } : {}),
    });
  }
  const filtered = dirsOnly ? collected.filter((r) => r.type === 'directory') : collected;
  const totalAll = filtered.length;
  return {
    ok: true,
    path: toPosix(target),
    entries: filtered.slice(0, limit),
    total: totalAll,
    truncated: totalAll > limit,
    ...(totalAll > limit ? { truncatedBy: 'limit' } : {}),
    limit,
    totalDirs: stats.totalDirs,
    totalFiles: stats.totalFiles,
    totalBytes: stats.totalBytes,
    stats,
    ...skippedOut(),
    scanned: budget.scanned,
    recursive: true,
    depth: depthArg != null ? Math.max(1, Math.floor(depthArg)) : null,
    dirsOnly,
    includeHidden,
    ...(hiddenExcluded > 0 ? { hiddenExcluded } : {}),
  };
}

function whichOrFallback(name, fallback) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts = (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean);
  for (const d of dirs) {
    for (const e of exts) {
      const p = path.join(d, name + e.toLowerCase());
      if (fs.existsSync(p)) return p;
      const p2 = path.join(d, name + e);
      if (fs.existsSync(p2)) return p2;
    }
  }
  return fallback && fs.existsSync(fallback) ? fallback : null;
}

const FMT_ALIAS = { md: 'markdown', markdown: 'markdown', docx: 'docx', html: 'html', txt: 'plain', csv: 'csv', latex: 'latex', pdf: 'pdf' };
/** pandoc 的 reader（-f）与 writer（-t）名称不同：plain 只能作输出，不能作输入。 */
const PANDOC_READER = { ...FMT_ALIAS, txt: 'markdown' };

let _depCache = null;
function probeDependencies(fmt) {
  if (!_depCache) {
    const pandoc = whichOrFallback('pandoc', PANDOC_FALLBACK);
    const typst = whichOrFallback('typst', TYPST_FALLBACK);
    _depCache = { pandoc, typst };
  }
  const missing = [];
  if (!_depCache.pandoc) missing.push('pandoc');
  if (fmt === 'pdf' && !_depCache.typst) missing.push('typst');
  return { missing, pandoc: _depCache.pandoc, typst: _depCache.typst };
}

async function toolConvertDocument(args) {
  const src = resolvePath(args.src);
  const fmt = String(args.fmt || '').toLowerCase();
  if (!FMT_ALIAS[fmt]) return { ok: false, error: 'invalid_args', reason: `不支持的目标格式：${args.fmt}` };
  const srcGuard = await guardPath(src, 'read', {});
  if (!srcGuard.ok) return srcGuard;
  if (!fs.existsSync(srcGuard.real)) return { ok: false, error: 'not_found', reason: `源文件不存在：${toPosix(src)}` };
  const srcExt = path.extname(srcGuard.real).replace(/^\./, '').toLowerCase();
  const inFmt = PANDOC_READER[srcExt] || srcExt;
  const out = args.out_path ? resolvePath(args.out_path) : path.join(path.dirname(srcGuard.real), `${path.basename(srcGuard.real, path.extname(srcGuard.real))}.${fmt}`);
  const outGuard = await guardPath(out, 'write', { write: true });
  if (!outGuard.ok) return outGuard;
  const deps = probeDependencies(fmt);
  if (deps.missing.length) return { ok: false, error: 'dependency_unavailable', missing: deps.missing };
  const pandoc = deps.pandoc;
  const argv = ['-f', inFmt, '-o', outGuard.real, srcGuard.real];
  if (fmt === 'pdf') {
    argv.unshift(`--pdf-engine=${deps.typst}`);
  }
  const r = await runCmd(pandoc, argv, { cwd: path.dirname(srcGuard.real) });
  if (r.code !== 0 || !fs.existsSync(outGuard.real)) {
    const stderr = (r.stderr || '').split(/\r?\n/).filter((l) => l.trim() !== '').slice(0, 15).join('\n');
    return { ok: false, error: 'io_error', reason: `pandoc 转换失败（exit ${r.code}）`, stderr: stderr || r.stdout.slice(0, 2000) };
  }
  const st = fs.statSync(outGuard.real);
  return { ok: true, src: toPosix(src), fmt, out: toPosix(out), bytes: st.size, engine: fmt === 'pdf' ? deps.typst : 'pandoc' };
}

async function toolDiff(args) {
  const a = resolvePath(args.pathA);
  const b = resolvePath(args.pathB);
  const mode = args.mode === 'full' ? 'full' : 'summary';
  const ga = await guardPath(a, 'read', {});
  if (!ga.ok) return ga;
  const gb = await guardPath(b, 'read', {});
  if (!gb.ok) return gb;
  for (const p of [ga.real, gb.real]) if (!fs.existsSync(p)) return { ok: false, error: 'not_found', reason: `路径不存在：${toPosix(p)}` };
  const git = whichOrFallback('git', GIT_FALLBACK);
  if (!git) return { ok: false, error: 'dependency_unavailable', missing: ['git'] };
  const argv = ['-c', 'core.autocrlf=false', 'diff', '--no-index'];
  if (mode === 'summary') argv.push('--stat');
  else argv.push('-U3');
  argv.push(ga.real, gb.real);
  const r = await runCmd(git, argv);
  if (r.code >= 2) return { ok: false, error: 'io_error', reason: `git diff 失败（exit ${r.code}）`, stderr: (r.stderr || '').slice(0, 2000) };
  let text = r.stdout || '';
  let truncated = false;
  if (Buffer.byteLength(text, 'utf8') > MAX_DIFF_BYTES) {
    text = Buffer.from(text, 'utf8').subarray(0, MAX_DIFF_BYTES).toString('utf8');
    truncated = true;
  }
  return { ok: true, pathA: toPosix(a), pathB: toPosix(b), mode, exitCode: r.code, hasDiff: r.code === 1, truncated, diff: text };
}

async function toolListProtected() {
  const cfg = loadConfig();
  const fp = configFingerprint();
  const audit = auditConfig();
  return {
    ok: true,
    version: cfg.version,
    config: fp,
    configError: _configError,
    audit: {
      enabled: audit.enabled === true,
      logPath: audit.logPath,
      retentionDays: audit.retentionDays,
      maxBytes: audit.maxBytes,
      summaryOnRotate: audit.summaryOnRotate !== false,
    },
    hotReload: { enabled: true, configPath: fp.configPath, strategy: 'mtimeMs+size' },
    writeRoots: cfg.writeRoots,
    batchLimits: cfg.batchLimits,
    readCaps: cfg.readCaps,
    count: cfg.rules.length,
    rules: cfg.rules.map((r) => ({
      id: r.id,
      scope: r.scope,
      pattern: r.pattern,
      patterns: r.patterns,
      deny: r.deny,
      denyMoveAsSourceOnly: r.denyMoveAsSourceOnly === true,
      reason: r.reason,
      sensitive: isSensitiveRule(r),
      enforced: true,
    })),
    enforcement: {
      writeRootsEnforced: true,
      sensitivePatternsEnforced: true,
      realpathCheck: true,
      identityCheck: true,
      readCache: true,
      layerOrder: ['device_path_check', 'realpath_check', 'write_root_check', 'sensitive_pattern_check', 'protected_rule_check'],
    },
  };
}

/* ------------------------------ SDK 装配 ------------------------------ */

const HANDLERS = {
  trash: toolTrash,
  move: toolMove,
  edit_text: toolEditText,
  read_text: toolReadText,
  find_files: toolFindFiles,
  convert_document: toolConvertDocument,
  diff: toolDiff,
  list_protected: toolListProtected,
  create_directory: toolCreateDirectory,
  get_file_info: toolGetFileInfo,
  list_directory: toolListDirectory,
  count_text: toolCountText,
};

const TOOLS = [
  {
    name: 'trash',
    title: '移入回收站',
    description: '把文件/目录移入 Windows 回收站（可恢复）。目录必须 recursive=true。**三态**：① 本进程能用回收站 → action:sent-to-recycle-bin + recyclable:true；② 不能用（如沙箱权限受限，默认情况）→ 仍然执行删除，但如实返回 action:deleted-permanently + recyclable:false + warning（不谎报，文件不可恢复）；③ 不能用且设了 FOP_REQUIRE_RECYCLE_BIN=1（严格模式）→ 返回 recycle_bin_unavailable 并拒绝删除。另设 FOP_ALLOW_PERMANENT_DELETE=1 表示调用方明确要求永久删除（跳过回收站，返回 permanentDelete:true，不带 warning）。',
    inputSchema: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' }, description: '要删除的文件/目录绝对路径' },
        recursive: { type: 'boolean', default: false, description: '目录删除必须为 true' },
      },
      required: ['paths'],
      additionalProperties: false,
    },
  },
  {
    name: 'move',
    title: '移动/复制',
    description: '同卷改名（原子），跨卷复制 + SHA-256 校验后删除源；mode=copy 只复制不删源（源不限路径，目标须在写根内）；mode=move 源与目标都须在写根内。目标已存在时默认报错；确认要覆盖时传 overwrite:true（覆盖前先处置目标；目标为目录时会先整体删除，并检查目录内受保护内容）。覆盖**三态**：① 能用回收站 → overwrittenToRecycleBin:true + recyclable:true；② 不能用（默认）→ 覆盖照常完成，目标被永久删除并如实返回 overwrittenToRecycleBin:false + recyclable:false + warning；③ 不能用且设了 FOP_REQUIRE_RECYCLE_BIN=1 → 返回 recycle_bin_unavailable 并放弃覆盖（源与目标均不改动）。FOP_ALLOW_PERMANENT_DELETE=1 → 跳过回收站直接删目标（permanentDelete:true，不带 warning）。',
    inputSchema: {
      type: 'object',
      properties: {
        src: { type: 'string' },
        dst: { type: 'string' },
        mode: { type: 'string', enum: ['move', 'copy'], default: 'move' },
        overwrite: { type: 'boolean', default: false, description: '默认 false。为 true 时允许覆盖已存在目标：目标为文件会先删除再写入（删除前记 overwrittenSha256）；目标为目录会先整体删除，因此会检查目录内受保护内容。批量时可按项覆盖。' },
        paths: {
          type: 'array',
          description: '批量移动（可选，最多 200 组）',
          items: {
            type: 'object',
            properties: { src: { type: 'string' }, dst: { type: 'string' }, mode: { type: 'string', enum: ['move', 'copy'] }, overwrite: { type: 'boolean', description: '项级覆盖：覆盖全局 args.overwrite（本项默认沿用全局值）' } },
            required: ['src', 'dst'],
            additionalProperties: false,
          },
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'edit_text',
    title: '精准替换文本',
    description: '部分内容替换（两级匹配：精确 → 字面量感知空白规范化；两级都零命中时返回近似候选 nearMisses）；oldText 必须唯一命中，否则 ambiguous；批量 edits 全部预校验通过才原子写入；可 overwrite 整文件并保留原编码。可用 paths[] 批量编辑多个文件（最多 20 个，默认逐文件独立，可用 all_or_nothing 做全有或全无）。成功结果恒带 indentChanged；若 oldText 覆盖了整行行首缩进而 newText 不带缩进，则 indentChanged=true 并附 originalIndent / newIndent / indentWarning（缩进即结构，请让 newText 带上同样的缩进）。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '单文件路径（与 paths 互斥）' },
        paths: { type: 'array', items: { type: 'string' }, description: '批量编辑的文件路径列表（最多 20 个；与 path 互斥）' },
        mode: { type: 'string', enum: ['replace', 'overwrite'], default: 'replace', description: '批量形态只支持 replace' },
        content: { type: 'string', description: 'mode=overwrite 时的完整新内容' },
        createIfMissing: { type: 'boolean', default: false, description: '仅 overwrite 时生效：目标不存在时新建（目标已存在时不需要此参数，改用 overwriteExisting）' },
        overwriteExisting: { type: 'boolean', default: false, description: '仅 overwrite 时生效：目标已存在时必须显式传 true 才允许覆盖（可同时传 expected_sha256 做版本校验）' },
        all_or_nothing: { type: 'boolean', default: false, description: '批量形态：true 时先全量预校验，任一文件失败则整批零写入' },
        expected_sha256: {
          description: '单文件形态为字符串；批量形态为按路径索引的对象（未列出的路径不做版本校验）',
          oneOf: [
            { type: 'string' },
            { type: 'object', additionalProperties: { type: 'string' } },
          ],
        },
        edits: {
          type: 'array',
          description: '最多 50 项',
          items: {
            type: 'object',
            properties: {
              oldText: { type: 'string' },
              newText: { type: 'string' },
              old_text: { type: 'string' },
              new_text: { type: 'string' },
            },
            additionalProperties: false,
          },
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'read_text',
    title: '读取文本',
    description: '读取文本文件，自动探测 UTF-8/UTF-16LE/UTF-16BE/GB18030/Big5（含无 BOM 的 UTF-16）；可显式传 encoding 指定唯一编码（显式指定就只按它解码，绝不改判）；GB18030 与 Big5 之间自动探测不可靠时返回 encodingCandidates 供甄别；二进制只返回元信息；默认按 readCaps 截断（返回正文硬上限 64 KiB，超长单行在行内截断并标记 lineTruncated）；重复读取命中缓存时只返回元信息（force_read=true 强制读正文）。截断原因看 truncatedBy：取值 max_lines（行数上限）或 max_bytes（字节上限）；大目录扫描另有 scan_limit（仅 find_files / list_directory 产生）。字节区间读：start_byte 从第几个字节开始读（与 start_line 互斥，同时给 → invalid_args），max_bytes 限制本次返回的正文字节数（默认 64 KiB，硬上限 65536）；截断时返回 howToContinue（给出下次调用该传的具体 start_byte）与 nextByteOffset。区间参数非法一律 invalid_args（start_line ≥ 1、count ≥ 1）；起点越界返回 ok=true + emptyRange + rangeOutOfBounds。字节区间仅支持 UTF-8/ASCII（非 UTF-8 文件请改用 start_line + count）。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        encoding: { type: 'string', default: 'auto' },
        start_line: { type: 'number' },
        count: { type: 'number' },
        start_byte: { type: 'number', default: 0, description: '从第几个字节开始读（绝对字节偏移）；与 start_line 互斥' },
        max_bytes: { type: 'number', default: 65536, description: '本次最多返回多少字节正文（默认 64 KiB）' },
        force_read: { type: 'boolean', default: false },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_directory',
    title: '创建目录',
    description: '创建目录（默认 recursive=true）；目标须在写根内。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        recursive: { type: 'boolean', default: true },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_file_info',
    title: '查看文件信息',
    description: '返回路径元信息：大小、mtime/ctime/atime、是否目录/符号链接；读类操作不限路径。',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_directory',
    title: '列出目录内容',
    description: '列出目录下的条目（名称/路径/类型，可选大小）；默认上限 500，超出时 truncated=true。可选：recursive（递归列举）、depth（限制层深，1=只列直接子项）、dirs_only（只返回目录）、include_hidden（是否包含 . 开头项）、with_stats（额外给出 totalDirs/totalFiles/totalBytes）。不传这些新参数时，行为与既有完全一致（逐字不变）。大目录扫描有预算上限，超出会截断（ok=true + truncated=true + truncatedBy=scan_limit，已扫到的部分结果照常返回）。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        with_sizes: { type: 'boolean', default: false },
        limit: { type: 'number', default: 500 },
        recursive: { type: 'boolean', default: false, description: '递归列举子目录；开启后 include_hidden 默认为 false（不含 . 开头项）' },
        depth: { type: 'number', description: '限制递归层深（1=只列直接子项）' },
        dirs_only: { type: 'boolean', default: false, description: '只返回目录条目' },
        include_hidden: { type: 'boolean', description: '是否包含 . 开头的隐藏项；未指定时：扁平列举保持既有行为（包含），递归/限深模式默认不含' },
        with_stats: { type: 'boolean', default: false, description: '额外返回 totalDirs / totalFiles / totalBytes' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'find_files',
    title: '按元数据筛文件',
    description: '按名称模式/扩展名/mtime/大小筛选文件，返回路径、字节、mtime；默认 limit=200。name_pattern 不含通配符（* / ?）时按【裸子串】匹配（如 "README" 命中 README.md），含通配符时按 glob 匹配。时间条件分三类：filters.modified_after / filters.modified_before 是【绝对时间区间】（如 "2026-01-01T00:00:00Z"），用于“某个已知时点之后/之前改过的文件”；modified_within 是【相对时间窗】（如 "24h" / "7d" / "30d"），用于“最近 N 天”这类滚动意图，跨天复用同一句查询仍然成立；三者同时给出时取【交集】（文件必须同时满足）。自动跳过受保护规则命中的目录（node_modules、.git 等）与二进制文件（复用 read_text 的二进制探测），返回里给出 skipped 与 skippedBy。大目录扫描有预算上限，超出会截断（ok=true + truncated=true + truncatedBy=scan_limit，已扫到的部分结果照常返回）。name_pattern 只匹配文件名；要限定目录用 root。',
    inputSchema: {
      type: 'object',
      properties: {
        root: { type: 'string' },
        modified_within: { type: 'string', description: '相对时间窗，如 "24h" / "7d" / "30d"；与 modified_after/modified_before 同时给时取交集' },
        filters: {
          type: 'object',
          properties: {
            name_pattern: { type: 'string', description: '名称过滤：不含通配符（* / ?）时按裸子串匹配（含通配符时按 glob 匹配）' },
            extensions: { type: 'array', items: { type: 'string' } },
            modified_after: { type: 'string', description: '绝对时间区间的下界（ISO 字符串）' },
            modified_before: { type: 'string', description: '绝对时间区间的上界（ISO 字符串）' },
            modified_within: { type: 'string', description: '相对时间窗（也可写在顶层参数上）' },
            min_size: { type: 'number' },
            max_size: { type: 'number' },
            recursive: { type: 'boolean', default: true },
          },
          additionalProperties: false,
        },
        limit: { type: 'number', default: 200 },
      },
      required: ['root'],
      additionalProperties: false,
    },
  },
  {
    name: 'count_text',
    title: '文本统计',
    description: '统计文本的行数、汉字数、字符数、词数等指标（多维度文本度量）。paths（文件或目录，可传目录）与 text 二选一，必须恰好给一个。适用：纯文本 / markdown / json / csv 等的规模度量。支持区间统计（与 read_text 对齐）：start_byte/max_bytes 字节区间、start_line/count 行区间；start_byte 与 start_line 互斥；目录模式与 text 模式不支持区间；区间统计时各维度只针对该区间，bytes=区间字节数、fileBytes=整文件字节数；区间参数非法一律 invalid_args（start_line ≥ 1、count ≥ 1），起点越界返回 ok=true + emptyRange。截断原因看 truncatedBy：取值 max_lines（行数上限）或 max_bytes（字节上限）。注意：PDF / Word / Excel 等需先抽取文本再统计；检索命中的条目数 ≠ 字数。',
    inputSchema: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' }, description: '要统计的文件或目录（与 text 互斥）' },
        text: { type: 'string', description: '直接统计的一段文本（与 paths 互斥）' },
        wordsForCjk: { type: 'boolean', default: false, description: '是否把 CJK 词计入 words（默认不计入；开启后用 Intl.Segmenter 分词）' },
        recursive: { type: 'boolean', default: true, description: '目录模式是否递归（默认递归）' },
        start_byte: { type: 'number', default: 0, description: '字节区间起点：从第几个字节开始统计（与 start_line 互斥，同传 → invalid_args）；落在多字节字符中间时自动回退到字符边界（返回 alignmentAdjusted / alignmentBackoffBytes）。仅支持单个文件，目录模式与 text 模式不支持' },
        max_bytes: { type: 'number', description: '字节区间上限：最多统计多少字节（默认到文件末尾）；可与 count 同时给，两者都生效' },
        start_line: { type: 'number', default: 1, description: '行区间起点：从第几行开始统计（与 start_byte 互斥，同传 → invalid_args）。仅支持单个文件，目录模式与 text 模式不支持' },
        count: { type: 'number', description: '行区间上限：最多统计多少行（默认到文件末尾）；可与 max_bytes 同时给，两者都生效' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'convert_document',
    title: '文档格式转换',
    description: '用 pandoc 转换文档格式（md/docx/html/txt/csv/latex/pdf），pdf 需 typst 引擎。',
    inputSchema: {
      type: 'object',
      properties: {
        src: { type: 'string' },
        fmt: { type: 'string', enum: ['md', 'docx', 'html', 'txt', 'csv', 'latex', 'pdf'] },
        out_path: { type: 'string' },
      },
      required: ['src', 'fmt'],
      additionalProperties: false,
    },
  },
  {
    name: 'diff',
    title: '比较差异',
    description: 'git diff --no-index 比较两个文件或目录；summary=--stat，full=-U3；输出超 200KB 截断。',
    inputSchema: {
      type: 'object',
      properties: {
        pathA: { type: 'string' },
        pathB: { type: 'string' },
        mode: { type: 'string', enum: ['summary', 'full'], default: 'summary' },
      },
      required: ['pathA', 'pathB'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_protected',
    title: '列出保护规则',
    description: '返回当前生效的强制规则：writeRoots / batchLimits / readCaps / 全部规则（条数见 count 字段）/ enforcement 开关与层级顺序；并给出配置指纹 config（configPath / mtime / sha256 / 规则条数）与审计开关 audit（含 retentionDays / maxBytes / summaryOnRotate）。protected.json 支持热加载（改完即时生效，无需重启）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

/**
 * --readonly：由主代理（main-delegator）挂载时使用，只暴露只读 7 工具。
 * 名单必须与上方 TOOLS 各工具的 name 字段逐字一致（新增只读工具时同步此名单）。
 */
const READONLY_TOOL_NAMES = ['read_text', 'list_directory', 'find_files', 'get_file_info', 'diff', 'count_text', 'list_protected'];
const READONLY_TOOL_SET = new Set(READONLY_TOOL_NAMES);
/** `--readonly` 启动时只注册只读工具；不带该参数时 12 个工具行为逐字不变。 */
const READONLY_MODE = process.argv.includes('--readonly');
/** tools/list 可见工具集：只读模式过滤，其他模式原样返回 TOOLS。 */
function visibleTools(readonly = READONLY_MODE) {
  return readonly ? TOOLS.filter((t) => READONLY_TOOL_SET.has(t.name)) : TOOLS;
}
/** tools/call 是否允许调用该工具：只读模式下写工具一律不可调用（不只是隐藏列表）。 */
function toolAllowed(name, readonly = READONLY_MODE) {
  return !readonly || READONLY_TOOL_SET.has(name);
}
/** tools/call 的唯一下发入口：列表过滤与调用过滤在同一处生效。 */
async function dispatchToolCall(name, args = {}, readonly = READONLY_MODE) {
  const fn = HANDLERS[name];
  if (!fn || !toolAllowed(name, readonly)) {
    const available = readonly ? visibleTools(true).map((t) => t.name) : Object.keys(HANDLERS);
    return { isError: true, content: [{ type: 'text', text: `未知工具：${name}。可用：${available.join(', ')}` }] };
  }
  try {
    const out = await fn(args);
    if (out && (out.error || out.ok === false)) return { isError: true, content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
    return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `工具执行异常：${err && err.stack ? err.stack : String(err)}` }] };
  }
}

const server = new Server(
  { name: 'mcp-file-ops', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

if (READONLY_MODE) {
  process.stderr.write('[mcp-file-ops] --readonly：只注册只读 7 工具（由主代理 main-delegator 挂载时使用）\n');
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: visibleTools() }));

server.setRequestHandler(CallToolRequestSchema, async (request) => (
  dispatchToolCall(request.params.name, request.params.arguments ?? {}, READONLY_MODE)
));

export { HANDLERS, TOOLS, READONLY_TOOL_NAMES, READONLY_TOOL_SET, READONLY_MODE, visibleTools, toolAllowed, dispatchToolCall, auditResetState, auditConfig, auditWrite, appendAudit, toolTrash, ensureRecycleBinCapability, recycleBinCapability, toolMove, toolEditText, toolEditTextSingle, toolEditTextBatch, toolReadText, toolFindFiles, toolConvertDocument, toolDiff, toolListProtected, toolCreateDirectory, toolGetFileInfo, toolListDirectory, toolCountText, checkProtected, guardPath, loadConfig, configFingerprint, ensureConfigFreshSync, ensureConfigFreshAsync, parseWithinSpec, protectedDirSkip, countStats, detectEncoding, findLiteralZones, normalizeForMatch, applyEditToText, findNearMisses, foldedCandidates, classifyDiffKind, countEol, eolStyleOf, appliedLedger, ledgerStats, indentViolations, indentNearMissEntries, leadingWsLen, lineStartOffset, lineEndOffset, indentChangeInfo, describeIndent };

const isDirectRun = (() => {
  try {
    const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
    return entry === path.resolve(fileURLToPath(import.meta.url));
  } catch { return true; }
})();

if (isDirectRun) {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

process.on('uncaughtException', (e) => {
  try { process.stderr.write(`[mcp-file-ops] uncaughtException: ${e && e.stack ? e.stack : e}\n`); } catch { /* ignore */ }
});
