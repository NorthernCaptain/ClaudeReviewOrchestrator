#!/usr/bin/env node
/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

// Ensure ~/.config/review-orchestrator/config.json exists with an
// authToken. Idempotent: an existing token is preserved verbatim; only
// the token field is touched. Other config keys are written from
// `defaults` only when the file is being created from scratch.
//
// Prints a single status line to stdout:
//   installed:<path>   — fresh file written (new token generated)
//   unchanged:<path>   — existing file had a valid token; nothing changed
//   updated:<path>     — existing file was missing/empty authToken; token added
//
// Returns exit 0 on success. Any error prints "error:<reason>" and exits 1.

import { randomBytes } from "node:crypto"
import {
    existsSync,
    mkdirSync,
    readFileSync,
    writeFileSync,
    renameSync,
} from "node:fs"
import path from "node:path"

const DEFAULTS = {
    port: 7777,
    bind: "127.0.0.1",
    allowedRoots: [],
    codex: {
        binary: "codex",
        model: "gpt-5-codex",
        ignoreProjectRules: true,
        extraArgs: [],
    },
    limits: {
        maxCodexRounds: 5,
        maxBlocks: 6,
        idleResetMinutes: 10,
        codexTimeoutSeconds: 240,
        maxCodexOutputBytes: 1048576,
        maxPayloadBytes: 262144,
        maxFileBytes: 65536,
        maxFiles: 40,
    },
    ignorePaths: [
        "**/node_modules/**",
        "**/dist/**",
        "**/.git/**",
        "**/coverage/**",
        "**/*.lock",
        "**/package-lock.json",
        "**/yarn.lock",
        "**/pnpm-lock.yaml",
        "**/Cargo.lock",
        "**/*.min.js",
        "**/*.min.css",
        "**/generated/**",
    ],
    blockingSeverities: ["blocker", "major"],
    extraReviewerInstructions: null,
    reviewsDir: "./reviews",
    reviewsRetentionDays: null,
    logging: { dir: "~/.claude/logs", level: "info" },
}

const genToken = () => randomBytes(32).toString("base64url")

const writeAtomic = (filePath, content, mode) => {
    const tmp = `${filePath}.tmp`
    writeFileSync(tmp, content, { mode })
    renameSync(tmp, filePath)
}

export const ensureToken = ({
    configPath,
    home,
    generate = genToken,
    readFile = readFileSync,
    writeAtomicFn = writeAtomic,
    existsFn = existsSync,
    mkdir = mkdirSync,
    defaults = DEFAULTS,
}) => {
    const cfgDir = path.dirname(configPath)
    mkdir(cfgDir, { recursive: true })

    // Greenfield: write the full default config with a fresh token.
    if (!existsFn(configPath)) {
        const cfg = {
            ...defaults,
            authToken: generate(),
            allowedRoots: defaults.allowedRoots?.length
                ? defaults.allowedRoots
                : [home],
        }
        writeAtomicFn(configPath, JSON.stringify(cfg, null, 2) + "\n", 0o600)
        return { action: "installed", path: configPath, token: cfg.authToken }
    }

    // Existing file: read, decide.
    let raw
    try {
        raw = readFile(configPath, "utf8")
    } catch (err) {
        throw new Error(`failed to read existing config: ${err.message}`)
    }
    let parsed
    try {
        parsed = JSON.parse(raw)
    } catch (err) {
        throw new Error(`existing config is not valid JSON: ${err.message}`)
    }

    if (
        parsed &&
        typeof parsed.authToken === "string" &&
        parsed.authToken.length > 0
    ) {
        return {
            action: "unchanged",
            path: configPath,
            token: parsed.authToken,
        }
    }

    // File exists but token is missing/empty/wrong-typed — add it, preserve
    // the rest.
    const updated = { ...parsed, authToken: generate() }
    writeAtomicFn(configPath, JSON.stringify(updated, null, 2) + "\n", 0o600)
    return { action: "updated", path: configPath, token: updated.authToken }
}

/* istanbul ignore next -- CLI guard exercised by smoke test only */
const isDirectInvocation = () => {
    if (!process.argv[1]) return false
    if (!import.meta.url.startsWith("file:")) return false
    return import.meta.url.endsWith(path.basename(process.argv[1]))
}

/* istanbul ignore next */
if (isDirectInvocation()) {
    try {
        const configPath = process.argv[2]
        const home = process.argv[3] ?? process.env.HOME
        if (!configPath || !home) {
            process.stderr.write(
                "usage: ensure-token.mjs <configPath> <home>\n"
            )
            process.exit(1)
        }
        const r = ensureToken({ configPath, home })
        process.stdout.write(`${r.action}:${r.path}\n`)
    } catch (err) {
        process.stderr.write(`error:${err.message}\n`)
        process.exit(1)
    }
}
