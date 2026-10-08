#!/usr/bin/env node
/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

// Rotate the server's authToken (hot-reload plan §5.7). In one locked,
// atomic update of config.json it sets a new token and appends a rotation
// record (hashes only, the last 10) to auth.rotations; the server reads
// the token per request and grants the old one its grace from that
// record, or none with --revoke-now. Nothing is sent over HTTP to revoke:
// the record is the revocation.
//
// Inside the same hold of the lock, hook-credentials.json is refreshed
// and Codex's managed MCP entry is re-merged with the new token (when
// installed), so concurrent rotations leave both on the last token. Then
// a signed GET /status made with the NEW token confirms the server sees
// it (and, after --revoke-now, that no old token is still accepted).
//
// Usage: rotate-token.mjs [--config <path>] [--revoke-now]

import { createHash, randomBytes } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import {
    clientHostFromBind,
    connect,
    defaultConfigPath,
} from "../hooks/signed-client.mjs"
import {
    defaultCredentialsPath,
    refreshHookCredentials,
    updateConfigFile,
    withConfigLock,
} from "./config-lock.mjs"
import { BEGIN, mergeCodexMcp } from "./merge-codex-mcp.mjs"

export const KEEP_ROTATIONS = 10

const sha256 = (text) => createHash("sha256").update(text).digest("hex")

export const genToken = () => randomBytes(32).toString("base64url")

// The config after one rotation, and the record it appended.
export const rotatedConfig = ({ parsed, token, revokeNow, at }) => {
    const previous = parsed?.authToken
    if (typeof previous !== "string" || previous.length === 0) {
        throw new Error(
            "config.json has no authToken to rotate — run install.sh"
        )
    }
    const record = {
        tokenHash: sha256(token),
        previousTokenHash: sha256(previous),
        grace: revokeNow ? "none" : "default",
        at,
    }
    const history = Array.isArray(parsed.auth?.rotations)
        ? parsed.auth.rotations
        : []
    return {
        config: {
            ...parsed,
            authToken: token,
            auth: {
                ...(parsed.auth ?? {}),
                rotations: [...history, record].slice(-KEEP_ROTATIONS),
            },
        },
        record,
    }
}

// The locked part: new token + record, then the credentials cache and
// `afterWrite({ token })` (the Codex entry), all inside one hold of the
// lock. Once config.json is written the rotation stands, so a failure of
// either later step is returned, not thrown.
export const rotateToken = ({
    configPath,
    revokeNow = false,
    generate = genToken,
    now = Date.now,
    credentialsPath = defaultCredentialsPath(),
    lock = withConfigLock,
    afterWrite = null,
}) =>
    lock(configPath, () => {
        const token = generate()
        let record = null
        const { backup } = updateConfigFile({
            configPath,
            now,
            update: (parsed) => {
                const next = rotatedConfig({
                    parsed,
                    token,
                    revokeNow,
                    at: new Date(now()).toISOString(),
                })
                record = next.record
                return next.config
            },
        })
        let credentialsError = null
        try {
            refreshHookCredentials({ configPath, credentialsPath, now })
        } catch (err) {
            credentialsError = err
        }
        let after = null
        let afterError = null
        try {
            after = afterWrite ? afterWrite({ token }) : null
        } catch (err) {
            afterError = err
        }
        return { token, record, backup, credentialsError, after, afterError }
    })

// Re-merges Codex's managed MCP entry with the new token, when the
// installer put one there. Returns what it did, or null.
export const updateCodexEntry = ({
    configTomlPath = path.join(homedir(), ".codex", "config.toml"),
    configPath,
    token,
    read = readFileSync,
    exists = existsSync,
    merge = mergeCodexMcp,
}) => {
    if (
        !exists(configTomlPath) ||
        !read(configTomlPath, "utf8").includes(BEGIN)
    )
        return null
    const parsed = JSON.parse(read(configPath, "utf8"))
    return merge({
        configTomlPath,
        token,
        port: Number.isInteger(parsed.port) ? parsed.port : 7777,
        bind: clientHostFromBind(parsed.bind),
    })
}

