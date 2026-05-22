#!/usr/bin/env node
/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

// Add the Stop hook entry to ~/.claude/settings.json. Idempotent: if a
// Stop-event handler with the matching `command` path already exists, we
// leave the file alone. Other Stop handlers are preserved verbatim.
//
// Schema shape (per Claude Code's hooks contract):
//   {
//     "hooks": {
//       "Stop": [
//         {
//           "matcher": "",
//           "hooks": [
//             { "type": "command", "command": "<hookPath>", "timeout": 300000 }
//           ]
//         }
//       ]
//     }
//   }

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v)

const writeAtomic = (filePath, content, mode = 0o644) => {
    const tmp = `${filePath}.tmp`
    writeFileSync(tmp, content, { mode })
    renameSync(tmp, filePath)
}

const backupIfDifferent = (filePath, newContent, nowStr) => {
    if (!existsSync(filePath)) return null
    const current = readFileSync(filePath, "utf8")
    if (current === newContent) return null
    const bak = `${filePath}.bak.${nowStr}`
    writeFileSync(bak, current)
    return bak
}

// True iff the given Stop matcher block contains a `hooks[].command`
// pointing at the install target path.
const matcherTargetsHook = (matcher, hookPath) => {
    if (!isObj(matcher) || !Array.isArray(matcher.hooks)) return false
    for (const h of matcher.hooks) {
        if (h?.command === hookPath) return true
    }
    return false
}

export const mergeStopHook = ({
    settingsPath,
    hookPath,
    timeout = 300000,
    now = () => new Date().toISOString().replace(/[:.]/g, "-"),
    existsFn = existsSync,
    readFile = readFileSync,
    writeAtomicFn = writeAtomic,
    backup = backupIfDifferent,
}) => {
    const ourMatcher = {
        matcher: "",
        hooks: [
            {
                type: "command",
                command: hookPath,
                timeout,
            },
        ],
    }

    let root = {}
    let existed = existsFn(settingsPath)
    if (existed) {
        const raw = readFile(settingsPath, "utf8")
        if (raw.trim() === "") {
            root = {}
        } else {
            try {
                root = JSON.parse(raw)
            } catch (err) {
                throw new Error(
                    `failed to parse ${settingsPath}: ${err.message}`
                )
            }
            if (!isObj(root)) {
                throw new Error(
                    `${settingsPath} is valid JSON but not an object`
                )
            }
        }
    }

    const hooks = isObj(root.hooks) ? { ...root.hooks } : {}
    const stopList = Array.isArray(hooks.Stop) ? [...hooks.Stop] : []

    // Already present?
    const existingIdx = stopList.findIndex((m) =>
        matcherTargetsHook(m, hookPath)
    )
    if (existingIdx !== -1) {
        // Compare deeply against ourMatcher; if identical → unchanged.
        if (
            JSON.stringify(stopList[existingIdx]) === JSON.stringify(ourMatcher)
        ) {
            return { action: "unchanged", path: settingsPath }
        }
        // Existing entry points at our hook but with different shape (e.g.
        // older timeout) — refresh it.
        stopList[existingIdx] = ourMatcher
    } else {
        stopList.push(ourMatcher)
    }

    hooks.Stop = stopList
    const next = { ...root, hooks }
    const serialized = JSON.stringify(next, null, 2) + "\n"
    const ts = now()
    const bak = backup(settingsPath, serialized, ts)
    writeAtomicFn(settingsPath, serialized)
    return {
        action: existed ? "updated" : "installed",
        path: settingsPath,
        backup: bak,
    }
}

/* istanbul ignore next */
const isDirectInvocation = () => {
    if (!process.argv[1]) return false
    if (!import.meta.url.startsWith("file:")) return false
    return import.meta.url.endsWith(path.basename(process.argv[1]))
}

/* istanbul ignore next */
if (isDirectInvocation()) {
    try {
        const settingsPath = process.argv[2]
        const hookPath = process.argv[3]
        if (!settingsPath || !hookPath) {
            process.stderr.write(
                "usage: merge-stop-hook.mjs <settingsPath> <hookPath>\n"
            )
            process.exit(1)
        }
        const r = mergeStopHook({ settingsPath, hookPath })
        process.stdout.write(`${r.action}:${r.path}\n`)
    } catch (err) {
        process.stderr.write(`error:${err.message}\n`)
        process.exit(1)
    }
}
