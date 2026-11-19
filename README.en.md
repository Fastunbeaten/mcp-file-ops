# file-ops — file-operation MCP server

A local file-operation MCP server implemented as a single-file ESM module (stdio transport), aimed at the scenario of "letting a model change files safely". Zero third-party dependencies besides `@modelcontextprotocol/sdk`; `iconv-lite` is an optional dependency (when it is missing, the encoding capabilities degrade, see §4 and §7.2).

Core positioning: **the write boundary is enforced by the tool** — read paths are unlimited, while write-type operations may only land inside the configured write roots (`writeRoots`); combined with unique matching, idempotency, atomic writes and encoding / line-ending fidelity, it keeps both classes of accident ("changed the wrong thing" and "corrupted the thing") out at the tool layer.

## 1. Design principles

| Principle | Meaning |
|---|---|
| Write boundary enforced by the tool | Read paths are unlimited; write-type operations only inside `writeRoots` (§6). **Never relies on the model's self-discipline** |
| Unique match | A hit must be unique; multiple hits are always rejected with candidates, **no guessing** |
| Idempotency | Re-submitting the same replacement is not applied twice; decided by **position and file hash**, not by "that text appears in the content" |
| Atomic writes | Temporary file + rename; in a batch, a single failing item means zero writes for that file |
| Fidelity | Keeps the original file's encoding (UTF-8 / GB18030 / Big5 / UTF-16) and line-ending style |
| Explainable errors | Every error carries `error`/`reason`, and most give a next step |

## 2. Tool overview (12 tools)

| Tool | One-line responsibility |
|---|---|
| `read_text` | Read text; supports chunked reading, line numbers, cache reuse |
| `edit_text` | **The workhorse**: precise replacement / whole-file overwrite |
| `create_directory` | Create a directory (recursive by default) |
| `get_file_info` | File metadata |
| `list_directory` | List a directory (recursive, depth-limited) |
| `find_files` | Find by name / extension / time / size |
| `trash` | **Move to the recycle bin** (recoverable; **degrades to a permanent delete, labelled truthfully, only in restricted environments where the recycle bin is unavailable**) |
| `move` | Move / copy (cross-volume supported, with sha256 verification) |
| `diff` | Content-level difference (`git diff --no-index`) |
| `convert_document` | Document conversion (pandoc): inputs md/docx/html/txt/csv/latex (**pdf is not an input format**), outputs also `txt` (plain writer) and `pdf` (typst engine); **a txt input is parsed as markdown** |
| `list_protected` | Query the effective write roots, protected rules, batch limits, read caps and the **config fingerprint** |
| `count_text` | **Text metrics**: lines / paragraphs / sentences / words / graphemes / code points / Han characters ... (directories, multiple encodings and **range statistics** supported) |

All tool schemas use `additionalProperties:false`. Parameter highlights:

- Reads and queries: `read_text` requires `path` and defaults to `encoding='auto'`, while line ranges and byte ranges are **mutually exclusive** (§7.1); `list_directory` has `limit=500` (beyond it, `truncated:true`); `find_files` requires `root` and has `limit=200`, its `name_pattern` **matches as a bare substring when it contains no wildcard**, and `modified_within` is a relative time window (e.g. `7d`).
- Writes and deletions: `edit_text`'s `path` and `paths` are mutually exclusive and `mode='replace'` is the default (§3); a directory passed to `trash` requires `recursive:true`, with a limit of 500 entries; `move`'s `paths[]` holds at most 200 pairs and `overwrite` defaults to `false` (§5.3); `create_directory` is recursive by default and its target must be inside a write root.
- The rest: `get_file_info` returns metadata; `list_protected` takes no parameters; `diff` has `mode='summary'` / `'full'` (truncated beyond 200 KB); `convert_document`'s `out_path` is optional; `count_text` takes either `paths` or `text`, **supports range statistics** — `start_byte`/`max_bytes` byte ranges and `start_line`/`count` line ranges (same parameters and semantics as `read_text`), where `bytes` covers that range only while `fileBytes` is always the whole file — and handles at most 200 files / 200 MB per call.
- Two side effects of `convert_document`: (1) **a txt input is parsed as markdown** (pandoc has no plain reader, so `#`/`*` inside the txt are treated as markdown syntax); (2) **pdf cannot be an input format** (pandoc has no pdf reader and reports `io_error`); on the output side `txt` (plain writer) is supported.

## 3. edit_text (the most important tool)

Prefer it when changing an existing file: no need to read the whole file first, encoding and line endings are preserved, hits must be unique, and repeated submissions are idempotent.

### 3.1 Two modes

| Mode | Purpose | What must be passed explicitly |
|---|---|---|
| `mode='replace'` (default) | Local replacement | none |
| `mode='overwrite'` | Whole-file overwrite | Overwriting an **existing** file needs `overwriteExisting:true`; **creating** a file needs `createIfMissing:true` |

`overwrite` requires an explicit statement: omit `overwriteExisting` → `target_exists`; omit `createIfMissing` → `target_missing`. It can be combined with `expected_sha256` for version checking; a mismatch → `version_mismatch`.

### 3.2 Two-level matching

1. **Exact match**: literally identical, and the hit must be unique (`matchedBy:'exact'`).
2. **Literal-aware normalization**: enabled only when the exact match has zero hits, and it collapses **semantically insignificant whitespace only**; neither **inside string literals** nor **the leading indentation of a line** is collapsed (`matchedBy:'normalized'`).

Multiple hits → rejected with candidates (`error:'ambiguous'`, `candidates[].line` / `.snippet`); zero hits at both levels → `nearMisses` is returned, each item giving `exactText` (the **exact original text** at that spot, which will match if copied verbatim), `diffKind` (`indent` for a different indentation shape, commonly tab vs. spaces / `literal` for a difference inside a string literal / `whitespace` for a difference in in-line whitespace) and `diffInsideLiteral`. Literal recognition covers `"..."`, `'...'`, backtick template strings and Python triple quotes (including escaped quotes); extra spaces inside a literal are **not** collapsed automatically.

