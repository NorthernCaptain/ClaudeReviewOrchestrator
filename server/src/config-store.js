/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

// The shell's config holder and its transactions (hot-reload plan §5.5,
// "Config changes are transactions"). The holder outlives every core, so
// every change to it — a dashboard edit, a swap's config step, a
// rollback's restore — runs here, one at a time:
//   * a dashboard edit is a delta merged into a FRESH read of
//     config.json, so keys the holder doesn't own (authToken, restart-only
//     keys, unapplied manual edits) keep their on-disk values;
//   * both results — the merged file and the holder plus the delta — must
//     pass the current core's schema and self-check before anything is
//     written;
//   * the write re-checks the file's content hash first (an edit landing
//     meanwhile means redo, up to 3 times), goes through a temp file and a
//     rename (0600), and keeps a timestamped backup of the file as read;
//   * the holder's value is an immutable snapshot, replaced on commit,
//     with a revision bumped on every commit;
//   * every write runs under the cross-process config lock
//     (install/config-lock.mjs, §5.7), shared with the installer and
//     rotate-token, and refreshes hook-credentials.json inside it.

import { createHash, randomBytes } from "node:crypto"
import {
    readdirSync as nodeReaddirSync,
    readFileSync as nodeReadFileSync,
    renameSync as nodeRenameSync,
    rmSync as nodeRmSync,
    writeFileSync as nodeWriteFileSync,
} from "node:fs"
import path from "node:path"
import {
    ConfigLockError,
    refreshHookCredentials,
    withConfigLock,
} from "../../install/config-lock.mjs"

export const MAX_SAVE_ATTEMPTS = 3
export const KEEP_BACKUPS = 10

export class ConfigChangeError extends Error {
    constructor(code, message, httpStatus = 409) {
        super(message)
        this.name = "ConfigChangeError"
        this.code = code
        this.httpStatus = httpStatus
    }
}

export const deepFreeze = (value) => {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
        Object.freeze(value)
        for (const child of Object.values(value)) deepFreeze(child)
    }
    return value
}

export const frozenCopy = (value) => deepFreeze(structuredClone(value))

const sha256 = (text) => createHash("sha256").update(text).digest("hex")

const getIn = (obj, keys) =>
    keys.reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), obj)

const setIn = (obj, keys, value) => {
    let node = obj
    for (const key of keys.slice(0, -1)) {
        if (!node[key] || typeof node[key] !== "object") node[key] = {}
        node = node[key]
    }
    node[keys.at(-1)] = value
}

// A delta is a list of [keyPath, value] pairs, e.g.
// [[["limits", "maxCodexRounds"], 6]].
export const applyDelta = (obj, delta) => {
    const out = structuredClone(obj ?? {})
    for (const [keys, value] of delta) setIn(out, keys, structuredClone(value))
    return out
}

const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// Timestamped, sortable backup names, unique even within one millisecond:
// config.json.bak-20261007T120000123Z-000001.
const backupName = (base, now, seq) =>
    `${base}.bak-${new Date(now()).toISOString().replace(/[-:.]/g, "")}-${String(seq).padStart(6, "0")}`

