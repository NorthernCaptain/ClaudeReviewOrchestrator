#!/usr/bin/env node
/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

// Remove our PostToolUse hook entry from ~/.claude/settings.json.
// Matches by command path so any hand-written PostToolUse hooks (and
// every other event) stay intact. Idempotent.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v)

const writeAtomic = (filePath, content) => {
    const tmp = `${filePath}.tmp`
    writeFileSync(tmp, content)
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

export const removePostToolUseHook = ({
    settingsPath,
    hookPath,
    now = () => new Date().toISOString().replace(/[:.]/g, "-"),
    existsFn = existsSync,
    readFile = readFileSync,
    writeAtomicFn = writeAtomic,
    backup = backupIfDifferent,
}) => {
    if (!existsFn(settingsPath)) {
        return { action: "absent", path: settingsPath }
    }
    const raw = readFile(settingsPath, "utf8")
    if (raw.trim() === "") {
        return { action: "unchanged", path: settingsPath }
    }
    let root
    try {
        root = JSON.parse(raw)
    } catch (err) {
        throw new Error(`failed to parse ${settingsPath}: ${err.message}`)
    }
    if (!isObj(root)) {
        throw new Error(`${settingsPath} is valid JSON but not an object`)
    }
    if (!isObj(root.hooks) || !Array.isArray(root.hooks.PostToolUse)) {
        return { action: "unchanged", path: settingsPath }
    }

    // Filter at the hook-entry level inside each matcher block.
    // Co-located user hooks survive; blocks that lose their last hook
    // are dropped.
    let removed = false
    const nextList = []
    for (const block of root.hooks.PostToolUse) {
        if (!isObj(block) || !Array.isArray(block.hooks)) {
            nextList.push(block)
            continue
        }
        const kept = block.hooks.filter((h) => h?.command !== hookPath)
        if (kept.length === block.hooks.length) {
            nextList.push(block)
        } else {
            removed = true
            if (kept.length > 0) {
                nextList.push({ ...block, hooks: kept })
            }
        }
    }
    if (!removed) {
        return { action: "unchanged", path: settingsPath }
    }

    const nextHooks = { ...root.hooks }
    if (nextList.length === 0) {
        delete nextHooks.PostToolUse
    } else {
        nextHooks.PostToolUse = nextList
    }
    const next = { ...root }
    if (Object.keys(nextHooks).length === 0) {
        delete next.hooks
    } else {
        next.hooks = nextHooks
    }
    const serialized = JSON.stringify(next, null, 2) + "\n"
    const ts = now()
    const bak = backup(settingsPath, serialized, ts)
    writeAtomicFn(settingsPath, serialized)
    return { action: "removed", path: settingsPath, backup: bak }
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
                "usage: remove-post-tool-use-hook.mjs <settingsPath> <hookPath>\n"
            )
            process.exit(1)
        }
        const r = removePostToolUseHook({ settingsPath, hookPath })
        process.stdout.write(`${r.action}:${r.path}\n`)
    } catch (err) {
        process.stderr.write(`error:${err.message}\n`)
        process.exit(1)
    }
}
