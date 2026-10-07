# Hot-reloadable review core — plan

Status: **proposal, no code changes yet** · 2026-10-06

## 1. Goal

Ship fixes and changes to the review logic, model presets, config and the
dashboard web page **without restarting the server**, and without dropping
the connections and work that are live at that moment: Stop-hook requests
waiting on a review, MCP sessions from Claude Code / Codex / opencode, and
reviews already running.

Fixed decisions from the request:

- **Reload is explicit only** — a command (`scripts/reload.sh`) or a button
  on the dashboard. No file watcher, no reload on save, no automatic
  trigger of any kind.
- **The dashboard web page is in scope** — HTML, CSS, inline JS, charts and
  its mutation endpoints reload with the rest of the logic.
- **Swap only when no reviews are running.** If reviews are in flight when
  a reload is requested, the reload is scheduled and applied as soon as
  none are running. A review never runs part on the old code and part on
  the new.

## 2. What a restart costs today

The server is one Node process (`server/src/index.js`) under launchd with
`KeepAlive`. Any code change needs that process restarted.

| Lost on restart | Where it lives | Effect |
|---|---|---|
| In-flight `/review` requests | Open HTTP sockets; reviewer child processes | The Stop hook waits up to the reviewer timeout + 60 s (capped at 29 min). A reset socket becomes a fetch error and the hook fails open: the turn ends unreviewed, and the killed reviewer's tokens are wasted. |
| MCP sessions | `sessions` map in `mcp.js` (stateful Streamable HTTP, one session id per client) | The client's next call carries an unknown `Mcp-Session-Id`. It has to re-initialize, and may show the server as failed until reconnected (Phase 0 verifies). |
| `request_review` tool calls in progress | Same | Aborted. |
| Duplicate-review and per-context ordering | `defaultInflight`, `defaultContextChains`, `defaultInflightMeta`: module-level maps in `review.js` | Gone (moot after a restart, since the reviews died too). |
| "Since restart" request metrics | `metrics` instance | Reset. |
| Config changes made by editing `config.json` | Read once at startup | Not applied until a restart. Dashboard-made changes apply live already. |
| Per-context state, review archive | `~/.cache/review-orchestrator/state.json`, `reviews/` | Survive (on disk). |

## 3. Requirements

1. Reloading changes the behaviour of every **new** request: review
   pipeline, cache and change detection, reviewer adapters, prompt, presets,
   dashboard.
2. The swap happens only at a moment with no reviews running. A reload
   requested while reviews are in flight is **validated immediately** (so
   a broken build is reported straight away) and **applied later**, when
   the last one finishes. Nothing is cut off and nothing is re-run. No
   single request waits more than a bounded time because of a reload
   (§5.5). A reload itself, though, can stay pending for as long as
   reviews keep overlapping. Idle-only swapping can't promise completion
   under sustained load without running two versions at once. A pending
   reload is always visible and cancellable, and you can force it with an
   explicit **apply now** (§5.5, decision Q4), accepting that running
   reviews finish on the old code.
3. MCP sessions stay valid across a reload. No client reconnect is needed
   for behaviour changes.
4. Duplicate-review handling and per-context ordering keep working while
   a reload is pending: a request for a context with a review still running
   joins it or queues behind it, exactly as today, and never starts a
   second pipeline on the same context's state.
5. A reload is all-or-nothing. If the new code fails to load or fails its
   self-check, the current code keeps serving and the error is reported.
   One action rolls back to the previous version.
6. You can always see which code is running: shell version, core version
   (content hash), when it was loaded, and the reload history.
7. The code that runs is exactly the code that was hashed and validated.
   A file saved during or after a reload can neither change a loaded core
   nor be mislabelled as part of it.
8. The end-of-turn review path never sends requests to an address or
   with credentials the running server doesn't accept, including while
   `config.json` is mid-edit (§5.7). It **never transmits the raw token**:
   requests are HMAC-signed and responses verified, so a relaying or
   impostor listener can neither learn the token nor forge a verdict. The
   one exception is reported, never silent: a file that stays unparseable
   *and* a last-known-good credentials cache that is missing or holds a
   token rotated past its grace. The cache is seeded by `install.sh` and
   kept fresh by the config writers (the server and `rotate-token.sh`). That covers the Claude Stop hook, the Codex
   Stop hook, the notify-change hook, and the opencode plugin's own
   `/review` and `/notify-change` requests. MCP connections whose client
   stores the token statically (Codex's `config.toml`, opencode's MCP
   registration) are covered by the rotation grace instead, and must be
   restarted within it to keep their `request_review` tool (§5.7).
9. Tests never spawn real reviewers. The loading machinery doesn't leak
   into Jest.

## 4. Options considered

**A. In-process hot swap of a "core".** A small, stable *shell* owns the
HTTP server, sockets, MCP sessions, state store, archive, metrics and the
in-flight maps. Everything else is the *core*. A reload imports the core
again as a fresh module graph and swaps it in atomically.

**B. Core in a worker process or thread.** The shell sends requests over
IPC to the current worker. A reload starts a new worker and lets the old
one drain.

**C. Zero-downtime restart of the whole process.** launchd socket
activation or socket handoff, with the old process draining.

