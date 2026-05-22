#!/usr/bin/env node
/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

// Add/replace the mcpServers.review subtree in ~/.claude.json, leaving
// every other key (and other MCP servers) intact. Idempotent.
//
// Status lines:
//   installed:<path>  — file did not exist, created with our entry
//   updated:<path>    — file existed; our entry was added or replaced
//   unchanged:<path>  — file existed; review entry already matched

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v)

const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b)

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

export const mergeMcp = ({
    claudeJsonPath,
    headersHelperPath,
    port = 7777,
    bind = "127.0.0.1",
    now = () => new Date().toISOString().replace(/[:.]/g, "-"),
    existsFn = existsSync,
    readFile = readFileSync,
    writeAtomicFn = writeAtomic,
    backup = backupIfDifferent,
}) => {
    const desired = {
        type: "http",
        url: `http://${bind}:${port}/mcp`,
        headersHelper: headersHelperPath,
    }

    let root = {}
    let existed = existsFn(claudeJsonPath)
    if (existed) {
        const raw = readFile(claudeJsonPath, "utf8")
        if (raw.trim() === "") {
            root = {}
        } else {
            try {
                root = JSON.parse(raw)
            } catch (err) {
                throw new Error(
                    `failed to parse existing ${claudeJsonPath}: ${err.message}`
                )
            }
            if (!isObj(root)) {
                throw new Error(
                    `${claudeJsonPath} is valid JSON but not an object`
                )
            }
        }
    }

    const before = JSON.stringify(root.mcpServers?.review)
    const mcpServers = isObj(root.mcpServers) ? { ...root.mcpServers } : {}
    mcpServers.review = desired
    const next = { ...root, mcpServers }

    if (existed && deepEqual(root.mcpServers?.review, desired)) {
        return { action: "unchanged", path: claudeJsonPath, before }
    }

    const serialized = JSON.stringify(next, null, 2) + "\n"
    const ts = now()
    const bak = backup(claudeJsonPath, serialized, ts)
    writeAtomicFn(claudeJsonPath, serialized)
    return {
        action: existed ? "updated" : "installed",
        path: claudeJsonPath,
        backup: bak,
    }
}

import path from "node:path"

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
        const headersHelperPath = process.argv[3]
        const port = process.argv[4] ? Number(process.argv[4]) : 7777
        const bind = process.argv[5] ?? "127.0.0.1"
        if (!claudeJsonPath || !headersHelperPath) {
            process.stderr.write(
                "usage: merge-mcp.mjs <claudeJsonPath> <headersHelperPath> [port] [bind]\n"
            )
            process.exit(1)
        }
        const r = mergeMcp({ claudeJsonPath, headersHelperPath, port, bind })
        process.stdout.write(`${r.action}:${r.path}\n`)
    } catch (err) {
        process.stderr.write(`error:${err.message}\n`)
        process.exit(1)
    }
}
