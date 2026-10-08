/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

// The config writers' toolkit (hot-reload plan §5.7, "Config file
// writers"). Every program that writes config.json — the server, the
// installer, rotate-token — takes the same cross-process lock and holds
// it across read, merge, re-check and rename, so among them no write is
// ever lost.
//
// The lock is an OS lock, not a lock file whose existence is the lock:
// config.json.lock is opened with macOS's O_EXLOCK (0x20 in <fcntl.h>;
// Node passes open flags straight to open(2)) plus O_NONBLOCK, and the
// kernel grants it to one open file at a time and releases it when the
// owner closes it or exits, however it exits. There is no stale-lock
// recovery at all. A waiter gives up after 10 s and writes nothing.
//
// Also here: the atomic writes those programs share, the update every
// writer outside the server makes (read, change, backup, re-check,
// rename), and hook-credentials.json, which only they write (from a read
// of config.json taken inside the lock) and the hooks only read.

import { createHash, randomBytes } from "node:crypto"
import {
    closeSync,
    constants,
    mkdirSync,
    openSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

const O_EXLOCK = 0x20
export const LOCK_TIMEOUT_MS = 10_000
export const LOCK_RETRY_MS = 50
export const KEEP_BACKUPS = 10
export const MAX_UPDATE_ATTEMPTS = 3

export class ConfigLockError extends Error {
    constructor(message) {
        super(message)
        this.name = "ConfigLockError"
        this.code = "CONFIG_LOCKED"
    }
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms))

export const lockPathFor = (configPath) => `${configPath}.lock`

// Takes the lock on `${configPath}.lock`. Resolves to { release }.
export const acquireConfigLock = async ({
    configPath,
    timeoutMs = LOCK_TIMEOUT_MS,
    retryMs = LOCK_RETRY_MS,
    now = Date.now,
    sleep = defaultSleep,
    open = openSync,
    close = closeSync,
    platform = process.platform,
}) => {
    if (platform !== "darwin") {
        throw new ConfigLockError(
            "the config lock needs macOS (O_EXLOCK); this install is launchd-only"
        )
    }
    const flags =
        constants.O_RDWR | constants.O_CREAT | O_EXLOCK | constants.O_NONBLOCK
    // A first install takes the lock before config.json's folder exists.
    try {
        mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 })
    } catch {
        // open() below reports it
    }
    const start = now()
    for (;;) {
        try {
            const fd = open(lockPathFor(configPath), flags, 0o600)
            let released = false
            return {
                release: () => {
                    if (released) return
                    released = true
                    close(fd)
                },
            }
        } catch (err) {
            if (err?.code !== "EAGAIN" && err?.code !== "EWOULDBLOCK") throw err
            if (now() - start >= timeoutMs) {
                throw new ConfigLockError(
                    "config.json is locked by another writer — try again"
                )
            }
            await sleep(retryMs)
        }
    }
}

// Runs `fn` holding the lock, releasing it however fn ends.
export const withConfigLock = async (configPath, fn, options = {}) => {
    const lock = await acquireConfigLock({ configPath, ...options })
    try {
        return await fn()
    } finally {
        lock.release()
    }
}

// Temp file + rename, so a reader sees the old file or the new one,
// never half of each.
export const writeFileAtomic = (
    filePath,
    content,
    { mode = 0o600, fs = {} } = {}
) => {
    const write = fs.writeFileSync ?? writeFileSync
    const rename = fs.renameSync ?? renameSync
    const mkdir = fs.mkdirSync ?? mkdirSync
    mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
    const tmp = `${filePath}.tmp-${randomBytes(6).toString("hex")}`
    try {
        write(tmp, content, { mode })
        rename(tmp, filePath)
    } catch (err) {
        rmSync(tmp, { force: true })
        throw err
    }
}

const sha256 = (text) => createHash("sha256").update(text).digest("hex")