| | A. In-process swap | B. Worker + IPC | C. Process restart + drain |
|---|---|---|---|
| In-flight reviews survive | Yes (the swap waits until none are running) | Yes (old worker drains) | Only if the old process drains first, up to 29 min; launchd runs one instance, so the new one waits |
| MCP sessions survive | Yes (owned by the shell) | Yes (owned by the shell) | No, unless MCP goes stateless, which breaks the roots check (`mcp.js` explains why stateful is required) |
| Fit with today's code | Good: handlers already take `config`, `store`, `deps`, and the in-flight maps are already injectable via `deps` | Poor: `state.json` has a single writer and the pipeline does in-process read-modify-write, so either every store call becomes IPC or two workers write the file during a drain | Needs the MCP and in-flight state moved out of memory |
| Memory | Each reload leaves the previous module graph in memory (Node's ES-module cache never evicts) | Reclaimed when the worker exits | Fresh process |
| Crash isolation | None (same as today) | Yes | Yes |
| Size of change | Medium–large, mostly mechanical | Large | Medium, but misses the goal |

**Recommendation: A.** It meets every requirement with the least new
machinery and matches how the code is already structured. B is a later
upgrade if crash isolation or memory reclamation ever matters; a clean
core boundary from A is most of the work B would need anyway. C doesn't
meet the goal.

## 5. Proposed design

### 5.1 Shell vs core

| Shell — stable, changing it needs a restart | Core — reloadable |
|---|---|
| `index.js`: startup, HTTP server, socket tracking, graceful shutdown | `review.js`: pipeline, fast path, cache, `NO_CHANGES` / no-progress, re-baselining |
| Express skeleton, `auth.js`, `loopbackOnly`, `http-log.js`, `logger.js` | `diff.js`, `context.js`, `project-config.js`, `exclusions.js` |
| MCP transport and session map (the `mountMcpRoute` half of `mcp.js`) | `reviewer.js`, `codex.js`, `claude.js`, `gemini.js`, output schema JSON |
| State store instance (`state.js`) and archive instance (`archive.js`) | `provider.js` (presets and switch handlers), `maxRounds.js`, `maxBlocks.js`, `blockingSeverities.js`, `reset.js`, the `notify-change` handler, `status.js` |
| Metrics instance (`metrics.js`) | `dashboard.js`: page, CSS, inline JS, charts, dashboard mutation handlers |
| **New:** the in-flight maps, moved out of `review.js` | MCP tool *behaviour*: `request_review` / `reset_review_context` handlers and the roots check |
| **New:** config holder, reload controller, core snapshot store, runtime address file | `config.js` schema and validation (used at startup and on reload) |

State-store and archive *code* stays in the shell in v1, because their
instances are closures created at startup. Changing the state or archive
code needs a restart. (A later step could move the record and markdown
rendering into the core and keep only file I/O in the shell.)

### 5.2 Core contract

```js
// server/src/core/index.js
export const CORE_API = 1
export const createCore = (staging) => ({
    api: CORE_API,
    version,            // content hash of the snapshot's files + package version (§5.3)
    routes: {           // (req, res, shell) handlers
        review, reset, notifyChange, provider, status,
        dashboardPage, inflight, dashboardMutations,
    },
    mcp: { toolDefs, requestReview, resetReviewContext },
    loadConfig,         // validateConfig is a *static* export of the module, used before createCore
    resources,          // non-JS files (output schema …), read from the immutable snapshot, §5.3
    selfCheck,          // (config) → throws if unusable with that validated config; never spawns a reviewer
    attach,             // (live) → binds live shell capabilities; called only at the swap
    dispose,            // detaches; stops anything it started; the shell then deletes its snapshot
})
```

**Two-phase initialization.** Preparing a candidate must not change the
running server, even if the candidate is then rejected.
- **Config never shapes core creation.** The snapshot module exports
  `CORE_API`, `STATE_FORMAT` and a pure `validateConfig(raw)` as **static
  exports**. The shell uses them right after import, before `createCore`,
  to run the contract check and validate the candidate config (§5.4 step
  4).
- **`createCore(staging)`** gets only inert, read-only inputs, and **no
  config at all**:
  - its resources, as the bytes captured and hashed in snapshot step 1
    (`staging.resources`; never read from the snapshot folder);
  - a logger tagged `candidate=<id>`;
  - `shellVersion` and `startedAt`.

  There's no config, no store, no archive, no metrics, no in-flight
  registries and no config holder, so nothing it does can write live
  state or depend on stale settings.
- **`selfCheck(config)`** is handed a deep-frozen, already-validated
  config, and checks it against this core: presets for the configured
  providers, the reviewer schema for the configured model, rendering the
  dashboard. It's **pure**: no live state, no I/O beyond the core's own
  in-memory resources, no reviewer spawns, synchronous and fast
  (milliseconds). So it's safe to call on the *running* core too. It
  runs on **every config about to go live**, not only for new code:
  - at preparation, for every candidate, config-only included (the
    running core's `selfCheck` on the edited config);
  - again **under the swap gate**, on the exact config read at swap time
    (§5.4 step 8.1);
  - on the config a rollback is about to restore (§5.4);
  - on every dashboard config transaction's merged result (§5.5).
- **`attach(live)`** hands over the live capabilities `{ config (holder),
  store, archive, metrics, registries: { inflight, contextChains,
  inflightMeta }, logger, configTransaction, spawnTool, execTool }`. It's called **only at the
  swap**, inside the swap gate (§5.5), after every check has passed.
  **`attach` is a pure reference assignment:** it stores the object it's
  given inside the candidate, and does nothing else. No I/O, no
  registration in a registry, no listeners, no timers, no reads of live
  state. Anything that could fail belongs in `createCore(staging)` or
  `selfCheck`, which run before the swap. So `attach` can't change live
  state, and has nothing to throw on. If a bug makes it throw anyway, the
  swap aborts at that point (§5.4 step 8.3) with nothing live altered. An
  outgoing core stays attached, for its pinned requests and as the
  rollback target, until it's disposed. `dispose()` detaches.
- **Imports are side-effect-free.** Core modules' top level only defines
  things: no timers, listeners, I/O or process hooks. A test imports a
  fresh snapshot of the core and checks the process's active handles and
  listeners are unchanged, and nothing is written.
- **Every rejected candidate is disposed**, whether it fails the contract
  check, the self-check, config validation or a swap-time check, or is
  cancelled or replaced. Then its snapshot is deleted. Since it never
  attached, it never touched live state, and disposal only releases what
  `createCore` itself built.

The shell refuses a core whose `api` doesn't match: a contract change is
the one kind of core change that needs a restart.

### 5.3 Loading a fresh copy of the code: immutable snapshots

Node caches ES modules by URL for the life of the process. Importing
`./core/index.js` again returns the cached copy, and adding `?v=N` only
refreshes that one file, not the modules it imports. Hashing the source
tree and then importing it separately has a second problem: a save
between the two (or during module loading) gives a graph mixing bytes
from different edits under the earlier hash.

**Recommended: content-addressed snapshots.** Each load:

1. **Read once:** read every file under `server/src/core/` (JS and
   non-JS, excluding `*.test.js`) into memory, once.
2. **Hash those bytes:** the version id is a short sha256 over exactly
   those bytes (path + content, sorted) plus the package version. A
   second, narrower hash, **`reviewVersion`**, covers only what the review
   path uses:
   - its **code:** the transitive static-import closure of the review
     entry module (`core/review/index.js`, which exports the pipeline and
     the MCP review handler), taken from the import graph that step 3a
     builds anyway;
   - its **resources:** every non-JS file under `core/review/`, starting
     with `codex-output.schema.json`, which moves there. Imports don't
     reach resources, so they're included by location. The core's
     resource loader serves review-path modules only from that folder,
     so a review resource can't live anywhere `reviewVersion` doesn't
     cover.

   - the **composition root**, `core/index.js` itself. It imports the
     review entry, so it isn't in that entry's closure, yet `createCore`
     there wires the review handlers and hands them their resources. A
     wiring change can change review behaviour, so it counts. `core/index.js`
     stays a thin composition layer, and anything else it would need
     belongs in the review entry's closure or in UI modules.

   Dashboard, status and other UI-only files are in none of these, so
   editing them changes the version id but not `reviewVersion`. Anything
   the review path runs, reads or is wired by changes both: prompt,
   adapters, change detection, the output schema and `createCore`.
3. **Detect in-progress edits:** re-read the files and compare. If
   anything changed while it was being read (a multi-file save in
   progress), retry, up to 3 times, then reject with "core files kept
   changing — try again".
3a. **Check code containment** on the captured bytes. Every JS file is
   parsed to an AST (`acorn`), not a regex, and its static `import` /
   `export … from` specifiers are checked:
   - **bare package imports** (`zod`, `ajv`, `node:fs`, …) are allowed.
     They're shared dependencies, outside the version by design (§6);
   - **relative imports** must resolve to a file *inside*
     `server/src/core/` that is part of this snapshot. `../index.js` from
     the core root, or anything reaching `server/src/`, is rejected;
   - **absolute paths, `file:` URLs, `#…` aliases** from `package.json`
     `imports`, **the package's own name** and **dynamic `import()`** are
     rejected outright. Each could reach mutable code outside the
     snapshot.

   The same AST pass rejects the **other ways to load code at run time**,
   which a static-import check alone wouldn't see:
   - imports of `node:module` / `module` (`createRequire`), `node:vm` /
     `vm`, `node:worker_threads` / `worker_threads` (workers load files by
     path);
   - any reference to `require`, `eval`, the `Function` constructor,
     `import.meta.resolve` or `process.execPath`;
   - imports of `node:child_process` / `child_process`. A core module
     can't start processes on its own at all.

   **Processes go through an allowlisted shell capability.** The core
   runs external tools only through `spawnTool(name, args, opts)`
   (streaming, for the reviewers) and `execTool(name, args, opts)`
   (buffered, for `git`). Both are **asynchronous**, part of the live
   capabilities (§5.2), and never available in staging. There's no
   synchronous variant (see "No blocking subprocesses" below):
   - `name` is a **tool name**, not a path: `git`, `codex`, `claude` or
     `gemini`. Nothing else can be run;
   - **`git`** isn't configurable: it's resolved from `PATH`, and any
     request that has pinned a core may run it. That includes non-review
     entry points like `/reset`, `/notify-change` and MCP
     `reset_review_context`, which resolve the repo context with git but
     never pass review admission;
   - **the reviewer tools** (`codex`, `claude`, `gemini`) need **the
     caller's pinned config** (`opts.config`), the frozen object review
     admission handed it (§5.5). The shell checks it's one it issued,
     keeping them in a `WeakSet`, and resolves the binary from that
     config's `codex.binary` / `reviewer.claude.binary` /
     `reviewer.gemini.binary`. **Never from the live config.** So a dashboard edit made while a review runs, or while
     it waits on the per-context chain, can't change which executable that
     review runs. That executable is the one its pinned config, and so its
     `reviewKey`, describes;
   - the shell **refuses** a resolved binary that is a Node executable:
     basename `node` or `nodejs`, or the same file as
     `process.execPath`. That holds even if a config points a reviewer
     binary at one, so a core can't run a JavaScript file from outside
     its snapshot via `node <script>`.

   **No blocking subprocesses.** Today `context.js` and `diff.js` run
   `git` with `execFileSync`, with no timeout. A stalled git (a hung
   credential prompt, a slow network filesystem, a locked index) blocks
   the whole event loop. Deadlines can't fire, admissions can't
   release, and a reload can't be handled; promise races mean nothing
   if no other code runs. So:
   - every request-path git call goes through the async `execTool`,
     with a per-command timeout of `limits.gitTimeoutSeconds` (new,
     default 30). On timeout the child is killed (`SIGTERM`, then
     `SIGKILL` after 2 s);
   - `resolveContext`, `buildPayload`, `isWorkingTreeClean`,
     `currentHeadSha` and `resolveFallbackBase` become `async`. That's
     a Phase 1 refactor of today's synchronous code and its tests;
   - a git timeout fails just that request, as a transient `ESCALATE`
     (`GIT_TIMEOUT`, not cached, with no state written). Every other
     request, deadline and reload proceeds meanwhile;
   - the containment check keeps `child_process` out of core modules,
     so no synchronous subprocess can come back in through the core.

   The reviewer CLIs (some of them Node programs installed with npm) and
   `git` are external tools, outside the version just like package
   dependencies (§6). This replaces today's direct `spawn` /
   `execFileSync` use in `codex.js`, `claude.js`, `gemini.js` and
   `diff.js`. Their existing `deps.spawn` / `deps.git` test injection maps
   onto the capability.

   Plain `fs` reads stay allowed: the core reads the reviewed repo's
   files for diffs. But without `require`, `eval`, `Function`, `vm` or a
   way to start `node`, reading a `.js` file can't turn it into running
   code.

   Every file in the snapshot is checked, so transitive imports are
   covered: anything a core file can import relatively is itself a
   snapshot file under the same rules. A violation fails the reload and
   names the file and what it used. The ESLint rule (step 6) gives the
   same feedback while editing, but the snapshot builder is what enforces
   it.

   **Scope of the guarantee.** The version hash covers all code the core
   reaches through the module loader, and the check shuts the dynamic
   loaders a core module would plausibly use. The core is this repo's own
   reviewed code, so this guards against **accidental drift**, such as a
   helper imported from `server/src/` or a stray `createRequire`. It is
   not a sandbox against deliberately hostile core code, which could
   still find a way out, for example by obfuscation. That's stated here,
   not implied.
4. **Write a fresh snapshot, every time:** write the bytes to
   `server/.core-versions/<id>-<nonce>/`, gitignored. `<id>` is the content
   hash and `<nonce>` is random per load. Write to a temp name and rename,
   so a half-written snapshot never exists. An existing folder is **never
   reused**, even for the same `<id>`. A folder from an earlier load could
   have been edited, or partly deleted or restored, since it was written,
   so its bytes can't be trusted to match its name. Only the folder this
   load just wrote is imported.
5. **Import:** `import(".../.core-versions/<id>-<nonce>/index.js")`. Every
   file has a URL unique to this load, so Node loads a completely fresh
   module graph, with no loader hook and nothing shared with earlier
   instances.
6. **Verify after import:** re-read every snapshot file and compare it
   with the bytes captured in step 1. A mismatch means something wrote
   into the folder between our write and Node's read. The candidate is
   rejected (never swapped in), its folder deleted, and the reload
   reported as failed. Core modules can only use static imports that stay
   inside the snapshot (step 3a enforces it; an ESLint rule flags it while
   editing), so no file is read from the snapshot after this check, and
   no core code comes from outside it. Package imports (`zod`, `ajv`,
   `minimatch`, …) resolve up the tree to the repo's `node_modules` and
   stay shared, so a dependency upgrade still needs a restart.

What runs is exactly what was hashed and self-checked. Edits to
`server/src/core/` afterwards don't touch a loaded core until the next
reload makes a new snapshot. Startup loads core v1 through the same path.

**Non-JS resources come with the snapshot, then live in memory.**
`codex-output.schema.json` is part of the snapshot, so a schema-only edit
is a new version. The core **never reads its snapshot folder for
resources**. The shell passes in the bytes it captured and hashed in step
1 (`staging.resources`, a path → bytes map), the same bytes the version id
and `reviewVersion` were computed from. Whatever happens to the folder
after the import, the core's resources are exactly the verified bytes,
and every adapter uses them:

- `claude.js` builds its inlined `--json-schema` argument from the
  in-memory copy, instead of reading the file on every invocation as
  today;
- `gemini.js` and the shared output validator compile from the same
  copy;
- only `codex.js` needs a *file path* (`--output-schema`). Its strict
  variant is materialized from the in-memory bytes into a shell-managed
  folder, `~/.cache/review-orchestrator/codex-schemas/<id>-<nonce>.json` (0600).
  That's outside the repo, so `git clean` can't remove it, and not
  `/tmp`, so macOS temp cleanup doesn't apply either. **Before every
  Codex run** the adapter reads the file and compares its sha256 with the
  in-memory strict schema's (a few kilobytes, microseconds). If it's
  missing, unreadable or different (edited, truncated, corrupted), the
  adapter recreates the folder (`mkdir -p`, so a deleted parent isn't an
  `ENOENT`) and rewrites the file atomically (temp + rename) from memory.
  Codex therefore always receives exactly the schema bytes its core
  validated.

So once a core is loaded, nothing reads its snapshot folder at request
time. If the folder is deleted by hand (say, `git clean -fdx`), every
adapter keeps working: the modules and the schema are in memory, and the
one file Codex needs is recreated on demand.

**Cleanup.** A snapshot folder, and its `codex-schemas/<id>-<nonce>.json`,
are deleted once its core can no longer be selected (§5.4). At startup,
any snapshot or schema file that isn't the one just loaded is deleted.
`.core-versions/` is added to `.gitignore`, `.prettierignore`, the ESLint
ignore list and Jest's `testPathIgnorePatterns`. Because it's
gitignored, the orchestrator never reviews it when reviewing this repo.

**Alternative considered: a resolve hook** (`module.registerHooks`) that
propagates `?v=<id>` from a core module to its relative imports, giving a
fresh graph without copies. It still reads the mutable source tree at
import time, so it needs a hash-before/hash-after check. Even that misses
an A→B→A edit during import, which leaves B loaded under A's hash. Data
files would also need special handling. Snapshots avoid all of that for
the price of a gitignored folder.

### 5.4 Reload flow

A reload covers **code and config together**. It builds a *candidate*: a
core (new or current) plus a validated config. Either half may be
unchanged, so editing only `config.json` and pressing Reload works.

**Prepare now (synchronous with the request):**

1. **Trigger:** `scripts/reload.sh` → `POST /admin/reload` (auth token), or
   the dashboard button → `POST /dashboard/reload` (loopback-only, like the
   other dashboard actions).
2. **One at a time:** while a reload is being prepared, another trigger
   gets `409`. A new trigger while one is *pending* prepares a
   replacement, and the newest **validated** candidate wins:
   - **it validates:** it replaces the pending one and keeps its place in
     the wait. The replaced candidate's core goes through the disposal
     rule (step 8.4): disposed only if it's a distinct instance nothing
     else refers to, never if it's the running core (a config-only
     candidate);
   - **it matches what's running:** it cancels the pending one (step 5);
   - **it fails to prepare** (bad code, invalid config, a restart-only
     key): the already-validated pending candidate stays exactly as it
     was, held requests stay held, and the response reports the failure.

   A malformed second trigger never discards a good pending reload.
3. **Code:** read, hash and re-check the core files (§5.3 steps 1–3),
   **before writing anything**.
   - **Same id as the running core:** no snapshot is written and nothing
     is imported. The candidate keeps the running core, the same
     instance, which is the config-only case.
   - **Different id:** run the containment check, write the
     `<id>-<nonce>` snapshot, import it, verify the files, and run the
     **contract check** on the module's static exports: `CORE_API` and
     `STATE_FORMAT` must equal the shell's, otherwise reject with "needs a
     restart". `createCore` isn't called yet.

   A snapshot written for a candidate that then fails any later
   preparation step is deleted at once, along with its Codex schema
   file. A no-op or config-only reload leaves no folder behind.
4. **Config:** re-read `config.json` and validate it with the candidate
   module's **static** `validateConfig`: the new module's for a new core,
   the running one's otherwise. Only now, for a new core, call
   `createCore(staging)` (§5.2: no config, no live capabilities). Compare it with the live config. **Restart-only keys**
   (§5.7) are checked against the values the server *started with*, not
   the last reload; any difference rejects the reload and names the key.
5. **No-op check:** the candidate has the same core id and no config
   difference from what's *running*:
   - no reload pending → `{ ok: true, unchanged: true }`;
   - a reload *is* pending → the newest trigger still wins, and it says
     "stay as you are". So the pending candidate is **cancelled**. Its
     core goes through the disposal rule (step 8.4), so a config-only
     candidate's core, which is the running one, is left alone. Held
     requests are released onto the running core, and the
     response is `{ ok: true, unchanged: true, cancelledPending: <id> }`.

   This covers files reverted back to the running version (A running, B
   pending, files back to A) after a reload was scheduled.
6. **Self-check**, for **every** candidate: `candidate.selfCheck(config)`
   with the deep-frozen config validated in step 4. That's the new core's
   check for a code reload, and the **running** core's for a config-only
   reload, whose new settings must pass too. It compiles the reviewer
   output schemas from the bytes captured at load, validates the presets
   for the configured providers, and renders the dashboard against
   fixture records. It never spawns a reviewer.

A failure in 3–6 leaves the running core and config untouched. The
response carries the error (the stack goes to the log), and the dashboard
shows "last reload failed: …".

**Apply when idle (§5.5):**

7. If no review request is active, start the swap now **through the swap
   gate** (§5.5): admission closes in the same synchronous step that sees
   the zero count, before anything waits for the config lock. Otherwise
   respond
   `{ ok: true, scheduled: true, to: <id>, configChanges, waitingFor: [...] }`
   and start it, through the same gate, when the last one finishes.
8. **Swap**, in one synchronous step:
   1. Re-read `config.json` and redo all of step 4: schema validation with
      the candidate core, **and** the restart-only comparison. The file may
      have changed while the reload waited (a dashboard edit, or a manual
      edit to `port` / `bind`). Then **`candidate.selfCheck` on this
      exact swap-time config**, since it may differ from the one checked
      at preparation (step 6): a setting that passes the schema but fails
      the self-check must not go live through a later edit either. Then
      the **hook-timeout check**: derive
      this swap-time config's **base** hook limit (the hooks' rules, no
      hold allowance). Compare it with the larger of the running config's
      and the prepared candidate's **base** limits, the two that went
      into every `hookTimeoutMs` published while the reload was pending
      (§5.7). Both sides are base limits, so the hold allowance can't
      mask a raise. If the swap-time limit is larger, some waiting hooks
      were given a limit too short for the new reviewer timeout. So a reviewer timeout *raised* after the reload
      was prepared is rejected; lowering it is fine. Any of these failures
      cancels the pending reload with the reason (for the timeout: "reviewer
      timeout raised after the reload was prepared — trigger the reload
      again"). The running core and config stay as they are, and held
      requests are released onto them, which fit the limits their hooks
      received. Triggering again prepares a new candidate and publishes the
      larger limit before anything is held under it.
   2. Record the rollback point: `previous = { core, before, applied }`.
      `before` is the live config just before this swap, and `applied` is
      the config this swap is about to apply. The outgoing core stays
      fully usable, schema file included, because it's the rollback
      target. For a config-only reload, `core` is the same on both sides
      and only the config halves differ.
   3. In this order:
      1. Call `candidate.attach(live)` (§5.2; skipped when the candidate is
         the running core). It's a pure reference assignment, done
         **before** anything live changes. If it throws, the swap aborts
         here. The current core and config are untouched, the candidate is
         disposed, held requests are released onto the running core, and
         the reload is reported as failed.
      2. Make the candidate current, and apply **the config read in 8.1**
         (not the one captured when the reload was prepared) to the live
         holder. Then log `core reloaded`. Edits made while the reload
         waited are therefore kept: dashboard edits persist to
         `config.json` before the swap reads it, and manual edits are in
         the file by definition. The one case where the live holder can
         differ from the file is a dashboard edit whose save failed, which
         is already reported to the dashboard when it happens. The swap
         result then lists every key where the live value differed from
         the file it applied, so nothing changes silently.
   4. **Dispose by reference, and only once nothing uses it.** The
      shell tracks which core *instances* it refers to: current,
      previous, and the pending candidate's core. A config-only candidate
      refers to the running instance and isn't a separate one. An instance
      is disposed, and its snapshot folder and schema file deleted, only
      when **no** reference points at it **and** its **pin count** is
      zero (§5.5). The pin count covers every request pinned to it,
      reviews and non-review requests such as an async dashboard mutation
      alike. Concretely:
      - after a swap, the core that *was* previous drops out (unless it's
        the one coming back, as in a rollback);
      - a cancelled, replaced or rejected candidate's core drops out only
        if it's a distinct instance. A config-only candidate shares the
        running core, so cancelling or replacing it disposes nothing;
      - a rollback exchanges current and previous and disposes nothing.

      If the count is already zero when the last reference goes, disposal
      happens right then.

The code that gets swapped in is exactly what was hashed and validated at
trigger time: it was imported from an immutable snapshot of the bytes that
were hashed (§5.3), so source edits made afterwards, even mid-load, aren't
picked up until the next reload makes a new snapshot.

**Rollback** (`{ rollback: true }`, or the dashboard's Roll back button)
undoes the last reload, code **and** config, and follows the same "when
idle" rule. It works the same for a config-only reload, which is
otherwise the case where rollback would have nothing to restore.

Config is restored key by key, inside a config transaction (§5.5),
comparing four values per key:

- `before`, the value before the reload;
- `applied`, what the reload applied;
- `live`, the holder's value now;
- `file`, a fresh read of `config.json` inside the transaction.

A key counts as **edited since the reload** if *either* `live ≠ applied`
(a dashboard edit) *or* `file ≠ applied` (a manual edit to the file not
applied yet).

| The key since the reload | Rollback sets it to |
|---|---|
| Changed by the reload (`applied ≠ before`) and not edited since (`live = applied` **and** `file = applied`) | `before`, in memory and in the file: the reload's change is undone |
| Edited from the dashboard (`live ≠ applied`) | Left as is, in memory and in the file: the later edit is kept |
| Edited in the file but not applied yet (`file ≠ applied`, `live = applied`) | Left as is: memory keeps the reload's value, and the file keeps the manual edit for the next reload to apply. Reported as "unapplied file edit kept". |
| Not changed by the reload | Unchanged |

Then:

- **Schema check.** The result is validated with the previous core's
  schema. Any key still failing (a field only the newer schema accepts,
  edited after the reload) is also set back to `before`, and listed.
- **Self-check.** The previous core's `selfCheck` then runs on the
  config about to be restored. If it fails even after the schema-driven
  reverts, the rollback is refused with the reason, and nothing
  changes: no swap, no config write.
- **Write-back.** Only the reverted keys are merged into the **fresh file
  read** (never a whole-holder dump), and the result is written atomically,
  keeping a timestamped backup of the replaced file. File and live config
  then agree on every reverted key, and the next reload won't quietly
  reapply what was rolled back. Everything else in the file is preserved
  as it is on disk: `authToken`, restart-only keys and unapplied manual
  edits.
- **Report.** The response, and the dashboard, list every key reverted,
  every key kept because it was edited after the reload, and the backup
  path.

A rollback swaps `current` and `previous`, recording the config it
restores as the new `applied`, so rolling back a rollback re-applies the
reload by the same rule.

**Cancel** (`{ cancel: true }`, or a dashboard button) drops a pending
reload.

### 5.5 Swapping only when idle

**Review admission.** The in-flight maps are registered *inside* the
pipeline, after asynchronous work such as context resolution and, for
MCP, awaiting the client's `roots/list` answer. They can't define
"idle": an MCP `request_review` sitting in its roots check is invisible
to them, so a swap could happen in that gap and the old core's callback
would then start a review after it. So the shell admits every review
request **at entry, before any `await`**, and only admitted requests
decide idleness:

- The Stop-hook `/review` route and the MCP `request_review` callback
  call `shell.admitReview()` as their first statement. It counts the
  request as **active**, pins the core (`currentCore()` at that instant)
  and **pins the config**, and returns a release function that runs in
  `finally`, whatever the outcome.
- **Config pinning:** admission takes a deep, frozen copy of the live
  config, and that review uses only the copy, start to finish. That
  covers the merge with `.review-orchestrator.json`, change detection,
  the reviewer's model, effort and timeout, blocking severities and
  round/block caps. Dashboard edits keep updating the live holder
  immediately, as today, but only affect reviews admitted after them. A
  config swap (§5.7) works the same way. So no review ever sees its
  config change halfway, whether the change comes from the dashboard or a
  reload.
- **Idle** means the active count is zero. That includes requests in
  their roots check, in context resolution, queued behind another review
  for the same context, joined to a running review, short-circuiting from
  the cache (milliseconds), or running a reviewer.
- Non-review requests (dashboard, `/status`, `notify-change`, MCP session
  traffic) aren't admitted and never wait.

**The swap gate.** Admission and release are synchronous counter
updates, but the swap can't always finish in the same step: its config
part (§5.4 step 8) runs as a config transaction, and must wait if a
dashboard mutation holds the transaction lock. So **every swap that
starts at idle** goes through the gate:

- a release brings the active count to zero with a reload or rollback
  pending;
- a reload or rollback finishes preparing (§5.4 step 7) while the count
  is already zero.

In either case the shell, in the same synchronous step that observes the
zero count:

1. **Closes admission.** From now on, new review requests wait at entry,
   exactly like held requests under the starvation guard: not counted, not
   pinned, and racing their request deadline (§5.5). The active count is
   now guaranteed to stay at zero.
2. **Takes the config lock**, waiting for any mutation in progress (one
   atomic file write, milliseconds).
3. **Runs the swap** (§5.4 step 8), then releases the lock.
4. **Reopens admission** and dispatches the waiting requests in arrival
   order:
   - after a successful swap, to the new core and config;
   - if the swap was rejected at this point (validation, restart-only key,
     hook-timeout check), to the current core and config, with the pending
     reload cancelled as §5.4 describes.

No review can be admitted on the old core between the idle decision and
the swap. Dispatching, not the swap, is the only thing the waiting
requests depend on.

**The candidate is frozen while the gate is closed.** Step 1 captures the
pending candidate (core, config, id) into the gated swap, and marks the
pending slot *swapping*. While it's swapping, reload triggers don't
touch it: a replacement, a cancel, a rollback, or a matching-the-running
trigger (§5.4 step 5). They wait for the gate to reopen, which takes
milliseconds (one config transaction), then run against the state the
swap left:

- a **replacement** becomes a new reload, compared with the now-current
  core and config. It prepares, then swaps at the next idle moment;
- a **cancel** finds nothing pending and reports "swap to `<id>` was
  already applied" (or "was rejected", if step 3 rejected it);
- a **rollback** rolls back the swap that just happened.

The gated swap applies and disposes only what it captured. Nothing else
can replace, cancel or dispose that candidate while the gate is closed,
so a swap never applies a cancelled candidate, and never uses a disposed
one.

**Starvation guard.** With several active sessions, review requests can
overlap continuously, so the server may never be idle. If a reload is
still pending after `reload.maxWaitMinutes` (default 5, decision Q3), admission
changes: new review requests are **held at entry**, before any work.
They're not counted as active and not pinned to a core.

- Requests admitted before the guard started finish on the current core.
- When they've all released, the shell swaps, then dispatches the held
  requests to the new core from the start, in arrival order. Nothing in
  them ran on the old core. A held request for a context whose review was
  still running gets no join, but that review's result is in
  `state.json` by then, so it usually short-circuits from the cache
  (`NO_CHANGES` or no progress) rather than reviewing again.
- **No request is held past `reload.maxHoldSeconds` (default 45).** The
  admitted work still draining is *not* bounded by one reviewer timeout:
  requests queued behind another review of the same context run one after
  another, so the drain can span several timeouts. A held request
  therefore carries its own deadline. When it passes, the request is
  released onto the still-current core, runs normally, and counts as
  active. While a reload is pending, the hook wait limit the server
  publishes (§5.7) includes `maxHoldSeconds`, so the hold itself never
  eats into the time for the review. The hooks cap any wait at 29 min, so
  the shell clamps the hold to keep the published sum within that cap.
  After release, the request may still queue behind same-context reviews;
  its **request deadline** (below) guarantees the hook still gets an
  answer in time.
- **The reload ends without a swap** (cancelled explicitly, cancelled by
  a trigger matching the running state, or rejected at swap time by
  config revalidation or the restart-only check): the shell releases
  every held request onto the still-current core, in arrival order, at
  once. Nothing stays held without a pending reload. A replacement that
  fails to prepare doesn't end the pending reload (§5.4 step 2), so it
  releases nothing.
- **What the guard does and doesn't guarantee** (requirement 2): no held
  request waits more than `maxHoldSeconds`, and the swap happens at the
  first moment the admitted work drains. It does **not** guarantee the
  reload completes under sustained load: requests released at their
  deadline join the active work, so a machine that's never idle can keep
  a reload pending indefinitely. That isn't fixable inside the idle-only
  rule. Completing under unbounded load means serving new requests on the
  new code while old ones finish on the old code, which is a non-idle
  swap. So:
  - **By default, idle-only, as requested:** an indefinitely pending
    reload is allowed. It's always visible on the dashboard (pending
    for, held now, released at deadline) and in `/status`, and can be
    cancelled at any time.
  - **Apply now (decision Q4: manual only, no automatic forcing):** an
    explicit `reload.sh --now`, or the dashboard's **Apply now** button
    on a pending reload, swaps without waiting for idle. With nothing
    pending, `--now` prepares and applies in one go. It's the only way
    a swap ever happens with reviews running, and only when you ask:
    - it goes through the same swap gate and every swap-time check
      (config revalidation, restart-only keys, hook-timeout check,
      self-check). A failure leaves everything as it was;
    - reviews already admitted **finish on the old core** they're pinned
      to, and archive with its version. Held requests and new ones go to
      the new core. The old core becomes `previous`, the **rollback
      target**, exactly as in an idle swap. So it stays attached and
      intact (resources, schema file, snapshot) after its pinned reviews
      drain. It's disposed only by the reference rule (§5.4 step 8.4):
      once no selection refers to it (a later swap pushes it out of
      `previous`) **and** its pin count is zero;
    - the core version in the duplicate key keeps new-core requests from
      joining old-core reviews, and the shared per-context chain keeps
      their state writes in order;
    - nothing is dropped and no request waits longer; the cost is a
      period where two versions run side by side, which you chose by
      pressing it.

    There's no `reload.forceAfterMinutes`: nothing forces a swap
    automatically.

**Request pinning.** A review request uses the core pinned at admission
to the end. With idle swaps, no review spans two versions. Non-review
requests pin `currentCore()` once at entry too, so an async one (say, a
dashboard mutation awaiting a disk write) that's mid-flight at a swap
finishes on the core it started with. Every pin, review or not,
increments that core's **pin count** and decrements it in `finally`. Idle
for *swapping* still counts only review admissions, but *disposal* waits
for the pin count (§5.4 step 8.4), so a core is never torn down, nor its
snapshot deleted, under a request still using it.

**One review key, for joining and for the cache.** Everything that
decides *what a review would conclude*, other than the code itself, is
folded into one hash:

`reviewKey = sha256(effective provider, effective-config fingerprint, reviewVersion, shellVersion)`

- the **effective provider**: the request's own `provider` override when an
  MCP call passes one, otherwise the configured `reviewer.provider`. The
  config fingerprint covers every provider's settings, but which provider
  *runs* is decided per request, so it's a separate part of the key, as
  it is in today's `reviewConfigHash`;
- the **effective-config fingerprint** (below): the pinned global config
  merged with `.review-orchestrator.json`, every field the pipeline reads.
  That includes reviewer, model and effort (`codex.reasoningEffort`,
  `reviewer.claude.effort`, …), limits, severities, ignore paths, payload
  options and extra instructions;
- **`reviewVersion`** (§5.3 step 2): the core code the review path runs;
- **`shellVersion`**: a hash of the shell's own source files, computed at
  startup. Shell code shapes reviews too: admission and config pinning,
  `spawnTool`, the in-flight registries, signing. It can only change with
  a restart, so after a restart that changes it, each context runs one
  fresh review instead of reusing a verdict reached by the previous
  shell. A restart with unchanged shell code invalidates nothing.

It's used in two places:

- **Joining** a running review: part of the duplicate key, as below.
- **Every persisted cache shortcut.** The baseline stores
  `lastBaseline.reviewKey`, and these all require it to equal the
  request's `reviewKey`:
  - the clean-tree fast path;
  - `NO_CHANGES`;
  - no progress (`NO_PROGRESS_WITH_OPEN_ISSUES`);
  - `CODEX_ERROR_CACHED`;
  - the prior-free re-baseline gate.

  That's on top of the commit range and `progressHash`. So a change to
  effort, model or any other review setting, or to the review code itself
  after a reload, means the next request runs a real review instead of
  reusing a verdict reached under different terms.

**Caller guidance (`extrasHash`) sits next to `reviewKey`, with its own
rule** (decision Q8). It's the hash of the request's
`extra_instructions`, empty for Stop hooks.

- **Joining** a running review needs an exact match: it's part of the
  duplicate key. A no-extras request doesn't join a review that's still
  running under extra guidance, because that review's outcome isn't
  known yet.
- **The cache** stores `lastBaseline.extrasHash`:
  - a request **with** extras needs an exact match;
  - a request **without** extras (every Stop hook) needs a match, **or**
    a **passing** baseline (`GOOD_TO_GO` / `GOOD_TO_GO_WITH_NOTES`)
    reached with any extras. A review that passed with extra guidance
    counts as reviewed, so the Stop hook after an MCP review with extras
    doesn't run another one. It doesn't accept an `ISSUES`, no-progress
    or `CODEX_ERROR_CACHED` baseline from other extras: those findings
    were shaped by guidance it didn't ask for.
  A dashboard-only reload leaves `reviewVersion` alone and invalidates
  nothing.

Today's `reviewConfigHash` hashes a subset: provider and model, but no
effort, no per-call extras and no code version. `reviewKey` keeps
everything it covers, including the per-call provider override, and adds
the rest. It stays for display and the archive, but no
longer gates any cache. Baselines without `reviewKey` (from before this
change) never match, so each context runs one review after the upgrade.

**Duplicate matching uses the review key and the core version.**
Today a request joins a running review when they share context, `force`
and provider. The key gains `reviewKey`, the caller's `extrasHash`, and
the core version:

- **An effective-config fingerprint:** a hash of the config the review
  will actually run with. That's the pinned global config **merged with
  the repo's `.review-orchestrator.json`** (model, effort, timeouts, caps,
  severities, ignore paths, payload options, extra instructions). Today
  the project file is loaded inside the pipeline, after duplicate
  matching. It moves before it: admit, resolve the context, read and
  merge the project file, then fingerprint and match. The merged result
  is pinned with the request, and the review uses exactly that, so a
  project-file edit mid-review can't change a running review either.
