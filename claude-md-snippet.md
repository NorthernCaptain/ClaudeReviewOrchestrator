<!-- review-orchestrator:begin -->
## Code review loop

A local review orchestrator is available via the `review` MCP server. It
runs Codex CLI as a meticulous read-only reviewer over your current git
changes and either approves them or returns a structured list of issues.

### Calling the tools

Both tools require a `cwd` input — pass the **current working directory of
this session** (the absolute path you'd see from `pwd`). The server uses
`cwd` to resolve the repo root and the active branch.

- `request_review({ cwd, extra_instructions? })` — run a review now.
- `reset_review_context({ cwd })` — clear the retry counter and
  prior-findings cache for this repo+branch. Call this when starting a
  fresh, unrelated coding task.

### How to use it

- Before declaring a coding task complete, call `request_review`. Address
  every **blocking** finding (`severity: blocker` or `major`), then call
  `request_review` again. `minor` and `nit` findings are informational —
  fix them if quick, ignore otherwise. Repeat until the tool returns
  `GOOD_TO_GO`.
- A `Stop` hook also runs `request_review` automatically when you try to
  end a turn — you don't have to remember to call it. Calling it
  explicitly mid-task is still cheaper than discovering issues at the end
  of a long edit session.
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
<!-- review-orchestrator:end -->
