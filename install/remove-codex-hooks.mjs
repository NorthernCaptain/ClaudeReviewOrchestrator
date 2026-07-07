#!/usr/bin/env node
/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

// Remove our Stop + PostToolUse hook entries from ~/.codex/hooks.json.
// Matches by command path so hand-written hooks (and any other event)
// stay intact. Empty blocks (where ours was the only hook) are pruned,
// and an event left with no blocks is dropped. Idempotent.

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

// Strip every hook entry whose command is in `commands` from one event's
// block array, pruning emptied blocks. Returns { list, removed }.
const stripEvent = (rawList, commands) => {
    if (!Array.isArray(rawList)) return { list: rawList, removed: false }
    let removed = false
    const next = []
    for (const block of rawList) {
        if (!isObj(block) || !Array.isArray(block.hooks)) {
            next.push(block)
            continue
        }
        const kept = block.hooks.filter((h) => !commands.includes(h?.command))
        if (kept.length === block.hooks.length) {
            next.push(block)
        } else {
            removed = true
            if (kept.length > 0) next.push({ ...block, hooks: kept })
        }
    }
    return { list: next, removed }
}

export const removeCodexHooks = ({
    hooksJsonPath,
    stopHookPath,
    notifyHookPath,
    now = () => new Date().toISOString().replace(/[:.]/g, "-"),
    existsFn = existsSync,
    readFile = readFileSync,
    writeAtomicFn = writeAtomic,
    backup = backupIfDifferent,
}) => {
    if (!existsFn(hooksJsonPath)) {
        return { action: "absent", path: hooksJsonPath }
    }
    const raw = readFile(hooksJsonPath, "utf8")
    if (raw.trim() === "") {
        return { action: "unchanged", path: hooksJsonPath }
    }
    let root
    try {
        root = JSON.parse(raw)
    } catch (err) {
        throw new Error(`failed to parse ${hooksJsonPath}: ${err.message}`)
    }
    if (!isObj(root)) {
        throw new Error(`${hooksJsonPath} is valid JSON but not an object`)
    }

    const next = { ...root }
    let removed = false
    for (const [event, command] of [
        ["Stop", stopHookPath],
        ["PostToolUse", notifyHookPath],
    ]) {
        if (!Array.isArray(root[event])) continue
        const res = stripEvent(root[event], [command])
        if (!res.removed) continue
        removed = true
        if (res.list.length === 0) delete next[event]
        else next[event] = res.list
    }

    if (!removed) {
        return { action: "unchanged", path: hooksJsonPath }
    }
    const serialized = JSON.stringify(next, null, 2) + "\n"
    const ts = now()
    const bak = backup(hooksJsonPath, serialized, ts)
    writeAtomicFn(hooksJsonPath, serialized)
    return { action: "removed", path: hooksJsonPath, backup: bak }
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
        const hooksJsonPath = process.argv[2]
        const stopHookPath = process.argv[3]
        const notifyHookPath = process.argv[4]
        if (!hooksJsonPath || !stopHookPath || !notifyHookPath) {
            process.stderr.write(
                "usage: remove-codex-hooks.mjs <hooksJsonPath> <stopHookPath> <notifyHookPath>\n"
            )
            process.exit(1)
        }
        const r = removeCodexHooks({
            hooksJsonPath,
            stopHookPath,
            notifyHookPath,
        })
        process.stdout.write(`${r.action}:${r.path}\n`)
    } catch (err) {
        process.stderr.write(`error:${err.message}\n`)
        process.exit(1)
    }
}