- **The caller's guidance:** a hash of the request's own
  `extra_instructions` (MCP callers can pass it), empty for Stop hooks.
  Two calls with different guidance don't share a *running* review.
- **The pinned core version.** Under idle-only swaps, requests on two
  cores never overlap, so this changes nothing. After an **apply now**
  (above), it stops a request admitted to the new core from joining the
  old core's review.

Nothing more is needed, because the existing per-context chain already
does the rest:

- a request whose effective config or core differs (after a dashboard
  edit, a project-file edit, a config swap or an apply now) has a
  different key;
- so it doesn't join the running review and take its result;
- instead it queues behind it on that chain, as a request with a
  different `force` or provider does today, and runs on its own config
  and core.

The chain is per context, shared across cores, so ordering of state
writes holds across versions too. This also fixes two pre-existing cases:
a dashboard edit or a `.review-orchestrator.json` edit made mid-review
can today hand the next request the old settings' result.

**Request deadlines.** A Stop-hook request can wait in several places:
the hold (§5.5), the per-context chain behind other reviews of the same
context, a running review it joined, and its own reviewer run. The chain
alone can span several reviewer timeouts, so no published wait limit can
cover every case. Each request therefore carries its own deadline, and
the deadline bounds the **response**, never the review:

- The Stop hook sends the wait limit it's using (`timeoutMs` in the
  request body). The server sets the request's deadline to arrival plus
  that limit, minus a response margin of `min(5 s, timeoutMs / 10)`. So a
  deliberately short limit, such as `hook.fetchTimeoutSeconds: 3`, still
  gets most of its time, not a deadline that's already past on
  arrival. MCP calls, with no known client limit, get no deadline, as
  today.
- **Limit handshake at pinning.** A hook reads `hookTimeoutMs` from
  `server.json` and sends its request a moment later. A swap, or a
  dashboard edit raising a timeout, can land in that gap, and no
  publish-side check can see a value the hook already holds. Time spent
  held or in the swap gate also eats into the hook's budget. That
  includes a hook that read the limit before a reload became pending (so
  no hold allowance) and was then held. So whenever a request with a
  `timeoutMs` gets its config pinned, the server compares two numbers.
  That's at admission, or when dispatched from the hold or the swap gate.
  - `remainingMs` = `timeoutMs − (now − arrival)`: what's left of the
    limit the hook is actually using. Whatever the request already spent
    waiting is gone.
  - `requiredMs`: the hook wait limit for *that pinned config*, by the
    hooks' own rules (reviewer timeout + 60 s, or the pinned
    `hook.fetchTimeoutSeconds`). There's no hold allowance, because a
    pinned request is past any hold.
  - Both are hook limits under the same rules, so they compare like with
    like. The 5 s response margin belongs to the request *deadline*
    (`DEADLINE_EXCEEDED` timing) only, never to this comparison.
  - If `remainingMs >= requiredMs − 2 s`, the request proceeds. The 2 s
    tolerance absorbs request transit and parsing. An unchanged-config
    request at immediate admission always passes: `timeoutMs` equals
    `requiredMs` and elapsed time is milliseconds. That holds with a short
    pinned `hook.fetchTimeoutSeconds` too. A hold of more than 2 s does
    count against it.
  - Otherwise it doesn't start. The server releases its admission and pin
    and answers at once `409` / `HOOK_LIMIT_STALE` with
    `{ hookTimeoutMs: requiredMs }`. No work was done, so nothing is lost.
    The hook's retry gets a fresh attempt, still inside its overall
    deadline (below), and isn't held again unless a new reload is
    pending.
  - **One overall deadline per hook run.** The shared hook client code
    (the Claude and Codex Stop hooks, and the opencode plugin, which
    already imports `decideStopHookResponse` from `stop-review.mjs`) sets
    a single deadline when the hook starts: start + 29 min, today's
    `MAX_FETCH_TIMEOUT_MS`, leaving the existing 60 s margin under the
    30 min Claude Code harness timeout that `install.sh` sets. Every
    attempt's abort timer, and the `timeoutMs` it sends, is
    `min(limit for this attempt, overall deadline − now)`. Retries and any
    time spent held come out of that one budget, so no sequence of
    `409`s and holds can outlast the harness.
  - **When to stop retrying.** On `HOOK_LIMIT_STALE` the hook resends
    with the returned limit. The **third outgoing attempt** (sent after a
    second `HOOK_LIMIT_STALE`) always carries `finalAttempt: true`, and so
    does any earlier resend when the remaining budget can't cover the
    required limit. On a final attempt the server never answers `409`; it
    proceeds on the deadline rules below. So there are at most three
    attempts, all inside the one budget.
  - A request therefore starts a review under a config whose reviewer
    timeout fits the limit its hook is using, unless the config kept
    changing across retries or the budget ran short. Then it proceeds on
    the deadline rules: an answer before the hook's deadline, with the
    review continuing in the background.
  - A pinned `hook.fetchTimeoutSeconds` shorter than the reviewer timeout
    is respected rather than fought: `requiredMs` uses the same rules, so
    it equals the pinned value and the request proceeds. The review then
    finishes in the background, as today.
- **Every wait races the deadline:** waiting in the hold queue, for the
  chain predecessor, on a joined review's promise, and on its own
  pipeline. If the deadline fires first, the request answers at once with
  a silent `ESCALATE` / `DEADLINE_EXCEEDED` (`notifyUser: false`, so the
  turn ends quietly, exactly as a hook timeout would, but with an answer).
  That response is never cached and writes no state.
- **What happens to the work depends on whether it started:**
  - **Still waiting** (held, or queued behind another review of the same
    context): the request is abandoned. It leaves the queue, releases its
    admission, and never runs. The next Stop hook asks again, and by
    then the review it was waiting behind has usually cached a result.
  - **Nothing to wait for:** a request that isn't held and has no
    predecessor on its context chain **always starts its own pipeline**,
    however short its remaining budget. Abandonment never applies to it.
    With a very short hook limit, it answers `DEADLINE_EXCEEDED` quickly
    while its review keeps running in the background and caches the
    result (next bullets), exactly as today's short-limit behaviour. A
    short limit never means the review is skipped.
  - **Joined another review:** only this waiter stops waiting. The review
    continues for its owner and stores its result as usual.
  - **Its own pipeline already running:** the pipeline keeps going with
    its pinned config and **configured** reviewer timeout, and caches its
    result in `state.json` as today. The next Stop hook picks it up as
    `NO_CHANGES`, no progress, or the cached findings. Its admission
    (and core pin) is released when the pipeline finishes, not when the
    response is sent, so idle detection and disposal still see it.
- **Reviewer timeouts are never shortened to fit a deadline.** Under a
  short hook timeout (say `hook.fetchTimeoutSeconds: 90` with a
  10-minute reviewer timeout), reviews still run to completion in the
  background and land in the cache, as they do today. A deadline only
  changes what the hook is told meanwhile.

The result: a Stop hook always gets an answer before it gives up, whether
the request was held, released at its hold deadline, queued behind
same-context reviews, joined to a slow review, or running a long one
itself. The review work itself behaves as it does today.

**Why the in-flight maps still move to the shell.** Duplicate-review
handling and per-context ordering must keep working for requests admitted
on the same core across the moment a reload becomes pending, and the
dashboard's in-flight view reads them. The admission counter and the
per-core pin counts are new shell state alongside them.

**Config changes are transactions, serialized with swaps.** Pinning keeps
a core alive under an async request, but the config holder and
`config.json` belong to the shell and outlive any core. An async
dashboard mutation that read the config before an idle swap and wrote
after it could otherwise put back settings the swap replaced. So every
config change goes through one shell function,
`configTransaction(change)`:

- Transactions run **one at a time**: dashboard mutations, the swap's
  config step (§5.4 step 8: re-read, validate, apply) and rollback's
  restore all queue on the same lock. A swap waits for a mutation in
  progress, and a mutation waits for a swap in progress.
