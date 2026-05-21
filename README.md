# Review Orchestrator

An automatic, in-session code-review loop for Claude Code, using Codex CLI as a
read-only meticulous reviewer. Claude does all development work in a single CLI
session; when it tries to finish (or explicitly asks for a review), a local
service runs Codex against the current changes and either returns
`GOOD-TO-GO` or a structured list of issues. Claude addresses every issue in
the same session and tries again. The loop repeats until Codex is satisfied or
a per-context retry cap is reached.

No second Claude process. No external orchestrator. One long-lived Claude
session, one short-lived Codex subprocess per review round, one local server
that ties it all together.

## Goals

- Keep the developer in **one** Claude CLI session for the entire dev + fix
  cycle. The user talks to Claude there and only there.
- Make review **automatic** by default (Stop hook), and **explicit** on demand
  (MCP tool Claude can call mid-task).
- Make Codex's job narrow and stateless: read a diff, return findings, exit.
- Share **state** (change detection, retry counter, prior-findings cache)
  between the automatic and explicit entry points so they can't disagree.
- Fail open: if any piece of the infrastructure is broken, the CLI still
  works — review is just skipped, loudly logged.

## Non-goals

- Cross-machine review. Everything runs on the developer's laptop.
- Multi-user / team coordination. Single-user tool.
- Replacing PR review. This is a pre-commit / in-flight quality gate.
- Driving Claude from outside (no orchestrator process spawning Claude).

## Architecture

```
                            ┌──────────────────────────────────────┐
                            │      Local Review Server (Node)      │
                            │                                      │
   ┌───────────────┐  HTTP  │  POST /mcp          (MCP transport)  │
   │  Claude CLI   │◄──────►│  POST /review       (Stop-hook API)  │
   │   (session)   │        │  POST /reset                         │
   └───────┬───────┘        │  GET  /status                        │
           │                │                                      │
           │ Stop event     │  state:                              │
           ▼                │   - per-context retry counter        │
   ┌───────────────┐  HTTP  │   - per-context prior findings       │
   │  Stop hook    │───────►│   - per-context last-review SHA      │
   │  (bash)       │        │   - per-context idle timer           │
   └───────────────┘        │                                      │
                            │  spawns:                             │
                            │   $ codex exec --sandbox read-only … │
                            └──────────────────────────────────────┘
```

Three components talk to one server:

1. **Claude (MCP client)** calls `request_review` and `reset_context` tools
   over HTTP MCP.
2. **Stop hook** posts to `/review` whenever Claude tries to end a turn.
3. **The server** is the only thing that runs `codex` and the only thing that
   holds state.

### Why a server instead of two independent integrations

The MCP tool and the Stop hook need to share three pieces of state:

- **Retry counter** — so manual `request_review` calls and automatic Stop-hook
  reviews count toward the same cap.
- **Prior-findings cache** — so round N+1 can ask Codex "verify each previous
  finding is fixed" instead of re-reviewing from scratch and drifting into new
  nits.
- **Change baseline** — so "did anything change since the last review?" has
  one answer, not two.

A single server with two entry points is the minimum infrastructure that makes
this coherent.

## Components

### 1. Review Server (`server/`)

Node 24, Express, stdio to spawn `codex`. Long-running, started by launchd.

**Endpoints:**

| Method | Path        | Purpose                                       | Caller       |
|--------|-------------|-----------------------------------------------|--------------|
| POST   | `/mcp`      | MCP HTTP transport (tools listed below)       | Claude       |
| POST   | `/review`   | Run a review, return Stop-hook decision JSON  | Stop hook    |
| POST   | `/reset`    | Clear counter + cache for a context           | Stop hook / manual |
| GET    | `/status`   | Dump all live contexts (debug / inspection)   | Human        |
| GET    | `/healthz`  | Liveness check                                | launchd / hook fail-open |

**MCP tools exposed over `/mcp`:**