export const createConfigStore = ({
    configPath,
    initial,
    // () => { validate, selfCheck } of the core current right now, so a
    // transaction that runs after a swap is checked by the new core.
    checks,
    keepBackups = KEEP_BACKUPS,
    now = Date.now,
    nonce = () => randomBytes(6).toString("hex"),
    fs = {},
    // Where hook-credentials.json goes; null writes none (tests).
    credentialsPath = null,
    withFileLock = withConfigLock,
    // (config) → called after every commit (server.json republishes the
    // hook wait). Its failure never undoes the commit.
    onCommit = () => {},
}) => {
    const read = fs.readFileSync ?? nodeReadFileSync
    const write = fs.writeFileSync ?? nodeWriteFileSync
    const rename = fs.renameSync ?? nodeRenameSync
    const readdir = fs.readdirSync ?? nodeReaddirSync
    const rm = fs.rmSync ?? nodeRmSync

    let config = frozenCopy(initial)
    let revision = 0
    let tail = Promise.resolve()
    let backupSeq = 0

    // Runs `fn` with nothing else in the store running. Swaps, rollbacks
    // and dashboard edits all queue here.
    const exclusive = (fn) => {
        const run = tail.then(() => fn())
        tail = run.catch(() => {})
        return run
    }

    // A fresh read of the file: { text, hash, parsed }.
    const readFile = () => {
        let text
        try {
            text = read(configPath, "utf8")
        } catch (err) {
            throw new ConfigChangeError(
                "CONFIG_FILE_UNREADABLE",
                `config.json can't be read: ${err.message}`,
                500
            )
        }
        let parsed
        try {
            parsed = JSON.parse(text)
        } catch {
            throw new ConfigChangeError(
                "CONFIG_FILE_INVALID",
                "config.json isn't valid JSON — fix it first"
            )
        }
        return { text, hash: sha256(text), parsed }
    }

    // Best effort: runs after the change is written and committed, so a
    // cleanup failure never turns a completed change into a rejected one.
    const pruneBackups = () => {
        try {
            const dir = path.dirname(configPath)
            const prefix = `${path.basename(configPath)}.bak-`
            const backups = readdir(dir)
                .filter((n) => n.startsWith(prefix))
                .sort()
            for (const name of backups.slice(0, -keepBackups)) {
                rm(path.join(dir, name), { force: true })
            }
        } catch {
            // an old backup left behind is harmless
        }
    }

    // Created exclusively, so no backup ever overwrites another.
    const writeBackup = (text) => {
        for (;;) {
            const backup = backupName(configPath, now, ++backupSeq)
            try {
                write(backup, text, { mode: 0o600, flag: "wx" })
                return backup
            } catch (err) {
                if (err?.code !== "EEXIST") throw err
            }
        }
    }

    // Writes `obj` if the file still has `expectHash`, keeping a backup of
    // `backupText` (the file as read). The hash is re-checked last, right
    // before the rename, so an edit landing while the temp file and the
    // backup were written is seen too. Returns null on a mismatch (having
    // removed both), otherwise the backup path. Callers prune
    // (pruneBackups) once they've committed.
    const writeFile = (obj, { expectHash, backupText }) => {
        const unchanged = () => sha256(read(configPath, "utf8")) === expectHash
        if (!unchanged()) return null
        const tmp = `${configPath}.tmp-${nonce()}`
        write(tmp, JSON.stringify(obj, null, 2) + "\n", { mode: 0o600 })
        const backup = writeBackup(backupText)
        if (!unchanged()) {
            rm(tmp, { force: true })
            rm(backup, { force: true })
            return null
        }
        rename(tmp, configPath)
        return backup
    }

    const commit = (next) => {
        config = frozenCopy(next)
        revision++
        try {
            onCommit(config)
        } catch {
            // the commit stands
        }
        return config
    }

    const checkBoth = (fileRaw, liveRaw) => {
        const { validate, selfCheck } = checks()
        const fileConfig = validate(fileRaw)
        const liveConfig = validate(liveRaw)
        selfCheck(frozenCopy(fileConfig))
        selfCheck(frozenCopy(liveConfig))
        return liveConfig
    }

    // Best effort: hooks fall back to config.json itself.
    const refreshCredentials = () => {
        if (!credentialsPath) return
        try {
            refreshHookCredentials({ configPath, credentialsPath, now })
        } catch {
            // a stale cache only matters when config.json is unreadable
        }
    }

    // Runs `fn` holding the config lock, then refreshes the hook
    // credentials from a read taken inside it. Callers that write
    // config.json also run inside exclusive().
    const underFileLock = async (fn) => {
        try {
            return await withFileLock(configPath, async () => {
                const result = await fn()
                refreshCredentials()
                return result
            })
        } catch (err) {
            if (!(err instanceof ConfigLockError)) throw err
            throw new ConfigChangeError("CONFIG_LOCKED", err.message, 503)
        }
    }

    // A dashboard edit. Resolves to { revision, config, replaced, backup };
    // rejects with a ConfigChangeError (or the core's validation error)
    // having written nothing.
    const mutate = (delta) =>
        exclusive(() => underFileLock(() => saveDelta(delta)))

    const saveDelta = (delta) => {
        for (let attempt = 1; attempt <= MAX_SAVE_ATTEMPTS; attempt++) {
            const file = readFile()
            // A key the delta sets whose file value differs from the
            // holder's: an unapplied manual edit, replaced by the
            // user's latest explicit action. The holder is normalized
            // (defaults filled, paths expanded), so the file is compared
            // in that form too; a file that doesn't validate (and so
            // holds a manual edit somewhere) is compared as written.
            let fileView = file.parsed
            try {
                fileView = checks().validate(file.parsed)
            } catch {
                // compared raw
            }
            const replaced = delta
                .filter(
                    ([keys]) =>
                        !sameValue(getIn(fileView, keys), getIn(config, keys))
                )
                .map(([keys]) => ({
                    key: keys.join("."),
                    manualValue: getIn(file.parsed, keys) ?? null,
                }))
            const mergedFile = applyDelta(file.parsed, delta)
            let liveConfig
            try {
                liveConfig = checkBoth(mergedFile, applyDelta(config, delta))
            } catch (err) {
                if (err instanceof ConfigChangeError) throw err
                throw new ConfigChangeError(
                    err.code ?? "CONFIG_REJECTED",
                    `config change rejected: ${err.message}`
                )
            }
            const backup = writeFile(mergedFile, {
                expectHash: file.hash,
                backupText: file.text,
            })
            if (backup === null) continue
            commit(liveConfig)
            pruneBackups()
            return { revision, config, replaced, backup }
        }
        throw new ConfigChangeError(
            "CONFIG_CHANGED_WHILE_SAVING",
            "config.json changed while saving — try again"
        )
    }

    return {
        current: () => config,
        revision: () => revision,
        exclusive,
        underFileLock,
        // Rewrites hook-credentials.json from config.json under the lock
        // (startup, a noticed token change). Never rejects.
        syncCredentials: () =>
            credentialsPath
                ? exclusive(() => underFileLock(() => null)).catch(() => false)
                : Promise.resolve(false),
        mutate,
        readFile,
        writeFile,
        pruneBackups,
        commit,
    }
}
