# file-ops —— 文件操作 MCP 服务

单文件 ESM 实现的本地文件操作 MCP 服务（stdio 传输），面向「让模型安全地改文件」这一场景。除 `@modelcontextprotocol/sdk` 外零第三方依赖，`iconv-lite` 为可选依赖（缺失时编码能力降级，见 §4、§7.2）。

核心定位：**写边界由工具强制**——读路径不限，写类操作只能落在配置的写根（`writeRoots`）内；配合唯一匹配、幂等、原子写与编码/换行保真，把「改错」与「改坏」两类事故挡在工具层。

## 1. 设计原则

| 原则 | 含义 |
|---|---|
| 写边界由工具强制 | 读路径不限；写类操作只在 `writeRoots` 内（§6）。**不依赖模型自觉** |
| 唯一匹配 | 命中必须唯一；多处命中一律拒绝并给出候选，**不猜** |
| 幂等 | 重复提交同一替换不会重复应用；按**位置与文件哈希**判定，不靠「内容里出现过」 |
| 原子写 | 临时文件 + rename；批量里任一项失败则该文件零写入 |
| 保真 | 保留原文件的编码（UTF-8 / GB18030 / Big5 / UTF-16）与行尾风格 |
| 可解释错误 | 每个错误都带 `error`/`reason`，多数给出下一步 |

## 2. 工具总览（12 个）

| 工具 | 一句话职责 |
|---|---|
| `read_text` | 读文本；支持分段读取、行号、缓存复用 |
| `edit_text` | **主力工具**：精准替换 / 整文件覆盖 |
| `create_directory` | 建目录（默认递归） |
| `get_file_info` | 文件元信息 |
| `list_directory` | 列目录（可递归、可限深） |
| `find_files` | 按名 / 扩展名 / 时间 / 大小查找 |
| `trash` | **移入回收站**（可恢复；**仅在回收站不可用的受限环境下降级为永久删除并如实标注**） |
| `move` | 移动 / 复制（支持跨盘，带 sha256 校验） |
| `diff` | 内容级差异（`git diff --no-index`） |
| `convert_document` | 文档转换（pandoc）：输入 md/docx/html/txt/csv/latex（**pdf 不能作输入**），输出另含 `txt`（plain writer）与 `pdf`（typst 引擎）；**txt 输入按 markdown 解析** |
| `list_protected` | 查询当前生效的写根、保护规则、批量上限、读上限、**配置指纹** |
| `count_text` | **文本统计**：行 / 段 / 句 / 词 / 字形 / 码点 / 汉字…（支持目录、多编码与**区间统计**） |

所有工具 schema 均为 `additionalProperties:false`。参数要点：

- 读与查：`read_text` 的 `path` 必填、`encoding='auto'`，行区间与字节区间**互斥**（§7.1）；`list_directory` 的 `limit=500`（超出 `truncated:true`）；`find_files` 的 `root` 必填、`limit=200`，`name_pattern` **不含通配符时按裸子串匹配**，`modified_within` 是相对时间窗（如 `7d`）。
- 写与删：`edit_text` 的 `path` 与 `paths` 互斥、`mode='replace'`（§3）；`trash` 的目录必须 `recursive:true`、上限 500 条；`move` 的 `paths[]` 最多 200 组、`overwrite` 默认 `false`（§5.3）；`create_directory` 默认递归且目标须在写根内。
- 其余：`get_file_info` 返回元信息；`list_protected` 无参数；`diff` 的 `mode='summary'`/`'full'`（超 200 KB 截断）；`convert_document` 的 `out_path` 可选；`count_text` 的 `paths` 与 `text` 二选一、**支持区间统计**——`start_byte`/`max_bytes` 字节区间与 `start_line`/`count` 行区间（与 `read_text` 同参数同口径），区间统计时 `bytes` 只覆盖该区间、`fileBytes` 始终是整文件字节数、单次最多 200 文件 / 200 MB。
- `convert_document` 的两个副作用：① **txt 作为输入按 markdown 解析**（pandoc 没有 plain reader，副作用是 txt 里的 `#`/`*` 会被当作 markdown 语法）；② **pdf 不能作为输入格式**（pandoc 无 pdf reader，会报 `io_error`）；输出侧支持 `txt`（plain writer）。

## 3. edit_text（最重要的工具）

改已有文件优先用它：不必先读全文，保编码保换行，命中必须唯一，重复提交幂等。

### 3.1 两种模式

| 模式 | 用途 | 必须显式传什么 |
|---|---|---|
| `mode='replace'`（默认） | 局部替换 | —— |
| `mode='overwrite'` | 整文件覆盖 | 覆盖**已存在**文件要 `overwriteExisting:true`；**新建**文件要 `createIfMissing:true` |

`overwrite` 必须显式表态：漏传 `overwriteExisting` → `target_exists`；漏传 `createIfMissing` → `target_missing`。可配合 `expected_sha256` 做版本校验，不符 → `version_mismatch`。

### 3.2 两级匹配

1. **精确匹配**：字面完全一致，必须唯一命中（`matchedBy:'exact'`）。
2. **字面量感知规范化**：仅在精确匹配零命中时启用，只折叠**无语义空白**；**字符串字面量内部**与**行首缩进**都不折叠（`matchedBy:'normalized'`）。

命中多次 → 拒绝并返回候选（`error:'ambiguous'`，`candidates[].line`/`.snippet`）；两级都不命中 → 返回 `nearMisses`，每项给 `exactText`（该处的**精确原文**，照它写就能命中）、`diffKind`（`indent` 缩进形态不同、常见 tab↔空格 / `literal` 差异在字符串字面量内 / `whitespace` 行内空白差异）与 `diffInsideLiteral`。字面量识别覆盖 `"..."`、`'...'`、反引号模板串与 Python 三引号（含转义引号），字面量内的多余空格**不会**被自动折叠。

### 3.3 缩进保护（两条规则）