- `request_review(scope?, extra_instructions?)` — Claude calls this when it
  wants a review mid-task. Returns either `{ status: "GOOD_TO_GO" }` or
  `{ status: "ISSUES", findings: [...] }`.
- `reset_review_context()` — Claude calls this when starting a fresh task to
  drop the counter and cache.

**Context identity:**

A "context" is keyed by `cwd + git branch` (branch defaults to `"-"` if not a
repo). Both MCP calls and Stop-hook calls resolve to the same context key,
which is what makes shared state work. The server computes the key itself from
the request — callers don't get to choose it.

**Review archive (on disk, per context):**

Every review call (Codex actually invoked — not cache hits) writes two files
to disk under a configurable root (default `./reviews/`, relative to the
server's working directory; overridable via `config.reviewsDir`):

```
reviews/
  <repo>:<branch>/
    2026-05-21T14-30-45Z.json    structured record
    2026-05-21T14-30-45Z.md      human-readable version
    2026-05-21T14-32-11Z.json
    2026-05-21T14-32-11Z.md
    ...
```

- `<repo>` = basename of the git repo root.
- `<branch>` = current branch, with `/` replaced by `__` (so
  `feature/foo` → `feature__foo`). Colons are kept literal — macOS allows
  them at the POSIX level; Finder displays them as `/` but that's cosmetic.
- Timestamp format: UTC ISO-8601 with `:` swapped for `-` so the name is
  filesystem-safe everywhere (`2026-05-21T14-30-45Z`).
- Same timestamp prefix for the `.json` / `.md` pair from one review.
- The folder is created on demand. Multiple repos with the same basename
  but different paths land in the same folder — acceptable for v1; if it
  becomes a problem we'll prepend a short hash of the repo path.

**`.json` schema (the durable record):**

```json
{
  "timestamp": "2026-05-21T14:30:45.123Z",
  "context": {
    "key": "/Users/leo/work/foo:main",
    "repo": "foo",
    "repoPath": "/Users/leo/work/foo",
    "branch": "main"
  },
  "round": 2,
  "trigger": "stop_hook" | "mcp_tool" | "manual",
  "baseline": {
    "headSha": "abc1234…",
    "diffHash": "sha256:…",
    "untrackedFiles": ["src/new.js"]
  },
  "codex": {
    "model": "gpt-5-codex",
    "durationMs": 18432,
    "exitCode": 0,
    "rawStdout": "…"
  },
  "result": {
    "status": "GOOD_TO_GO" | "ISSUES" | "ESCALATE",
    "findings": [ /* parsed findings array, empty if GOOD_TO_GO */ ],
    "parseError": null
  },
  "priorFindingsFedIn": [ /* the findings from the previous round, if any */ ]
}
```

**`.md` rendering (what a human reads):**

```markdown
# Review — foo:main — 2026-05-21 14:30:45 UTC

- **Status:** ISSUES (round 2 of 5)
- **Trigger:** stop_hook
- **HEAD:** abc1234
- **Model:** gpt-5-codex (18.4s)

## Blockers
- `src/auth.js:42` — Token comparison uses `==` instead of constant-time compare.
  *Suggestion:* use `crypto.timingSafeEqual`.

## Major
- `src/foo.js:120` — …

## Minor / Nits
- …

---
## Prior findings fed to Codex this round
- `src/auth.js:42` — (from previous review)
```

The `.json` file is the source of truth; the `.md` is generated from it for
human inspection. Both are written atomically (tmp + rename) so a partial
file never appears.

**Retention:** unlimited by default. A `config.reviewsRetentionDays`
(default `null` = keep forever) can prune older files at server startup if
set.

**State (in-memory, per context):**

```ts
type ContextState = {
  key: string;                  // cwd + branch
  counter: number;              // rounds used in current loop, max 5
  lastBaseline: string | null;  // git HEAD SHA + diff hash at last review
  priorFindings: Finding[];     // last review's findings, for verify-on-rereview
  lastReviewedAt: number;       // epoch ms, for idle reset
  lastResultStatus: "GOOD_TO_GO" | "ISSUES" | null;
};
```

Persisted to `~/.cache/review-orchestrator/state.json` on every change so a
server restart doesn't lose the loop mid-flight.

**Counter reset triggers (any of these):**

- `GOOD_TO_GO` returned → counter resets to 0.
- 10 minutes idle since last review → counter resets to 0.
- Explicit `reset_review_context` call → counter resets to 0.
- Branch change detected on the next call → counter resets to 0.

**Cap:** 5 rounds. After that, server returns
`{ status: "ESCALATE", reason: "5 review rounds exhausted" }` and Claude is
allowed to finish so the human can step in.

**Change detection (server-side, callers don't supply it):**

On every review call:
1. Compute current baseline: `git rev-parse HEAD` + sha256 of `git diff HEAD`
   (or sha256 of recursive file mtimes if not a git repo).
2. Compare to `lastBaseline`.
3. If unchanged → return cached last result immediately (no Codex spawn).
4. If changed → run Codex, update baseline.

**Codex invocation:**

```bash
codex exec --sandbox read-only --model <reviewer-model>
```

stdin: a constructed prompt containing:
- A fixed reviewer system preamble (output contract: either exact string
  `GOOD-TO-GO` or a JSON array of findings with `file`, `line`, `severity`,
  `message`).
- The diff (`git diff HEAD` or a file dump for non-git contexts).
- If `priorFindings` non-empty: "On the previous round you flagged the
  following. Verify each is resolved; do not re-flag fixed items; do flag
  regressions or new issues."
- Optional `extra_instructions` from the MCP caller.

Parse stdout. If it equals `GOOD-TO-GO`, return success. Otherwise parse the
JSON findings block. If parsing fails, return raw text as a single "finding"
of severity `unknown` rather than crashing — fail safe.

**Concurrency:** per-context mutex around Codex spawns. Two simultaneous
requests on the same context queue; different contexts run in parallel.

### 2. MCP server (HTTP, served from the same Express app)

Registered in `~/.claude.json` (user-level) so every project gets it. The
snippet to merge lives in `claude-mcp.json` in this repo:

```json
{
  "mcpServers": {
    "review": {
      "type": "http",
      "url": "http://127.0.0.1:7777/mcp"
    }
  }
}
```

`install.sh` reads `claude-mcp.json` and merges its `mcpServers.review` key
into `~/.claude.json` (with a `.bak` backup first).

Tools the server advertises:

- `request_review` — input `{ scope?: "diff" | "branch" | "worktree", extra_instructions?: string }`, returns review result.
- `reset_review_context` — input `{}`, returns `{ ok: true }`.

### 3. Stop hook (`hooks/stop-review.sh`)

Bash, lives at `~/.claude/hooks/stop-review.sh`. Registered user-level in
`~/.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "~/.claude/hooks/stop-review.sh",
            "timeout": 300000
          }
        ]
      }
    ]
  }
}
```

Hook responsibilities (kept minimal):

1. Read Stop payload from stdin, extract `cwd`, `session_id`,
   `stop_hook_active`. **`stop_hook_active` is intentionally ignored** —
   the multi-round loop runs inside a single turn (see "Loop semantics"
   below). The server-side counter is the real cap.
2. Curl `POST /review` with `{ cwd, session_id }`. Timeout 280s.
3. On HTTP error / connection refused → log to `~/.claude/logs/review-hook.log`
   and exit 0 (fail-open).
4. On `GOOD_TO_GO` or `NO_CHANGES` or `ESCALATE` → exit 0.
5. On `ISSUES` → emit Stop-hook decision JSON to stdout:
   ```json
   {
     "decision": "block",
     "reason": "Codex review (round N of 5):\n\n<formatted findings>\n\nAddress every point, then finish."
   }
   ```
   Exit 0. Claude continues the turn with the review injected.

Hook prints a heartbeat (`Reviewing changes with Codex…`) to stderr before the
curl so the CLI shows progress instead of looking hung.

### 4. CLAUDE.md guidance (user-level)

The canonical text lives in `claude-md-snippet.md` at the repo root (named
that way so it isn't auto-loaded as project instructions when working in
this repo). `install.sh` appends it verbatim to `~/.claude/CLAUDE.md`,
wrapped in marker comments so re-running the install replaces the block in
place rather than duplicating it. See
[./claude-md-snippet.md](./claude-md-snippet.md) for the full text.

## Loop semantics (important)

The multi-round review loop happens **inside a single turn**. The hook
ignores `stop_hook_active` and keeps blocking until the server says we're
done (GOOD-TO-GO, NO_CHANGES, or ESCALATE).

Sequence on the user's screen:

1. User: "implement X"
2. Claude edits files, says "done", emits Stop.
3. Stop hook fires → server runs Codex → ISSUES (round 1).
4. Hook returns `decision: block` with findings as `reason`.
5. Claude sees the findings as a system message and continues **in the same
   turn**, edits files, says "done", emits Stop again.
6. Stop hook fires again — does **not** short-circuit on
   `stop_hook_active`. Server runs Codex → ISSUES (round 2). Block again.
7. … repeats until either:
   - Codex returns `GOOD-TO-GO` → hook exits 0 → turn actually ends, control
     returns to the user.
   - Server counter reaches `maxRoundsPerContext` (default 5) → server
     returns `ESCALATE` → hook exits 0 → Claude surfaces the situation to
     the user.

Trade-offs of this choice (vs honoring `stop_hook_active`):

- **Pro:** Fully autonomous loop. The user issues one instruction and gets
  back a reviewed result without having to nudge the CLI between rounds.
- **Pro:** All review rounds for one task are visibly contiguous in the
  transcript.
- **Con:** Higher risk of a runaway turn if the server-side cap fails or is
  misconfigured. Mitigations: the cap is enforced server-side (the hook
  can't override it), the cap is low (5), and ESCALATE is a hard exit.
- **Con:** No natural human checkpoint between rounds. The user must
  interrupt (Ctrl-C) if they want to step in mid-loop.

The user can still interrupt at any point. The server's counter is the
authoritative safety net.

## Failure modes & fallbacks

| Failure | Behavior |
|---|---|
| Server not running | Hook fails open, logs, Claude finishes normally. |
| Codex CLI missing / errors | Server returns `ESCALATE` with error message. |
| Codex output unparseable | Treated as a single finding, not a crash. |
| Hook timeout | Claude finishes normally (better than hanging the CLI). |
| Counter exhausted | Server returns `ESCALATE`, Claude surfaces to user. |
| Branch switch mid-loop | Counter + cache reset, fresh review on next call. |
| Two sessions same cwd | Per-context mutex serializes; both share state intentionally. |

## Configuration

`~/.config/review-orchestrator/config.json`:

```json
{
  "port": 7777,
  "codex": {
    "binary": "codex",
    "model": "gpt-5-codex",
    "extraArgs": ["--sandbox", "read-only"]
  },
  "limits": {
    "maxRoundsPerContext": 5,
    "idleResetMinutes": 10,
    "codexTimeoutSeconds": 240
  },
  "reviewsDir": "./reviews",
  "reviewsRetentionDays": null,
  "logging": {
    "dir": "~/.claude/logs",
    "level": "info"
  }
}
```

## Implementation plan

Phased so each phase is independently usable. Stop after any phase and you
have a working (lesser) version.

### Phase 0 — Repo scaffolding

- [ ] `package.json` (Node 24, type: module).
- [ ] Dependencies: `express`, `zod`, `@modelcontextprotocol/sdk` (for HTTP
      MCP server helpers), `pino` for logging.
- [ ] Layout:
  ```
  server/
    src/
      index.js           // express bootstrap
      mcp.js             // MCP /mcp handler
      review.js          // /review endpoint
      reset.js           // /reset endpoint
      status.js          // /status, /healthz
      context.js         // context-key resolution + state store
      codex.js           // codex subprocess wrapper
      diff.js            // git diff / mtime baseline
      archive.js         // per-context review files on disk (json + md)
      config.js          // load + validate config
      logger.js
    test/                // jest tests, *.test.js next to each src file
  hooks/
    stop-review.sh
  launchd/
    com.leo.review-orchestrator.plist
  claude-mcp.json        // MCP entry to merge into ~/.claude.json
  claude-md-snippet.md   // guidance text to append to ~/.claude/CLAUDE.md
                         // (named to avoid being auto-loaded as project instructions)
  install.sh             // sets up launchd, copies hook, edits ~/.claude.json
  README.md              // this file
  ```

### Phase 1 — Minimum viable server (no MCP, no hook)

- [ ] `POST /review` accepts `{ cwd }`, computes baseline, runs Codex, returns
      raw stdout.
- [ ] `GET /healthz`.
- [ ] Manual test: `curl -X POST localhost:7777/review -d '{"cwd":"..."}'`.

### Phase 2 — State & change detection

- [ ] `context.js`: resolve `cwd` → context key (cwd + branch), in-memory
      state map, persisted to `~/.cache/review-orchestrator/state.json`.
- [ ] `diff.js`: baseline = `git rev-parse HEAD` + sha256(`git diff HEAD`).
      Fallback to mtime-based baseline if not a repo.
- [ ] `review.js`: short-circuit with cached result if baseline unchanged.
- [ ] Counter + idle reset logic.
- [ ] Tests for context-key resolution, baseline diffing, counter behavior.

### Phase 3 — Codex output contract

- [ ] System preamble that pins output format: exact `GOOD-TO-GO` or fenced
      JSON array of findings.
- [ ] Parser in `codex.js` with graceful fallback (raw text → single finding).
- [ ] Include `priorFindings` on round 2+.
- [ ] Tests with fixture Codex outputs (mock the subprocess).

### Phase 3.5 — Review archive on disk

- [ ] `archive.js`: writes `<reviewsDir>/<repo>:<branch>/<ts>.json` and
      matching `.md` atomically (tmp + rename).
- [ ] Branch sanitization (`/` → `__`), timestamp formatting,
      directory-on-demand creation.
- [ ] Markdown renderer grouped by severity, with `file:line` refs and
      a "Prior findings fed in" footer when applicable.
- [ ] Skip archive write on cache hits (no Codex call → no new file).
- [ ] Retention pruning on startup if `reviewsRetentionDays` set.
- [ ] Tests: archive layout, sanitization, markdown rendering, atomicity
      (kill mid-write → no partial file visible), retention pruning.

### Phase 4 — MCP HTTP transport

- [ ] `/mcp` endpoint using `@modelcontextprotocol/sdk` HTTP transport.
- [ ] Tools: `request_review`, `reset_review_context`.
- [ ] Register in `~/.claude.json` (manual step documented in `install.sh`).
- [ ] Verify with `claude mcp list` and a session that calls
      `request_review`.

### Phase 5 — Stop hook

- [ ] `hooks/stop-review.sh` per spec above.
- [ ] Fail-open on connection error.
- [ ] Heartbeat to stderr.
- [ ] Register in `~/.claude/settings.json` (handled by `install.sh`).
- [ ] Verify: edit a file in a Claude session, ask Claude to finish, observe
      hook running and review injection.

### Phase 6 — launchd & install

- [ ] `launchd/com.leo.review-orchestrator.plist` with `KeepAlive=true`,
      `RunAtLoad=true`, logs to `~/.claude/logs/review-server.{out,err}.log`.
- [ ] `install.sh`:
  - Copies plist to `~/Library/LaunchAgents/`, `launchctl bootstrap`.
  - Copies hook to `~/.claude/hooks/`.
  - Patches `~/.claude.json` to add the MCP entry (with backup).
  - Patches `~/.claude/settings.json` to add the Stop hook (with backup).
  - Writes `~/.config/review-orchestrator/config.json` if absent.
- [ ] `uninstall.sh` symmetrical.

### Phase 7 — Polish

- [ ] `GET /status` returns pretty JSON of all live contexts for debugging.
- [ ] `pino-pretty` formatted logs.
- [ ] Shared-secret header (`X-Review-Token`) checked on `/review` and `/mcp`,
      generated on install, stored in config and exported into hook env.
- [ ] Optional: simple HTML dashboard at `GET /` showing contexts + last
      review.

### Phase 8 — Tests

Per user rules: jest, ≥90% coverage, test files alongside source as
`<name>.test.js`. Mock the Codex subprocess and the filesystem where
practical.

- [ ] `context.test.js` — key resolution, persistence, idle reset.
- [ ] `diff.test.js` — baseline computation, git vs mtime fallback.
- [ ] `codex.test.js` — output parsing (GOOD-TO-GO, valid JSON, malformed).
- [ ] `archive.test.js` — folder layout, branch sanitization, markdown
      rendering, atomic write, retention pruning.
- [ ] `review.test.js` — full flow with mocked Codex: unchanged-cache,
      issues path, GOOD_TO_GO path, escalate path.
- [ ] `reset.test.js`.
- [ ] `mcp.test.js` — MCP tool invocations.

## Decisions

These are settled for v1. Anything not on this list is open to revisit
during implementation; anything on this list is locked unless we agree to
change it.

- **Reviewer model:** `gpt-5-codex` (Codex CLI default). Overridable via
  `config.codex.model`.
- **Diff scope:** `git diff HEAD` combined with
  `git ls-files --others --exclude-standard` (untracked, non-ignored files).
  Both are sent to Codex as a unified payload — modified content via diff,
  new files as full content with a `+++ b/<path>` header so Codex sees them
  as additions. No staged-only mode; no full-branch mode. Not exposed as a
  per-call parameter in v1.
- **Non-git directories:** Git repos only. If `cwd` is not inside a git
  repository, the server returns
  `{ status: "ESCALATE", reason: "Not a git repository: <cwd>. Run git init or move into a repo." }`.
  No auto-init, no mtime fallback. The current working directory
  (`/Users/leo/work/trace/review`) needs `git init` before the server can
  review changes here.
- **Findings format:** Codex emits **JSON** matching the schema below;
  the server **reformats to markdown** before injecting into the Stop-hook
  `reason` or returning from the `request_review` MCP tool. The JSON form is
  what gets cached in `priorFindings` for round N+1 verification.

  Codex output contract — exactly one of:

  ```
  GOOD-TO-GO
  ```

  or a fenced JSON block:

  ````
  ```json
  [
    {
      "file": "src/foo.js",
      "line": 42,
      "severity": "blocker" | "major" | "minor" | "nit",
      "category": "bug" | "security" | "perf" | "style" | "test" | "other",
      "message": "Short description of the issue.",
      "suggestion": "Optional concrete fix recommendation."
    }
  ]
  ```
  ````

  Server-side markdown rendering groups by severity, then file, with
  `file:line` refs Claude can navigate.

## Deferred to v2

- **Per-project overrides** via `.review-orchestrator.json` in repo root
  (extra reviewer instructions, ignored paths, custom severity threshold).
- **Configurable diff scope** per `request_review` call.
- **Non-git directory support** via mtime baselines.
- **Multiple reviewers** (e.g. Codex + a second model for cross-check).
