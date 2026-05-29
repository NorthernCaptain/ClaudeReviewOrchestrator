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

export const mergeStopHook = ({
    settingsPath,
    hookPath,
    // 12 minutes. Codex high-effort reviews on a large repo can run
    // 2–5 minutes; multiple rounds plus the server's own wait push
    // total Stop-hook time toward 10+. Claude Code kills the hook
    // process at this timeout regardless of what the server is doing,
    // so this needs to be larger than any realistic review.
    timeout = 720000,
    now = () => new Date().toISOString().replace(/[:.]/g, "-"),
    existsFn = existsSync,
    readFile = readFileSync,
    writeAtomicFn = writeAtomic,
    backup = backupIfDifferent,
}) => {
    const ourEntry = { type: "command", command: hookPath, timeout }
    const ourMatcher = { matcher: "", hooks: [ourEntry] }

    let root = {}
    const existed = existsFn(settingsPath)
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

    const matcherPattern = ""
    const hooks = isObj(root.hooks) ? { ...root.hooks } : {}
    const stopList = Array.isArray(hooks.Stop) ? hooks.Stop.map((m) => m) : []

    // Same plan as the PostToolUse merger (see notes there). Summary:
    //   1. Prefer a canonical (matcher === "") block that already
    //      contains our hook; fall back to the first canonical block;
    //      fall back to appending a fresh one. ONE preferred home.
    //   2. Strip our hook from every other block (canonical or not),
    //      preserving siblings and dropping emptied blocks. This
    //      collapses the duplicate-install case where a stop event
    //      fires twice because two canonical blocks each contain our
    //      hook.
    //   3. Refresh / append our entry inside the preferred block.
    const isCanonical = (b) => isObj(b) && b.matcher === matcherPattern
    const hasOurs = (b) =>
        Array.isArray(b?.hooks) && b.hooks.some((h) => h?.command === hookPath)
    let preferredIdx = stopList.findIndex((b) => isCanonical(b) && hasOurs(b))
    if (preferredIdx === -1) preferredIdx = stopList.findIndex(isCanonical)
    const preferredRef = preferredIdx !== -1 ? stopList[preferredIdx] : null

    let changed = false
    const reindexed = []
    stopList.forEach((block, i) => {
        if (i === preferredIdx) {
            reindexed.push(block)
            return
        }
        if (!isObj(block) || !Array.isArray(block.hooks) || !hasOurs(block)) {
            reindexed.push(block)
            return
        }
        const kept = block.hooks.filter((h) => h?.command !== hookPath)
        if (kept.length > 0) {
            reindexed.push({ ...block, hooks: kept })
        }
        changed = true
    })

    if (preferredRef) {
        const where = reindexed.indexOf(preferredRef)
        const block = reindexed[where]
        const blockHooks = Array.isArray(block.hooks) ? block.hooks : []
        const hookIdx = blockHooks.findIndex((h) => h?.command === hookPath)
        if (hookIdx === -1) {
            reindexed[where] = { ...block, hooks: [...blockHooks, ourEntry] }
            changed = true
        } else if (
            JSON.stringify(blockHooks[hookIdx]) !== JSON.stringify(ourEntry)
        ) {
            const nextHooks = blockHooks.slice()
            nextHooks[hookIdx] = ourEntry
            reindexed[where] = { ...block, hooks: nextHooks }
            changed = true
        }
    } else {
        reindexed.push(ourMatcher)
        changed = true
    }

    stopList.length = 0
    stopList.push(...reindexed)

    if (!changed) {
        return { action: "unchanged", path: settingsPath }
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
