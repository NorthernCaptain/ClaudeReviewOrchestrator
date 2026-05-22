#!/usr/bin/env node
/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

// Remove only the mcpServers.review subtree from ~/.claude.json. Leaves
// every other top-level key and other MCP servers untouched. Idempotent:
// returns "unchanged" when the entry isn't present.

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

export const removeMcp = ({
    claudeJsonPath,
    now = () => new Date().toISOString().replace(/[:.]/g, "-"),
    existsFn = existsSync,
    readFile = readFileSync,
    writeAtomicFn = writeAtomic,
    backup = backupIfDifferent,
}) => {
    if (!existsFn(claudeJsonPath)) {
        return { action: "absent", path: claudeJsonPath }
    }
    const raw = readFile(claudeJsonPath, "utf8")
    if (raw.trim() === "") {
        return { action: "unchanged", path: claudeJsonPath }
    }
    let root
    try {
        root = JSON.parse(raw)
    } catch (err) {
        throw new Error(`failed to parse ${claudeJsonPath}: ${err.message}`)
    }
    if (!isObj(root)) {
        throw new Error(`${claudeJsonPath} is valid JSON but not an object`)
    }
    if (!isObj(root.mcpServers) || !("review" in root.mcpServers)) {
        return { action: "unchanged", path: claudeJsonPath }
    }
    const { review: _drop, ...keep } = root.mcpServers
    void _drop
    const next = { ...root }
    if (Object.keys(keep).length === 0) {
        delete next.mcpServers
    } else {
        next.mcpServers = keep
    }
    const serialized = JSON.stringify(next, null, 2) + "\n"
    const ts = now()
    const bak = backup(claudeJsonPath, serialized, ts)
    writeAtomicFn(claudeJsonPath, serialized)
    return { action: "removed", path: claudeJsonPath, backup: bak }
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
        const claudeJsonPath = process.argv[2]
        if (!claudeJsonPath) {
            process.stderr.write("usage: remove-mcp.mjs <claudeJsonPath>\n")
            process.exit(1)
        }
        const r = removeMcp({ claudeJsonPath })
        process.stdout.write(`${r.action}:${r.path}\n`)
    } catch (err) {
        process.stderr.write(`error:${err.message}\n`)
        process.exit(1)
    }
}