- A mutation is a **delta**, not a snapshot: the keys it sets, with the
  values the user chose, such as `{ limits.maxCodexRounds: 6 }`. Inside the
  lock:
  0. **Take the cross-process config lock** (§5.7, "Config file
     writers"). Every program that writes `config.json` takes it: this
     server, `rotate-token.sh`, the installer. It's held across steps
     1–3, so a rotation can't land between this transaction's read and
     its rename.
  1. **Read `config.json` fresh.** The file has keys the holder doesn't
     own or hasn't applied: `authToken` (rotated outside reloads),
     restart-only keys, and manual edits waiting for a reload. If the file
     can't be parsed, the mutation fails with "config.json isn't valid
     JSON — fix it first" and writes nothing.
  2. **Merge the delta into that fresh read**, and only the delta. Every
     other key keeps its on-disk value, so a dashboard save can never put
     back an old token or erase an unapplied manual edit.
  3. **Validate and self-check both results.** Build both:
     - the merged *file* (fresh read + delta);
     - the *live result* (current holder + delta).

     They differ when the file holds unapplied manual edits. Both must
     pass the current core's schema and its `selfCheck` (§5.2). The live
     result is what will actually run, and the file is what the next
     reload will load. So the holder never receives a combination that
     wasn't checked, and the file never stores one that a reload would
     reject. If either fails, the mutation fails and nothing is written.
     Then
     **check and write**: re-read the file and compare its content hash
     with the one read in step 1. A match means nothing changed it
     meanwhile, including a manual edit by an editor that can't take the
     lock: write to a temp file and rename. A mismatch means redo from
     step 1 on the new content, up to 3 times, then fail with
     "config.json changed while saving — try again". Nothing is written
     over an edit the merge didn't see.
  4. **Commit the checked live result to the holder**: the current holder
     plus the delta, exactly as checked in step 3. The holder doesn't pick
     up the file's other unapplied edits; a reload does that.
  5. **Conflict on the same key:** if the fresh file has an unapplied
     manual edit to a key the delta also sets, the dashboard value wins in
     both places (it's the user's latest explicit action), and the response
     says which manual edit it replaced.
- A dashboard request that started on the old core but commits after a
  swap therefore lands on top of the new config, checked by the new
  schema. If that rejects it (say, the key no longer exists), it fails
  with "config changed, reload the page" instead of writing anything.
- The holder carries a **revision**, bumped on every commit. Rollback's
  "edited since the reload" test, the dashboard's stale-page check
  (§5.8) and the swap's "file differed from live" report all read it.

**State compatibility rule, both directions.** Two retained cores share
`state.json` and the archive: state v6 wrote is read by v7 after the swap,
and state v7 writes is read by v6 again after a **rollback**. So
compatibility has to hold both ways, for as long as both can be
selected:

- Each core declares **`STATE_FORMAT`** in its contract, next to
  `CORE_API`. The shell swaps, and rolls back, only between cores with
  the **same** `STATE_FORMAT`. A candidate with a different one is
  rejected with "persisted state format changed — needs a restart",
  exactly like a contract change. A restart leaves no older core to roll
  back to.
- **Within a `STATE_FORMAT`, persisted changes are additive only:**
  - new fields are optional;
  - readers ignore fields they don't know and default the ones that are
    missing;
  - no field is renamed, removed, or given a new meaning or type.

  The pipeline already reads this way (`?? default` fallbacks, as in
  `attemptsSincePass`, and `{ ...state, … }` saves that carry fields it
  doesn't interpret). So a retained previous core reads what the newer
  core wrote, and the newer core reads what the previous one wrote.
- **The shell must not drop fields either.** Today's `idleResetContext`
  in `server/src/state.js` rebuilds a context from a fixed field list
  after ten idle minutes, silently dropping any field it doesn't name:
  exactly the "new optional field" this rule allows. It changes to
  `{ ...existing, codexRounds: 0, blockCount: 0, lastReviewedAt: 0 }`,
  clearing only the loop counters and keeping everything else, known or
  not. That's a Phase 1 shell fix. The other shell paths that build
  contexts behave as they should: `store.save` merges with
  `Object.assign`; `store.reset` is a deliberate wipe, and so starts from
  a blank context on purpose. Archive records are built by the shell's
  frozen archive code in v1, so cores can't add archive fields (decision
  Q7).
- Anything non-additive bumps `STATE_FORMAT`, and so needs a restart.

This rule, and the `STATE_FORMAT` bump for non-additive changes, goes into
`CLAUDE.md` / `AGENTS.md`. A test round-trips state through two core
fixtures in both directions, **including an idle reset in between**, so
a field dropped by the shell can't slip past it.

### 5.6 MCP sessions

Each session's transport and `McpServer` stay in the shell's session map.
Tool callbacks become thin delegates. `request_review` admits itself
first, synchronously, before the roots check or anything else
asynchronous (§5.5), and runs on the core pinned by that admission:
`(args) => { const { core, release } = shell.admitReview(); … core.mcp.requestReview({ args, ctx }) … finally release() }`.
Under the starvation guard the same callback waits in the hold queue
instead, and runs on the new core once released.

`reset_review_context` isn't a review, so it doesn't count toward idle,
but it does await the roots check. It **pins its core at callback entry**
(`const { core, release } = shell.pinCore()`, released in `finally`), so
the core it started on can't be disposed under it, however many swaps
happen meanwhile. The same applies to every non-review entry point:
every route handler and MCP callback pins at entry and releases in
`finally` (§5.5, "Request pinning"). Behaviour changes
therefore apply to already-open sessions on the first call after the
swap, with no reconnect.

A tool's *name, description and input schema* are registered when a
session initializes, so changes to those reach new sessions only. Pushing
them to open sessions would need re-registration plus
`notifications/tools/list_changed`; that's out of scope. Such changes are
rare and are documented as "needs a client reconnect".

### 5.7 Config reload

Every reload re-reads `config.json` (same action, no separate button),
including when the code hasn't changed, so a config-only edit is just a
reload (§5.4 step 5). Changes are applied in place to the shell's config
holder at swap time, under the same idle rule as code. Dashboard-made
changes keep working as today: they mutate the holder immediately and
best-effort persist. Neither reaches a review already admitted, because
each review runs on the config pinned at admission (§5.5).

The restart-only check compares against the values the server **started
with**, and runs both when the reload is prepared and again at the swap
(§5.4 step 8).

**Hooks and the two connection settings.** The Stop hook, the
notify-change hook and the opencode plugin read `config.json` themselves
on every call, so the server applying config at swap time isn't enough
for the settings they use to *reach* it:

- **`authToken` is not part of reloads.** The shell's auth check reads
  the token from `config.json` on **every authenticated request and every
  `/healthz` challenge** (§5.7, identity check), exactly as the hooks do, with no modification-time cache, which a rewrite that
  keeps the timestamp would fool. It's a sub-kilobyte read on an
  infrequent request. A pending reload or a
  rollback (which never touches `authToken`) can never put
  hooks and server out of sync. If the file can't be parsed mid-edit, the
  server keeps the last successfully read token.
- **Hooks during a half-written `config.json`.** Each hook run is a fresh
  process with no memory. Today's token reader returns null on a parse
  error, so a review is silently skipped whenever a hook catches the file
  mid-write. Three layers fix that:
  - **Our writes become atomic and coordinated.** Every program that
    writes `config.json` switches to write-to-temp-then-rename (mode 0600).
    That covers the dashboard's saves (`persistProvider` /
    `persistPreset` and the caps and severity handlers, which write in
    place today), `rotate-token.sh` and the installer. A reader then sees
    either the old file or the new one, never half of each.
  - **Config file writers** share one cross-process lock on
    `config.json.lock`, next to the file. It's an **OS-level lock**, not a
    lock file whose existence is the lock:
    - the lock file is opened with macOS's `O_EXLOCK` flag (raw value
      `0x20` from `<fcntl.h>`; Node passes open flags straight to
      `open(2)`), plus `O_NONBLOCK`, retried every 50 ms;
    - the kernel grants it to one open file at a time and releases it
      when the owner closes it or exits, however it exits (crash,
      `kill -9`). There's **no stale-lock recovery** at all: no pid
      checks, no age checks, no unlinking. So two waiters can never both
      "break" a lock and end up as two writers. The file itself stays in
      place permanently;
    - a waiter gives up after 10 s with "config.json is locked by another
      writer" and writes nothing. A wedged but live owner shows up as an
      error, not as a lost write;
    - a small shared Node helper (`install/config-lock.mjs`) provides it
      to the server and to the bash scripts, which already shell out to
      Node for their config merges;
    - verified on this machine with Node 24: a second process gets
      `EAGAIN` while the first holds the lock, and gets the lock right
      after the first is killed with `kill -9`. Phase 0 re-checks it on the
      launchd Node. `O_EXLOCK` is BSD/macOS-only, which matches this
      project's launchd-only scope.

    Each writer holds the lock across read, merge, re-check and rename.
    **Among writers that take the lock, no write is ever lost.** That's a
    strict guarantee: this server, `rotate-token.sh`, the installer.

    **An editor saving `config.json` by hand can't take the lock, so its
    save is protected best-effort, not guaranteed.** Every writer does the
    content-hash re-check before renaming (§5.5, transaction step 3), so
    an editor save that lands before the re-check is seen: the writer
    redoes its merge on top of it, or fails. A save landing in the narrow
    window between the re-check and the rename can still be overwritten.
    So:
    - every config write also keeps a **backup**,
      `config.json.bak-<timestamp>` (0600, the last 10), of the file as the
      writer read it under the lock. It's a recovery aid:
      - **guaranteed** for anything written by a program that takes the
        lock, since nothing else could have changed the file in between;
      - **best effort** for an editor's save. A save that lands after the
        writer's re-check but before its rename is in no backup, and can't
        be detected either: the writer saw the file unchanged;
    - when the re-check *did* see a change and the writer gave up after
      its retries, the response and the dashboard say so and name the
      latest backup.

    For a strict guarantee with manual edits, edit through a writer that
    takes the lock, or with the server stopped.
  - **Brief retry for manual edits.** On a read or parse failure, the hook
    retries 3 times over about 1 s. Editors that save in place
    (truncate, then write) finish within that window.
  - **Last-known-good fallback.** The connection details a hook needs
    (the token, plus the config-derived address and timeout used when
    `server.json` is absent) are kept in
    `~/.cache/review-orchestrator/hook-credentials.json`. That's an atomic
    write, mode 0600, the same protection as `config.json` itself. It's
    **seeded and refreshed**, so it exists from the start rather than
    after a first lucky hook run. Its writers are exactly the programs
    that write `config.json`, and they follow one rule: **write the cache
    only while holding the config lock, from a read of `config.json` taken
    inside that lock.** Every config write happens under the same lock,
    so the last cache writer always derived it from the newest committed
    config. A writer that read an older token can't overwrite a newer
    cache later.
    - `install.sh` writes it when it installs the hooks;
    - `rotate-token.sh` writes it as part of the rotation, inside the
      same lock that writes the new token;
    - the server writes it at startup, at swaps, on detecting a token
      change, and at the end of each config transaction.

    **Hooks never write it.** They only read it. A hook that read the old
    token and paused through a rotation therefore can't put that token
    back. When nothing has refreshed it yet after a manual edit made with
    the server down, the cache simply holds the last committed token,
    which the server still accepts or rejects as usual.

    If the retries still can't parse the file, the hook uses the cache
    and logs that it did.
  - **When the cache can't help.** It's missing (deleted, or a manual
    install that skipped `install.sh` and a server that never started),
    or it holds a token that was rotated past its grace. Then the hook
    fails open as today, but the stderr line names the unparseable config
    and the reason (no cache, or `401` on a cached token).

  So a review is skipped only when `config.json` stays unparseable *and*
  the cache is either missing or holds a token rotated past its grace.
  That case is reported, not silent.
- **Changing the token is a rotation, with a grace period for MCP
  clients.** The hooks re-read the token on every call, and Claude Code's
  MCP entry fetches it through `mcp-headers.sh` (a `headersHelper`). But
  Codex has it written into `~/.codex/config.toml` by
  `merge-codex-mcp.mjs`, and the opencode plugin reads it once when it
  loads, for both its own requests and the MCP registration header. So:
  - **The opencode plugin's own requests read the token per request.** The
    plugin's `/review` (its end-of-turn review on `session.idle`) and
    `/notify-change` calls switch from the token read at load to reading
    `config.json` (and `server.json`, for address and timeout) on every
    call, like the hooks. An open opencode keeps its end-of-turn reviews
    through any rotation, with no restart.
  - **Static MCP registrations** remain: the header in Codex's
    `config.toml` and the one the opencode plugin passes when it registers
    the MCP server. Those clients keep sending the old token until they're
    reconfigured *and* restarted. That affects only their
    `request_review` / `reset_review_context` MCP tools, not their
    end-of-turn reviews (opencode's goes through the plugin's own requests,
    Codex's through its Stop hook, both per request). Hence:
  - When the shell sees the file's token change, it keeps accepting the
    **previous token** until a **fixed expiry**, with the length set by
    `auth.previousTokenGraceHours` (new, default 24):
    - **scripted rotation** (the current token has a record in
      `auth.rotations`, below): the predecessor the server knows, `P`, gets
      a grace only from **the record that rotated `P` out**, the one whose
      `previousTokenHash = sha256(P)`, and only if that record's `grace` is
      `"default"` and no later record is `"none"`. Expiry = that record's
      `at` + the grace length. That's counted from when *`P`* was rotated
      out, not from when the server noticed, and not from a later rotation
      it missed. A server idle for 30 hours after a rotation grants
      nothing. A server that missed A→B and sees A→C gives A the grace
      from A→B, which is likely long over, or none if A→B or anything after
      it was `--revoke-now`. With no record that rotated `P` out (history
      trimmed), `P` gets no grace;
    - **an `authToken` edited by hand** (no record for the current
      token): expiry = the time the server noticed the change + the grace
      length. That's the best it can do, and `rotate-token.sh` is the
      supported path.

    The expiry is checked in the pre-verification refresh, so an expired
    previous token is rejected even on the first request after it ran
    out. Open sessions keep working until then, and `/status` and the
    dashboard show "previous token accepted until …". The grace lives in
    memory, so a server restart ends it early.
  - A new `scripts/rotate-token.sh` is the supported way to change it.
    It generates a token, writes `config.json` (0600), re-runs the Codex
    MCP merge so `config.toml` carries the new token, and tells you which
    clients to restart (Codex and opencode sessions; Claude Code picks it
    up through the helper on its next connection).
  - `rotate-token.sh --revoke-now` skips the grace, for a leaked token.
    **Revocation is durable, written with the token change, never sent
    over HTTP:**
    - every rotation, in **one atomic write under the config lock**, sets
      the new `authToken` and appends a **rotation record** to
      `auth.rotations`, a history of the last 10:
      `{ tokenHash: sha256(new), previousTokenHash: sha256(token it
      replaced), grace: "default" | "none", at }`. `--revoke-now` writes
      `grace: "none"`. The records hold only hashes, no secrets;
    - the server re-reads `config.json` on every authenticated request
      and every `/healthz` challenge (above), and applies the grace rule
      above to the predecessor it knows. Its outcomes:
      - a `"none"` record anywhere *after* the one that rotated the
        predecessor out means no grace, and any running grace is dropped.
        So A→B (`--revoke-now`), then B→C (normal), seen as A→C, gives A
        nothing: the A→B record revoked it;
      - A→B (normal), then B→C (`--revoke-now`), seen as A→C, gives A
        nothing too, because a later record is `"none"`;
      - because the rule finds the record by `previousTokenHash`, a later
        rotation the server didn't see can't extend or restart an older
        token's grace;
      - a current token with no record (edited by hand) falls back to the
        notice-time rule;
    - the refresh happens **before** the request is verified. So even a
      request signed with the old token that arrives as the very first
      one after the rotation is checked against a state where the old
      token is already revoked, and gets `401`;
    - with the server stopped, nothing is in memory to revoke, and its
      next start reads only the new token.

    So there's no second step that can fail and leave the leaked token in
    grace, and no request ever carries a raw token to an address that
    might be an impostor. The old `POST /admin/revoke-previous-token`
    idea is dropped. `rotate-token.sh` reports "revoked: takes effect on
    the server's next request", and confirms it with the **new** token. It
    makes a signed `GET /status`, through the shared client: address
    selection and the response check both use the new token, which the
    server proves on its first refresh. `/status` now reports the auth
    state: `auth: { currentTokenHash, previousTokenGrace: null | { tokenHash,
    until } }`. The script checks `currentTokenHash = sha256(new)` and
    `previousTokenGrace = null`, from a response signed with the new token.
    No old-token probe is needed: the old token can no longer pass the
    challenge, so a client using it couldn't even pick an address. The
    check confirms rather than performs the revocation, and nothing it
    sends carries a raw token.
    Clients still on the old token get `401` until they restart. That
    trade-off is explicit, not a surprise.
  - Either way, once the grace ends (or after `--revoke-now`), an open
    Codex or opencode session that wasn't restarted loses its MCP review
    *tools* until restart. Its end-of-turn reviews keep working, because
    they read the token per request. `rotate-token.sh` and the dashboard
    say so, and name the clients to restart.
- **`port` / `bind` come from a runtime file.** At startup, once
  listening, the shell writes its actual address to
  `~/.cache/review-orchestrator/server.json` (`{ pid, port, bind,
  startedAt, instanceId, hookTimeoutMs }`, atomic write, 0600) and removes
  it on graceful shutdown. `instanceId` is a random UUID per server start.

  An ungraceful exit leaves the file behind, and its pid can later belong
  to an unrelated process. The port can be taken over too. A listener
  there can relay anything to the real server and back. So the hooks
  protect the token by **never sending it**, and only use the challenge
  below to pick an address.

  **Signed requests and responses, for every non-MCP caller.** The Claude
  and Codex Stop hooks, the notify-change hook, the opencode plugin's own
  requests, **and every script** (`reload.sh`, `rotate-token.sh`'s check,
  `replay-review.sh`, `reset-review.sh`, `setprovider.sh`) stop sending
  `X-Review-Token`. They all go through one shared Node client,
  `install/signed-client.mjs`, which also does the address selection
  below. The bash scripts call it the way they already call Node for
  config merges. The server **rejects `X-Review-Token` on every route
  except `/mcp`**: `/review`, `/notify-change`, `/reset`, `/provider`,
  `/status` and `/admin/*` all require a signed request. Instead each
  request carries
  `X-Review-Timestamp`, a random `X-Review-Nonce`, and
  `X-Review-Signature = HMAC-SHA256(key = authToken, method + path +
  sha256(body) + timestamp + nonce + instanceId)`, where `instanceId` is
  the target server instance the caller learned from the challenge
  (below), and sent as `X-Review-Instance`:
  - **The server** accepts a request only if all of these hold:
    - the signature verifies, with the current token or, during a
      rotation grace, the previous one;
    - `instanceId` is **its own**;
    - the timestamp is within ±5 min;
    - the nonce hasn't been seen (in-memory cache, 10 min TTL, which
      covers the whole timestamp window).

    Within one server instance, a relayed request can only ever be the
    same request, once. **Across a restart**, the nonce cache is gone but
    so is the instance: the new one has a fresh `instanceId`, so every
    signature made for the old instance fails, and a captured
    `/admin/reload` or `/reset` can't be replayed after a restart. A
    caller whose request fails with "unknown instance" re-runs the
    challenge, learns the new id, and re-signs, once.
  - **The server signs its response with the same token that verified the
    request**, `X-Review-Response-Signature = HMAC-SHA256(key = <verifying
    token>, request nonce + response status + sha256(response body))`.
    During a rotation grace, a request signed with the previous token gets
    a response signed with the previous token, so a hook still holding it
    (from its cache) can verify the genuine answer. **The caller verifies
    it** before acting on it: a hook on a verdict, a script on a reload or
    reset result. A listener without the token can relay genuine responses
    unchanged, but can't fabricate or alter one, for example to turn
    `ISSUES` into `GOOD_TO_GO`. A response that fails verification is
    treated as a failed request: fail open, with "unverified response
    from <address>" in stderr.
  - The token never leaves the hook, so a relaying or impostor listener
    learns nothing it could reuse. Per-request HMACs over a
    sub-megabyte body cost microseconds.

  **MCP connections stay on `X-Review-Token`.** Claude Code's
  `headersHelper`, Codex's `config.toml` header and opencode's MCP
  registration send a static header their clients control. They connect
  to the address in their own client config, not `server.json`. Their
  exposure to an impostor on the configured port is the same as today:
  a documented residual, out of scope for this plan.

  **Address selection (challenge).** To choose between `server.json`'s
  address and `config.json`'s, a hook still runs the challenge below. It
  decides where to send, while signing is what protects the token and
  the verdict:
  1. The hook picks a random 32-byte nonce and calls the unauthenticated
     `GET /healthz?challenge=<nonce>` at the address.
  2. The server first **refreshes the token from `config.json`**, the same
     read every authenticated request does, including noticing a changed
     token and starting the previous token's grace. Right after a
     rotation, a hook's challenge is often the server's *first* request,
     and must already prove the new token. It then answers
     `{ ok, service, instanceId, proofs }`. `proofs`
     holds `HMAC-SHA256(key = authToken, "review-orchestrator:" + nonce + ":"
     + instanceId)`, plus one keyed by the previous token while a rotation
     grace is running.
  3. The hook computes the same HMAC with the token it holds (from
     `config.json` or its credentials cache) and accepts the address only
     if one of the proofs matches. For `server.json`, `instanceId` must
     also match the file.

  A proof shows the address can reach *a* token holder, which a relay
  could also arrange, so it's used only to **choose** an address. On any
  failure (unreachable, wrong service, bad proof), `server.json` is
  ignored as stale and the hook falls back to `config.json`'s address,
  which must pass the same challenge. Whatever address is chosen,
  requests are signed and responses verified as above, so a wrong choice
  can cost a review but never the token or a forged verdict. It costs one
  loopback round trip and one HMAC: milliseconds.

  An edit to `port` or `bind` in `config.json` therefore can't redirect
  hooks away from the
  running server, whether or not a reload is pending. The hooks use the
  file only after it passes the challenge above. The new values take
  effect on the next restart, which is the only thing that applies them.
  This also fixes today's behaviour, where such an edit breaks hooks
  immediately. It requires a hooks change, picked up via `install.sh`.
