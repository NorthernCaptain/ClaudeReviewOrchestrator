#!/usr/bin/env node
/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

// Claude Code PostToolUse hook for the review orchestrator.
//
// Wire it from ~/.claude/settings.json like:
//   {
//     "hooks": {
//       "PostToolUse": [{
//         "matcher": "Write|Edit|MultiEdit",
//         "hooks": [{
//           "type": "command",
//           "command": "node ~/.claude/hooks/notify-change.mjs",
//           "timeout": 3000
//         }]
//       }]
//     }
//   }
//
// Every matched tool call sends a fire-and-forget POST to the local
// server's /notify-change endpoint with `{cwd, tool, file}`. The
// server flips the context's dirtySinceLastReview flag so the next
// Stop-hook /review can fast-path to NO_CHANGES when nothing has
// actually been edited.
//
// Must be FAST and silent — it fires on every Write/Edit/MultiEdit.
// All errors are swallowed; the hook never blocks Claude's tool
// execution or pollutes the user's CLI output. The request goes through
// the shared signed client (signed-client.mjs, installed next to this
// file), like the Stop hook's.

import path from "node:path"
import { connect as connectSignedServer } from "./signed-client.mjs"

const REQUEST_TIMEOUT_MS = 2000
const CHALLENGE_TIMEOUT_MS = 1000

const readStdinJSON = async (stdin) => {
    let buf = ""
    for await (const chunk of stdin) {
        buf += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk)
    }
    if (!buf.trim()) return {}
    return JSON.parse(buf)
}

const main = async ({
    stdin = process.stdin,
    connect = connectSignedServer,
} = {}) => {
    let payload
    try {
        payload = await readStdinJSON(stdin)
    } catch {
        return 0
    }
    const cwd = payload?.cwd
    if (typeof cwd !== "string" || cwd.length === 0) return 0

    try {
        const conn = await connect({ challengeTimeoutMs: CHALLENGE_TIMEOUT_MS })
        if (!conn.ok) return 0
        // Server down, timeout or an unverified answer: nothing to do. The
        // Stop hook's slow path covers it (dirty stays as it was).
        await conn.request({
            method: "POST",
            path: "/notify-change",
            body: {
                cwd,
                tool: payload?.tool_name ?? null,
                file: payload?.tool_input?.file_path ?? null,
            },
            timeoutMs: REQUEST_TIMEOUT_MS,
        })
    } catch {
        // never break the user's session
    }
    return 0
}

/* istanbul ignore next -- executable guard exercised by smoke test only */
const isDirectInvocation = () => {
    if (!process.argv[1]) return false
    if (!import.meta.url.startsWith("file:")) return false
    return import.meta.url.endsWith(path.basename(process.argv[1]))
}

/* istanbul ignore next */
if (isDirectInvocation()) {
    main().then((code) => {
        process.exitCode = code
    })
}

export { main as __main_for_tests }
