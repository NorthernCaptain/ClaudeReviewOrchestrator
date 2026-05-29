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
    //   1. Remove our hook from any block whose matcher is NOT
    //      `matcherPattern` (preserving any sibling hooks in that
    //      block; dropping empty blocks). Otherwise an old/stale
    //      matcher like "Write|Edit" would silently leave us off
    //      MultiEdit — the bug codex flagged.
    //   2. Locate (or create) a canonical block whose matcher IS
    //      `matcherPattern`; refresh / append our entry there.
    //      Sibling hooks already inside that canonical block stay.
    let changed = false
    const reindexed = []
    for (const block of list) {
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
        // Wrong-matcher block: strip our hook, keep the rest.
        const kept = block.hooks.filter((h) => h?.command !== hookPath)
        if (kept.length > 0) {
            reindexed.push({ ...block, hooks: kept })
        }
        // else: block emptied by our removal — drop it.
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
    // Replace `list` content in place with the new layout.
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