- **The hook wait limit comes from the running server too.** Today the
  Stop hook derives its fetch timeout from `config.json` (reviewer timeout
  plus 60 s, or `hook.fetchTimeoutSeconds`). While a reload is pending,
  the file may already hold the *new* settings while reviews still run on
  the old ones. A lowered reviewer timeout would make new hooks give up
  on an old-config review and fail open. So the server publishes
  `hookTimeoutMs` in `server.json`, and the hooks use it whenever the
  file is live:
  - the timeout derived (with today's rules) from the **running**
    config;
  - while a reload is pending, the **larger** of the running and
    candidate configs' timeouts, plus `reload.maxHoldSeconds` for a
    possible hold;
  - capped at the hooks' 29 min maximum.

  The server rewrites it at every swap, every time a reload becomes
  pending or ends, and on dashboard edits. A hook started while a reload
  is pending therefore waits long enough for a review run under either
  config. The swap's hook-timeout check (§5.4 step 8.1) keeps that true
  when `config.json` changes after the reload was prepared: a swap-time
  config needing a longer wait than was published is rejected rather than
  applied. After the swap the published value drops to the new config's,
  and so do the reviews. A hook that read the file just before a change
  and sends just after is caught by the limit handshake (§5.5): it gets
  `HOOK_LIMIT_STALE` with the new limit before any work starts, and
  resends.

| Key | On reload |
|---|---|
| `reviewer.*`, `codex.*`, `limits.*`, `blockingSeverities`, `ignorePaths`, `extraReviewerInstructions`, `payload.*`, `allowedRoots`, `reload.*` (new: `maxWaitMinutes` 5, `maxHoldSeconds` 45 clamped as in §5.5), `auth.previousTokenGraceHours` (new, 24) | Applied live at swap |
| `authToken` | Not a reload setting: read from the file on every request by both server and hooks. Changed via `rotate-token.sh`, with the previous token accepted for `auth.previousTokenGraceHours` (above). |
| `logging.level` | Applied live at swap (`logger.level`) |
| `port`, `bind` | Restart-only: the reload (or the pending swap) is rejected and names the key. Hooks keep using the running server's address from `server.json`. |
| `logging.dir`, `reviewsDir`, `reviewsRetentionDays` | Restart-only: the reload (or the pending swap) is rejected and names the key |

### 5.8 Dashboard (web page)

- **Routes:** `/`, `/inflight`, `/dashboard/*` mutation endpoints and the
  favicon become delegates to the core. After a reload, the next page load
  renders with the new HTML, CSS, inline JS and charts.
- **Host allowlist, on every route (DNS rebinding).** An attacker's domain
  can resolve to `127.0.0.1` (DNS rebinding). The browser then treats
  pages from it as same-origin with the server, so it could load `/`,
  read the embedded CSRF token, and post "same-origin" mutations. So the
  shell rejects, with `421` and before routing, **any** request whose
  `Host` header isn't exactly one of the **allowed hosts**, each with the
  listening port:
  - the loopback names: `127.0.0.1`, `localhost`, `[::1]`;
  - **the client host for the configured `bind`**, from the same
    `clientHostFromBind` rule the hooks use (`hooks/stop-review.mjs`,
    `hooks/notify-change.mjs`). `0.0.0.0` maps to `127.0.0.1`, `::` to
    `[::1]`, and a specific address to itself (bracketed for IPv6). So a
    server bound to, say, `10.0.0.5` accepts `Host: 10.0.0.5:<port>`,
    exactly what its hooks, scripts and MCP clients send.

  A rebinding domain's name is never in that list. That covers `GET /` (where the token is embedded),
  `/inflight`, `/dashboard/*`, `/healthz`, `/mcp` and the signed API
  routes. A rebinding origin arrives with `Host: evil.example:<port>` and
  can't load the page, so it never sees the token. The hooks, scripts and
  MCP clients all connect to `127.0.0.1` or `localhost` and are
  unaffected.
- **"Local" includes the bind address.** Today's `loopbackOnly` guard on
  dashboard actions accepts only loopback remote addresses. A browser on
  the same machine that opens the dashboard through a specific
  non-loopback `bind` address arrives *from* that address, so today it
  can't use any dashboard button in that setup. The guard becomes: the
  remote address is loopback, **or is exactly the address the server is
  listening on**:
  - that address comes from the listening socket itself,
    `server.address().address` after `listen`, **not from DNS**. `bind`
    may be a hostname (the config schema allows it), and a hostname can
    resolve to several addresses, some of which may belong to other
    machines. Node binds to exactly one, and only that one counts. No DNS
    answer is ever trusted as "local";
  - the remote address is normalized before comparing: IPv4-mapped IPv6
    such as `::ffff:10.0.0.5` becomes `10.0.0.5`, and brackets are
    stripped;
  - with a wildcard listen (`0.0.0.0` or `::`), the listening address
    is the wildcard, and only loopback counts;
  - it's fixed for the server's lifetime, like the socket.

  A request from another machine on the network has that machine's
  address and is still rejected. With `bind: 0.0.0.0`, only loopback
  counts, as today. The Host and `Origin` allowlists accept the `bind`
  hostname itself, since that's what clients put in the URL.
- **Cross-site protection for every dashboard action.** The dashboard's
  action routes are local-only but take no token, and a web page from
  any origin can make the browser send a request to `127.0.0.1`. That
  covers the new `/dashboard/reload` (and its rollback and cancel forms)
  and the existing provider, preset, caps, severity and exclusion routes,
  which have the same gap today. Without protection, a malicious page
  could trigger a reload nobody asked for. So every `/dashboard/*`
  mutation requires all three of:
  - **a CSRF token:** a random value per server start, embedded in the
    page, sent back in an `X-Dashboard-Csrf` header. Another origin can't
    read the page (no CORS headers are ever sent), so it can't get the
    token;
  - **a strict origin check:** the request's `Origin`, when present, must
    exactly match `http://<host>:<port>` for one of the **allowed hosts**
    above: the loopback names, plus the client host derived from `bind`.
    So with `bind: 10.0.0.5`, a dashboard loaded from
    `http://10.0.0.5:<port>` can post its own actions. It's checked **even
    when `Sec-Fetch-Site: same-origin` is sent**, because after DNS
    rebinding an attacker's own origin is "same-origin" with itself. A
    mutation with neither a matching `Origin` nor `Sec-Fetch-Site:
    same-origin` is `403`;
  - **a JSON body** (`Content-Type: application/json`), which an HTML form
    can't send, and which a cross-origin `fetch` can only send after a
    preflight the server never approves.

  Explicit triggers stay explicit: the button on the real page, or
  `scripts/reload.sh` with the auth token on `/admin/reload`.
- **No framing (clickjacking).** The checks above stop *requests* from
  other origins, but not a page from another origin that **frames the
  real dashboard** and tricks the user into clicking Reload or Roll
  back. That click comes from the genuine page, with its own CSRF token,
  same-origin. So:
  - every HTML response (`/` and any other page the dashboard serves)
    carries `X-Frame-Options: DENY` and `Content-Security-Policy:
    frame-ancestors 'none'`. Browsers then refuse to render the dashboard
    inside any frame, from any origin, so there's nothing to click on;
  - as a second layer, the page's script checks `window.top ===
    window.self` before enabling any action button, and otherwise shows
    "the dashboard can't be used inside a frame" and leaves them
    disabled.
- **Reload controls:** in the active-config panel, next to the provider
  switcher:
  - **Reload core** posts to `/dashboard/reload` and shows the result:
    applied (from → to, config changes), scheduled, or the error.
  - **Roll back** appears when a previous core is still in memory.
  - **Cancel pending reload** and **Apply now** appear while one is
    waiting. Apply now asks for confirmation ("running reviews will finish
    on the old code") and then swaps without waiting for idle (§5.5,
    decision Q4).
- **Pending state:** while a reload waits, the panel shows "Reload to
  `<id>` pending — waiting for N reviews", lists the running reviews from
  the existing in-flight view, and shows when the starvation guard will
  start holding new reviews ("holding new reviews since …" once it has,
  with how many are held and how many were released at their hold
  deadline).
  The page's existing 2 s poll keeps this current and flips it to
  "applied" when the swap happens.
- **Header:** shell `vX` · core `<id>` loaded `<time>` · `N` reloads, plus
  the last reload error if there is one.
- **Open tabs:** the page already polls `/inflight` every 2 s. That
  response gains `coreVersion`. When it differs from the version embedded
  in the page, a banner says "Dashboard updated to `<id>` — reload page",
  with a button. The page is never refreshed automatically, so nothing
  half-done in a tab gets wiped.
- **Old tab, new server:** a stale tab may post to a newer core's endpoint.
  Mutation requests carry the page's core version. If a contract changed,
  the core rejects it with "page is outdated — reload". Otherwise
  request/response shapes stay backward compatible.

### 5.9 Triggers (explicit only)

- `scripts/reload.sh [--rollback | --cancel | --now] [--wait]`: bash,
  macOS-compatible. It reads the token from config like the other scripts
  and posts to `/admin/reload` through the shared signing client (§5.7):
  a signed request to an address chosen by the challenge, with the
  response verified. It never sends the raw token, and an impostor can't
  feed it a forged "applied". It prints "applied" (from → to, config
  changes), "scheduled — waiting for N reviews", or the error, and exits
  non-zero on failure. With `--wait`, a scheduled reload is polled until
  it's applied, cancelled or fails.
- The dashboard **Reload core** / **Roll back** / **Cancel pending reload**
  / **Apply now** buttons. `--now` and Apply now are the only ways a swap
  happens while reviews run (§5.5).
- Nothing else: no file watcher, no SIGHUP handler, no reload on install.

### 5.10 Observability

- `GET /healthz` → `{ ok, shellVersion, coreVersion, reloadPending }`.
- `/status` adds the core version, load time, previous version, any pending
  reload (target id, requested at, reviews waited on, holding since, held
  now, released at deadline), and
  the reload history (last 20: requested at, applied at, from, to, ok,
  error, config keys changed, how long it waited).
- Archive records gain `coreVersion`, so reviews before and after a fix can
  be compared.
- Logs: `core reloaded` / `core reload failed` / `core rolled back`, with
  details.

## 6. What still needs a restart

- Shell code: startup, HTTP, auth, logging, MCP transport and session
  handling, state store, archive, metrics.
- A core↔shell contract change (`CORE_API` bump).
- Dependency upgrades (`node_modules`) and Node upgrades.
- Restart-only config keys (§5.7).
- MCP tool name, description or schema changes (open sessions need a
  reconnect regardless).
- The hooks and the opencode plugin aren't server code. They're separate
  scripts installed by `install.sh` and pick up changes on their next run
  after a reinstall.

## 7. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Memory grows with each reload (an old module graph is never freed) | Phase 0 measures it, expected a few MB per reload. The dashboard and `/status` show the reload count, and a restart clears it. Option B is the long-term fix if it ever matters. |
| A new core passes its self-check but fails on real requests | Per-request errors already map to 500 / `ESCALATE`. One-click manual rollback; no automatic rollback (decision Q2). |
| A pending reload never applies because reviews keep overlapping | Starvation guard (§5.5): after `reload.maxWaitMinutes` (5 min), new review requests are held so the admitted work can drain. It doesn't guarantee progress under sustained load: the dashboard shows the stuck state, and the operator can cancel, use the "apply now" override if adopted, or restart. |
| Held requests outlast the Stop hook's fetch timeout and fail open | Every held request has its own `reload.maxHoldSeconds` deadline (default 45 s, inside the hook's 60 s margin; clamped when `hook.fetchTimeoutSeconds` is pinned). It's then released onto the current core. Holding is never what times a hook out, even when same-context queues make the drain span several reviewer timeouts. |
| Held requests stranded when a reload ends without a swap | Cancel, a cancelling trigger matching the running state, or a swap-time rejection releases every held request onto the still-current core, in arrival order. A failed *replacement* doesn't end the pending reload, so its held requests keep waiting for it (§5.4 step 2, §5.5). |
| Rollback target unusable because its resources were removed | Disposal only happens once a core is neither current nor previous (§5.4); the rollback target keeps its schema file. |
| macOS temp cleanup deletes a core's Codex schema file during a long uptime | Checked before every Codex run and rewritten from the core's captured bytes (§5.3). |
| A review fixed by the new code still runs on the old code while the reload waits | Expected with idle-only swaps. The dashboard shows what's being waited on, and **apply now** swaps on request (decision Q4). |
| State written by one retained core can't be read by the other (after a swap, or after a rollback) | `STATE_FORMAT` must match for swap and rollback, and persisted changes within a format are additive only, readable in both directions. A non-additive change bumps the format and needs a restart (§5.5). |
| A review request is still in async set-up (context resolution, MCP roots check) when idleness is decided | Admission at entry, before any `await` (§5.5): such a request already counts as active and is pinned. |
| A data file (output schema) edited on disk changes a running or rolled-back core | Non-JS resources are read into each core at load and hashed into its version (§5.3). |
| Rollback leaves the reload's config in place (config-only reload, or a valid but bad value) | Rollback restores key by key from `previous = { core, before, applied }`. Keys the reload changed and nobody edited since go back to `before`, and later edits are kept. The result is checked with the previous core's schema and written back to `config.json` atomically with a backup (§5.4). |
| An adapter reads a deleted snapshot folder | The schema is held in memory per core. No adapter reads the snapshot at request time, and Codex's file is recreated from memory before each run (§5.3). |
| An async dashboard mutation commits stale settings across a swap | `configTransaction`: mutations, swap config steps and rollbacks are serialized. Mutations are deltas applied at commit to the current config, validated with the current schema, with a revision counter (§5.5). |
| A review admitted on the old core while the swap waits for the config lock | The swap gate covers every swap that starts at idle: when the last release reaches zero, and when preparation finishes with the count already zero. Admission closes in that same synchronous step, before the lock wait (§5.4 step 7, §5.5). |
| A replace or cancel trigger lands while a gated swap waits for the config lock | The gated swap captures and freezes the candidate. Reload triggers wait for the gate to reopen, then act on the resulting state (§5.5). |
| A core module imports a source-tree file outside the snapshot, so code changes without a new version id | The snapshot builder checks import containment on every file. Only package imports, and relative imports that resolve inside `server/src/core/`, are allowed; absolute paths, `file:`, `#` aliases, self-package and dynamic `import()` fail the reload (§5.3 step 3a). |
| A core module loads code outside the snapshot through `createRequire`, `vm`, `eval`, `Function`, workers, or running `node` (via `process.execPath`, by name, or by path) | The AST check rejects those loaders and any `child_process` import. Processes run only through the shell's async `spawnTool` / `execTool`: a tool-name allowlist (`git`, the configured reviewers) that refuses Node executables. The guarantee targets accidental drift (§5.3 step 3a). |
| A stalled git command blocks the event loop, so deadlines, admission releases and reloads stop | All request-path git is async through `execTool`, with `limits.gitTimeoutSeconds`. A timeout fails only that request, as an uncached `GIT_TIMEOUT` (§5.3 step 3a, Phase 1). |
| Non-review routes (`/reset`, `/notify-change`, `reset_review_context`) can't run git under the capability check | `git` needs only a pinned core; only the reviewer tools need a review-admission config (§5.3 step 3a). |
| The shell's idle reset drops a field a newer core persisted, breaking the additive-state rule | `idleResetContext` spreads the existing context and clears only the loop counters. The round-trip test includes an idle reset (§5.5, Phase 1). |
| A rejected candidate changes the running server during preparation | Two-phase init: `createCore(staging)` gets only frozen, read-only inputs; `attach(live)` happens only at the swap. Imports are side-effect-free (tested), and every rejected candidate is disposed (§5.2). |
| `attach` fails partway and leaves live state altered | `attach` is a pure reference assignment, done before the current core or config changes. A throw aborts the swap with nothing live altered (§5.2, §5.4 step 8.3). |
| A `reset_review_context` awaiting MCP roots runs on a disposed core | Every non-review route and MCP callback pins its core at entry and releases it in `finally`; disposal waits for the pin count (§5.6). |
| During a rotation grace, a hook on the previous token rejects a genuine response | Responses are signed with the token that verified the request (§5.7). |
| The first request after a rotation is a hook's `/healthz` challenge, and the server proves only the old token | Challenges refresh the token from `config.json` (and start the grace) before computing proofs, like authenticated requests (§5.7). |
| A dashboard save writes back an old `authToken` or erases an unapplied manual edit | Deltas are merged into a fresh read of `config.json` inside the transaction. Only the delta reaches the file and the holder, and a same-key conflict is reported (§5.5). |
| `rotate-token.sh` or a manual edit lands between a transaction's read and its rename | Writers that take the lock never lose a write, and their changes are recoverable from the rotating backup (both strict). An editor save is protected and recoverable best effort only: one landing between the re-check and the rename is neither detected nor backed up (§5.7). |
| A request that spent its budget held passes the handshake with too little time left, or every ordinary request fails it | The handshake compares `timeoutMs − elapsed` with the pinned config's hook limit, with a 2 s tolerance; the 5 s response margin applies to the deadline only. Unchanged-config requests at admission always pass, and held time counts (§5.5). |
| A snapshot folder edited or partly restored between loads gets imported under a validated id | Every load writes a fresh `<id>-<nonce>` folder and never reuses one. Files are re-verified against the captured bytes after import, and a mismatch rejects the candidate (§5.3). |
| Two writers overlap through stale-lock recovery (two waiters both break a dead owner's lock), or a live owner's lock is broken | The lock is an OS lock (`O_EXLOCK` on macOS), released by the kernel when its owner exits. There's no stale-lock recovery, so it can't race. Waiters time out with an error instead of writing (§5.7). |
| A paused hook writes an old token back into the credentials cache | Hooks never write the cache. Only config writers do, under the config lock, from a config read inside it (§5.7). |
| Caller guidance and reuse | `extrasHash` sits beside `reviewKey`. Joining a running review needs an exact match. For the cache, a request with extras needs an exact match; a request without extras (Stop hooks) also accepts a *passing* baseline reached with extras (decision Q8), but not `ISSUES`, no-progress or `CODEX_ERROR_CACHED` from other extras (§5.5). |
| A reviewer timeout raised by less than `maxHoldSeconds` slips past the swap check | The swap check compares base limits on both sides, with no hold allowance (§5.4 step 8.1). |
| A stale `server.json`, or a port taken over by another process, gets the hook's token or forges a verdict, including by relaying to the real server | End-of-turn requests are HMAC-signed (timestamp, nonce, body hash) and never carry the token. Responses are HMAC-signed and verified by the hook, and nonces aren't replayable. The `/healthz` challenge only picks an address. MCP clients' static `X-Review-Token` headers are a documented residual (§5.7). |
| A script (`reload.sh`, `replay-review.sh`, …) sends the raw token to an impostor, or accepts a forged result | Every non-MCP route requires signed requests, and raw `X-Review-Token` is accepted only on `/mcp`. All scripts use the shared signing client, with challenge-based address selection and response verification (§5.7). |
| A combined code and config reload validates or initializes the new core with stale settings | `validateConfig` is a static export used before `createCore`. `createCore(staging)` takes no config, and `selfCheck(config)` receives the validated candidate config (§5.2, §5.4 steps 3–6). |
| Schema-valid settings that fail the self-check go live (config-only reload, a swap-time config differing from the prepared one, a rollback, a dashboard edit) | The pure, fast `selfCheck(config)` runs on every config about to go live: at preparation for every candidate, again under the swap gate on the exact swap-time config, before a rollback's restore, and in each config transaction (§5.2). |
| A cross-site or DNS-rebinding page triggers a reload, rollback or other dashboard action | A Host allowlist on every route (`127.0.0.1` / `localhost` / `[::1]` plus the port, else `421`) blocks rebinding origins from loading the page and its CSRF token. Mutations also need the CSRF token, an `Origin` matching the fixed allowlist whenever present (even with `Sec-Fetch-Site: same-origin`), and a JSON body (§5.8). |
| A page frames the dashboard and tricks a click on Reload / Roll back (clickjacking) | `X-Frame-Options: DENY` and `frame-ancestors 'none'` on every HTML response; action buttons stay disabled when the page is framed (§5.8). |
| The Host allowlist rejects a server bound to a specific non-loopback address | Allowed hosts include the client host derived from `bind`, with the same `clientHostFromBind` rule the hooks use (§5.8). |
| A previous token stays accepted long after its rotation, because the server was idle or missed an intermediate rotation (A→B→C seen as A→C) | `auth.rotations` keeps a history with `previousTokenHash`. A predecessor's grace comes only from the record that rotated it out, expires at that record's `at` + the grace length, and is void if any later record is `"none"`. All of this is checked before verification (§5.7). |
| With a non-loopback `bind`, dashboard buttons can't work (Origin outside the allowlist, loopback-only guard) | The Origin allowlist uses the same allowed hosts as the Host check (loopback names plus the `bind`-derived host). "Local" means loopback or the configured `bind` address (§5.8). |
| A captured signed request is replayed after a restart clears the nonce cache | Signatures cover the target `instanceId`, which changes on every restart, so pre-restart signatures fail (§5.7). |
| A hostname `bind` never equals the remote IP (breaking dashboard actions), or resolving it admits another machine's address as local | "Local" is loopback or exactly the socket's own listening address (`server.address()`), never a DNS answer. Remote IPs are normalized (IPv4-mapped) before comparing (§5.8). |
| `--revoke-now` can't confirm revocation (an old-token probe can't pick an address) | Confirmation uses a new-token-signed `GET /status`, which reports `currentTokenHash` and `previousTokenGrace` (§5.7). |
| A restart with changed shell code reuses verdicts from the previous shell | `reviewKey` includes `shellVersion`, a hash of the shell's source (§5.5). |
| A dashboard edit mid-review changes which reviewer executable the review runs | `spawnTool` resolves binaries from the request's pinned config (verified as shell-issued), never the live one, keeping the allowlist and Node refusal (§5.3 step 3a). |
| A fresh install or deleted cache leaves no fallback while `config.json` is broken | `install.sh` seeds `hook-credentials.json`, and the server refreshes it at startup, at swaps, on token changes and after config transactions. The remaining case is reported, and requirement 8 says exactly that (§5.7). |
| Codex gets a schema file edited or corrupted on disk | Before every run the file's sha256 is compared with the in-memory strict schema, and it's rewritten atomically on any mismatch (§5.3). |
| Rollback overwrites a manual edit to `config.json` that wasn't applied yet | Rollback compares the fresh file too. A key with `file ≠ applied` is left as is and reported, and the write-back merges only reverted keys into the fresh read (§5.4). |
| Codex's schema can't be rewritten after its folder is deleted | It lives in `~/.cache/review-orchestrator/codex-schemas/`, and the adapter runs `mkdir -p` before rewriting it from memory (§5.3). |
| A config-only edit is ignored because the code hash didn't change | Reload compares code *and* config; either change makes it a real reload (§5.4). |
| Loading files that are mid-edit, or a hash that doesn't match what loaded | Content-addressed snapshot (§5.3): bytes are read once, hashed, re-checked for changes during the read (retry, then reject), written to an immutable folder, and imported only from there. |
| Token or address drift between hooks and server | `authToken` is read from the file on every request by both sides, outside reloads. Hooks get the live address from `server.json`, not from `config.json` (§5.7). |
| A token change cuts off Codex / opencode MCP sessions that have the old token written into their config | Rotation via `rotate-token.sh`: the previous token is accepted for `auth.previousTokenGraceHours`, the Codex `config.toml` is rewritten, and the clients to restart are listed. `--revoke-now` drops the grace deliberately. The opencode plugin's own end-of-turn requests read the token per request, so only static MCP tool connections are affected after the grace, and only until restart (§5.7). |
| A held hook gets `DEADLINE_EXCEEDED` because `config.json` raised the reviewer timeout after the reload was prepared | The swap's hook-timeout check rejects a swap-time config needing a longer wait than was published. Held requests run on the current config, and triggering again republishes the limit (§5.4 step 8.1). |
| A hook reads the old `hookTimeoutMs`, then a swap or dashboard edit raises the needed limit before its request arrives | Limit handshake when the request is pinned: `timeoutMs` below the pinned config's required limit gets an immediate `409 HOOK_LIMIT_STALE` with the new limit, and the hook restarts its timer and resends, up to 2 retries (§5.5). |
| A hook gives up on a review that's still running under the old config | The hooks wait as long as the published `hookTimeoutMs`: the larger of the running and pending configs' timeouts, plus the hold allowance (§5.7). |
| A review sees settings change halfway (dashboard edit or swap) | Config is pinned per admitted review (§5.5). |
| A request joins a running review that runs with different settings, guidance or core | The duplicate key includes `reviewKey` (effective provider, effective config with the project file resolved before matching, `reviewVersion`, `shellVersion`), the exact `extrasHash` and the core version. A mismatch queues on the per-context chain instead of joining (§5.5). |
| A cache shortcut reuses a verdict reached with different settings (for example `codex.reasoningEffort`), another provider, an older output schema, or older review code | Every persisted cache shortcut requires `lastBaseline.reviewKey` to match. `reviewKey` covers the effective provider (including a per-call override), the full effective config, `reviewVersion` (review-path code *and* `core/review/` resources such as the output schema) and `shellVersion`. `reviewConfigHash` no longer gates the cache (§5.5). |
| A malformed replacement trigger discards a validated pending reload | A replacement that fails to prepare leaves the pending candidate and held requests untouched (§5.4 step 2). |
| A token change goes unnoticed by the server | The token is read from the file on every authenticated request; no timestamp cache (§5.7). |
| A hook catches `config.json` half-written and skips the review | Atomic writes by every program that writes the file, 3 read retries over about 1 s, then the last-known-good `hook-credentials.json` (0600). A remaining failure is reported in stderr (§5.7). |
| `--revoke-now` leaves a leaked token in grace (a failed second call, or a server that missed an intermediate rotation), or sends the new token to an impostor | Revocation is a durable `"none"` record in `auth.rotations`, written atomically with the new token. A predecessor rotated out by, or before, any `"none"` record gets no grace, whichever rotations the server saw. No HTTP call carries a raw token (§5.7). |
| The core loads resource bytes that differ from the verified snapshot | Resources are passed into `createCore` as the captured, hashed bytes (`staging.resources`), never read from the folder (§5.3). |
| A dashboard edit commits a holder state that was never self-checked (the file has unapplied manual edits) | Both the merged file and the live result (holder plus delta) are validated and self-checked. The holder gets exactly the checked live result (§5.5). |
| Handshake retries and holds outlast the 30 min harness | One overall hook deadline (start + 29 min). Each attempt waits `min(limit, remaining)`, and the hook marks its third outgoing attempt (or an earlier one, when the budget is short) `finalAttempt` (§5.5). |
| A request outlives the Stop hook while held, queued behind same-context reviews, joined to a slow review, or running its own | Request deadlines race every wait. At the deadline the hook gets a silent, uncached `DEADLINE_EXCEEDED`. Not-yet-started work is abandoned, and started reviews finish in the background and cache their result, with their configured timeout never shortened (§5.5). |
| Waiting edits overwritten at swap | The swap applies the config read at swap time, not the prepare-time copy, and reports keys where the live value differed (§5.4 step 8). |
| A core disposed under a still-running non-review request | Per-core pin counts cover every request; disposal and snapshot deletion wait for zero (§5.4 step 8.4). |
| Cancelling or replacing a config-only reload disposes the running core | Disposal is by reference: a config-only candidate shares the running instance, which stays referenced as current. Only distinct, unreferenced instances with pin count zero are disposed (§5.4 step 8.4). |
| A wiring change in `createCore` reuses old cached verdicts | `reviewVersion` includes the composition root `core/index.js` (§5.3 step 2). |
| No-op and config-only reloads leave orphan snapshot folders | The hash is computed before writing, and a match with the running core writes no snapshot. A failed candidate's snapshot is deleted at once (§5.4 step 3). |
| A file revert after scheduling leaves the old pending reload armed | A trigger matching the running core and config cancels the pending reload (§5.4 step 5). |
| A pending reload never completes under sustained load | Idle-only by default (requirement 2): always visible and cancellable. The starvation guard holds new reviews after 5 min (decision Q3), and **apply now** completes it on request (decision Q4). Nothing forces it automatically. |
| Module-level state inside the core silently splits between versions | Audit (done): only the `review.js` in-flight maps need sharing, and they move to the shell. The validator caches in `codex.js` / `claude.js` / `gemini.js` are fine per version. A test asserts the core has no module-level mutable state beyond caches. |
| Timers or listeners started by a core | None today. `dispose()` is the hook for any future ones. |
| Reload endpoint abuse | `/admin/reload` needs the auth token. The dashboard route is loopback-only, like the other dashboard actions. |
| Snapshot folders picked up by tooling or left behind | `.core-versions/` is gitignored and ignored by Prettier, ESLint and Jest. Unselectable snapshots are deleted, stale ones are cleared at startup, and snapshots are created only by the real entry point, never in Jest. |

## 8. Implementation phases

| Phase | Work | Size |
|---|---|---|
| 0. Spike | On the launchd Node 24: importing from `server/.core-versions/<id>/` gives a fresh graph, and package imports resolve to the repo's `node_modules`. Measure memory over 20 reloads. Record Claude Code's MCP behaviour after a restart (the status quo). | S |
| 1. Shell-owned maps and state | Move `inflight`, `contextChains` and `inflightMeta` out of `review.js` module scope into a shell `registries` object injected via `deps` (already supported). Fix `idleResetContext` to spread the existing context and clear only the loop counters, so it stops dropping fields it doesn't name. Add async `spawnTool` / `execTool` as shell capabilities (tool-name allowlist; `git` from `PATH` for any pinned request; reviewer binaries from the caller's shell-issued pinned config; Node executables refused). Make every request-path git call async with `limits.gitTimeoutSeconds` (default 30): `resolveContext`, `buildPayload`, `isWorkingTreeClean`, `currentHeadSha` and `resolveFallbackBase` become `async`, and route the adapters' and `diff.js`'s process calls through them. Otherwise no behaviour change. | S–M |
| 2. Core boundary | Static module exports `CORE_API`, `STATE_FORMAT` and `validateConfig`; `createCore(staging)` takes no config and `selfCheck(config)` gets the validated candidate. Add `STATE_FORMAT` to the core contract (swap and rollback only within a format; changes additive). Create `server/src/core/` and two-phase `createCore(staging)` / `attach(live)`, with side-effect-free module top levels, and `git mv` the core modules (mechanical). A review entry module, `core/review/index.js`, exports the pipeline and the MCP review handler; its import closure defines `reviewVersion`, so UI modules must not be imported by it. Routes in `index.js` and MCP tool callbacks become delegates through `currentCore()`. Non-JS resources are read into the core instance at load: `claude.js` / `codex.js` take schema bytes and paths from the instance instead of reading the source tree per call. Startup loads core v1 through the same loader path a reload uses. | L |
| 3. Reload controller | Snapshot store (read once, hash, re-check, code containment checked on every file with an `acorn` AST (static imports, plus `require`/`createRequire`, `vm`, `worker_threads`, `eval`, `Function`, `import.meta.resolve`, `process.execPath`), a fresh `<id>-<nonce>` folder per load written atomically and never reused, post-import byte verification, a matching ESLint rule, cleanup, tooling ignores), contract check, self-check. Review admission (`admitReview` at entry of `/review` and MCP `request_review`, before any `await`) with config pinning. Per-core pin counts for every request. Project config loaded before duplicate matching. Duplicate key extended with the effective-config fingerprint (global plus `.review-orchestrator.json`), the caller's `extra_instructions` hash and the pinned core version. `extrasHash` beside `reviewKey` (exact for joining and for requests with extras; Stop hooks also accept a pass reached with extras), `reviewKey` (effective provider including per-call override, effective config, `reviewVersion` from the review entry's import closure plus non-JS files under `core/review/` with the output schema moved there, and `shellVersion`; **no caller extras**) is stored as `lastBaseline.reviewKey` and required by every cache shortcut, replacing `reviewConfigHash` as the cache gate. Limit handshake (remaining budget vs `requiredMs` of the pinned config, at admission and at dispatch from the hold or the swap gate, `409 HOOK_LIMIT_STALE`, retries in the shared hook client code under one overall deadline of start + 29 min, each attempt capped to the remaining budget, `finalAttempt` on the third outgoing attempt, or earlier when the budget is short). Request deadlines (`timeoutMs` from the Stop hook, raced against the hold, chain, join and own pipeline; silent uncached `DEADLINE_EXCEEDED`; not-started work abandoned; started reviews finish in the background, admission released at pipeline end). Scheduling: the idle decision on the admission counter, pending/replace/cancel, the starvation guard with its hold-at-entry queue (per-request `maxHoldSeconds` deadline, and release onto the current core when a reload ends without a swap), a swap gate for every swap that starts at idle (admission closed, candidate frozen, config lock taken, swap, waiting requests and deferred reload triggers handled against the resulting state). Dispose only the core that drops out of current and previous, and only once its pin count is zero. The swap applies the config read at swap time, after the restart-only and hook-timeout checks. Codex schema file checked and rewritten before every run. `selfCheck(config)` (pure, synchronous) on every config about to go live: at preparation for every candidate, at the swap on the swap-time config, before a rollback's restore, and in config transactions. Rollback from `previous = { core, before, applied }` with a per-key restore comparing before, applied, live and file, a previous-schema check, and a write-back merging only reverted keys into a fresh file read (with backup). `configTransaction` (serialized deltas merged into a fresh `config.json` read, with both the merged file and the live result validated and self-checked, file-owned keys preserved, same-key conflicts reported, revision counter) used by dashboard mutations, the swap and rollback. Schema bytes held in memory per core for every adapter. Codex strict schema in `~/.cache/review-orchestrator/codex-schemas/<id>-<nonce>.json`, hash-checked before every run and rewritten atomically (with `mkdir -p`) when missing or different. **Apply now** (`reload.sh --now`, dashboard button) through the swap gate and every swap-time check, with running reviews finishing on the old core. `/admin/reload`, `scripts/reload.sh` (`--wait`/`--cancel`/`--rollback`), `/healthz` / `/status` fields, `coreVersion` in the archive. | M–L |
| 4. Config reload and hook connection | Config-only reloads (code unchanged). Re-read, validate and apply in place at swap. Config pinned per admitted review. Restart-only comparison against start-up values, at prepare time and again at swap. The auth check reads `authToken` from the file on every authenticated request, with the previous-token grace, plus `scripts/rotate-token.sh` (every rotation appends `{ tokenHash, previousTokenHash, grace, at }` to `auth.rotations` (last 10) atomically with the new token. The server grants a predecessor grace only from the record that rotated it out, expiring at its `at` + the grace length, and only if no later record is `"none"`. No HTTP revocation call). All programmatic `config.json` writes go atomic (temp + rename, 0600), under the shared `config.json.lock` (`install/config-lock.mjs`: an `O_EXLOCK` OS lock released by the kernel on owner exit, no stale recovery, 10 s wait timeout) with a content-hash re-check before the rename. `server.json` gains `instanceId`, and `/healthz?challenge=` answers with HMAC proofs keyed by the current and grace tokens. Hooks use it only to pick an address. All non-MCP requests (hooks, plugin, every script) are HMAC-signed through the shared `install/signed-client.mjs` (`X-Review-Timestamp`, `X-Review-Nonce`, `X-Review-Instance`, `X-Review-Signature` covering the target `instanceId`, server nonce cache) instead of carrying `X-Review-Token`, which the server accepts only on `/mcp`; and responses carry `X-Review-Response-Signature`, which the hooks verify. Every config write keeps a rotating backup. `hook-credentials.json` is written only by config writers (`install.sh`, `rotate-token.sh`, the server), under the config lock, from a read inside it. Hooks only read it. Hooks retry unparseable reads and fall back to `hook-credentials.json`. `server.json` carries the live address and `hookTimeoutMs`, rewritten on swap, pending changes and dashboard edits. The Stop hook, notify-change hook and opencode plugin prefer it over `config.json`. The opencode plugin's own `/review` and `/notify-change` calls read the token (and `server.json`) per request instead of once at load (reinstall via `install.sh`). Logger level from the holder. | M |
| 5. Dashboard | A Host allowlist on every route (loopback names plus the `bind`-derived client host; `421` otherwise), the same set for `Origin`, anti-framing headers (`X-Frame-Options: DENY`, `frame-ancestors 'none'`) plus a framed-page guard, and the local guard widened to loopback or exactly the socket's listening address (`server.address()`, never DNS; IPv4-mapped normalized), and CSRF protection for every `/dashboard/*` mutation: per-server token header, `Origin` checked against the fixed allowlist whenever present, `Sec-Fetch-Site`, JSON body. This covers the existing actions too. Reload / Roll back buttons and result display, version in the header, stale-tab banner from the poll, version on mutation requests. | S–M |
| 6. Docs and tests | README section, the state compatibility rule and the "needs a restart" list in `CLAUDE.md` / `AGENTS.md`, the tests in §9, version bump. | M |

