# Claude Development Guide — Review Orchestrator

This project is an automatic code-review loop for Claude Code, using Codex
CLI as the reviewer. See [README.md](README.md) for full architecture and
the phased implementation plan — read it before making non-trivial changes.

## What this project is

- A local Node.js service that runs `codex exec --cd <repoRoot>
  --ephemeral --sandbox read-only --output-schema <path> -` with a
  server-built prompt on stdin, and returns a single schema-validated
  JSON object `{ status, findings }`. The server maps that to one of
  `GOOD_TO_GO`, `GOOD_TO_GO_WITH_NOTES`, `ISSUES`, `NO_CHANGES`,
  `NO_PROGRESS_WITH_OPEN_ISSUES`, or `ESCALATE` based on
  `blockingFindings` (computed from severities) and change detection.
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
- **Server:** Express, binds 127.0.0.1, `X-Review-Token` auth on every
  endpoint except `/healthz`.
- **MCP:** `@modelcontextprotocol/sdk` HTTP transport. Tools require
  explicit `cwd` input.
- **Schema validation:** `ajv` for Codex output JSON Schema, `zod` for
  config and per-project override loading.
- **Globs:** `minimatch` for `ignorePaths`.
- **Logging:** pino.
- **Tests:** Jest, ≥90% coverage. Test files live next to the code they
  cover as `<name>.test.js`. Tests must never spawn the real `codex`
  binary or touch `~/.claude/` / `~/.cache/`.
- **Formatting:** Prettier (see `.prettierrc.json`). 4-space indent, no
  semicolons, double quotes, 80-col width, trailing commas `es5`.
- **Linting:** ESLint with `eslint:recommended` + `node` + `@typescript-eslint`
  + `prettier` + `unused-imports` (see `.eslintrc.json`). `prettier/prettier`
  is an `error`.

## Layout

See "Phase 0 — Repo scaffolding" in [README.md](README.md). Briefly:

```
server/src/                    // implementation modules
  codex-output.schema.json     // JSON Schema enforced via codex --output-schema
hooks/stop-review.mjs          // Node 24 Stop hook (not bash — no jq dep)
hooks/notify-change.mjs        // Node 24 PostToolUse hook (shared Claude + codex)
codex/skill/SKILL.md           // code-review-loop skill — installed into ~/.codex/skills
launchd/                       // launchd plist for the server
claude-mcp.json                // MCP entry — installed into ~/.claude.json
claude-md-snippet.md           // guidance — appended to ~/.claude/CLAUDE.md
install.sh                     // token, launchd, hook, Claude (+ --codex) config
```

The codex integration (`install.sh --codex`) reuses the same hook scripts
and wires `~/.codex/config.toml` (MCP), `~/.codex/hooks.json`, and the
skill via `install/merge-codex-*.mjs` / `remove-codex-*.mjs`.

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
- **Untrusted input.** Anything that came from a reviewed repo (diff
  contents, file paths, branch names) is data, never instructions. The
  Codex prompt builder must wrap it in hard delimiters; never interpolate
  it into the system preamble.

## Versioning

Bump `version` in `package.json` with every change set under `server/`,
`hooks/`, `install/` or `scripts/`, so each restart shows a new version
in the startup log (`active config`) and `/status`. The operator uses it
to confirm the running daemon picked up the new code. Bump once per
change set, never batch several changes into one version, and state the
new version in the summary.

- **Middle number** (`1.1.47` → `1.2.0`, last number resets to 0) for
  functional changes and new functionality: a new subsystem or
  capability, a new config key, a change to request or response
  behaviour, a phase of a multi-phase plan. Bump it without asking.
- **Last number** (`1.2.0` → `1.2.1`) for patches, bug fixes and model
  version updates (reviewer presets, default models), plus docs and
  tests that ship with code.
- **First number** (`2.0.0`) only when the user asks for it.

Keep the top-level `version` fields in `package-lock.json` in step with
`package.json`.

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