// A signed GET /status with the new token. Resolves to
// { running: false, reason } or { running: true, ok, auth, problem? }.
export const confirmWithServer = async ({
    configPath,
    token,
    revokeNow,
    connectFn = connect,
}) => {
    const conn = await connectFn({ configPath })
    if (!conn.ok) return { running: false, reason: conn.reason }
    const res = await conn.request({
        method: "GET",
        path: "/status",
        timeoutMs: 10_000,
    })
    if (res.httpStatus !== 200) {
        return {
            running: true,
            ok: false,
            problem: res.fetchError ?? `HTTP ${res.httpStatus}`,
        }
    }
    const auth = res.body?.auth ?? null
    if (auth?.currentTokenHash !== sha256(token)) {
        return {
            running: true,
            ok: false,
            auth,
            problem: "the server doesn't report the new token as current",
        }
    }
    if (revokeNow && auth.previousTokenGrace !== null) {
        return {
            running: true,
            ok: false,
            auth,
            problem: "the server still accepts the previous token",
        }
    }
    return { running: true, ok: true, auth }
}

export const parseArgs = (argv) => {
    const opts = { configPath: defaultConfigPath(), revokeNow: false }
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]
        if (arg === "--revoke-now") opts.revokeNow = true
        else if (arg === "--config" && argv[i + 1]) opts.configPath = argv[++i]
        else return { error: `unknown option '${arg}'` }
    }
    return opts
}

export const main = async ({
    argv = process.argv.slice(2),
    stdout = process.stdout,
    stderr = process.stderr,
    rotate = rotateToken,
    updateCodex = updateCodexEntry,
    confirm = confirmWithServer,
} = {}) => {
    const args = parseArgs(argv)
    if (args.error) {
        stderr.write(
            `${args.error}\nusage: rotate-token.mjs [--config <path>] [--revoke-now]\n`
        )
        return 2
    }
    let rotated
    try {
        rotated = await rotate({
            configPath: args.configPath,
            revokeNow: args.revokeNow,
            afterWrite: ({ token }) =>
                updateCodex({ configPath: args.configPath, token }),
        })
    } catch (err) {
        stderr.write(`error: ${err.message}\n`)
        return 1
    }
    stdout.write(
        `rotated: new token written to ${args.configPath} (backup: ${rotated.backup})\n`
    )
    if (rotated.credentialsError) {
        stderr.write(
            `warning: couldn't refresh the hooks' credentials cache (${rotated.credentialsError.message}); the hooks read the new token from config.json\n`
        )
    }
    if (rotated.afterError) {
        stderr.write(
            `warning: couldn't update Codex's MCP entry (${rotated.afterError.message}) — rerun install.sh --codex\n`
        )
    } else if (rotated.after) {
        stdout.write(
            `codex: MCP entry ${rotated.after.action} (${rotated.after.path})\n`
        )
    }
    const seen = await confirm({
        configPath: args.configPath,
        token: rotated.token,
        revokeNow: args.revokeNow,
    })
    if (!seen.running) {
        stdout.write(
            `server: not reachable (${seen.reason}); it reads the new token when it starts\n`
        )
    } else if (!seen.ok) {
        stderr.write(`error: ${seen.problem}\n`)
        return 1
    } else if (args.revokeNow) {
        stdout.write(
            "server: revoked — the previous token is no longer accepted\n"
        )
    } else {
        const until = seen.auth.previousTokenGrace?.until
        stdout.write(
            until
                ? `server: previous token accepted until ${until}\n`
                : "server: previous token no longer accepted\n"
        )
    }
    stdout.write(
        "Restart open Codex and opencode sessions: their MCP tools keep the token\n" +
            "they loaded" +
            (args.revokeNow ? "" : " until the grace ends") +
            ". The hooks and end-of-turn reviews read\n" +
            "the new token on every call; Claude Code picks it up on its next MCP\n" +
            "connection.\n"
    )
    return 0
}

/* istanbul ignore next -- CLI guard exercised by scripts/rotate-token.sh */
if (
    process.argv[1] &&
    import.meta.url.startsWith("file:") &&
    import.meta.url.endsWith(path.basename(process.argv[1]))
) {
    main().then((code) => {
        process.exitCode = code
    })
}