Phases 1 and 2 are refactors with no behaviour change and can merge on
their own. Phase 3 is the first one you'd notice.

## 9. Test plan

**Unit**
- Reload controller:
  - unchanged code and unchanged config is a no-op;
  - a config-only edit (same core hash) is applied as a reload;
  - an import error keeps the current core;
  - a contract mismatch is rejected;
  - a self-check failure is rejected;
  - success with nothing running swaps immediately;
  - with reviews running it's scheduled, and swaps the moment the last one
    finishes, before the next request is dispatched;
  - a second trigger while pending replaces the candidate;
  - cancel drops it;
  - a config change that turns invalid before the swap cancels it;
  - a `port` / `bind` edit made while a reload waits cancels it at the swap;
  - rollback follows the same idle rule;
  - rollback after a **config-only** reload:
    - keys the reload changed go back to their pre-reload values, in
      memory and in `config.json` (with a backup);
    - a key edited on the dashboard after the reload keeps its new value;
    - `authToken` is untouched;
  - rollback after a code reload whose config added a key the old schema
    rejects: that key reverts and is listed;
  - a rollback of a rollback re-applies the reload by the same rule;
  - rollback with an unapplied manual edit to a key the reload changed
    (`file ≠ applied`, `live = applied`): the key is left in memory and in
    the file, and reported. Other reverted keys are written into the fresh
    file read, and `authToken` and other on-disk keys are preserved;
  - a trigger while one is being prepared gets `409`;
  - a pending **config-only** reload (candidate = running core) that's
    cancelled, or replaced by another config-only or code reload: the
    running core is never disposed and keeps serving. A replaced
    *distinct* candidate core is disposed once unreferenced and unpinned;
  - repeated no-op and config-only reloads write no snapshot folders. A
    candidate failing its contract or self-check leaves no folder behind;
  - raising the reviewer timeout by less than `maxHoldSeconds` after
    preparation is still rejected at the swap;
  - with B validated and pending, a second trigger whose code fails to
    load (or whose config is invalid) reports the failure. B stays
    pending, and held requests stay held. B still applies at idle;
  - B pending with a request held, then `config.json` raises the reviewer
    timeout before idle: the swap is rejected with "reviewer timeout raised
    after the reload was prepared". The held request runs on the current
    config and answers within its hook's limit. Triggering again
    publishes the larger `hookTimeoutMs`. Lowering the timeout instead
    swaps normally;
  - A running, B pending, files reverted to A, then trigger: B is
    cancelled and disposed, held requests are released onto A, and the
    response has `cancelledPending: B`. Same with code unchanged but a
    pending config-only reload reverted.
