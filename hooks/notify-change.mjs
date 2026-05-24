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
// execution or pollutes the user's CLI output.

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

const CONFIG_PATH = () =>
    path.join(homedir(), ".config", "review-orchestrator", "config.json")
const DEFAULT_PORT = 7777
const DEFAULT_BIND = "127.0.0.1"
const REQUEST_TIMEOUT_MS = 2000

// Same bind→host mapping the Stop hook uses. Keep them in sync.
const clientHostFromBind = (bind) => {
    if (!bind || bind === "0.0.0.0") return "127.0.0.1"
    if (bind === "::" || bind === "::1") return "[::1]"
    if (bind.startsWith("[")) return bind
    const colons = (bind.match(/:/g) ?? []).length
    if (colons >= 2) return `[${bind}]`
    return bind
}

const readEndpoint = () => {
    try {
        const raw = readFileSync(CONFIG_PATH(), "utf8")
        const cfg = JSON.parse(raw)
        if (!cfg?.authToken) return null
        const port = Number.isInteger(cfg.port) ? cfg.port : DEFAULT_PORT
        const bind =
            typeof cfg.bind === "string" && cfg.bind.length > 0
                ? cfg.bind
                : DEFAULT_BIND
        return {
            token: cfg.authToken,
            url: `http://${clientHostFromBind(bind)}:${port}/notify-change`,
        }
    } catch {
        return null
    }
}

const readStdinJSON = async () => {
    let buf = ""
    for await (const chunk of process.stdin) {
        buf += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk)
    }
    if (!buf.trim()) return {}
    return JSON.parse(buf)
}

const main = async () => {
    let payload
    try {
        payload = await readStdinJSON()
    } catch {
        return 0
    }
    const cwd = payload?.cwd
    if (typeof cwd !== "string" || cwd.length === 0) return 0

    const ep = readEndpoint()
    if (!ep) return 0

    const body = {
        cwd,
        tool: payload?.tool_name ?? null,
        file: payload?.tool_input?.file_path ?? null,
    }

    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS)
    try {
        await fetch(ep.url, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-review-token": ep.token,
            },
            body: JSON.stringify(body),
            signal: ctl.signal,
        })
    } catch {
        // Server down / timeout / network. Swallow — the Stop hook's
        // existing slow-path covers this case correctly (dirty stays
        // at its current value).
    } finally {
        clearTimeout(timer)
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

export {
    main as __main_for_tests,
    readEndpoint as __readEndpoint_for_tests,
    clientHostFromBind as __clientHostFromBind_for_tests,
}
