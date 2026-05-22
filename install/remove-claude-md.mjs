#!/usr/bin/env node
/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

// Strip the review-orchestrator marker block from ~/.claude/CLAUDE.md.
// Hand-written content outside the markers is preserved. Idempotent.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"

const BEGIN_MARKER = "<!-- review-orchestrator:begin -->"
const END_MARKER = "<!-- review-orchestrator:end -->"

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

export const removeClaudeMd = ({
    claudeMdPath,
    now = () => new Date().toISOString().replace(/[:.]/g, "-"),
    existsFn = existsSync,
    readFile = readFileSync,
    writeAtomicFn = writeAtomic,
    backup = backupIfDifferent,
}) => {
    if (!existsFn(claudeMdPath)) {
        return { action: "absent", path: claudeMdPath }
    }
    const current = readFile(claudeMdPath, "utf8")
    const begin = current.indexOf(BEGIN_MARKER)
    if (begin === -1) {
        return { action: "unchanged", path: claudeMdPath }
    }
    const end = current.indexOf(END_MARKER, begin)
    if (end === -1) {
        return { action: "unchanged", path: claudeMdPath }
    }
    const before = current.slice(0, begin).replace(/\n+$/, "")
    const after = current.slice(end + END_MARKER.length).replace(/^\n+/, "")
    let next
    if (before && after) {
        next = `${before}\n\n${after}\n`
    } else if (before) {
        next = `${before}\n`
    } else if (after) {
        next = after.endsWith("\n") ? after : `${after}\n`
    } else {
        next = ""
    }
    if (next === current) {
        return { action: "unchanged", path: claudeMdPath }
    }
    const ts = now()
    const bak = backup(claudeMdPath, next, ts)
    writeAtomicFn(claudeMdPath, next)
    return { action: "removed", path: claudeMdPath, backup: bak }
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
        const claudeMdPath = process.argv[2]
        if (!claudeMdPath) {
            process.stderr.write("usage: remove-claude-md.mjs <claudeMdPath>\n")
            process.exit(1)
        }
        const r = removeClaudeMd({ claudeMdPath })
        process.stdout.write(`${r.action}:${r.path}\n`)
    } catch (err) {
        process.stderr.write(`error:${err.message}\n`)
        process.exit(1)
    }
}