- Admission: an MCP `request_review` parked in its roots check (fake
  client that delays `roots/list`) keeps the server non-idle. A reload
  requested meanwhile stays pending until that call finishes, and the call
  runs entirely on the old core.
- Starvation guard:
  - after `maxWaitMinutes`, new review requests are held at entry,
    unpinned and uncounted;
  - on swap, they are dispatched to the new core from the start, in
    arrival order;
  - a held request reaching `maxHoldSeconds` is released onto the current
    core and counted as active;
  - the hold is clamped when `hook.fetchTimeoutSeconds` is pinned;
  - cancel, or a swap-time rejection, releases all held requests onto the
    current core, in order;
  - a **failed replacement** (its code or config fails to prepare) leaves
    the validated pending reload in place, and held requests stay held
    until it swaps or ends.
- Dispose:
  - a swap disposes only the core that drops out of current and previous,
    and a rollback disposes nothing;
  - after a reload then a rollback, a Codex run on the restored core finds
    its schema file;
  - a dropped-out core with an async dashboard mutation still pinned to it
    isn't disposed, nor its snapshot deleted, until that mutation
    finishes.
- Swap gate vs reload triggers: while a gated swap waits for the config
  lock (injected delay):
  - a replacement trigger waits, then becomes a new reload against the
    swapped-in core;
  - a cancel trigger waits, then reports "already applied";
  - the swap applies exactly the candidate captured at gate time, and
    never disposes it mid-swap.
- Swap gate, immediate case: a reload finishes preparing with zero
  active reviews while a dashboard mutation holds the config lock. A
  review request arriving during the lock wait waits at entry, and runs
  on the new core after the swap. Rollback at idle behaves the same.
- Swap gate: with a dashboard mutation holding the config lock (injected
  delay) when the last review releases:
  - a review request arriving meanwhile waits at entry, uncounted;
  - the swap completes after the mutation;
  - the waiting request then runs on the new core;
  - if the swap is rejected at that point, the waiting request runs on
    the current core and the pending reload is cancelled.
- Config transactions:
  - after `rotate-token.sh` changes `authToken`, a dashboard save keeps
    the new token on disk;
  - an unapplied manual edit to another key survives a dashboard save;
  - a manual edit to the *same* key is replaced and reported;
  - an unparseable `config.json` makes the mutation fail without writing;
  - `rotate-token.sh` running between a dashboard transaction's read and
    its rename (injected delay) waits for the lock. The token it writes
    survives, and the dashboard change is applied on top;
  - a manual edit (no lock) landing before the re-check fails it. The
    transaction redoes its merge on the edited content, keeping the
    edit, and fails after 3 conflicting attempts;
  - every config write leaves a `config.json.bak-<ts>` (0600), keeping
    the last 10, holding the file as read under the lock;
  - a manual edit forced into the re-check-to-rename window (injected) is
    overwritten and isn't in any backup. That documents the best-effort
    limit; nothing claims otherwise;
  - lock semantics, in child processes:
    - a second writer gets `EAGAIN` while the first holds the `O_EXLOCK`;
    - after `kill -9` of the holder, the next writer gets the lock at once,
      with no stale-file handling;
    - three writers racing never overlap (each appends to a shared log
      while holding the lock, and the log shows no interleaving);
    - a live, paused holder (`SIGSTOP`) makes waiters time out after 10 s
      without writing;
  - a dashboard mutation that started before an idle swap and commits
    after it lands on top of the new config, validated by the new schema;
  - if that schema rejects it, it fails with "config changed, reload the
    page" and writes nothing;
  - a swap waits for an in-progress mutation and vice versa (two
    interleaved async mutations around a swap, with injected delays);
  - the revision increases on every commit.
- Swap config: a dashboard edit and a manual file edit made while a reload
  waits are both in effect after the swap. A live value that differed from
  the file (failed save) is listed in the swap result.
- Snapshot folder deleted while its core is current: Claude, Gemini and
  Codex reviews all keep working. Claude and Gemini use the in-memory
  schema, and Codex's strict file lives outside the snapshot.
- `codex-schemas/` folder deleted: the next Codex run recreates the folder
  and the file from memory, with no `ENOENT`.
- Schema file present but edited or truncated: the next Codex run detects
  the hash mismatch and rewrites it atomically before invoking Codex.
- Resources: a core keeps the schema bytes it loaded with. Editing the
  JSON on disk afterwards changes neither its reviewer arguments nor a
  rolled-back core's, and the edit gives a new version id.
- Config reload: valid changes are applied, invalid config is rejected,
  and restart-only keys are reported.
- Shared maps: requests admitted on the same core join or queue behind
  each other as today, including across the moment a reload becomes
  pending.
- Pinning: a non-review request that started before a swap finishes on
  its original core.

**Integration** (real HTTP server, fake reviewer, never `codex`)
1. Start the server and begin a slow `/review` (the fake reviewer waits on
   a promise).
2. Trigger a reload to a fixture core variant with a different version
   string. It reports "scheduled", and `/healthz` shows it pending.
3. Release the review: it completes and archives with the old version, and
   the swap follows immediately.
4. A new `/review` then runs on the new core.
5. The same flow with `maxWaitMinutes` (default 5) set tiny: a second `/review` arriving
   during the wait is held, then runs on the new core after the swap.
6. MCP: open a session, reload, then call `request_review` with the same
   `Mcp-Session-Id`. It succeeds on the new core with no re-initialize.
7. Dashboard: `GET /` renders the new version. The `/inflight` poll reports
   the pending state, then the change.

**Snapshots**
- Import containment: a core file that imports
  `../../src/state.js`, an absolute path, a `file:` URL, a `#internal`
  alias, the package's own name, or uses dynamic `import()`, fails the
  reload. The error names the file and specifier. A transitive case is
  caught too: core A imports core B, which reaches outside.
- Bare package imports and relative imports inside `core/` load fine.
- `STATE_FORMAT`: a candidate with a different format is rejected with
  "needs a restart". Within a format, state written by fixture core B
  (with an added top-level field) is read correctly by fixture core A
  after a rollback, and A's state is read by B. The added field survives
  an idle reset in between (the `idleResetContext` fix), and A's own
  saves keep it.
- A core file using `createRequire`, `require`, `vm`, `worker_threads`,
  `eval`, `new Function`, `import.meta.resolve`, `process.execPath` or a
  `child_process` import fails the reload, naming the file and the
  construct.