1. **不会被意外改动**：若命中区间的**起点落在文件行首缩进内部**（`oldText` 自带前导空白、且与文件缩进只差长度），该候选**作废** → `not_found` + `diffKind:'indent'` + 完整原文。出路：用不带前导空白的 `oldText`，或用完整缩进。
2. **故意改动会被告知**：若 `oldText` 覆盖整行缩进而 `newText` 不带缩进 → 工具**照做**，但返回 `indentChanged:true` 与 `originalIndent`/`newIndent`/`indentWarning`。

YAML 里缩进即结构、Python 里缩进即语法：请让 `newText` 带上同样的缩进。

### 3.4 幂等

- 重复提交同一对 (oldText, newText) → `status:'already_applied'`，并给 `alreadyAppliedBy:'ledger'`（哈希记账）或 `'position'`（目标位置已等于 newText）。
- **判据是位置与哈希一致**，不是「文件里出现过 newText」——后者会把「本来就有这句话」误判成已应用。
- 账本是**进程内内存态**（上限 200 条），超限丢弃最旧条目（功能不受影响），**不落盘**——重启或换进程后 `already_applied` 的 ledger 证据消失，重放只剩位置判据（相同内容会真正再次应用）。`already_applied` 是状态不是错误，无需再改。

### 3.5 批量

| 形态 | 用途 | 上限 |
|---|---|---|
| `edits[]` | 同一文件多处改 | 每文件 50 处；整批原子（任一失败则该文件零写入） |
| `paths[]` | 多个文件改同一处 | 20 个文件 / 单次总替换 200 / 单文件 8 MiB；默认**逐文件独立**，可选 `all_or_nothing:true`（先全量预校验，任一不过则整批零写入） |

- `summary.failed > 0` 表示有文件没改成 → **必须逐个处理**；`summary.skipped` 里的超 8 MiB 文件是 `file_too_large`，**不中断整批**。
- 每个文件改法不同 → **不要用批量**，逐个调用；超限 → `batch_limit`（带 `limit`/`given`）。
- 批量只支持 `mode='replace'`；传 `overwrite` 或同时传 `path` 与 `paths` → `invalid_args`；目标是目录 → `invalid_args`（目录内容不变）。

## 4. 换行与编码

| 场景 | 行为 |
|---|---|
| `mode='replace'` + 原文件混用 CRLF/LF | **拒绝**（`mixed_eol`），reason 给出各风格行数与出路：读出全文统一后用 `mode='overwrite'` 写回 |
| `mode='replace'` + 原文件纯 LF / 纯 CRLF | 跟随文件风格（`writtenEol:'lf'` / `'crlf'`） |
| `mode='overwrite'` + content 纯 CRLF | 写成 CRLF（`writtenEol:'crlf'`，`eolNormalized:false`） |
| `mode='overwrite'` + content 纯 LF | 写成 LF（**听调用方的**，不跟随原文件） |
| `mode='overwrite'` + content 自身混用 | **自动统一为多数风格**并回报 `eolNormalized:true` 与 `contentEolNormalizedTo` |

**编码**：读写保持原编码（返回 `encoding` / `encodingPreserved`），UTF-8 / UTF-16LE / UTF-16BE / GB18030 / Big5 均支持。**探测顺序**：BOM → UTF-8(strict) → **UTF-16 启发式** → GB18030 → Big5；UTF-16 启发式按 2 字节配对统计 NUL 落在偶位/奇位的比例（NUL 数 ≥ 2 且优势方 ≥ 60%），再解码校验（无 U+FFFD、无异常控制字符）才采信 → **无 BOM 的 UTF-16 也能正确读出**，含 NUL 的真二进制仍判 `binary`。

**GB18030 与 Big5 可以互相「无错」解码 → 自动探测在两者之间不可靠**：无法确定时返回 `encodingCandidates`（如 `["gb18030","big5"]`）与 `encodingUncertain:true`，请**显式传 `encoding`**。GB18030 的 BOM（`84 31 95 33`）会被剥离并回 `bom:true`，正文不含 U+FEFF。

**iconv-lite 缺失时的降级**：GB18030 / Big5 依赖可选的 `iconv-lite`（纯 JS）；装不上时能力降级为**只支持 UTF-8 / UTF-16**，此后处理这两种编码得到 `dependency_unavailable`，**不会静默按 UTF-8 口径读写**（那会把中文写成乱码字节）；**字节区间读**则是另一回事：**仅支持 UTF-8/ASCII**——任何非 UTF-8 文件（含 GB18030 / Big5）的字节区间读一律返回 `invalid_args`，**与 `iconv-lite` 是否可用无关**；错误信息会引导改用 `start_line` + `count` 按行读取（行区间对所有编码都支持）。

## 5. 删除与移动

- `trash` → **进 Windows 回收站，可恢复**；仅在回收站能力不可用的受限环境下降级为永久删除并如实标注（§5.1）；目录必须 `recursive:true`；单次上限 500 条。
- `move` 默认是**移动**（同卷改名，原子）；跨卷时先复制 + SHA-256 校验再删源，返回 `crossVolume:true`/`sha256Verified:true`。
- `mode='copy'` 是复制（**源不限路径**，目标须在写根内）；`mode='move'` 源与目标**都**须在写根内。递归 `trash` 目录 / `move` 搬整棵目录前会先扫子树（§6.4）；`copy` 与单文件删除不触发。
- 批量 `trash` 的顶层 `ok` 只有全部成功才为 true（带 `succeeded`/`failed`，逐条看 `results[]`）；批量 `edit_text` 的顶层 `ok` 与 `summary` 一致，有失败条目即为 false。

### 5.1 回收站三态

