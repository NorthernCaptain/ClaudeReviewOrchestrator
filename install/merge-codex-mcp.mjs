#!/usr/bin/env node
/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

// Add/replace the [mcp_servers.review] table in ~/.codex/config.toml,
// leaving every other table (and other MCP servers) intact. Idempotent.
//
// Codex has no JSON config we can deep-merge like ~/.claude.json, so we
// manage our table as a marker-delimited block inside config.toml:
//
//   # review-orchestrator:begin (managed — do not edit)
//   [mcp_servers.review]
//   url = "http://127.0.0.1:7777/mcp"
//   http_headers = { "X-Review-Token" = "<token>" }
//   # review-orchestrator:end
//
// The markers are TOML comments, so the block is valid TOML and we can
// find/replace it on reinstall without parsing the whole file (no TOML
// dependency). The token is read from the orchestrator's config.json
// (same trust level — both are loopback-only, user-owned files).
//
// Status lines:
//   installed:<path>  — file did not exist, created with our block
//   updated:<path>    — file existed; our block was added or replaced
//   unchanged:<path>  — file existed; our block already matched

import {
    chmodSync,
    existsSync,
    readFileSync,
    renameSync,
    writeFileSync,
} from "node:fs"
import path from "node:path"

// Exported so remove-codex-mcp.mjs matches the exact same managed block
// (single source of truth for the marker text).
export const BEGIN = "# review-orchestrator:begin (managed — do not edit)"
export const END = "# review-orchestrator:end"

// config.toml embeds the live X-Review-Token, so it — and any backup of
// its prior token-bearing bytes — must be owner-only, matching the 0600
// config.json / 0700 header-helper the Claude path uses. Other local
// users must not be able to read the token. We chmod after the write so
// the mode is enforced even if a stale .tmp / .bak already existed (the
// `mode` option only applies when the file is created).
export const SECRET_MODE = 0o600

const writeAtomic = (filePath, content, mode = SECRET_MODE) => {
    const tmp = `${filePath}.tmp`
    writeFileSync(tmp, content, { mode })
    renameSync(tmp, filePath)
    chmodSync(filePath, mode)
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

// Matches an mcp_servers.review table header in any form codex accepts:
//   [mcp_servers.review]          [[mcp_servers.review]]
//   [mcp_servers.review.sub]      (a subtable implies the table exists)
// Used to detect a pre-existing UNMANAGED review entry so we never emit a
// duplicate table.
const REVIEW_TABLE_RE = /^[ \t]*\[\[?\s*mcp_servers\.review(\.[^\]]*)?\s*\]\]?/m

// Escape a value for a TOML basic (double-quoted) string. Tokens are
// alphanumeric in practice, but guard against backslash/quote/control
// chars so a hand-edited token can never break the file.
const tomlBasicString = (value) =>
    `"${String(value)
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/\n/g, "\\n")
        .replace(/\t/g, "\\t")
        .replace(/\r/g, "\\r")}"`

const readToken = (tokenConfigPath, readFile) => {
    const raw = readFile(tokenConfigPath, "utf8")
    let parsed
    try {
        parsed = JSON.parse(raw)
    } catch (err) {
        throw new Error(`failed to parse ${tokenConfigPath}: ${err.message}`)
    }
    const token = parsed?.authToken
    if (typeof token !== "string" || token.length === 0) {
        throw new Error(`no authToken in ${tokenConfigPath}`)
    }
    return token
}

export const mergeCodexMcp = ({
    configTomlPath,
    tokenConfigPath = null,
    token = null,
    port = 7777,
    bind = "127.0.0.1",
    now = () => new Date().toISOString().replace(/[:.]/g, "-"),
    existsFn = existsSync,
    readFile = readFileSync,
    writeAtomicFn = writeAtomic,
    backup = backupIfDifferent,
}) => {
    const resolvedToken = token ?? readToken(tokenConfigPath, readFile)

    const block =
        `${BEGIN}\n` +
        `[mcp_servers.review]\n` +
        `url = "http://${bind}:${port}/mcp"\n` +
        `http_headers = { "X-Review-Token" = ${tomlBasicString(resolvedToken)} }\n` +
        `${END}\n`

    const existed = existsFn(configTomlPath)
    const current = existed ? readFile(configTomlPath, "utf8") : ""

    const blockRe = new RegExp(
        `${escapeRegExp(BEGIN)}[\\s\\S]*?${escapeRegExp(END)}\\n?`
    )

    // Refuse if the file defines an [mcp_servers.review] table (or
    // subtable / array-of-tables) OUTSIDE our managed block. Appending
    // our table would then produce a duplicate `review` table — invalid
    // TOML that breaks codex config parsing. We don't blindly rewrite a
    // hand-authored entry; the user must remove or rename it first.
    const outsideManaged = current.replace(blockRe, "")
    if (REVIEW_TABLE_RE.test(outsideManaged)) {
        throw new Error(
            `${configTomlPath} already defines an unmanaged ` +
                `[mcp_servers.review] table. Remove it (or rename that ` +
                `server) and rerun — refusing to append a duplicate table.`
        )
    }

    let next
    if (blockRe.test(current)) {
        next = current.replace(blockRe, block)
    } else if (current.trim() === "") {
        next = block
    } else {
        // Append after existing content, guaranteeing a blank line
        // separator so our [table] header can't glue onto a prior line.
        const sep = current.endsWith("\n") ? "" : "\n"
        next = `${current}${sep}\n${block}`
    }

    if (existed && next === current) {
        // Bytes already correct, but an earlier installer version may
        // have left this token-bearing file world-readable. Repair the
        // mode before returning so a rerun always secures it.
        chmodSync(configTomlPath, SECRET_MODE)
        return { action: "unchanged", path: configTomlPath }
    }
    const ts = now()
    const bak = backup(configTomlPath, next, ts)
    writeAtomicFn(configTomlPath, next)
    return {
        action: existed ? "updated" : "installed",
        path: configTomlPath,
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
        const configTomlPath = process.argv[2]
        const tokenConfigPath = process.argv[3]
        const port = process.argv[4] ? Number(process.argv[4]) : 7777
        const bind = process.argv[5] ?? "127.0.0.1"
        if (!configTomlPath || !tokenConfigPath) {
            process.stderr.write(
                "usage: merge-codex-mcp.mjs <configTomlPath> <tokenConfigPath> [port] [bind]\n"
            )
            process.exit(1)
        }
        const r = mergeCodexMcp({ configTomlPath, tokenConfigPath, port, bind })
        process.stdout.write(`${r.action}:${r.path}\n`)
    } catch (err) {
        process.stderr.write(`error:${err.message}\n`)
        process.exit(1)
    }
}
