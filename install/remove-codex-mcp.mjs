#!/usr/bin/env node
/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

// Remove only the review-orchestrator managed block (the
// [mcp_servers.review] table between our markers) from
// ~/.codex/config.toml. Leaves every other table and hand-written
// content untouched. Idempotent: "unchanged" when our block isn't
// present, "absent" when the file doesn't exist.

import {
    chmodSync,
    existsSync,
    readFileSync,
    renameSync,
    writeFileSync,
} from "node:fs"
import path from "node:path"
import { BEGIN, END, SECRET_MODE } from "./merge-codex-mcp.mjs"

// Owner-only: the rewritten config no longer holds the token, but the
// .bak captures the prior token-bearing bytes, so both stay 0600 to
// match the merge side and avoid leaking the old token to other users.
const writeAtomic = (filePath, content) => {
    const tmp = `${filePath}.tmp`
    writeFileSync(tmp, content, { mode: SECRET_MODE })
    renameSync(tmp, filePath)
    chmodSync(filePath, SECRET_MODE)
}

const backupIfDifferent = (filePath, newContent, nowStr) => {
    if (!existsSync(filePath)) return null
    const current = readFileSync(filePath, "utf8")
    if (current === newContent) return null
    const bak = `${filePath}.bak.${nowStr}`
    writeFileSync(bak, current, { mode: SECRET_MODE })
    chmodSync(bak, SECRET_MODE)
    return bak
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

export const removeCodexMcp = ({
    configTomlPath,
    now = () => new Date().toISOString().replace(/[:.]/g, "-"),
    existsFn = existsSync,
    readFile = readFileSync,
    writeAtomicFn = writeAtomic,
    backup = backupIfDifferent,
}) => {
    if (!existsFn(configTomlPath)) {
        return { action: "absent", path: configTomlPath }
    }
    const current = readFile(configTomlPath, "utf8")
    const blockRe = new RegExp(
        `\\n?${escapeRegExp(BEGIN)}[\\s\\S]*?${escapeRegExp(END)}\\n?`
    )
    if (!blockRe.test(current)) {
        return { action: "unchanged", path: configTomlPath }
    }
    const next = current.replace(blockRe, "\n").replace(/^\n+/, "")
    const ts = now()
    const bak = backup(configTomlPath, next, ts)
    writeAtomicFn(configTomlPath, next)
    return { action: "removed", path: configTomlPath, backup: bak }
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
        const configTomlPath = process.argv[2]
        if (!configTomlPath) {
            process.stderr.write(
                "usage: remove-codex-mcp.mjs <configTomlPath>\n"
            )
            process.exit(1)
        }
        const r = removeCodexMcp({ configTomlPath })
        process.stdout.write(`${r.action}:${r.path}\n`)
    } catch (err) {
        process.stderr.write(`error:${err.message}\n`)
        process.exit(1)
    }
}
