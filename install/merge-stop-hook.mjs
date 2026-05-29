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

    // Plan:
    //   1. Remove our hook from any block whose matcher is NOT the
    //      canonical "" (preserving siblings; dropping empty blocks).
    //      A user who tucked our hook under a narrow matcher would
    //      otherwise stop firing on Stop events that don't match.
    //   2. Locate (or create) a block whose matcher IS "" and
    //      refresh / append our entry there. Sibling hooks already
    //      inside the canonical block stay.
    let changed = false
    const reindexed = []
    for (const block of stopList) {
        if (!isObj(block) || !Array.isArray(block.hooks)) {
            reindexed.push(block)
            continue
        }
        const isCanonical = block.matcher === matcherPattern
        const hasOurs = block.hooks.some((h) => h?.command === hookPath)
        if (!hasOurs || isCanonical) {
            reindexed.push(block)
            continue
        }
        const kept = block.hooks.filter((h) => h?.command !== hookPath)
        if (kept.length > 0) {
            reindexed.push({ ...block, hooks: kept })
        }
        changed = true
    }

    let canonicalIdx = reindexed.findIndex(
        (b) => isObj(b) && b.matcher === matcherPattern
    )
    if (canonicalIdx === -1) {
        reindexed.push(ourMatcher)
        changed = true
    } else {
        const block = reindexed[canonicalIdx]
        const blockHooks = Array.isArray(block.hooks) ? block.hooks : []
        const hookIdx = blockHooks.findIndex((h) => h?.command === hookPath)
        if (hookIdx === -1) {
            reindexed[canonicalIdx] = {
                ...block,
                hooks: [...blockHooks, ourEntry],
            }
            changed = true
        } else if (
            JSON.stringify(blockHooks[hookIdx]) !== JSON.stringify(ourEntry)
        ) {
            const nextHooks = blockHooks.slice()
            nextHooks[hookIdx] = ourEntry
            reindexed[canonicalIdx] = { ...block, hooks: nextHooks }
            changed = true
        }
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