动手前先探测「**本进程能不能真的把文件送进回收站**」：在包内临时目录建 1 字节探针 → 记录 `<卷>:\$Recycle.Bin\` 下**所有 SID 子目录**的 `$I*` 总数（不可读的 SID 目录逐个 try/catch 跳过）→ 用底层原始动作把探针送回收站 → 再数一次，**`after > before` 才算可用**。

为什么必须真做一次删除：受限进程（低完整性 / 可写域不含 `$Recycle.Bin`）里 `SHFileOperation` **仍返回 rc=0**，文件却已被**静默永久删除**——只看「exit 0 + 文件消失」会谎报成功。结果进程内缓存（**懒加载**），探测异常一律按**不可用**处理（fail-closed），原因留在 `recycleBinCapability().detail`；探针仍在则用 `fsp.rm` 清掉。

| 情况 | `trash` 返回 | `move` 覆盖返回 |
|---|---|---|
| 能力 `true` | `ok:true` / `action:'sent-to-recycle-bin'` / `recyclable:true` | `ok:true` / `overwrote:true` / `overwrittenToRecycleBin:true` / `recyclable:true` |
| 能力 `false`（默认） | `ok:true` / `action:'deleted-permanently'` / `recyclable:false` / 顶层 `warning:'本进程无法使用回收站（可能受沙箱权限限制），文件已永久删除且不可恢复'` | `ok:true` / `overwrote:true` / `overwrittenToRecycleBin:false` / `recyclable:false` / `warning:'…覆盖时目标已永久删除且不可恢复'` |
| 能力 `false` + `FOP_REQUIRE_RECYCLE_BIN=1`（严格模式） | `ok:false` / `error:'recycle_bin_unavailable'`，一个文件都不删 | 同左：`ok:false` / 源与目标均保持原样 |

降级原则三条：**不谎报**（能力不可用时绝不报 `sent-to-recycle-bin`，即使文件确实消失了）、**不阻碍**（默认不让删除类任务卡死）、**可严格**（要「必须可恢复」就设 `FOP_REQUIRE_RECYCLE_BIN=1`）。能力 `false` 且非严格时**不再调**底层 COM 动作（省一次几百毫秒的子进程），直接用 `fsp.rm` 并标注降级。

`FOP_ALLOW_PERMANENT_DELETE=1` 的语义是**强制永久删**：跳过回收站、直接 `fsp.rm`，返回 `permanentDelete:true`（即使能力可用也不进回收站），且**不带 `warning`**（调用方已明确表态，例如清缓存 / 删 `node_modules`）。探测成功会在回收站留下一个几字节的探针条目（可接受）。

### 5.2 删除语义与保护分层

| 层 | 机制 | 管什么 |
|---|---|---|
| 第一层 | `protected.json`（保护规则） | **挡住「不该被删的东西」**——`node_modules`/`.git`/凭据/核心配置/审计日志/包管理器缓存。命中即拒绝，带 `ruleId` 与 `reason` |
| 第二层 | `trash` 回收站 | **兜底「删了还想恢复」**——进回收站，可还原 |
| 第三层 | 外部 shell 原生删除 | **效率优先的日常清理**——`Remove-Item`/`fs.rm`，快、无批量上限，**永久删除** |

四条容易误判的实际情况：

1. **回收站是后悔药，不是救命稻草**：重要文件的安全依赖第一层与工作区外的备份，**不依赖**回收站。
2. **`trash` 的可恢复性依赖执行进程的权限**：探测失败即降级并如实标注（`deleted-permanently` + `recyclable:false` + `warning`），**绝不谎报**。
3. **DSH 的 `pwsh` 沙箱是 Low integrity，其内部删除恒为永久**：`Remove-Item`/`fs.rm` 都**绕开本工具**，回收站兜底对该路径不适用——沙箱固有属性，不是本工具的缺陷。
4. **因此不强制所有删除走 `trash`**：它走 PowerShell COM、每文件一次调用，慢且受批量上限约束；只有**需要后悔药**的少量删除才值得用。

严格模式（`FOP_REQUIRE_RECYCLE_BIN=1`）供「宁可删不掉也不永久删」的场景使用，默认关闭。

### 5.3 move 的 overwrite（三态）

目标已存在 → 默认**拒绝覆盖**（`invalid_args`，避免误伤）；要覆盖必须显式传 **`overwrite:true`**（批量可按项传，项级覆盖全局）。覆盖前必过**三道闸**：

- **闸 A · 目标本身受保护**：仍走 `guardPath(dst,'move',{write:true})`，命中规则照旧拒绝。
- **闸 B · 目标是目录时查其子树**：覆盖目录 = 整棵树被删掉，等价 `trash` 语义 → 扫子树命中树形规则 → `protected_content_inside` 拒绝，**目标一个字节都不动**。
- **闸 C · 目标不是源自身 / 源的祖先 / 源的后代**：`src===dst`、`dst` 在 `src` 内、`src` 在 `dst` 内 → `invalid_args`（防 `mv a a/b` 自噬）。

执行策略（**防数据丢失**）：

- **同卷 `move`（走 rename）**：记 `overwrittenSha256`（文件）→ **把目标送进回收站** → `rename` 源到目标；rename 本身即原子移动，失败时**源仍在**。
- **其余（`copy` / 跨卷）**：记 `overwrittenSha256` → 复制源到目标同目录的临时路径 `.fop-ov-<pid>-<ts>`（`force:false` `errorOnExist:true`）→ 校验临时副本 sha256 等于源 → **才把目标送进回收站** → `rename` 临时到目标 → `mode='move'` 再删源；中途失败 `finally` 清理临时路径、目标保持原样。
- **处置按能力三态**：可用 → 送回收站（`overwrittenToRecycleBin:true`/`recyclable:true`）；不可用（默认）→ 直接删除并**如实标注** `overwrittenToRecycleBin:false`/`recyclable:false`/`warning`；不可用且严格模式 → 拒绝覆盖。处置**失败即放弃覆盖**（`io_error`，源与目标均未改动）；判定为可用时**不会**退回直接删除（那等于悄悄永久删除）。
- **`mode='move'` 删源仍直接删除**：这是「移动」的固有语义（源已完整复制并校验通过），**只有被覆盖的目标才送回收站**；`.fop-ov-*` 是本次操作自己产生的垃圾，直接删。
- 返回体加 `overwrote:true` + `overwrittenToRecycleBin` + `recyclable`；被覆盖目标是文件时带 `overwrittenSha256`（降级另带 `warning`，强制永久删带 `permanentDelete:true`）。

## 6. 写根与保护规则

**执行层序**（每层都过了才轮到下一层）：

```
device_path_check → realpath_check → write_root_check → sensitive_pattern_check → protected_rule_check
```

`identity_check` **不在这个序列里**：它是**调用侧的独立校验**（`verifyIdentity`），由调用方在真正写入前单独执行，不属于上述层序。

| 层 | 判什么 | 拒绝时的错误码 |
|---|---|---|
| `device_path_check` | 路径是否为设备名（`NUL`、`CON`、`COM1`…）或 `/dev/*` | `device_path` |
| `realpath_check` | 把路径解析为真实路径后再判一次 | —— |
| `write_root_check` | 写类动作的目标是否落在 `writeRoots` 内 | `write_root_denied` |
| `sensitive_pattern_check` | 是否命中凭据类规则（`.env*`、`*.pem`、`*.key`、`.ssh/**`、`.aws/**`、`*.credentials.yaml`） | `sensitive_denied` |
| `protected_rule_check` | 是否命中其余保护规则（带 `ruleId`/`reason`） | `protected_rule_denied` |
| `identity_check`（**不在上述序列内**，调用侧 `verifyIdentity`） | 校验后目标是否已发生变化（写前复核） | `identity_changed` |

**参数校验与存在性检查发生在规则判定之前**：参数非法（如 `trash` 一个目录缺 `recursive`）→ `invalid_args`；路径不存在 → `not_found`；两者都不会走到规则表。

### 6.1 配置文件在哪

- 默认是**包目录下的 `protected.json`**：`<包目录>/protected.json`；可用环境变量 `FILEOPS_CONFIG` 指向另一份（多实例隔离、自测都靠它）。
- 格式 v2，顶层 `version`/`writeRoots`/`batchLimits`/`readCaps`/`scanBudget`/`audit`/`rules`：
- `scanBudget`：扫描预算（`maxFiles` 文件数 / `maxMs` 毫秒），默认 `{ maxFiles: 20000, maxMs: 15000 }`；超限返回部分结果 + `truncatedBy:'scan_limit'`。

```json
{
  "version": 2,
  "writeRoots": [],
  "batchLimits": { "trash": 500, "move": 200, "edits": 50, "editPaths": 20, "editTotalReplacements": 200, "maxEditableBytes": 8388608, "failureDetailFiles": 10 },
  "readCaps": { "maxLines": 2000, "maxBytes": 65536 },
  "audit": { "enabled": false, "logPath": null, "retentionDays": 6, "maxBytes": 20971520, "summaryOnRotate": true },
  "rules": [
    { "id": "R3", "scope": "directory", "pattern": "**/node_modules/**", "patterns": ["**/node_modules/**", "**/node_modules"], "deny": ["trash", "move"], "reason": "依赖目录，误删需重装" }
  ]
}
```

- **首次上手必读的三处默认值**：① `writeRoots` 默认**空数组** → 忘配则**所有写操作被拒**（`write_root_denied`）；② `audit.enabled` 默认 **`false`**、`audit.logPath` 默认 **`null`** → 审计默认不落盘；③ 配置模板是 `protected.example.json`，**需复制为 `protected.json`** 后使用（模板里的 `writeRoots` 也是空的）。
- 每条规则字段：`id`、`scope`（`directory`/`file`）、`pattern`（或 `patterns` 多路径）、`deny`（`read`/`list`/`write`/`edit`/`trash`/`move`）、可选 `denyMoveAsSourceOnly`（`move` 只看源侧）、`reason`（必填）。
- **不允许** per-rule 例外开关字段（`enabled`/`except`/`exclude`/`ignore`/`bypass`）——语义统一。目录级规则默认只挡 `trash`/`move`，可读可编辑；凭据类规则连 `read`/`list` 一起挡。

### 6.2 三种 pattern 写法的语义

| 写法 | 例 | 实际匹配范围 | 含该目录本身？ |
|---|---|---|---|
| **字面路径** | `C:/work/profiles` | 只匹配该路径**本身**；其下的文件与子目录**不受**此条限制 | 是（就是它） |
| **通配 + `/**` 结尾** | `**/node_modules/**` | 该目录**之下**的所有层级（文件与子目录都算） | **否** |
| **通配（其他形态）** | `C:/work/logs/app.log*` | 按模式字面匹配到的所有路径（`*` 不跨目录分隔符） | 视模式而定 |

- **同一规则可列多条 pattern**：`patterns` 是数组 → 既能护「整棵树」（`**/node_modules/**`）又能护「目录本身」（`**/node_modules`）。示例配置里的 node_modules / .git / .ssh / .aws 就这么写且 `deny` 都含 `move`，故目录本身也不能被 `trash`/`move`（`.ssh`/`.aws` 的 `deny` 还含 `read`/`list`/`write`/`edit`，连 `list` 都拒）。
- **`scope` 的已知偏差（如实记录，暂不修）**：`scope:"file"` 的规则在**通配 pattern** 下 **`scope` 不参与正则匹配**（内部 `globToRegex` 对 `dirScope` 取 `void`）→ `**/*.key` 也会命中一个**名为 `my.key` 的目录**（**过度拒绝**，宁可偏严）；无通配的**字面**路径规则也**不区分文件 / 目录**。
- 判定逐条累加：命中某条且动作在其 `deny` 内 → 拒；命中但动作不在 `deny` 内 → 继续判下一条。

### 6.3 空目录放行

**语义**：命中的是**树形规则**（`scope:"directory"` 且至少一条 pattern 以 `/**` 结尾）、动作为 **`trash`**、目标是**空目录**时 → **放行**。放行粒度是「**这一条规则**」——继续判定下一条，**不是**放行整个操作。

**四种不放行**：① 动作不是 `trash`（`move`/`write`/`edit_text`/`read`/`list` 照旧判）；② 目标不是目录；③ 目录非空（只有一个空子目录也算非空）；④ 命中的不是树形规则——**字面路径规则永不**因「空」放行。

- **判空**：`statSync` + `readdirSync`，**fail-closed**：任何异常（不存在 / 无权限 / 实际不是目录）一律按「**非空**」处理 → **仍然拒绝**。判空紧贴操作执行，TOCTOU 窗口极小。
- **审计留痕**：因放行而**成功**的条目单独写审计：`ok:true` + `waived_rule:"<规则id>"` + `waived_reason:"empty_directory"`；**失败被拒条目的审计格式一字未改**。
- **副作用（如实记录）**：**空的 `.ssh`/`.aws` 目录也可被 `trash`**（空目录没有内容可泄露）；非空的一律拒绝。

### 6.4 祖先包含推理

**要堵的洞**：§6.2 / §6.3 只回答「**目标本身**是否受保护」。一个**不受保护**的父目录被递归 `trash` 时，子树里整棵 `node_modules` 会随之消失而规则完全不命中 —— **删父目录等于绕过子树的保护**。

**语义（不做任何放宽）**：递归删目录（`trash` + `recursive:true`）或 `move`（`mode:'move'`）搬整棵目录时，若**子树里存在命中树形保护规则的路径** → **一律拒绝**；**绝不因该子树是空的而放行父目录**。正确姿势是**两道程序**：先单独删掉那个空的受保护目录（§6.3 放行），再删它的父级。参与判定的只有**树形规则**，其「目录本身」pattern（`**/node_modules`、`**/.git`、`**/.ssh`、`**/.aws`）**也计入命中** → 「里面只有一个**空** `node_modules`」同样被拒；字面路径规则**不参与**。

错误码 `protected_content_inside`（与「目标本身受保护」的 `protected_rule_denied` 明确区分），报文要点：`ok:false` + `error` + `ruleId`（顶层再冗余一份便于筛选）+ `reason`（形如「目标目录的子树中存在受保护内容（node_modules），已拒绝递归删除/移动」）+ `protected_content` = `{ relative_path, ruleId, rule_reason }`（`relative_path` **相对被删/被移目录**）+ `next_step`（先单独删除其中那个目录，再删本目录）+ `scanned_entries`（本次扫描条目数）；仅**扫描超预算 / 读目录失败**时另有 `budget_exceeded`（`depth`/`entries`/`readdir_error` 之一）。

**扫描预算与 fail-closed**：条目上限 **50 000**、深度上限 **32**；超预算或读目录失败 → **一律拒绝**（错误码仍是 `protected_content_inside`，带 `budget_exceeded`）。**不存在「扫不完就放行」的路径**。生效范围：`trash`（目录 + `recursive:true`）与 `move`（`mode:'move'`，源侧）；**`copy` 与单文件删除不触发**。

**行为代价（如实记录）**：父目录里有**非空**受保护子树时，它及其所有上级永远无法经本工具删除或移走；跑过 `npm install`、是 git 仓库、含 `.ssh`/`.aws` 的项目目录因此都不可删，且每次递归都要全量扫子树。

### 6.5 局部不可读的处置口径

**要堵的洞**：`readdir` 失败（ACL 拒绝列举、EACCES/EPERM 等）若被静默吞掉，该目录及其**整棵子树**会从结果里消失，而返回体仍是 `ok:true`——这比报错更难发现。

**处置口径（四处目录遍历统一：`find_files`、`list_directory`、`count_text` 目录模式、目录统计）**：

| # | 规则 | 说明 |
|---|---|---|
| 1 | **不整条失败** | 局部不可读**不升级为错误**：顶层 `ok:true`，已扫到的**部分结果照常返回** |
| 2 | **不静默丢弃** | 该目录**计入 `skipped`**，并在 `skippedBy.unreadable` 记数（**1 个不可读目录 = 1 条**，不按其下文件数） |
| 3 | **给明细** | 追加到该函数**既有的明细数组**（不新增字段）：`find_files`/`list_directory` 用 `skippedSamples`，`count_text` 用 `skippedDetails`；每条 `{ path, reason:'unreadable' }`，`path` 为 posix 风格，上限 20 条 |
| 4 | **敏感不带 path** | 命中敏感规则的条目只给 `{ reason:'unreadable' }`，**不带 `path`**（沿用敏感不泄露纪律） |
| 5 | **顶层仍 fail-closed** | 列/扫的就是那个目录本身、且它读不出来 → 仍是 `io_error`，**不降级为 skipped** |
| 6 | **不改既有返回结构** | 未遇到不可读目录时返回体与改前**逐字一致**：`skipped`/`skippedBy`/`skippedSamples` 三件套**仅在真的遇到不可读目录时出现** |

## 7. 读取

- 默认最多 **2000 行 / 64 KiB**（`readCaps`），超出给 `truncated:true` 与 `nextStartLine`；显式 `count` 可突破行数上限。
- 重复读同一文件命中缓存（`cached:true`/`unchanged:true`，正文不再返回）；文件变化后自动失效，强制取正文用 `force_read:true`。
- 二进制只返回元信息（`binary:true`、`reason:'binary_detected'`）与 sha256；**判定三处一致**（`read_text`/`find_files`/`count_text`）。空文件 `totalLines=0`（与 `count_text` 的 `lines=0` 一致）。

### 7.1 read_text 与字节区间读

两组区间参数**互斥**，同传 → `invalid_args`：

| 组 | 参数 | 语义 |
|---|---|---|
| 行区间 | `start_line`（1 起）+ `count` | 从第几行开始读多少行；默认上限 2000 行 |
| 字节区间 | `start_byte`（≥ 0 的整数）+ `max_bytes`（≥ 1 的整数，默认 65536） | 从第几个字节开始读多少字节 |

- `start_byte` 负数 → `invalid_args`；≥ 文件长度 → 空正文并提示「起点超出文件长度」；`max_bytes` 超 65536 按 65536 处理。
- **`max_bytes` 只约束正文**，续读说明**附加在外**、只受 65536 字节响应体硬上限约束；单行超限时**行内截断**并标记 `lineTruncated:true`（给 `truncatedLine`/`truncatedLineBytes`），截断时返回 `howToContinue`。
- `count_text` 区间口径与 `read_text` 对齐（行区间与字节区间都支持）；字节区间落在多字节字符中间时**回退到字符边界**（`alignmentAdjusted`/`alignmentBackoffBytes`）。非 UTF-8 文件的**字节区间读一律返回 `invalid_args`**——字节区间**仅支持 UTF-8/ASCII**，**与是否安装 `iconv-lite` 无关**；错误信息会提示改用 `start_line` + `count` 按行读取，**行区间对所有编码都支持**。字节边界落在多字节字符中间时的自动回退（`alignmentAdjusted` / `alignmentBackoffBytes`）只发生在 UTF-8 字节区间内。

### 7.2 编码支持

| 编码 | 自动探测 | 备注 |
|---|---|---|
| UTF-8（带 / 不带 BOM） | 支持（BOM → strict 校验） | 非法字节序列不会硬判 UTF-8 |
| UTF-16LE / UTF-16BE | 支持（含**无 BOM** 的启发式） | NUL 奇偶位比例 ≥ 60% 且 NUL 数 ≥ 2，再解码校验 |
| GB18030 | 支持（BOM `84 31 95 33` 剥离并回 `bom:true`） | 需要 `iconv-lite` |
| Big5 | 支持 | 需要 `iconv-lite`；与 GB18030 自动区分不可靠 |

- **显式 `encoding` 是可靠的唯一覆盖手段**：显式给定编码时**只按该编码解码**（跳过候选尝试与二进制嗅探），返回 `encoding` 回显实际所用编码；**非法编码名 → `invalid_args`**（不在 schema 里设 enum，避免协议层先拒而给出另一套错误）。
- 探测顺序与 GB18030 / Big5 的歧义见 §4；遇到日文 / 繁体内容请显式传 `encoding`。

### 7.3 三处最易混淆的字段

1. **`bytes` vs `fileBytes` vs `totalBytes`**
   - `bytes` = **本次范围**的字节数：区间模式 = 区间字节数；非区间模式 = 整文件字节数（此时与 `fileBytes` 相等）；
   - `fileBytes` = **整个文件**有多大；`totalBytes` = 整棵范围（单文件即文件本身、目录即整棵子树）累计字节数。
   区间统计时 `bytes` 只算区间，`fileBytes` 始终是整文件——两者**不是**同一个数。
2. **`range.count` vs `range.returnedCount`**
   - `range.count` = 你**请求**的行数上限；`range.returnedCount` = 实际**返回 / 统计**的行数。
   请求 300 行但文件只剩 10 行时，`count=300`、`returnedCount=10`。
3. **`truncated` 与 `truncatedBy`**
   - `truncated` 只回答「**不完整**」；**原因**看 `truncatedBy`：`limit`（条数）/ `max_lines`（行数）/ `max_bytes`（字节）/ `scan_limit`（扫描预算）——本 MCP 不产生 `max_matches_per_file`（属检索类工具）。只读 `truncated` 分不清是哪条上限。

## 8. 错误码总表

| error | 触发条件 | 该怎么办 |
|---|---|---|
| `target_missing` | `overwrite` 且目标不存在、未传 `createIfMissing` | 传 `createIfMissing:true`，或改用 `replace` |
| `target_exists` | `overwrite` 且目标已存在、未传 `overwriteExisting` | 传 `overwriteExisting:true`（可配合 `expected_sha256`） |
| `version_mismatch` | `expected_sha256` 与实际不符 | 重新读取取新 sha256 再提交 |
| `not_found` | `oldText` 零命中（含缩进作废、字面量不匹配） | 看 `nearMisses[].exactText` 照抄原文 |
| `ambiguous` | `oldText` 命中多处 | 用 `candidates[].line`/`.snippet` 补上下文使其唯一 |
| `write_root_denied` | 写类目标不在 `writeRoots`（发布版默认空数组！） | 改到写根内，或先 `move`（`copy`）进来 |
| `sensitive_denied` | 命中敏感规则（`.env*`、`*.pem`、`*.key`、`.ssh/**`、`.aws/**`、`*.credentials.yaml`） | 不要绕过，请用户提供内容。**例外**：`trash` 一个**空的** `.ssh`/`.aws` **目录**走空目录放行（§6.3）→ 成功并带 `waived_rule` + `waived_reason:"empty_directory"`（非错误码） |
| `protected_rule_denied` | 命中保护规则（带 `ruleId`/`reason`） | 按 reason 处理；受保护目录需人工清理。**例外**：树形规则下 `trash` **空目录**放行（§6.3）→ `ok:true` + `waived_reason:"empty_directory"` |
| `protected_content_inside` | 递归删/搬**整棵目录**时子树里有命中**树形规则**的路径（**空子树也算**），含 `move` 传 `overwrite:true` 覆盖目录的情形（覆盖=整树删除）；或扫描超预算（50 000 条 / 32 层）、读目录失败 → fail-closed | **不会自动放行**；按 `next_step` 先单独处理 `protected_content.relative_path`，再删/移父目录；覆盖场景下目标**未被改动**（§6.4） |
| `recycle_bin_unavailable` | **仅能力不可用 + `FOP_REQUIRE_RECYCLE_BIN=1` 时出现**；未设该变量时降级执行（永久删 + `recyclable:false` + `warning`，**不是**错误码）。判据：`<卷>:\$Recycle.Bin\<SID>` 下 `$I*` 数量没有增加 | 要「不阻碍」→ 取消严格模式；要「必须可恢复」→ 保持严格并改由用户手工删除；不需回收站 → `FOP_ALLOW_PERMANENT_DELETE=1` |
| `mixed_eol` | 原文件混用 CRLF/LF 且用 `replace` | 读出全文统一换行后 `overwrite` 写回 |
| `batch_limit` | 超过批量上限（带 `limit`/`given`） | 分批提交 |
| `identity_changed` | 校验后目标发生变化 | 重试 |
| `invalid_args` | 参数非法（空 `paths`、`path` 与 `paths` 互斥、`oldText` 为空、批量 overwrite、**目标是目录**、**非法编码名**、区间参数互斥等）；`move` 目标已存在却未传 `overwrite:true`，或 `src===dst`/`dst` 在 `src` 内/`src` 在 `dst` 内（闸 C） | 按 reason 改正参数；要覆盖就传 `overwrite:true`，否则换目标名或换不相交的目标 |
| `already_applied` | `status:'already_applied'`（非错误，表示此前已生效） | 无需再改；查 `alreadyAppliedBy` |
| `binary` | 编码探测失败 / 二进制内容不可按文本处理时返回（注意：与 §7 里表示「读到的内容是二进制」的 `binary:true` 标记字段是两回事） | 按元信息处理，或改用脚本按字节处理 |
| `aborted` | 批量编辑 `all_or_nothing:true` 预校验失败时，随每个文件返回的中止标记 | 按各文件自己的失败原因逐个处理，修正后重新提交 |
| `device_path` | 路径是设备名（`NUL`、`CON`、`COM1`…）或 `/dev/*` | 换真实文件路径 |
| `dependency_unavailable` | 缺少 `iconv-lite` 等依赖，无法处理该编码 | 安装依赖或只处理 UTF-8（§4 / §7.2） |
| `file_too_large` | 单文件超过 8 MiB 可编辑上限 | 用脚本处理（批量中仅跳过该文件） |
| `io_error` | 底层 IO / 编解码 / 校验失败；**目录遍历里只用于「顶层」目录本身读不出来** → fail-closed。**子树内不可读目录不报错**，走 `skipped`（§6.5） | 按 reason 排查；子树被跳过时看 `skipped`/`skippedBy`/`skippedSamples` |
| `scan_limit` | 历史错误码，**现不再作为 `error` 返回**：`find_files`/`list_directory` 递归扫描超预算（文件数 20000 或耗时 15000 ms） | 现返回 `ok:true` + `truncated:true` + `truncatedBy:'scan_limit'` + `reason`/`hint` + `scanned`/`elapsedMs`/`limit` 与部分结果；缩小范围后重试 |

## 9. 启用方式

服务是 **stdio 传输**、**长驻进程**：被客户端拉起后一直运行，改 `index.mjs` 必须重启客户端才生效（改 `protected.json` 是热加载，见 §10.3）。

**只读模式**：支持 `--readonly` 启动参数——只注册 **7 个只读工具**（`read_text` / `get_file_info` / `list_directory` / `find_files` / `count_text` / `diff` / `list_protected`），调用写类工具会被拦截。适合纯检索场景。

### 9.1 作为 MCP 客户端注册

通用 `mcpServers` 格式（Claude Desktop、多数 MCP 客户端通用）：

```json
{
  "mcpServers": {
    "file-ops": {
      "command": "node",
      "args": ["D:/tools/mcp-file-ops/index.mjs"],
      "env": { "FILEOPS_CONFIG": "D:/tools/mcp-file-ops/protected.json" }
    }
  }
}
```

DSH 的 preset 挂载格式（`cordis.patch.yml`）：

```yaml
- id: mcp-file-ops
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: file-ops
    transport: stdio
    command: node
    args:
      - D:/tools/mcp-file-ops/index.mjs
```

挂载后还需把要用的工具名加入该 preset 的工具白名单（`allowlists`）。

### 9.2 环境变量

| 变量 | 作用 | 默认 |
|---|---|---|
| `FILEOPS_CONFIG` | 规则文件路径（替代 `<包目录>/protected.json`） | 未设 → 用包内 `protected.json` |
| `TYPST_PATH` | `convert_document` 输出 PDF 时的 typst 可执行文件 | 先扫 `PATH`，再用内置 fallback |
| `PANDOC_PATH` | `convert_document` 的 pandoc 路径 | 先扫 `PATH`，再用内置 fallback |
| `GIT_PATH` | `diff` 用的 git 可执行文件 | 先扫 `PATH`，再退回常规安装位置 |
| `FOP_ALLOW_PERMANENT_DELETE` | `=1` **强制永久删**：跳过回收站、直接删除，`permanentDelete:true`，不带 `warning` | 未设 |
| `FOP_REQUIRE_RECYCLE_BIN` | `=1` **严格模式**：回收站能力不可用即拒绝删除 / 拒绝覆盖，绝不降级 | 未设（宽松降级） |
| `FOP_FORCE_CROSS` | `=1` 把同卷 `move` 也按**跨卷路径**处理（复制 + sha256 校验 + 删源），用于验证跨卷分支 | 未设 |

外部程序探测顺序：环境变量 → `PATH` → 内置 fallback（只放常规安装位置）。

## 10. 保护规则怎么改

### 10.1 直接编辑 protected.json

- 文件：`<包目录>/protected.json`（或 `FILEOPS_CONFIG` 指向的那份）。编辑前先 `list_protected()` 看一眼当前生效快照与 `config` 指纹（`configPath`/`mtime`/`sha256`/规则条数），确认改的是服务端真正在读的那份。
- 写入前自查：JSON 合法；每条规则必须有 `id`/`scope`/`pattern` 或 `patterns`/`deny`/`reason`；`deny` 的动作名必须在 `read,list,write,edit,trash,move` 内；不得出现 per-rule 例外开关字段。
- `protected.example.json` 只给 9 条常见规则（node_modules、.git、凭据、密钥、缓存目录等），**可按需增删**。9 个 ID：`R3`(node_modules) / `R4`(.git) / `R5`(*.credentials.yaml) / `R8`(.env*) / `R9`(.ssh) / `R10`(.aws) / `R11`(*.pem) / `R12`(*.key) / `R15`(包管理器缓存目录)。
- **审计日志要自己保护**：若把 `audit.enabled` 打开并指定 `logPath`，**建议自行加一条规则保护该日志**（pattern 覆盖 `<你指定的路径>` 及其轮转副本，`deny` 为 `trash`/`move`/`write`/`edit`）——**示例配置里没有这条**，不补则日志可被客户端删改。

### 10.2 管理台用法

仓库内附带 `manage-rules.mjs`（只用 Node 内置模块，无额外依赖）：

```
node <包目录>/manage-rules.mjs
```

```
=== 保护规则管理台 ===
现役: <包目录>/protected.json   最后修改: <时间戳>   规则: <N> 条
[1] 列出全部规则          [2] 新增规则        [3] 修改规则
[4] 删除规则              [5] 试算路径         [6] 校验并写回
[0] 退出
```

菜单项：`1` 列出全部规则（编号/范围/路径/deny/reason）、`2` 新增规则（问答：范围 → 路径 → 拦哪些动作 → 理由 → 确认）、`3` 修改、`4` 删除、`5` 试算路径（「会被哪些规则命中、拦什么动作、能不能读」）、`6` 校验并写回。单命令模式便于脚本化：

```
node <包目录>/manage-rules.mjs list
node <包目录>/manage-rules.mjs check "C:/work/projects/app/a.md"
node <包目录>/manage-rules.mjs add --scope file --pattern "C:/work/my.conf" --deny "trash,edit" --reason "手工维护的配置"
node <包目录>/manage-rules.mjs verify
```

- `list`/`check`/`verify` 的每个动作都带**错误码**：敏感类规则 → `sensitive_denied`；其余保护规则 → `protected_rule_denied`；放行的动作 → `errorCode: null`。`check` 额外输出一行 `JSON: {...}` 供脚本消费。
- `verify` 用固定样例路径输出**管理台自己的判定**，与 file-ops 实际行为对拍：两者是**两套独立实现**，不一致说明语义漂移，应修实现而不是改规则。写回前自动备份（`<包目录>/backups/protected-<YYYYMMDD-HHMMSS>.json`），主文件始终是固定名 `protected.json`；**管理台不表达执行层序**，对拍时以现役行为为准（§6）。

### 10.3 热加载

服务端在**每次判定前**比对 `protected.json` 的 mtime + size，变了就重载（`hotReload` 回报 `{ enabled:true, configPath, strategy:'mtimeMs+size' }`）。

- **改 JSON 立刻生效，不用重启**（`protected.json` 与 `FILEOPS_CONFIG` 指向的文件一样）。
- **改 `index.mjs` 必须重启客户端**——它是长驻进程，内存里的实现不会自我替换。
- `list_protected()` 返回**当前生效快照**：`writeRoots`/`batchLimits`/`readCaps`/全部规则（含条数）/`enforcement` 开关与层序/`config` 指纹（`configPath`/`mtime`/`sha256`/规则条数）/`audit` 开关与保留期/`hotReload`；配置语法错误时另给 `configError`。用它回答「服务端现在认的是哪一版」。

## 11. 已知边界与坑

1. **工具参数里的 `\r\n` 是字面量**（不会被解析成换行）→ 需要真实 CRLF 时，用 `read_text` 读一个真实含 CRLF 的文件，把返回的 `text` 原样传回。
2. **长驻进程**：`index.mjs` 改完必须重启客户端才生效；MCP 层功能验收放在重启之后（`protected.json` 的规则改动是热加载，无需重启）。
3. **匹配语义只有一套**：字面路径只匹配该路径本身；通配 + `/**` 结尾匹配该目录**之下**的所有层级、**不含该目录本身**；要同时护「整棵树」与「目录本身」，就在同一规则的 `patterns` 里列两条 pattern（§6.2 / §6.3 / §6.4）。
4. `read_text` 默认有行数 / 字节上限，超出要显式 `count`；`max_bytes` 只约束正文，续读说明另计。
5. **写根限制只管本 MCP 的写类操作**，管不到外部 shell（如 code-operator 的 `pwsh`）——后者的写边界由它自己的沙箱（会话工作区）决定。
6. **`scope` 的已知偏差**：通配 pattern 下 `scope` 不参与匹配（`**/*.key` 会命中名为 `my.key` 的目录，过度拒绝）；字面路径规则不区分文件 / 目录。要连目录本身一起护，就在 `patterns` 里显式列 `**/xxx`。
7. **`.tmp/` 是运行时临时目录，不要手工清理**：服务按需自动创建，调用外部程序时在其下新建 `run-*` 存放 stdout/stderr，用完自动删除；删掉不会破坏功能，但清理无收益，且要确认无子进程占用。
8. **审计日志默认不落盘**（`enabled:false`、`logPath:null`）；开启后返回体带 `auditLogged`/`auditRotated`/`auditPrevious`（未启用时 `auditLogged` 不出现）。**示例规则里没有保护审计日志的规则，开启后请自行加一条**（§10.1）。
9. **`trash` 的可恢复性取决于执行进程权限**：探测为不可用即如实降级（`deleted-permanently` + `recyclable:false` + `warning`），绝不谎报 `sent-to-recycle-bin`；需要硬保证就开 `FOP_REQUIRE_RECYCLE_BIN=1`。
10. **`FOP_TEST_RB_CAP` 是内部测试钩子**：设为 `0` 可强制「回收站能力探测」判为不可用，用于验证降级路径；**正常使用不要设置**。

## 12. 许可

MIT，完整条款见 `LICENSE`。

- 包名 `@fastunbeaten/mcp-file-ops`，版本 `0.1.0`；`engines.node >= 20`；运行时依赖 `@modelcontextprotocol/sdk`（`1.32.2`），可选依赖 `iconv-lite`（缺失时编码能力降级，见 §4 / §7.2）。
- 实现参考 `@modelcontextprotocol/server-filesystem`（MIT）的**公开行为**，按行为自行实现，未复制其源码。