// config.json.bak-20261007T120000123Z-<random>, the server's sortable
// naming; created exclusively, 0600.
export const writeConfigBackup = ({ configPath, text, now = Date.now }) => {
    const stamp = new Date(now()).toISOString().replace(/[-:.]/g, "")
    for (;;) {
        const backup = `${configPath}.bak-${stamp}-${randomBytes(3).toString("hex")}`
        try {
            writeFileSync(backup, text, { mode: 0o600, flag: "wx" })
            return backup
        } catch (err) {
            if (err?.code !== "EEXIST") throw err
        }
    }
}

// Keeps the newest `keep` backups. Best effort.
export const pruneConfigBackups = ({ configPath, keep = KEEP_BACKUPS }) => {
    try {
        const dir = path.dirname(configPath)
        const prefix = `${path.basename(configPath)}.bak-`
        const backups = readdirSync(dir)
            .filter((n) => n.startsWith(prefix))
            .sort()
        for (const name of backups.slice(0, -keep)) {
            rmSync(path.join(dir, name), { force: true })
        }
    } catch {
        // an old backup left behind is harmless
    }
}

// One change to config.json, for a caller holding the config lock: a
// fresh read, `update(parsed)` (a new object, or null for no change), a
// temp file and a backup of the file as read, and the content hash
// re-checked right before the rename, so an editor's save landing
// meanwhile is redone on top of (up to 3 times) instead of lost.
// Resolves to { changed, config, backup }.
export const updateConfigFile = ({ configPath, update, now = Date.now }) => {
    for (let attempt = 1; attempt <= MAX_UPDATE_ATTEMPTS; attempt++) {
        const text = readFileSync(configPath, "utf8")
        let parsed
        try {
            parsed = JSON.parse(text)
        } catch (err) {
            throw new Error(`${configPath} is not valid JSON: ${err.message}`)
        }
        const next = update(parsed)
        if (next === null)
            return { changed: false, config: parsed, backup: null }
        const tmp = `${configPath}.tmp-${randomBytes(6).toString("hex")}`
        writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", {
            mode: 0o600,
        })
        let backup = null
        try {
            backup = writeConfigBackup({ configPath, text, now })
            if (sha256(readFileSync(configPath, "utf8")) !== sha256(text)) {
                rmSync(tmp, { force: true })
                rmSync(backup, { force: true })
                continue
            }
            renameSync(tmp, configPath)
        } catch (err) {
            rmSync(tmp, { force: true })
            if (backup) rmSync(backup, { force: true })
            throw err
        }
        pruneConfigBackups({ configPath })
        return { changed: true, config: next, backup }
    }
    throw new Error("config.json changed while saving — try again")
}

// Under `home`: the installer's --home, else the user's.
export const defaultCredentialsPath = (home = homedir()) =>
    path.join(home, ".cache", "review-orchestrator", "hook-credentials.json")

// What a hook needs when config.json can't be read: the token, and the
// config-derived address and hook settings used when server.json is
// absent.
export const credentialsFrom = (config) => ({
    token: config?.authToken ?? null,
    port: Number.isInteger(config?.port) ? config.port : 7777,
    bind:
        typeof config?.bind === "string" && config.bind.length > 0
            ? config.bind
            : "127.0.0.1",
    hook: config?.hook ?? null,
    reviewer: config?.reviewer ?? null,
    limits: config?.limits ?? null,
})

// Writes hook-credentials.json from a read of config.json taken inside
// the config lock — the rule every writer follows, so the last writer
// always derived it from the newest committed config. The caller holds
// the lock. A config.json that doesn't parse leaves the cache as it is.
export const refreshHookCredentials = ({
    configPath,
    credentialsPath = defaultCredentialsPath(),
    now = Date.now,
    read = readFileSync,
}) => {
    let parsed
    try {
        parsed = JSON.parse(read(configPath, "utf8"))
    } catch {
        return false
    }
    if (typeof parsed?.authToken !== "string" || !parsed.authToken) {
        return false
    }
    writeFileAtomic(
        credentialsPath,
        JSON.stringify(
            {
                ...credentialsFrom(parsed),
                writtenAt: new Date(now()).toISOString(),
            },
            null,
            2
        ) + "\n"
    )
    return true
}