- `/reset`, `/notify-change` and MCP `reset_review_context` run git through
  `execTool` with only a pinned core, and succeed. A reviewer tool called
  without a shell-issued config is refused.
- A stalled git (a fake git that sleeps) in one request's
  `resolveContext`:
  - another request reaches its deadline and gets `DEADLINE_EXCEEDED` on
    time;
  - a dashboard request and a pending reload's swap proceed;
  - the stalled request fails with `GIT_TIMEOUT` after
    `gitTimeoutSeconds`, and its child is killed.
- `spawnTool` resolves a reviewer binary from the caller's pinned config:
  changing `codex.binary` on the dashboard while a review waits on the
  context chain doesn't change the binary that review runs. The next
  admitted review uses the new one. A config object the shell didn't
  issue is rejected.
- `spawnTool` runs only the allowlisted tool names. It refuses `node`,
  `nodejs` and `process.execPath`, also when a reviewer binary in config
  points at one, and refuses unknown names.
- Importing a fresh core snapshot creates no timers, listeners or handles,
  and writes nothing.
- A config transaction where the file has an unapplied manual edit, and
  the delta plus that edit pass while holder plus delta fails the
  self-check (or the reverse): the mutation fails, nothing is written,
  and the holder is unchanged.
- The snapshot's schema file is modified after the post-import check:
  the core still uses the captured bytes, and Codex's strict file
  matches them.
- Self-check coverage, with a config that passes the schema but fails the
  self-check (for example a preset for a provider the core can't
  render):
  - a config-only reload with it is rejected at preparation;
  - a pending reload whose config is edited to it before the swap is
    cancelled at the swap;
  - a rollback that would restore it is refused;
  - a dashboard edit producing it is rejected;
  - `selfCheck` on the running core doesn't touch live state (before and
    after compared).
- Combined code and config reload where the new code needs a new config
  key, present in the edited `config.json`: validation uses the new
  module's static `validateConfig`, `createCore` gets no config, and
  `selfCheck` receives the edited config and passes. The same reload
  validated against the *old* config would have failed.
- A candidate whose `attach` throws (injected): the swap aborts. The
  current core, config holder, registries and store are unchanged, held
  requests run on the running core, and the candidate is disposed.
- A `reset_review_context` call parked in its roots check across two
  swaps: its core isn't disposed until the call finishes, and it
  completes normally.
- A candidate that fails its self-check, config validation or a swap-time
  check leaves the live registries, store, archive, metrics and config
  holder untouched (snapshots compared before and after). It's disposed,
  and `attach` is never called on it.
- Loading the same code twice writes two `<id>-<nonce>` folders. Editing
  a file inside an old folder never affects a later load.
- A file modified in the snapshot between its write and the post-import
  check (injected): the candidate is rejected and its folder deleted.
- Two snapshots of different bytes import as distinct module instances,
  including a transitive module. The same bytes get the same `<id>` but a new folder each load.
- Editing a source file after a core loaded changes neither its behaviour
  nor its resources (schema bytes).
- A file changing during the read triggers a retry, and repeated changes
  reject the reload.
- An unselectable core's snapshot folder is deleted. Startup clears stale
  ones.
- A Codex run finds its strict schema in the snapshot, rewriting it if the
  folder was removed.

**Hooks and token**
- Relaying impostor on the recorded port: a test listener that forwards
  everything to the real server and back.
  - The hook's request bodies and headers, as captured by the impostor,
    never contain the token.
  - Re-sending a captured request is rejected (nonce seen).
  - A response the impostor alters (say `ISSUES` → `GOOD_TO_GO`) fails
    the hook's verification, and the hook fails open with "unverified
    response".
- Full review during a rotation grace with a hook holding the **previous**
  token: its request verifies, its response is signed with the previous
  token, and the hook verifies it and acts on the verdict. A request
  signed with the current token gets a current-token response.
- Every script (`reload.sh`, `rotate-token.sh`, `replay-review.sh`,
  `reset-review.sh`, `setprovider.sh`) sends signed requests only, as
  captured by a relaying listener, and rejects an altered response. A raw
  `X-Review-Token` is rejected on every route except `/mcp`.
- A signed `/admin/reload` captured before a server restart and replayed
  after it (within 5 min) is rejected as "unknown instance". A genuine
  caller re-runs the challenge and succeeds.
- Server-side: unsigned, badly signed, stale-timestamp and replayed-nonce
  requests on the end-of-turn routes are rejected. A previous-token
  signature is accepted only during the grace.
- First request after a rotation is a hook's `/healthz` challenge (no
  authenticated request in between): the proofs include the new token,
  and the previous token's proof while its grace runs. The hook holding
  the new token accepts the server and the review runs.
- During a rotation grace, a hook holding the previous token (from its
  cache) verifies the previous-token proof and proceeds. After the grace,
  only the current-token proof is offered.
- With `server.json` present and its pid alive, the hooks use its address
  and `hookTimeoutMs`, even after `config.json`'s `port` or reviewer
  timeout is edited. They fall back to `config.json` when the pid is dead
  or the file is missing.
- `hookTimeoutMs` is the running config's derived timeout. While a reload
  is pending, it's the larger of running and candidate plus
  `maxHoldSeconds`, capped at 29 min. It's rewritten on swap, on a
  pending change and on dashboard edits.
- A token change in `config.json` is accepted on the next request with no
  reload. The previous token is still accepted during the grace and
  rejected after it, and `--revoke-now` rejects it immediately. A
  rollback doesn't change the accepted token.
- `rotate-token.sh` writes the new token, rewrites the Codex
  `config.toml` header (tested against a temp `HOME`), and lists the
  clients to restart.
- An unparseable `config.json` keeps the last good token on the server.
- Hooks against a half-written `config.json` (truncated mid-object):
  - the retry succeeds once the file is complete within about 1 s;
  - a file that stays broken makes the hook use `hook-credentials.json`
    and log it;
  - with no cache, the hook fails open with the unparseable path and "no
    credentials cache" in stderr;
  - after `install.sh`, the cache exists before any hook has run. After
    server startup, a token change or a config transaction, it holds the
    current token;
  - a hook paused between reading the old token and finishing (injected),
    with a rotation in between, never writes the cache: hooks only read
    it. The cache keeps the rotated token;
  - the cache is written 0600 and atomically.
- Dashboard saves and `rotate-token.sh` write `config.json` atomically:
  a reader polling during a write never sees partial JSON.
- `rotate-token.sh --revoke-now`:
  - `config.json` gets the new token and a
    `{ tokenHash: sha256(new), previousTokenHash: sha256(old), grace:
    "none" }` record appended to `auth.rotations`, in one atomic write;
  - A→B (normal), then B→C with `--revoke-now`, with no server request in
    between: the server, seeing A→C, gives A no grace. A request signed
    with A gets `401`;
  - a request signed with the old token as the **first** request after
    the rotation gets `401`, with no grace started;
  - a grace already running when a `grace: "none"` rotation lands is
    dropped on the next request;
  - an `authToken` changed by hand (no matching rotation record) gets the
    default grace for the predecessor the server saw;
  - nothing the script sends contains the raw old or new token (captured
    by a relaying test listener);
  - with the server stopped during the rotation, its next start accepts
    only the new token;
  - the script's confirmation is a new-token-signed `GET /status` showing
    `currentTokenHash = sha256(new)` and `previousTokenGrace: null`.
- Missed rotations, server sees only A→C:
  - A→B normal, then B→C normal, 30 h apart: A gets no grace, because its
    own A→B grace has expired; C's rotation time doesn't restart it;
  - A→B normal, then B→C normal, 1 h apart: A is accepted until
    A→B's `at` + 24 h, not C's;
  - A→B with `--revoke-now`, then B→C normal: A gets no grace;
  - with the A→B record trimmed from history: A gets no grace.
- Grace expiry from rotation time: a normal scripted rotation, then the
  server's first request arriving 25 h later (clock injected) rejects the
  previous token, with no grace starting then. A first request 2 h later
  accepts it until `rotation.at + 24 h`.
- The opencode plugin reads the token per request: after a rotation, its
  next `session.idle` review succeeds with the new token, with no restart,
  including after the grace expires. Its MCP registration keeps the old
  header (documented), and `rotate-token.sh` lists opencode among the
  clients to restart.
- A token rewrite that keeps the file's modification time (`touch -r`) is
  accepted on the next request.

**Dashboard CSRF**
- With `bind` set to a specific non-loopback address, requests with that
  `Host` (as the hooks build it) succeed on every route. Other hosts get
  `421`.
- With `bind` set to a hostname whose DNS answers include a local
  interface *and* another machine's IP (stubbed resolver): only the
  address the socket actually listens on counts as local.
  - A remote address arriving as `::ffff:<listening IP>` is accepted.
  - The other machine's IP, though it's in the DNS answer, is rejected.
- With that bind, a same-machine browser on `http://<bind>:<port>` can use
  reload, rollback and cancel: `Origin` matches, and the remote address
  equals `bind`. A request from another machine's address is rejected.
- DNS rebinding: a request with `Host: evil.example:<port>` to `/`,
  `/dashboard/*`, `/healthz` and `/mcp` gets `421`, so the page and its
  CSRF token never load. A mutation sent with `Sec-Fetch-Site:
  same-origin` but `Origin: http://evil.example:<port>` gets `403`.
- A cross-origin form `POST` to `/dashboard/reload` (and to rollback,
  cancel and the existing action routes) is rejected: wrong or missing
  `Sec-Fetch-Site` / `Origin`, no CSRF header, or a non-JSON body. No
  reload happens.
- A same-origin `fetch` from the real page with the embedded token
  succeeds.
- The token changes on server restart, so a page from before the restart
  is told to reload.
- Every HTML response carries `X-Frame-Options: DENY` and
  `Content-Security-Policy: frame-ancestors 'none'`. The page loaded in
  an iframe (jsdom) leaves its action buttons disabled and shows the
  framing notice.

**Config pinning**
- A dashboard edit made while a review runs doesn't change that review's
  model, effort, timeout, caps or severities. The next admitted review
  uses the new values.
- A config swap at idle followed by a held request: the held request runs
  on the new config.
- Review key and cache:
  - after a GOOD_TO_GO, changing `codex.reasoningEffort` (not in today's
    `reviewConfigHash`) makes the next request on the unchanged tree run
    a review: no `NO_CHANGES` from the fast path or the post-build
    check;
  - after a reload that changes a review-path file (say the prompt), the
    unchanged tree is reviewed again;
  - after a reload that changes only `dashboard.js`, it still
    short-circuits, because `reviewVersion` is unchanged;
  - after a reload that changes **only `core/index.js` wiring**,
    `reviewVersion` changes and the unchanged tree is reviewed again;
  - after a reload that changes **only `codex-output.schema.json`**,
    `reviewVersion` changes and the unchanged tree is reviewed again;
  - two MCP calls with identical config and extras but different
    `provider` overrides (codex, then claude) don't share a baseline: the
    second runs its own review, and repeating the first provider's call
    afterwards doesn't reuse the second's verdict;
  - a baseline from before `reviewKey` existed never matches;
  - a restart whose shell source differs (fixture) invalidates cached
    verdicts once. A restart with an identical shell doesn't.
- Two MCP `request_review` calls for the same context with different
  `extra_instructions` don't join each other; the second queues.
- A later call with different extras doesn't get `NO_CHANGES` from a
  baseline produced under other extras, while one with the same extras
  does.
- A Stop hook (no extras) after an MCP review with extras that ended
  `GOOD_TO_GO` returns `NO_CHANGES` with no reviewer run (decision Q8).
  After one that ended `ISSUES`, it runs its own review.
- A Stop hook doesn't *join* a still-running MCP review with extras; it
  queues, then gets `NO_CHANGES` if that review passed.
- A request admitted after a model change, for a context whose old-config
  review is running, doesn't join it. It queues on the context chain and
  runs with the new model. A request with the same fingerprint still
  joins.
- The same with an edit to the repo's `.review-orchestrator.json` (for
  example `blockingSeverities`) made while a review runs: the next request
  queues and runs with the new project settings, and the running review
  keeps the ones it was pinned with.
- After an **apply now**: a request admitted to the new core, for a
  context whose old-core review is running with the same config, queues
  behind it rather than joining it.

**Limit handshake**
- A hook paused between reading `server.json` and sending `/review`
  (injected delay), while a swap raises the reviewer timeout in the gap:
  - the server answers `409 HOOK_LIMIT_STALE` with the new limit, having
    done no work;
  - the hook restarts its timer with that limit and resends;
  - the review runs to completion within the hook's wait, with no
    `DEADLINE_EXCEEDED`.
- The same with a dashboard edit raising the timeout in the gap.
- An unchanged-config Stop-hook request at immediate admission passes the
  handshake, with no `409`. That holds with a default `timeoutMs` and
  with a pinned `hook.fetchTimeoutSeconds` shorter than the reviewer
  timeout.
- A held request whose hook read the pre-pending limit (no hold
  allowance), held for most of its budget, then dispatched after the swap:
  its remaining budget is below the pinned config's required wait, so it
  gets `HOOK_LIMIT_STALE` before any work. The resend runs within the
  hook's overall deadline.
- The same check at dispatch from the swap gate.
- Config changing on every attempt: the first two attempts get
  `HOOK_LIMIT_STALE`, and the third outgoing attempt carries
  `finalAttempt: true`. The server proceeds on the deadline rules instead
  of answering `409`, so there's never a fourth attempt.
- Two attempts each held for 45 s, then a stale-limit `409`: the final
  attempt's timer is capped to the remaining overall budget. The hook
  answers within start + 29 min, under the 30 min harness, every time.
- A remaining budget shorter than the required limit: the next attempt
  goes straight to `finalAttempt: true`.
- A pinned `hook.fetchTimeoutSeconds` shorter than the reviewer timeout
  never triggers `HOOK_LIMIT_STALE`.
- MCP requests (no `timeoutMs`) skip the handshake.
- The opencode plugin path retries the same way as the Stop hooks.

**Request deadlines**
- A Stop-hook request with a short `timeoutMs` queued behind two
  same-context reviews answers `DEADLINE_EXCEEDED` before `timeoutMs`,
  while still queued. It's removed from the chain and never runs, and the
  chain continues.
- A request joined to a slow review answers `DEADLINE_EXCEEDED` at its
  deadline. The review continues and stores its result for its owner.
- A request whose own review outlasts its deadline answers
  `DEADLINE_EXCEEDED`. The review finishes with its configured timeout and
  caches its result. The next request gets that result from the cache,
  and the admission count stays above zero until the review ends.
- With `hook.fetchTimeoutSeconds: 3` (deadline margin `min(5 s, 0.3 s)`)
  and no queue: the request starts its pipeline, answers
  `DEADLINE_EXCEEDED` at about 2.7 s, and the review completes in the
  background. The next Stop hook gets the cached result. Repeated
  short-limit Stop hooks never skip the review entirely.
- With `hook.fetchTimeoutSeconds: 90` and a 600 s reviewer timeout and no
  queue or reload: the review runs to completion and the following Stop
  hook gets its cached result. Nothing is ever blocked by a minimum
  budget.
- A held request answers `DEADLINE_EXCEEDED` at its deadline if that
  comes before its hold deadline, and leaves the hold queue.
- `DEADLINE_EXCEEDED` responses are never cached and write no state.
- An MCP request without `timeoutMs` keeps today's behaviour.

**Apply now** (decision Q4):
- With a review running, `reload.sh --now` (and the dashboard button)
  swaps at once. The running review finishes and archives on the old
  core, and new and held requests run on the new one. After that review
  drains, the old core is still `previous`, not disposed, and a
  **rollback** to it works: its resources and Codex schema file are
  intact. It's disposed only after a later swap pushes it out of
  `previous` and its pins are zero.
- `--now` with a failing swap-time check (say a restart-only key)
  changes nothing.
- `--now` with nothing pending prepares and applies in one call.
- Nothing swaps without an explicit trigger: with reviews running for a
  long time and nobody pressing it, the reload stays pending.

## 10. Decisions (2026-10-06)

| # | Question | Decision |
|---|---|---|
| Q1 | Where snapshots live | `server/.core-versions/` in the repo, gitignored (§5.3). |
| Q2 | Automatic rollback after errors | **No.** Manual rollback only, via `reload.sh --rollback` or the dashboard. |
| Q3 | Starvation guard | Hold new reviews after **5 min** pending (`reload.maxWaitMinutes` = 5), each held at most **45 s** (`reload.maxHoldSeconds`). |
| Q4 | Completing a reload under constant load | **Manual "apply now" only** (`reload.sh --now`, dashboard button). Running reviews finish on the old code. No automatic forcing (`forceAfterMinutes` dropped). |
| Q5 | Core layout | **Move** the reloadable modules into `server/src/core/`, with the review entry at `core/review/index.js`. |
| Q6 | Token rotation grace | **24 h**, in memory; a server restart ends it. |
| Q7 | Archive and state code | **Frozen in the shell** for v1; archive/state format changes need a restart. |
| Q8 | Caller guidance and the cache | A Stop hook (no extras) **accepts a passing result** from a review that had `extra_instructions`. Exact match is still required for joining, for requests with extras, and for non-passing results (§5.5). |
