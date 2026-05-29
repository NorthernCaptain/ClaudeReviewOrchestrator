#!/usr/bin/env node
/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

// Add the PostToolUse hook entry to ~/.claude/settings.json. Mirrors
// merge-stop-hook.mjs but hardcodes event="PostToolUse",
// matcher="Write|Edit|MultiEdit", timeout=3000 — the trio the
// notify-change.mjs hook expects. Idempotent: if a matcher block with
// the matching `command` path already exists for PostToolUse, the file
// is left alone. Other PostToolUse handlers (and every other event)
// are preserved.

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

export const mergePostToolUseHook = ({
    settingsPath,
    hookPath,
    timeout = 3000,
    matcherPattern = "Write|Edit|MultiEdit",
    now = () => new Date().toISOString().replace(/[:.]/g, "-"),
    existsFn = existsSync,
    readFile = readFileSync,
    writeAtomicFn = writeAtomic,
    backup = backupIfDifferent,
}) => {
    const ourEntry = { type: "command", command: hookPath, timeout }
    const ourMatcher = { matcher: matcherPattern, hooks: [ourEntry] }

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

    const hooks = isObj(root.hooks) ? { ...root.hooks } : {}
    const list = Array.isArray(hooks.PostToolUse)
        ? hooks.PostToolUse.map((m) => m)
        : []

    // Plan:
    //   1. Pick ONE preferred home for our hook — a canonical-matcher
    //      block that already contains it; failing that, the first
    //      canonical block; failing that, append a new one.
    //   2. Strip our hook from every OTHER block (canonical or not).
    //      Siblings inside those blocks stay; blocks emptied by the
    //      strip are dropped. This collapses the duplicate-install
    //      case (an installer-owned block + a user-owned canonical
    //      block both containing our hook → two Stop hook fires).
    //   3. Refresh our entry inside the preferred block to the
    //      current { type, command, timeout } shape; append it if the
    //      preferred block is canonical but doesn't yet contain it.
    const isCanonical = (b) => isObj(b) && b.matcher === matcherPattern
    const hasOurs = (b) =>
        Array.isArray(b?.hooks) && b.hooks.some((h) => h?.command === hookPath)
    let preferredIdx = list.findIndex((b) => isCanonical(b) && hasOurs(b))
    if (preferredIdx === -1) preferredIdx = list.findIndex(isCanonical)
    const preferredRef = preferredIdx !== -1 ? list[preferredIdx] : null

    let changed = false
    const reindexed = []
    list.forEach((block, i) => {
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
        // Within-block dedupe: drop every entry whose command is ours
        // and reinsert exactly one refreshed `ourEntry` at the first
        // occurrence (or append if none). Without this a block
        // carrying our hook twice would still fire it twice after
        // merge.
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

    list.length = 0
    list.push(...reindexed)

    if (!changed) {
        return { action: "unchanged", path: settingsPath }
    }

    hooks.PostToolUse = list
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
                "usage: merge-post-tool-use-hook.mjs <settingsPath> <hookPath>\n"
            )
            process.exit(1)
        }
        const r = mergePostToolUseHook({ settingsPath, hookPath })
        process.stdout.write(`${r.action}:${r.path}\n`)
    } catch (err) {
        process.stderr.write(`error:${err.message}\n`)
        process.exit(1)
    }
}
