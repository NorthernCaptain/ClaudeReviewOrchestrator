#!/usr/bin/env node
/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

// Remove our Stop hook entry from ~/.claude/settings.json. Matches by
// command path so hand-written Stop hooks (and any other event hooks)
// stay intact. Idempotent.

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

const matcherTargetsHook = (matcher, hookPath) => {
    if (!isObj(matcher) || !Array.isArray(matcher.hooks)) return false
    return matcher.hooks.some((h) => h?.command === hookPath)
}

export const removeStopHook = ({
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
    if (!isObj(root.hooks) || !Array.isArray(root.hooks.Stop)) {
        return { action: "unchanged", path: settingsPath }
    }

    const filtered = root.hooks.Stop.filter(
        (m) => !matcherTargetsHook(m, hookPath)
    )
    if (filtered.length === root.hooks.Stop.length) {
        return { action: "unchanged", path: settingsPath }
    }

    const nextHooks = { ...root.hooks }
    if (filtered.length === 0) {
        delete nextHooks.Stop
    } else {
        nextHooks.Stop = filtered
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
                "usage: remove-stop-hook.mjs <settingsPath> <hookPath>\n"
            )
            process.exit(1)
        }
        const r = removeStopHook({ settingsPath, hookPath })
        process.stdout.write(`${r.action}:${r.path}\n`)
    } catch (err) {
        process.stderr.write(`error:${err.message}\n`)
        process.exit(1)
    }
}