### 3.3 Indentation guard (two rules)

1. **Never changed by accident**: if the **start of the matched span falls inside the leading indentation of a file line** (`oldText` carries leading whitespace and differs from the file's indentation in length only), that candidate is **invalidated** → `not_found` + `diffKind:'indent'` + the full original text. The way out: use an `oldText` without leading whitespace, or use the full indentation.
2. **Deliberate changes are announced**: if `oldText` covers a whole line's indentation while `newText` carries none, the tool **does as asked** but returns `indentChanged:true` with `originalIndent` / `newIndent` / `indentWarning`.

In YAML indentation is structure and in Python indentation is syntax: make `newText` carry the same indentation.

### 3.4 Idempotency

- Re-submitting the same (oldText, newText) pair → `status:'already_applied'`, together with `alreadyAppliedBy:'ledger'` (hash bookkeeping) or `'position'` (the target position already equals newText).
- **The criterion is position plus hash agreement**, not "newText appears somewhere in the file" — the latter would mistake "this sentence was already there" for an applied change.
- The ledger is **in-process memory state** (200 entries max) that drops the oldest entry beyond that (functionality is unaffected) and **is never written to disk** — after a restart or in another process the ledger evidence for `already_applied` is gone, leaving a replay only the position criterion (identical content really is applied again). `already_applied` is a status, not an error; nothing more needs to be changed.

### 3.5 Batching

| Form | Purpose | Limit |
|---|---|---|
| `edits[]` | Several changes in one file | 50 spots per file; the whole batch is atomic (one failure means zero writes for that file) |
| `paths[]` | The same change across several files | 20 files / 200 total replacements per call / 8 MiB per file; **independent per file** by default, with optional `all_or_nothing:true` (validate everything first, and if any item fails the whole batch writes nothing) |

- `summary.failed > 0` means some files were not changed → **they must be handled one by one**; files above 8 MiB in `summary.skipped` are `file_too_large` and **do not abort the batch**.
- If each file needs a different change → **do not use the batch form**, call the tool once per file; exceeding a limit → `batch_limit` (with `limit` / `given`).
- Batching supports `mode='replace'` only; passing `overwrite`, or both `path` and `paths` → `invalid_args`; a target that is a directory → `invalid_args` (the directory's content is untouched).

## 4. Line endings and encoding

| Scenario | Behavior |
|---|---|
| `mode='replace'` + the file mixes CRLF/LF | **Rejected** (`mixed_eol`); the reason gives the line counts per style and the way out: read the whole file, unify the line endings, and write it back with `mode='overwrite'` |
| `mode='replace'` + the file is pure LF / pure CRLF | Follows the file's style (`writtenEol:'lf'` / `'crlf'`) |
| `mode='overwrite'` + content is pure CRLF | Written as CRLF (`writtenEol:'crlf'`, `eolNormalized:false`) |
| `mode='overwrite'` + content is pure LF | Written as LF (**the caller is obeyed**, the original file is not followed) |
| `mode='overwrite'` + content mixes the two itself | **Unified automatically to the majority style**, reporting `eolNormalized:true` and `contentEolNormalizedTo` |

**Encoding**: reads and writes preserve the original encoding (returned as `encoding` / `encodingPreserved`); UTF-8 / UTF-16LE / UTF-16BE / GB18030 / Big5 are all supported. **Detection order**: BOM → UTF-8 (strict) → **UTF-16 heuristic** → GB18030 → Big5; the UTF-16 heuristic counts, over 2-byte pairs, how often the NULs land on even versus odd positions (at least 2 NULs and a winning side of at least 60%), and only then validates by decoding (no U+FFFD, no anomalous control characters) before trusting it → **BOM-less UTF-16 is read correctly too**, while real binaries containing NULs are still classified as `binary`.

**GB18030 and Big5 can decode each other "without error", so auto-detection between the two is unreliable**: when it cannot decide, it returns `encodingCandidates` (e.g. `["gb18030","big5"]`) and `encodingUncertain:true`; pass `encoding` **explicitly**. GB18030's BOM (`84 31 95 33`) is stripped and reported back as `bom:true`, and the body never contains U+FEFF.

**Degradation when iconv-lite is missing**: GB18030 / Big5 depend on the optional `iconv-lite` (pure JS); when it cannot be installed, the capability degrades to **UTF-8 / UTF-16 only**, and from then on those two encodings yield `dependency_unavailable` — it **never silently reads or writes them under a UTF-8 assumption** (that would write Chinese as mojibake bytes); **byte-range reads** are a different matter: a byte-range read of any non-UTF-8 file (including GB18030 / Big5) **always returns `invalid_args`**, **regardless of whether `iconv-lite` is installed**; the error message guides the caller to `start_line` + `count` for line-based reads (line ranges support every encoding).

## 5. Deletion and moving

- `trash` → **goes to the Windows recycle bin, recoverable**; it degrades to a permanent delete, labelled truthfully, only in restricted environments where the recycle bin is unavailable (§5.1); a directory requires `recursive:true`; at most 500 entries per call.
- `move` is a **move** by default (a rename on the same volume, atomic); across volumes it copies first, verifies SHA-256, then deletes the source, returning `crossVolume:true` / `sha256Verified:true`.
- `mode='copy'` copies (**the source path is unlimited**, the target must be inside a write root); `mode='move'` requires **both** source and target inside write roots. A recursive `trash` of a directory / a `move` of a whole directory scans the subtree first (§6.4); `copy` and single-file deletion do not trigger it.
- The top-level `ok` of a batch `trash` is true only when everything succeeded (it carries `succeeded` / `failed`, with per-entry details in `results[]`); the top-level `ok` of a batch `edit_text` agrees with `summary` and is false as soon as any entry failed.

### 5.1 The three states of the recycle bin

Before acting, it probes "**can this process really put a file into the recycle bin**": create a 1-byte probe in a temporary directory inside the package → record the total number of `$I*` entries under **all SID subdirectories** of `<volume>:\$Recycle.Bin\` (unreadable SID directories are skipped one by one with try/catch) → send the probe to the recycle bin with the low-level native action → count again; only **`after > before` counts as available**.

Why a real deletion is mandatory: in a restricted process (low integrity / `$Recycle.Bin` outside the writable set) `SHFileOperation` **still returns rc=0** while the file has already been **silently deleted permanently** — judging by "exit 0 plus the file is gone" would report success falsely. The result is cached inside the process (**lazy loading**), and any probe anomaly is treated as **unavailable** (fail-closed), with the cause left in `recycleBinCapability().detail`; if the probe still exists it is removed with `fsp.rm`.

| Situation | What `trash` returns | What `move` overwriting returns |
|---|---|---|
| Capability `true` | `ok:true` / `action:'sent-to-recycle-bin'` / `recyclable:true` | `ok:true` / `overwrote:true` / `overwrittenToRecycleBin:true` / `recyclable:true` |
| Capability `false` (default) | `ok:true` / `action:'deleted-permanently'` / `recyclable:false` / top-level `warning:'this process cannot use the recycle bin (possibly restricted by sandbox permissions); the file has been permanently deleted and cannot be recovered'` | `ok:true` / `overwrote:true` / `overwrittenToRecycleBin:false` / `recyclable:false` / `warning:'...on overwrite the target was permanently deleted and cannot be recovered'` |
| Capability `false` + `FOP_REQUIRE_RECYCLE_BIN=1` (strict mode) | `ok:false` / `error:'recycle_bin_unavailable'`, and not a single file is deleted | As on the left: `ok:false` / both source and target stay as they were |

Three degradation principles: **never misreport** (when the capability is unavailable it never claims `sent-to-recycle-bin`, even if the file really is gone), **never block** (by default a deletion task is not stalled), **can be strict** (when "must be recoverable" is required, set `FOP_REQUIRE_RECYCLE_BIN=1`). When the capability is `false` and strictness is off, it **no longer calls** the native COM action (saving one subprocess of a few hundred milliseconds) and uses `fsp.rm` directly, labelling the degradation.

`FOP_ALLOW_PERMANENT_DELETE=1` means **force a permanent delete**: skip the recycle bin and call `fsp.rm` directly, returning `permanentDelete:true` (the recycle bin is bypassed even when the capability is available) and **carrying no `warning`** (the caller has already stated its intent, e.g. clearing caches / deleting `node_modules`). A successful probe leaves a few-byte probe entry in the recycle bin (acceptable).

### 5.2 Deletion semantics and the protection tiers

| Tier | Mechanism | What it governs |
|---|---|---|
| First tier | `protected.json` (protected rules) | **Blocks "things that must not be deleted"** — `node_modules`/`.git`/credentials/core config/audit log/package-manager caches. A hit is a rejection, with `ruleId` and `reason` |
| Second tier | `trash` / the recycle bin | **Catches "deleted but wanted back"** — goes to the recycle bin, restorable |
| Third tier | Native deletion from an external shell | **Efficiency-first routine cleanup** — `Remove-Item`/`fs.rm`, fast, no batch limit, **permanent deletion** |

Four practical facts that are easy to misjudge:

1. **The recycle bin is an undo button, not a lifeline**: the safety of important files depends on the first tier and on backups outside the workspace, **not** on the recycle bin.
2. **The recoverability of `trash` depends on the permissions of the executing process**: a failed probe means degradation, labelled truthfully (`deleted-permanently` + `recyclable:false` + `warning`), **never misreported**.
3. **DSH's `pwsh` sandbox runs at Low integrity, so deletions inside it are always permanent**: `Remove-Item`/`fs.rm` **bypass this tool**, and the recycle-bin safety net does not apply to that path — an inherent property of the sandbox, not a defect of this tool.
4. **Hence not every deletion is forced through `trash`**: it goes through PowerShell COM with one call per file, which is slow and bound by batch limits; only the few deletions that **need an undo button** are worth it.

Strict mode (`FOP_REQUIRE_RECYCLE_BIN=1`) serves scenarios that would rather fail to delete than delete permanently, and is off by default.

### 5.3 move's overwrite (three states)

If the target already exists → **overwriting is refused** by default (`invalid_args`, to avoid collateral damage); to overwrite, pass **`overwrite:true`** explicitly (per item in a batch, where an item-level value overrides the global one). Before overwriting, **three gates** must be passed:

- **Gate A · the target itself is protected**: it still goes through `guardPath(dst,'move',{write:true})`, and a rule hit is rejected as usual.
- **Gate B · when the target is a directory, its subtree is checked**: overwriting a directory means the whole tree is deleted, which is `trash` semantics → the subtree is scanned against tree-shaped rules → `protected_content_inside` rejection, and **not one byte of the target is touched**.
- **Gate C · the target is neither the source itself, an ancestor of the source, nor a descendant of the source**: `src===dst`, `dst` inside `src`, `src` inside `dst` → `invalid_args` (prevents `mv a a/b` self-cannibalism).

Execution strategy (**to prevent data loss**):

- **Same-volume `move` (via rename)**: record `overwrittenSha256` (file) → **send the target to the recycle bin** → `rename` the source onto the target; the rename itself is the atomic move, and if it fails **the source is still there**.
- **Everything else (`copy` / cross-volume)**: record `overwrittenSha256` → copy the source to a temporary path `.fop-ov-<pid>-<ts>` in the target's directory (`force:false` `errorOnExist:true`) → verify that the temporary copy's sha256 equals the source's → **only then send the target to the recycle bin** → `rename` the temporary file onto the target → for `mode='move'`, delete the source afterwards; on a failure midway, `finally` cleans up the temporary path and the target stays as it was.
- **Disposal follows the capability's three states**: available → send it to the recycle bin (`overwrittenToRecycleBin:true` / `recyclable:true`); unavailable (default) → delete directly and **label it truthfully** with `overwrittenToRecycleBin:false` / `recyclable:false` / `warning`; unavailable plus strict mode → refuse the overwrite. A **failed disposal abandons the overwrite** (`io_error`, neither source nor target changed); when the capability is judged available it **never** falls back to direct deletion (that would be a silent permanent delete).
- **`mode='move'` still deletes the source directly**: that is the inherent semantics of "move" (the source has already been copied in full and verified), and **only a target that is being overwritten goes to the recycle bin**; `.fop-ov-*` is garbage produced by this very operation and is deleted directly.
- The response body adds `overwrote:true` + `overwrittenToRecycleBin` + `recyclable`; when the overwritten target was a file it carries `overwrittenSha256` (the degraded path also carries `warning`, and a forced permanent delete carries `permanentDelete:true`).

## 6. Write roots and protected rules

**Check order** (every layer must pass before the next one runs):

```
device_path_check → realpath_check → write_root_check → sensitive_pattern_check → protected_rule_check
```

`identity_check` is **not part of this sequence**: it is an **independent check on the caller's side** (`verifyIdentity`), run separately by the caller right before the actual write.

| Layer | What it decides | Error code on rejection |
|---|---|---|
| `device_path_check` | Whether the path is a device name (`NUL`, `CON`, `COM1`, ...) or `/dev/*` | `device_path` |
| `realpath_check` | Resolve the path to its real path and judge once more | - |
| `write_root_check` | Whether the target of a write-type action falls inside `writeRoots` | `write_root_denied` |
| `sensitive_pattern_check` | Whether a credential rule is hit (`.env*`, `*.pem`, `*.key`, `.ssh/**`, `.aws/**`, `*.credentials.yaml`) | `sensitive_denied` |
| `protected_rule_check` | Whether any other protected rule is hit (carrying `ruleId` / `reason`) | `protected_rule_denied` |
| `identity_check` (**not in the sequence above**; caller-side `verifyIdentity`) | Whether the target has changed after validation (re-check before writing) | `identity_changed` |

**Parameter validation and existence checks happen before rule evaluation**: illegal parameters (e.g. `trash` on a directory without `recursive`) → `invalid_args`; a path that does not exist → `not_found`; neither ever reaches the rule table.

### 6.1 Where the config file lives

- The default is **`protected.json` inside the package directory**: `<package dir>/protected.json`; the environment variable `FILEOPS_CONFIG` can point at another copy (multi-instance isolation and self-tests both rely on it).
- Format v2, with top-level `version` / `writeRoots` / `batchLimits` / `readCaps` / `scanBudget` / `audit` / `rules`:
- `scanBudget`: scan budget (`maxFiles` file count / `maxMs` milliseconds), default `{ maxFiles: 20000, maxMs: 15000 }`; exceeding it returns partial results + `truncatedBy:'scan_limit'`.

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

- **Three defaults everybody must read on first use**: (1) `writeRoots` defaults to an **empty array** → if you forget to configure it, **every write operation is rejected** (`write_root_denied`); (2) `audit.enabled` defaults to **`false`** and `audit.logPath` to **`null`** → nothing is audited to disk by default; (3) the config template is `protected.example.json`, which **must be copied to `protected.json`** before use (the template's `writeRoots` is empty as well).
- Per-rule fields: `id`, `scope` (`directory`/`file`), `pattern` (or `patterns` for several paths), `deny` (`read`/`list`/`write`/`edit`/`trash`/`move`), optional `denyMoveAsSourceOnly` (`move` looks at the source side only), `reason` (required).
- Per-rule exception switches (`enabled`/`except`/`exclude`/`ignore`/`bypass`) are **not allowed** — the semantics stay uniform. Directory-level rules block only `trash`/`move` by default and remain readable and editable; credential rules block `read`/`list` as well.

### 6.2 Semantics of the three pattern forms

| Form | Example | What it actually matches | Includes the directory itself? |
|---|---|---|---|
| **Literal path** | `C:/work/profiles` | Matches that path **itself** only; files and subdirectories beneath it are **not** covered by this rule | Yes (it is the path) |
| **Wildcard + `/**` suffix** | `**/node_modules/**` | Every layer **below** that directory (files and subdirectories alike) | **No** |
| **Wildcard (other shapes)** | `C:/work/logs/app.log*` | Every path the pattern matches literally (`*` does not cross directory separators) | Depends on the pattern |

- **One rule may list several patterns**: `patterns` is an array, so a rule can protect both "the whole tree" (`**/node_modules/**`) and "the directory itself" (`**/node_modules`). The example config writes node_modules / .git / .ssh / .aws this way and every `deny` contains `move`, so those directories themselves cannot be `trash`ed or `move`d either (`.ssh`/`.aws` also carry `read`/`list`/`write`/`edit` in `deny`, so even `list` is refused).
- **Known deviation of `scope` (recorded truthfully, not fixed for now)**: for `scope:"file"` rules with a **wildcard pattern**, **`scope` takes no part in regex matching** (internally `globToRegex` takes `dirScope` as `void`) → `**/*.key` also hits a **directory named `my.key`** (**over-rejection**, deliberately leaning strict); **literal** path rules without wildcards likewise **do not distinguish files from directories**.
- Evaluation accumulates rule by rule: a hit whose action is inside that rule's `deny` → reject; a hit whose action is not in `deny` → keep evaluating the next rule.

### 6.3 Empty-directory allowance

**Semantics**: when the hit comes from a **tree-shaped rule** (`scope:"directory"` with at least one pattern ending in `/**`), the action is **`trash`**, and the target is an **empty directory** → **allowed**. The granularity of the allowance is "**this one rule**" — evaluation continues with the next rule; it does **not** allow the whole operation.

**Four cases that are not allowed**: (1) the action is not `trash` (`move`/`write`/`edit_text`/`read`/`list` are still evaluated); (2) the target is not a directory; (3) the directory is not empty (a single empty subdirectory still counts as not empty); (4) the hit is not a tree-shaped rule — **literal path rules are never** allowed for being "empty".

- **Emptiness check**: `statSync` + `readdirSync`, **fail-closed**: any anomaly (does not exist / no permission / actually not a directory) is treated as "**not empty**" → **still rejected**. The check hugs the operation execution, so the TOCTOU window is tiny.
- **Audit trail**: entries that **succeed** because of the allowance are audited separately: `ok:true` + `waived_rule:"<rule id>"` + `waived_reason:"empty_directory"`; **the audit format of failed, rejected entries is unchanged character for character**.
- **Side effect (recorded truthfully)**: **empty `.ssh`/`.aws` directories can be `trash`ed too** (an empty directory has nothing to leak); a non-empty one is always rejected.

### 6.4 Ancestor containment inference

**The hole to plug**: §6.2 / §6.3 only answer "is the **target itself** protected". When an **unprotected** parent directory is recursively `trash`ed, an entire `node_modules` inside its subtree disappears with it while no rule matches at all — **deleting a parent directory amounts to bypassing the protection of its subtree**.

**Semantics (without any relaxation)**: when recursively deleting a directory (`trash` + `recursive:true`) or when `move` (`mode:'move'`) moves a whole directory, if **the subtree contains a path that hits a tree-shaped protected rule** → **always rejected**; **an empty subtree never allows the parent directory**. The correct approach is **two passes**: first delete that empty protected directory on its own (§6.3 allows it), then delete its parent. Only **tree-shaped rules** take part, and their "directory itself" pattern (`**/node_modules`, `**/.git`, `**/.ssh`, `**/.aws`) **counts as a hit as well** → "there is only an **empty** `node_modules` inside" is rejected too; literal path rules **do not take part**.

Error code `protected_content_inside` (clearly distinguished from `protected_rule_denied` for "the target itself is protected"). The payload's key points: `ok:false` + `error` + `ruleId` (duplicated at the top level for easier filtering) + `reason` (of the form "the subtree of the target directory contains protected content (node_modules); the recursive delete/move has been refused") + `protected_content` = `{ relative_path, ruleId, rule_reason }` (`relative_path` **relative to the directory being deleted/moved**) + `next_step` (delete that inner directory on its own first, then delete this directory) + `scanned_entries` (the number of entries scanned this time); only for **scan budget exceeded / readdir failure** does it additionally carry `budget_exceeded` (one of `depth`/`entries`/`readdir_error`).

**Scan budget and fail-closed**: at most **50 000** entries and **32** levels of depth; exceeding the budget or failing to read a directory → **always rejected** (the error code is still `protected_content_inside`, with `budget_exceeded`). **There is no "could not finish scanning, so allow it" path.** Scope: `trash` (directory + `recursive:true`) and `move` (`mode:'move'`, source side); **`copy` and single-file deletion do not trigger it**.

**Behavioral cost (recorded truthfully)**: when a parent directory contains a **non-empty** protected subtree, it and all of its ancestors can never be deleted or moved through this tool; project directories that have run `npm install`, that are git repositories, or that contain `.ssh`/`.aws` are therefore undeletable, and every recursive attempt rescans the whole subtree.

### 6.5 How locally unreadable entries are handled

**The hole to plug**: if a `readdir` failure (ACL refusing enumeration, EACCES/EPERM and the like) were swallowed silently, that directory and its **whole subtree** would vanish from the results while the response body still said `ok:true` — harder to notice than an error.

**Handling principles (uniform across the four directory traversals: `find_files`, `list_directory`, `count_text` in directory mode, and directory statistics)**:

| # | Rule | Note |
|---|---|---|
| 1 | **Do not fail wholesale** | Being locally unreadable **does not escalate to an error**: the top level stays `ok:true` and the **partial results already scanned are returned as usual** |
| 2 | **Do not drop silently** | That directory **counts into `skipped`** and is tallied in `skippedBy.unreadable` (**1 unreadable directory = 1 entry**, not the number of files beneath it) |
| 3 | **Provide details** | Appended to the function's **existing detail array** (no new fields): `find_files`/`list_directory` use `skippedSamples`, `count_text` uses `skippedDetails`; each entry is `{ path, reason:'unreadable' }`, `path` in posix style, at most 20 entries |
| 4 | **Sensitive entries carry no path** | An entry that hits a sensitive rule only gets `{ reason:'unreadable' }`, **without `path`** (following the sensitive-no-leak discipline) |
| 5 | **The top level still fails closed** | If the directory being listed/scanned is that very directory and it cannot be read → still `io_error`, **not downgraded to skipped** |
| 6 | **Do not change existing response shapes** | With no unreadable directory encountered, the response body is **character-for-character identical** to before: the `skipped`/`skippedBy`/`skippedSamples` trio **appears only when an unreadable directory was really encountered** |

## 7. Reading

- **2000 lines / 64 KiB** at most by default (`readCaps`); beyond that it gives `truncated:true` and `nextStartLine`; an explicit `count` can go past the line limit.
- Reading the same file repeatedly hits the cache (`cached:true` / `unchanged:true`, the body is not returned again); the cache is invalidated automatically when the file changes, and `force_read:true` forces the body.
- Binaries return metadata only (`binary:true`, `reason:'binary_detected'`) plus the sha256; **detection is consistent in all three places** (`read_text`/`find_files`/`count_text`). An empty file has `totalLines=0` (consistent with `count_text`'s `lines=0`).

### 7.1 read_text and byte-range reads

The two groups of range parameters are **mutually exclusive**; passing both → `invalid_args`:

| Group | Parameters | Semantics |
|---|---|---|
| Line range | `start_line` (starting at 1) + `count` | How many lines to read starting at which line; the limit is 2000 lines by default |
| Byte range | `start_byte` (integer ≥ 0) + `max_bytes` (integer ≥ 1, default 65536) | How many bytes to read starting at which byte |

- A negative `start_byte` → `invalid_args`; ≥ the file length → an empty body plus the hint "the start offset is beyond the file length"; `max_bytes` above 65536 is treated as 65536.
- **`max_bytes` constrains the body only**; the continuation notes are **attached outside it**, bounded only by the 65536-byte response hard limit; when a single line is too long it is **cut inside the line** and flagged `lineTruncated:true` (giving `truncatedLine` / `truncatedLineBytes`), and a truncated read returns `howToContinue`.
- `count_text`'s range semantics align with `read_text` (both line ranges and byte ranges are supported); when a byte range lands in the middle of a multi-byte character it **backs off to the character boundary** (`alignmentAdjusted` / `alignmentBackoffBytes`). A **byte-range read** of a non-UTF-8 file **always returns `invalid_args`** — byte ranges **support UTF-8/ASCII only**, **regardless of whether `iconv-lite` is installed**; the error message suggests switching to `start_line` + `count` to read by line, and **line ranges are supported for every encoding**. The automatic back-off to the character boundary when a byte offset lands inside a multi-byte character (`alignmentAdjusted` / `alignmentBackoffBytes`) only happens within UTF-8 byte ranges.

### 7.2 Encoding support

| Encoding | Auto-detection | Notes |
|---|---|---|
| UTF-8 (with / without BOM) | Supported (BOM → strict validation) | Invalid byte sequences are not forced to be UTF-8 |
| UTF-16LE / UTF-16BE | Supported (including the **BOM-less** heuristic) | NUL even/odd position ratio ≥ 60% with at least 2 NULs, then validated by decoding |
| GB18030 | Supported (BOM `84 31 95 33` stripped and reported as `bom:true`) | Requires `iconv-lite` |
| Big5 | Supported | Requires `iconv-lite`; auto-discrimination from GB18030 is unreliable |

- **An explicit `encoding` is the reliable and only override**: when it is given, decoding uses **that encoding only** (skipping candidate trials and binary sniffing), and the returned `encoding` echoes the encoding actually used; **an invalid encoding name → `invalid_args`** (no enum in the schema, so the protocol layer does not reject it first with a different error).
- The detection order and the GB18030 / Big5 ambiguity are in §4; for Japanese / Traditional Chinese content, pass `encoding` explicitly.

### 7.3 The three most confusing fields

1. **`bytes` vs `fileBytes` vs `totalBytes`**
   - `bytes` = the byte count of **this range**: in range mode the range's byte count; outside range mode the whole file's byte count (then equal to `fileBytes`);
   - `fileBytes` = how large **the whole file** is; `totalBytes` = the cumulative byte count of the whole scope (the file itself for a single file, the whole subtree for a directory).
   In range statistics `bytes` counts the range only while `fileBytes` is always the whole file — the two are **not** the same number.
2. **`range.count` vs `range.returnedCount`**
   - `range.count` = the line limit you **requested**; `range.returnedCount` = the number of lines actually **returned / measured**.
   Request 300 lines while the file has only 10 left, and you get `count=300`, `returnedCount=10`.
3. **`truncated` and `truncatedBy`**
   - `truncated` only answers "**is it incomplete**"; the **cause** is in `truncatedBy`: `limit` (entry count) / `max_lines` (lines) / `max_bytes` (bytes) / `scan_limit` (scan budget) — this MCP never produces `max_matches_per_file` (that belongs to retrieval tools). Reading `truncated` alone cannot tell which limit was hit.

## 8. Error code table

| error | Trigger | What to do |
|---|---|---|
| `target_missing` | `overwrite` with a target that does not exist and no `createIfMissing` | Pass `createIfMissing:true`, or switch to `replace` |
| `target_exists` | `overwrite` with an existing target and no `overwriteExisting` | Pass `overwriteExisting:true` (optionally with `expected_sha256`) |
| `version_mismatch` | `expected_sha256` does not match reality | Read again to get a fresh sha256, then resubmit |
| `not_found` | `oldText` has zero hits (including invalidation by indentation, or a literal mismatch) | Look at `nearMisses[].exactText` and copy that text verbatim |
| `ambiguous` | `oldText` hits several places | Add context using `candidates[].line` / `.snippet` to make it unique |
| `write_root_denied` | A write-type target is outside `writeRoots` (empty array by default in the published build!) | Move it inside a write root, or `move` (`copy`) it in first |
| `sensitive_denied` | A sensitive rule is hit (`.env*`, `*.pem`, `*.key`, `.ssh/**`, `.aws/**`, `*.credentials.yaml`) | Do not bypass it; ask the user for the content. **Exception**: `trash` on an **empty** `.ssh`/`.aws` **directory** goes through the empty-directory allowance (§6.3) → succeeds with `waived_rule` + `waived_reason:"empty_directory"` (not an error code) |
| `protected_rule_denied` | A protected rule is hit (with `ruleId` / `reason`) | Act on the reason; protected directories need manual cleanup. **Exception**: under a tree-shaped rule, `trash` of an **empty directory** is allowed (§6.3) → `ok:true` + `waived_reason:"empty_directory"` |
| `protected_content_inside` | When recursively deleting / moving a **whole directory**, the subtree contains a path hitting a **tree-shaped rule** (**an empty subtree counts too**), including `move` with `overwrite:true` overwriting a directory (overwrite = whole-tree deletion); or the scan exceeds the budget (50 000 entries / 32 levels) or a readdir fails → fail-closed | **Never allowed automatically**; follow `next_step` to handle `protected_content.relative_path` on its own first, then delete/move the parent directory; in the overwrite case the target **was not touched** (§6.4) |
| `recycle_bin_unavailable` | **Only when the capability is unavailable + `FOP_REQUIRE_RECYCLE_BIN=1`**; without that variable it degrades instead (permanent delete + `recyclable:false` + `warning`, which is **not** an error code). Criterion: the number of `$I*` entries under `<volume>:\$Recycle.Bin\<SID>` did not grow | For "never block" → turn strict mode off; for "must be recoverable" → keep it strict and have the user delete manually; if no recycle bin is needed → `FOP_ALLOW_PERMANENT_DELETE=1` |
| `mixed_eol` | The file mixes CRLF/LF and `replace` is used | Read the whole file, unify the line endings, then write back with `overwrite` |
| `batch_limit` | A batch limit is exceeded (with `limit` / `given`) | Submit in several batches |
| `identity_changed` | The target changed after validation | Retry |
| `invalid_args` | Illegal parameters (empty `paths`, `path` and `paths` together, an empty `oldText`, batch `overwrite`, **a target that is a directory**, **an invalid encoding name**, mutually exclusive range parameters, ...); `move` with an existing target but no `overwrite:true`, or `src===dst` / `dst` inside `src` / `src` inside `dst` (gate C) | Fix the parameters per the reason; to overwrite, pass `overwrite:true`, otherwise choose another target name or a non-overlapping target |
| `already_applied` | `status:'already_applied'` (not an error; it was applied earlier) | Nothing more to change; check `alreadyAppliedBy` |
| `binary` | Returned when encoding detection fails / the content is binary and cannot be handled as text (note: this is **not** the same as the `binary:true` marker field in §7) | Handle it from the metadata, or switch to a script that works on bytes |
| `aborted` | The abort marker returned with every file when the pre-validation of a batch edit with `all_or_nothing:true` fails | Handle each file by its own failure reason, then resubmit |
| `device_path` | The path is a device name (`NUL`, `CON`, `COM1`, ...) or `/dev/*` | Use a real file path |
| `dependency_unavailable` | A dependency such as `iconv-lite` is missing, so that encoding cannot be handled | Install the dependency, or work with UTF-8 only (§4 / §7.2) |
| `file_too_large` | A single file exceeds the 8 MiB editable limit | Handle it with a script (in a batch only that file is skipped) |
| `io_error` | Underlying IO / codec / verification failure; **in directory traversal it is used only for the "top-level" directory itself being unreadable** → fail-closed. **Unreadable directories inside a subtree are not errors** and go through `skipped` (§6.5) | Investigate per the reason; when a subtree was skipped, look at `skipped`/`skippedBy`/`skippedSamples` |
| `scan_limit` | Historical error code, **no longer returned as an `error`**: `find_files`/`list_directory` recursive scans exceeding the budget (20 000 files or 15 000 ms) | It now returns `ok:true` + `truncated:true` + `truncatedBy:'scan_limit'` + `reason`/`hint` + `scanned`/`elapsedMs`/`limit` with partial results; narrow the scope and retry |

## 9. How to enable

The server uses **stdio transport** and is a **long-running process**: once the client has started it, it keeps running, so changing `index.mjs` requires restarting the client to take effect (changing `protected.json` is a hot reload, see §10.3).

**Install**: `npm install -g mcp-file-ops` (or run `node index.mjs` from a checkout — no install needed). **A config file is required on first use**: copy `protected.example.json` to `protected.json` and fill in `writeRoots` (the template ships an empty array, which denies all writes). The config path can also be set via the `FILEOPS_CONFIG` environment variable.

**Read-only mode**: the `--readonly` startup flag is supported — only the **7 read-only tools** are registered (`read_text` / `get_file_info` / `list_directory` / `find_files` / `count_text` / `diff` / `list_protected`), and calls to write-type tools are blocked. Suits purely retrieval scenarios.

### 9.1 Registering as an MCP client

The generic `mcpServers` format (Claude Desktop and most MCP clients):

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

DSH's preset mount format (`cordis.patch.yml`):

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

After mounting, the tool names you intend to use must also be added to that preset's tool allowlist (`allowlists`).

### 9.2 Environment variables

| Variable | Effect | Default |
|---|---|---|
| `FILEOPS_CONFIG` | Path of the rules file (instead of `<package dir>/protected.json`) | unset → the packaged `protected.json` |
| `TYPST_PATH` | The typst executable used when `convert_document` outputs PDF | scans `PATH` first, then a built-in fallback |
| `PANDOC_PATH` | The pandoc path for `convert_document` | scans `PATH` first, then a built-in fallback |
| `GIT_PATH` | The git executable used by `diff` | scans `PATH` first, then regular install locations |
| `FOP_ALLOW_PERMANENT_DELETE` | `=1` **forces a permanent delete**: skip the recycle bin and delete directly, `permanentDelete:true`, no `warning` | unset |
| `FOP_REQUIRE_RECYCLE_BIN` | `=1` **strict mode**: refuse to delete / refuse to overwrite as soon as the recycle-bin capability is unavailable, never degrading | unset (lenient degradation) |
| `FOP_FORCE_CROSS` | `=1` treats a same-volume `move` as the **cross-volume path** too (copy + sha256 verification + delete source), for exercising the cross-volume branch | unset |

External program discovery order: environment variable → `PATH` → built-in fallback (regular install locations only).

## 10. How to change protected rules

### 10.1 Editing protected.json directly

- File: `<package dir>/protected.json` (or whichever file `FILEOPS_CONFIG` points at). Before editing, call `list_protected()` to look at the effective snapshot and the `config` fingerprint (`configPath`/`mtime`/`sha256`/rule count) and confirm you are editing the copy the server actually reads.
- Self-checks before writing: valid JSON; every rule must have `id`/`scope`/`pattern` or `patterns`/`deny`/`reason`; the action names in `deny` must be within `read,list,write,edit,trash,move`; no per-rule exception switches may appear.
- `protected.example.json` ships only 9 common rules (node_modules, .git, credentials, keys, cache directories, ...), and **you may add or remove them as needed**. The 9 IDs: `R3`(node_modules) / `R4`(.git) / `R5`(*.credentials.yaml) / `R8`(.env*) / `R9`(.ssh) / `R10`(.aws) / `R11`(*.pem) / `R12`(*.key) / `R15`(package-manager cache directories).
- **The audit log needs protecting too**: if you turn `audit.enabled` on and set a `logPath`, **it is recommended to add a rule protecting that log** (a pattern covering `<the path you specified>` and its rotated copies, with `deny` set to `trash`/`move`/`write`/`edit`) — **the example config has no such rule**, and without it the log can be deleted or altered by clients.

### 10.2 Using the management console

The repository ships `manage-rules.mjs` (Node built-ins only, no extra dependencies):

```
node <package dir>/manage-rules.mjs
```

```
=== 保护规则管理台 ===
现役: <package dir>/protected.json   最后修改: <timestamp>   规则: <N> 条
[1] 列出全部规则          [2] 新增规则        [3] 修改规则
[4] 删除规则              [5] 试算路径         [6] 校验并写回
[0] 退出
```

Menu items: `1` lists all rules (number/scope/path/deny/reason), `2` adds a rule (questions: scope → path → which actions to block → reason → confirm), `3` edits, `4` deletes, `5` dry-runs a path ("which rules hit it, which actions they block, whether it can be read"), `6` validates and writes back. A single-command mode makes scripting easy:

```
node <package dir>/manage-rules.mjs list
node <package dir>/manage-rules.mjs check "C:/work/projects/app/a.md"
node <package dir>/manage-rules.mjs add --scope file --pattern "C:/work/my.conf" --deny "trash,edit" --reason "手工维护的配置"
node <package dir>/manage-rules.mjs verify
```

- Every action of `list`/`check`/`verify` carries an **error code**: sensitive rules → `sensitive_denied`; other protected rules → `protected_rule_denied`; allowed actions → `errorCode: null`. `check` additionally prints a `JSON: {...}` line for scripts to consume.
- `verify` uses fixed sample paths to print **the console's own verdicts**, to be cross-checked against file-ops' actual behavior: the two are **two independent implementations**, so a disagreement means semantic drift, and the implementation should be fixed rather than the rules. Writing back backs up automatically (`<package dir>/backups/protected-<YYYYMMDD-HHMMSS>.json`) while the main file keeps the fixed name `protected.json`; **the console does not express the check order**, so in a cross-check the effective behavior wins (§6).

### 10.3 Hot reload

Before **every evaluation** the server compares the mtime + size of `protected.json` and reloads when they changed (`hotReload` reports `{ enabled:true, configPath, strategy:'mtimeMs+size' }`).

- **JSON changes take effect immediately, no restart needed** (both `protected.json` and the file `FILEOPS_CONFIG` points at).
- **Changing `index.mjs` requires restarting the client** — it is a long-running process and the in-memory implementation does not replace itself.
- `list_protected()` returns the **effective snapshot**: `writeRoots`/`batchLimits`/`readCaps`/all rules (with their count)/the `enforcement` switch and check order/the `config` fingerprint (`configPath`/`mtime`/`sha256`/rule count)/the `audit` switch and retention/`hotReload`; on a config syntax error it also gives `configError`. Use it to answer "which version is the server honoring right now".

## 11. Known limits and pitfalls

1. **`\r\n` inside tool parameters is literal** (it is not parsed into a newline) → when you need real CRLF, read a file that genuinely contains CRLF with `read_text` and pass the returned `text` back verbatim.
2. **Long-running process**: after changing `index.mjs` the client must be restarted for it to take effect; functional acceptance at the MCP layer belongs after the restart (rule changes in `protected.json` are a hot reload and need no restart).
3. **There is only one set of matching semantics**: a literal path matches that path itself only; wildcard + `/**` suffix matches every layer **below** that directory and **excludes the directory itself**; to protect both "the whole tree" and "the directory itself", list two patterns in the same rule's `patterns` (§6.2 / §6.3 / §6.4).
4. `read_text` has line / byte limits by default, and exceeding them requires an explicit `count`; `max_bytes` constrains the body only, while continuation notes are counted separately.
5. **The write-root restriction governs only this MCP's write-type operations** and cannot govern an external shell (such as code-operator's `pwsh`) — the latter's write boundary is decided by its own sandbox (the session workspace).
6. **Known deviation of `scope`**: under a wildcard pattern `scope` takes no part in matching (`**/*.key` hits a directory named `my.key`, an over-rejection); literal path rules do not distinguish files from directories. To protect a directory itself as well, list `**/xxx` explicitly in `patterns`.
7. **`.tmp/` is a runtime temporary directory; do not clean it up by hand**: the server creates it on demand and, when invoking external programs, creates `run-*` beneath it for stdout/stderr and deletes it automatically afterwards; deleting it does not break functionality, but cleaning brings no benefit and you must first confirm no child process is using it.
8. **The audit log writes nothing to disk by default** (`enabled:false`, `logPath:null`); once enabled, response bodies carry `auditLogged`/`auditRotated`/`auditPrevious` (when it is not enabled, `auditLogged` does not appear). **The example rules contain no rule protecting the audit log, so add one yourself after enabling it** (§10.1).
9. **The recoverability of `trash` depends on the executing process's permissions**: when the probe says unavailable it degrades truthfully (`deleted-permanently` + `recyclable:false` + `warning`) and never falsely claims `sent-to-recycle-bin`; when a hard guarantee is needed, set `FOP_REQUIRE_RECYCLE_BIN=1`.
10. **`FOP_TEST_RB_CAP` is an internal test hook**: set to `0` it forces the recycle-bin capability probe to report unavailable, for exercising the degraded path; **do not set it in normal use**.

## 12. License

MIT; see `LICENSE` for the full terms.

- Package name `mcp-file-ops`, version `0.1.1`; `engines.node >= 20`; runtime dependency `@modelcontextprotocol/sdk` (`1.32.2`), optional dependency `iconv-lite` (when missing, encoding support degrades, see §4 / §7.2).
- The implementation takes the **public behavior** of `@modelcontextprotocol/server-filesystem` (MIT) as a reference and implements it from behavior; no source code was copied.
