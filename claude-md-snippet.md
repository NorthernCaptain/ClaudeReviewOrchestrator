<!-- review-orchestrator:begin -->
## Code review loop

A local review orchestrator is available via the `review` MCP server. It
runs Codex CLI as a meticulous read-only reviewer over your current git
changes and either approves them or returns a structured list of issues.

### How to use it

- Before declaring a coding task complete, call the `request_review` MCP
  tool. Address every finding it returns, then call `request_review` again.
  Repeat until it returns `GOOD_TO_GO`.
- When starting a fresh, unrelated coding task, call `reset_review_context`
  first so the retry counter and prior-findings cache start clean.
- A `Stop` hook also runs `request_review` automatically when you try to
  end a turn — you don't have to remember to call it. But calling it
  explicitly mid-task is cheaper than discovering issues at the end of a
  long edit session.
- If `request_review` returns `ESCALATE`, stop work and surface the
  situation to the user. Do not attempt to bypass the review loop.

### What the reviewer sees

- `git diff HEAD` plus any untracked, non-ignored files in the current
  working directory's repo.
- The findings it produced on the previous round (if any), so it can
  verify each one is resolved instead of re-flagging from scratch.
- The repo must be a git repository. If it isn't, the tool returns
  `ESCALATE` — run `git init` or move into a repo before retrying.

### Result shapes

- `GOOD_TO_GO` — no issues found; safe to finish the task.
- `ISSUES` — array of findings with `file`, `line`, `severity`
  (`blocker` | `major` | `minor` | `nit`), `category`, `message`, optional
  `suggestion`. Address all `blocker` and `major` items at minimum.
- `NO_CHANGES` — nothing changed since the last review; treat as
  `GOOD_TO_GO`.
- `ESCALATE` — the loop hit its retry cap or a fatal error. Stop and
  involve the user.
<!-- review-orchestrator:end -->
