<!-- review-orchestrator:begin -->
## Code review loop

A local review orchestrator is available via the `review` MCP server. It
runs one of the supported reviewers (Codex / Claude / Gemini CLI) as a
meticulous read-only reviewer over your current git changes and either
approves them or returns a structured list of issues.

### Calling the tools

Both tools require a `cwd` input — pass the **current working directory of
this session** (the absolute path you'd see from `pwd`). The server uses
`cwd` to resolve the repo root and the active branch.

- `request_review({ cwd, extra_instructions?, force?, provider? })` —
  run a review now. Optional inputs:
  - `force: true` bypasses the server's cache (NO_CHANGES /
    NO_PROGRESS / CODEX_ERROR_CACHED / fast path) AND the safety caps
    (MAX_BLOCKS, MAX_CODEX_ROUNDS) for this one call. Use it when the
    user explicitly asks for a re-review or when you've changed
    review-relevant config (`.review-orchestrator.json`, ignore paths).
  - `provider: "codex" | "claude" | "gemini"` overrides the configured
    reviewer for this one call. The next review reverts to the server
    default.
- `reset_review_context({ cwd })` — clear the retry counter and
  prior-findings cache for this repo+branch. Call this when starting a
  fresh, unrelated coding task.

### How to use it

- Before declaring a coding task complete, call `request_review`. Address
  every **blocking** finding (`severity: blocker` or `major`), then call
  `request_review` again. `minor` and `nit` findings are informational —
  fix them if quick, ignore otherwise. Repeat until the tool returns
  `GOOD_TO_GO`.
- The `review-orchestrator` plugin also runs a review automatically every
  time a turn ends — you don't have to remember to call it. When that
  review finds blocking issues, they come back as a new user turn
  containing the findings: address them and finish again. Calling
  `request_review` explicitly mid-task is still cheaper than discovering
  issues at the end of a long edit session.
- That automatic review only survives in a long-lived server (the TUI or
  `opencode serve`). Under headless `opencode run` the process exits when
  the turn ends and the in-flight review dies with it — call
  `request_review` yourself there before reporting a task complete.
- If the tool returns `NO_PROGRESS_WITH_OPEN_ISSUES`, the previous
  findings are still unresolved — actually edit code to address them
  before retrying.
- If the tool returns `ESCALATE`, stop work and surface the situation to
  the user. Do not attempt to bypass the review loop.

### What the reviewer sees

- `git diff HEAD` plus untracked, non-ignored files in the repo at `cwd`.
- The findings it produced on the previous round (if any), so it can
  verify each is resolved instead of re-flagging from scratch.
- The repo must be a git repository. If it isn't, the tool returns
  `ESCALATE` — run `git init` or move into a repo before retrying.

### Result shapes

- `GOOD_TO_GO` — no findings; safe to finish the task.
- `GOOD_TO_GO_WITH_NOTES` — only non-blocking findings (`minor`, `nit`).
  Safe to finish; consider the notes for follow-up.
- `ISSUES` — at least one **blocking** finding (`blocker` or `major`).
  Each finding has `file`, `line`, `severity`, `category`, `message`,
  optional `suggestion`. Address every blocking finding before retrying.
- `NO_CHANGES` — nothing changed since the last review; treat as
  `GOOD_TO_GO`.
- `NO_PROGRESS_WITH_OPEN_ISSUES` — payload identical to the previous
  review but blocking findings still open. Actually edit code before
  retrying.
- `ESCALATE` — the loop hit its retry cap, the repo is not reviewable,
  or a fatal error occurred. Stop and involve the user.

### Other things to know

- A localhost dashboard runs at **http://127.0.0.1:7777/** with a live
  in-flight panel, request-mix and time-by-result pie charts, the full
  archive of past reviews, a provider switcher, and a per-context
  Reset button. No auth needed — it's loopback-only.
- The plugin registers the `review` MCP server itself and notifies the
  server after every `write` / `edit` / `patch` / `bash` call, so the
  next review's "anything actually changed?" short-circuit is fast and
  accurate. No special handling required; it's transparent.
- Launch-time switches: `REVIEW_ORCH_SKIP=1` disables the plugin
  entirely; `REVIEW_ORCH_OPENCODE_PASSIVE=1` keeps the automatic review
  but reports findings as a toast instead of continuing the session.
<!-- review-orchestrator:end -->
