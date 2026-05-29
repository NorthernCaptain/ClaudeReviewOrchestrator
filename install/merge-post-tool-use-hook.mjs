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

    // Operate at the hook-entry level inside each matcher block —
    // never blow away a sibling command the user put alongside ours.
    let changed = false
    let found = false
    for (let i = 0; i < list.length; i++) {
        const block = list[i]
        if (!isObj(block) || !Array.isArray(block.hooks)) continue
        const hookIdx = block.hooks.findIndex((h) => h?.command === hookPath)
        if (hookIdx === -1) continue
        found = true
        const existingEntry = block.hooks[hookIdx]
        if (JSON.stringify(existingEntry) !== JSON.stringify(ourEntry)) {
            const nextHooks = block.hooks.slice()
            nextHooks[hookIdx] = ourEntry
            list[i] = { ...block, hooks: nextHooks }
            changed = true
        }
        break
    }
    if (!found) {
        list.push(ourMatcher)
        changed = true
    }

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
