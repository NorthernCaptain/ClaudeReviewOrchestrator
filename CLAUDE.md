# Claude Development Guide — Review Orchestrator

This project is an automatic code-review loop for Claude Code, using Codex
CLI as the reviewer. See [README.md](README.md) for full architecture and
the phased implementation plan — read it before making non-trivial changes.

## What this project is

- A local Node.js service that runs `codex exec --sandbox read-only` against
  the current git changes and returns either `GOOD-TO-GO` or a structured
  list of findings.
- An HTTP MCP endpoint Claude calls via the `request_review` tool.
- A `Stop` hook that triggers reviews automatically when Claude tries to end
  a turn, and keeps blocking until the server returns a terminal status.
- A persistent on-disk archive of every review under `reviews/<repo>:<branch>/`.

## What this project is NOT

- Not a project that consumes its own review loop while being developed. The
  `claude-md-snippet.md` and `claude-mcp.json` here are templates the
  installer drops into user-level Claude config; they do not apply when
  working in this repo.
- Not multi-user, not cross-machine, not a replacement for PR review.

## Tech stack

- **Runtime:** Node.js 24 (ESM, `"type": "module"`).
- **Server:** Express.
- **MCP:** `@modelcontextprotocol/sdk` HTTP transport.
- **Logging:** pino.
- **Tests:** Jest, ≥90% coverage. Test files live next to the code they
  cover as `<name>.test.js`.
- **Formatting:** Prettier (see `.prettierrc.json`). 4-space indent, no
  semicolons, double quotes, 80-col width, trailing commas `es5`.
- **Linting:** ESLint with `eslint:recommended` + `node` + `@typescript-eslint`
  + `prettier` + `unused-imports` (see `.eslintrc.json`). `prettier/prettier`
  is an `error`.

## Layout

See "Phase 0 — Repo scaffolding" in [README.md](README.md). Briefly:

```
server/src/           // implementation modules
server/test/          // jest (test files live alongside sources)
hooks/                // bash Stop hook
launchd/              // launchd plist for the server
claude-mcp.json       // MCP entry — installed into ~/.claude.json
claude-md-snippet.md  // guidance text — appended to ~/.claude/CLAUDE.md
install.sh            // sets up launchd + hook + Claude config edits
```

`reviews/` is generated at runtime — do not commit it. `node_modules/`,
`coverage/`, and persisted state under `~/.cache/review-orchestrator/` are
also ignored.

## Conventions

- **Copyright header** on every source file (per global rules). Format:
  ```js
  /**
   * Copyright AlpineReplay Inc, 2026. All rights reserved.
   * Author: Leo Khramov
   */
  ```
  If editing an existing file with an older header, update the year and
  ensure Leo Khramov is listed. JSON and shell-config files don't need
  headers.
- **No Python.** Scripts are bash or Node 24.
- **macOS-compatible shell.** BSD userland, `#!/usr/bin/env bash`, no
  GNU-only flags.
- **No new files** unless the architecture in README.md calls for them.
  Prefer editing existing modules.
- **Comments are rare.** Only when the WHY is non-obvious. Never narrate
  what well-named code already says.

## Testing

- Jest, mock the Codex subprocess and the filesystem where practical.
- Each module gets a sibling `<name>.test.js`.
- Aim for ≥90% statement coverage; track via `npm run test:coverage`.
- Tests must not invoke the real `codex` binary or touch
  `~/.claude/` / `~/.cache/`.

## Running locally

```bash
npm install
npm start                    # server on http://127.0.0.1:7777
npm test
npm run lint
npm run format
```

A separate `install.sh` is responsible for putting the server under
launchd and wiring the user-level Claude config. Don't run it as part of
development — use `npm start` in the foreground for iteration.

## When the architecture is unclear

Re-read [README.md](README.md). The phased plan, decisions, and deferred
items are spelled out there. If a question isn't answered in the README,
ask the user before improvising — this project's whole purpose is to make
review explicit, so the design should be explicit too.
