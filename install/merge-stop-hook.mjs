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
//             { "type": "command", "command": "<hookPath>", "timeout": 1320 }
//           ]
//         }
//       ]
//     }
//   }

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
// MAX_FETCH_TIMEOUT_MS is the hard ceiling the Stop hook clamps its own
// fetch wait to (regardless of config). We bake the harness timeout one
// buffer above THAT — a fixed value, NOT derived from the install-time
// config. resolveFetchTimeoutMs clamps to this ceiling, so this static
// harness timeout always sits above the hook's actual wait for any
// config, even after the operator raises the reviewer timeout without
// rerunning the installer. Single shared constant, no drift.
import { MAX_FETCH_TIMEOUT_MS } from "../hooks/stop-review.mjs"

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v)

// Seconds the installed Claude Code hook `timeout` keeps ABOVE the
// hook's hard wait ceiling. Claude Code kills the hook process at this
// timeout no matter what; keeping it above the (clamped) fetch ceiling
// guarantees the hook aborts cleanly first and a long review is never
// cut off mid-flight. Static and config-independent by construction:
//   reviewer (≤cap) +60 → hook wait (≤ceiling) +60 → harness.
const HARNESS_BUFFER_SECONDS = 60
export const HARNESS_TIMEOUT_SECONDS =
    MAX_FETCH_TIMEOUT_MS / 1000 + HARNESS_BUFFER_SECONDS // 1800 (30 min)

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
    // The Claude Code hook `timeout`, in SECONDS (that is the unit
    // Claude Code reads — its own default is 600s). A fixed value, set
    // one buffer above the hook's hard wait ceiling, so it never needs
    // to track per-install config: the hook clamps its own wait to that
    // ceiling, so this stays above the actual wait for any config.
    //
    // NOTE: an earlier version hard-coded 720000 — written as if this
    // field were milliseconds (720000ms = 12min), but Claude Code reads
    // SECONDS, so it silently became ~200 hours and never backstopped.
    timeout = HARNESS_TIMEOUT_SECONDS,
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
        // Within-block dedupe: strip EVERY entry whose command is ours,
        // then add back exactly one refreshed `ourEntry` at the
        // position of the first occurrence (or appended if there
        // wasn't one). Siblings keep their original order; second-
        // and-later dupes of our command are dropped — without this
        // a canonical block carrying our hook twice would still fire
        // twice after the merge.
        const firstIdx = blockHooks.findIndex((h) => h?.command === hookPath)
        let nextHooks
        if (firstIdx === -1) {
            nextHooks = [...blockHooks, ourEntry]
        } else {
            nextHooks = []
            for (let i = 0; i < blockHooks.length; i++) {
                const h = blockHooks[i]
                if (h?.command !== hookPath) {
                    nextHooks.push(h)
                    continue
                }
                if (i === firstIdx) nextHooks.push(ourEntry)
                // else: drop dupes
            }
        }
        if (JSON.stringify(nextHooks) !== JSON.stringify(blockHooks)) {
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
