/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

// The reload controller (hot-reload plan §5.4–5.5). Shell state, outside
// every core:
//   * which core is current, the rollback target (previous) and a
//     pending reload, each a record holding the core instance, its
//     validateConfig, version ids and the files it owns;
//   * review admission: a counter that defines "idle", a frozen config
//     pinned per review, and a queue for requests that arrive while the
//     swap gate is closed or the starvation guard holds them;
//   * per-core pin counts, so a core is disposed (and its snapshot and
//     codex schema file deleted) only once nothing refers to it and no
//     request still runs on it.
// Reloads are explicit: prepared on a trigger, applied when idle (or at
// once with `now`), always through the swap gate.

import {
    MAX_FETCH_TIMEOUT_MS,
    resolveFetchTimeoutMs,
} from "../../hooks/stop-review.mjs"
import { frozenCopy } from "./config-store.js"

export const RESTART_ONLY_KEYS = Object.freeze([
    "port",
    "bind",
    "logging.dir",
    "reviewsDir",
    "reviewsRetentionDays",
])
export const HISTORY_LIMIT = 20
const DEFAULT_MAX_WAIT_MINUTES = 5
const DEFAULT_MAX_HOLD_SECONDS = 45

export class ReloadError extends Error {
    constructor(code, message, httpStatus = 409) {
        super(message)
        this.name = "ReloadError"
        this.code = code
        this.httpStatus = httpStatus
    }
}

const getIn = (obj, keys) =>
    keys.reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), obj)

const setIn = (obj, keys, value) => {
    let node = obj
    for (const key of keys.slice(0, -1)) {
        if (!node[key] || typeof node[key] !== "object") node[key] = {}
        node = node[key]
    }
    if (value === undefined) delete node[keys.at(-1)]
    else node[keys.at(-1)] = structuredClone(value)
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const leaves = (obj, prefix = [], out = new Map()) => {
    for (const [k, v] of Object.entries(obj ?? {})) {
        const keys = [...prefix, k]
        if (v && typeof v === "object" && !Array.isArray(v)) {
            leaves(v, keys, out)
        } else {
            out.set(keys.join("."), v)
        }
    }
    return out
}

// Dotted leaf keys whose values differ between two configs.
export const configChanges = (before, after) => {
    const a = leaves(before)
    const b = leaves(after)
    return [...new Set([...a.keys(), ...b.keys()])]
        .filter((k) => !same(a.get(k), b.get(k)))
        .sort()
}

// The hooks' own wait limit for a config (no hold allowance).
export const baseHookLimitMs = (config) => resolveFetchTimeoutMs(config)

// The wait a review under `config` needs from a Stop hook: the hooks'
// rule (a pinned hook.fetchTimeoutSeconds, else reviewer timeout + 60 s)
// applied to the reviewer that config runs (Stop hooks never override
// the provider). The max over every provider's timeout, defaults
// included, would make an unchanged hook that computed its limit from
// the raw config.json look stale.
export const requiredHookWaitMs = (config) => {
    const pinned = config?.hook?.fetchTimeoutSeconds
    if (Number.isInteger(pinned) && pinned > 0) {
        return resolveFetchTimeoutMs({ hook: { fetchTimeoutSeconds: pinned } })
    }
    const provider = config?.reviewer?.provider ?? "codex"
    const codexSec = config?.limits?.codexTimeoutSeconds
    const seconds =
        provider === "codex"
            ? codexSec
            : (config?.reviewer?.[provider]?.timeoutSeconds ?? codexSec)
    return resolveFetchTimeoutMs({ limits: { codexTimeoutSeconds: seconds } })
}

const describe = (err) => ({
    error: err?.message ?? String(err),
    code: err?.code ?? "RELOAD_FAILED",
})

export const createReloadController = ({
    // The running core: { core, validateConfig, version, reviewVersion,
    // snapshotDir, codexSchemaPath }.
    initial,
    configStore,
    // The config the server started with (restart-only keys).
    startupConfig,
    // (record) → the live capabilities a core of this record attaches.
    liveFor,
    // async (currentRecord, config) → { same: true } | candidate record
    // fields ({ module, version, reviewVersion, resources, snapshotDir,
    // codexSchemaPath }); the controller builds the core.
    loadCandidate,
    // (loadedCandidate, config) → core instance, contract- and
    // self-checked (core-loader prepareCore).
    buildCore,
    // (record) → deletes the files a disposed record owned.
    disposeFiles = () => {},
    // () → descriptions of the reviews running now, for responses.
    runningReviews = () => [],
    // (config) → applies what takes effect outside the holder at a swap
    // (the logger level).
    onApplied = () => {},
    logger = null,
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
}) => {
    const makeRecord = (fields) => ({
        loadedAt: now(),
        ...fields,
        pins: 0,
        disposed: false,
    })

    let current = makeRecord(initial)
    let previous = null // { record, before, applied }
    let pending = null
    let preparing = false
    let gate = null // a Promise while the swap gate is closed
    let active = 0
    let holding = false
    let holdingSince = null
    let releasedAtDeadline = 0
    const waiters = []
    const history = []
    // Configs this shell pinned to an admitted review: the reviewer
    // tools only run with one of these (tools.js spawnTool).
    const issued = new WeakSet()

    const referenced = (record) =>
        record === current ||
        record === previous?.record ||
        record === pending?.record

    const maybeDispose = (record) => {
        if (!record || record.disposed || referenced(record)) return
        if (record.pins > 0) return
        record.disposed = true
        // Cleanup never fails a swap that already committed, nor a release.
        try {
            record.core?.dispose?.()
        } catch (err) {
            logger?.warn?.({ err: err?.message }, "core dispose threw")
        }
        try {
            disposeFiles(record)
        } catch (err) {
            logger?.warn?.(
                { err: err?.message, version: record.version },
                "removing a disposed core's files failed"
            )
        }
    }

    const pinRecord = (record) => {
        record.pins++
        let released = false
        return () => {
            if (released) return
            released = true
            record.pins--
            maybeDispose(record)
        }
    }

    // ---- admission ----------------------------------------------------

    const issue = () => {
        active++
        const record = current
        const config = configStore.current()
        issued.add(config)
        const unpin = pinRecord(record)
        let released = false
        return {
            core: record.core,
            version: record.version,
            config,
            release: () => {
                if (released) return
                released = true
                active--
                unpin()
                if (active === 0 && pending && !pending.swapping && !gate) {
                    applyPending().catch(() => {})
                }
            },
        }
    }

    const dropWaiter = (waiter) => {
        const i = waiters.indexOf(waiter)
        if (i >= 0) waiters.splice(i, 1)
        if (waiter.deadlineTimer) clearTimer(waiter.deadlineTimer)
        if (waiter.holdTimer) clearTimer(waiter.holdTimer)
    }

    const holdMs = () => {
        const config = configStore.current()
        const wanted =
            (config.reload?.maxHoldSeconds ?? DEFAULT_MAX_HOLD_SECONDS) * 1000
        // The published hook wait is the larger limit plus the hold; keep
        // that sum within the hooks' cap.
        const base = Math.max(
            baseHookLimitMs(config),
            pending ? baseHookLimitMs(pending.config) : 0
        )
        return Math.max(0, Math.min(wanted, MAX_FETCH_TIMEOUT_MS - base))
    }

    const dispatchWaiters = () => {
        while (waiters.length > 0 && !gate) {
            const waiter = waiters[0]
            if (holding && waiter.held) return
            dropWaiter(waiter)
            waiter.resolve(issue())
        }
    }

    // Admits a review request. Counted and pinned at once when admission
    // is open; otherwise it waits at entry (uncounted, unpinned) for the
    // gate to reopen, the reload to end, or its hold deadline. Rejects
    // with DEADLINE_EXCEEDED when `deadline` passes first.
    const admitReview = ({ deadline = null } = {}) => {
        if (!gate && !holding) return Promise.resolve(issue())
        return new Promise((resolve, reject) => {
            const waiter = { resolve, reject, held: holding }
            waiters.push(waiter)
            if (deadline !== null) {
                waiter.deadlineTimer = setTimer(
                    () => {
                        dropWaiter(waiter)
                        reject(
                            new ReloadError(
                                "DEADLINE_EXCEEDED",
                                "request deadline passed while waiting for a reload"
                            )
                        )
                    },
                    Math.max(0, deadline - now())
                )
            }
            if (waiter.held) {
                waiter.holdTimer = setTimer(() => {
                    dropWaiter(waiter)
                    releasedAtDeadline++
                    waiter.resolve(issue())
                }, holdMs())
            }
        })
    }

    // Pins the current core for a non-review request.
    const pin = () => {
        const record = current
        return { core: record.core, release: pinRecord(record) }
    }

    // ---- pending reloads ------------------------------------------------

    let holdTimer = null
    const startHoldTimer = () => {
        if (holdTimer || holding) return
        const minutes =
            configStore.current().reload?.maxWaitMinutes ??
            DEFAULT_MAX_WAIT_MINUTES
        holdTimer = setTimer(() => {
            holdTimer = null
            if (!pending) return
            holding = true
            holdingSince = now()
            logger?.info?.(
                { to: pending.to },
                "reload pending too long — holding new reviews"
            )
        }, minutes * 60_000)
    }

    const endHold = () => {
        if (holdTimer) clearTimer(holdTimer)
        holdTimer = null
        holding = false
        holdingSince = null
        dispatchWaiters()
    }

    const record = (entry) => {
        history.unshift({ at: now(), ...entry })
        history.length = Math.min(history.length, HISTORY_LIMIT)
    }

    // Runs after the swap committed: it can't make a completed swap fail.
    const applyOutsideHolder = (config) => {
        try {
            onApplied(config)
        } catch (err) {
            logger?.warn?.(
                { err: err?.message },
                "applying a setting outside the config holder failed"
            )
        }
    }

    // Ends the pending reload without a swap: its distinct core goes, and
    // held requests run on the current core.
    const dropPending = (reason) => {
        const p = pending
        pending = null
        endHold()
        if (p) {
            record({
                kind: p.kind,
                requestedAt: p.requestedAt,
                from: current.version,
                to: p.to,
                ok: false,
                error: reason,
            })
            maybeDispose(p.record)
        }
        return p
    }

    const restartOnly = (config) =>
        RESTART_ONLY_KEYS.filter(
            (key) =>
                !same(
                    getIn(startupConfig, key.split(".")),
                    getIn(config, key.split("."))
                )
        )

    // The validated config a candidate would run: the file through the
    // candidate's own schema, with the running token (authToken is not a
    // reload setting) and no restart-only change. `withRaw` also returns
    // the file as written, which a rollback later compares against.
    const candidateConfig = (validateConfig, { withRaw = false } = {}) => {
        const file = configStore.readFile()
        const config = {
            ...validateConfig(file.parsed),
            authToken: configStore.current().authToken,
        }
        const changed = restartOnly(config)
        if (changed.length > 0) {
            throw new ReloadError(
                "RESTART_ONLY_KEY",
                `${changed.join(", ")} can only change with a restart`,
                422
            )
        }
        return withRaw ? { config, raw: file.parsed } : config
    }

    // §5.4 steps 3–6.
    const prepare = async () => {
        const loaded = await loadCandidate(current)
        if (loaded.same) {
            const config = candidateConfig(current.validateConfig)
            const changes = configChanges(configStore.current(), config)
            if (changes.length === 0) return { unchanged: true }
            current.core.selfCheck(frozenCopy(config))
            return { record: current, config, changes, to: current.version }
        }
        let candidate = null
        try {
            const config = candidateConfig(loaded.module.validateConfig)
            candidate = makeRecord({
                core: buildCore(loaded, config),
                validateConfig: loaded.module.validateConfig,
                version: loaded.version,
                reviewVersion: loaded.reviewVersion,
                snapshotDir: loaded.snapshotDir,
                codexSchemaPath: loaded.codexSchemaPath,
            })
            return {
                record: candidate,
                config,
                changes: configChanges(configStore.current(), config),
                to: loaded.version,
            }
        } catch (err) {
            if (candidate) maybeDispose(candidate)
            else disposeFiles(loaded)
            throw err
        }
    }

    // §5.4 step 8, for a reload. Runs inside the swap gate.
    const swapTo = (p) => {
        const { config, raw } = candidateConfig(p.record.validateConfig, {
            withRaw: true,
        })
        p.record.core.selfCheck(frozenCopy(config))
        const published = Math.max(
            baseHookLimitMs(configStore.current()),
            baseHookLimitMs(p.config)
        )
        if (baseHookLimitMs(config) > published) {
            throw new ReloadError(
                "HOOK_TIMEOUT_RAISED",
                "reviewer timeout raised after the reload was prepared — trigger the reload again"
            )
        }
        const before = configStore.current()
        const from = current
        if (p.record !== current) {
            try {
                p.record.core.attach(liveFor(p.record))
            } catch (err) {
                throw new ReloadError(
                    "ATTACH_FAILED",
                    `the new core failed to attach: ${err.message}`,
                    500
                )
            }
        }
        const dropped = previous?.record
        previous = { record: from, before, applied: config, appliedRaw: raw }
        current = p.record
        configStore.commit(config)
        applyOutsideHolder(config)
        maybeDispose(dropped)
        return {
            from: from.version,
            to: current.version,
            configChanges: configChanges(before, config),
        }
    }

    // §5.4 "Rollback": exchanges current and previous and restores the
    // config key by key. Runs inside the swap gate.
    const rollBack = () => {
        if (!previous) {
            throw new ReloadError(
                "NOTHING_TO_ROLL_BACK",
                "no reload to roll back"
            )
        }
        const { record: target, before, applied, appliedRaw } = previous
        const file = configStore.readFile()
        const live = configStore.current()
        const restored = structuredClone(live)
        const fileOut = structuredClone(file.parsed)
        const reverted = []
        const keptEdited = []
        const keptUnapplied = []
        for (const key of configChanges(before, applied)) {
            const keys = key.split(".")
            const a = getIn(applied, keys)
            if (!same(getIn(live, keys), a)) {
                keptEdited.push(key)
            } else if (
                !same(getIn(file.parsed, keys), getIn(appliedRaw, keys))
            ) {
                // The file holds something else than what the reload read
                // (raw against raw, so defaults, expanded paths and any
                // unrelated invalid key don't count): a manual edit.
                keptUnapplied.push(key)
            } else {
                setIn(restored, keys, getIn(before, keys))
                setIn(fileOut, keys, getIn(before, keys))
                reverted.push(key)
            }
        }
        // Keys only the newer schema accepts, edited after the reload, go
        // back to `before` too.
        const schemaReverted = []
        let config
        try {
            config = target.validateConfig(restored)
        } catch (err) {
            for (const issue of err.issues ?? []) {
                const paths =
                    issue.code === "unrecognized_keys"
                        ? issue.keys.map((k) => [...issue.path, k])
                        : [issue.path]
                for (const keys of paths) {
                    const value = getIn(before, keys)
                    setIn(restored, keys, value)
                    setIn(fileOut, keys, value)
                    schemaReverted.push(keys.join("."))
                }
            }
            config = target.validateConfig(restored)
        }
        target.core.selfCheck(frozenCopy(config))
        let backup = null
        if (reverted.length + schemaReverted.length > 0) {
            backup = configStore.writeFile(fileOut, {
                expectHash: file.hash,
                backupText: file.text,
            })
            if (backup === null) {
                throw new ReloadError(
                    "CONFIG_CHANGED_WHILE_SAVING",
                    "config.json changed while rolling back — try again"
                )
            }
        }
        const from = current
        previous = {
            record: from,
            before: live,
            applied: config,
            appliedRaw: backup === null ? file.parsed : fileOut,
        }
        current = target
        configStore.commit(config)
        configStore.pruneBackups?.()
        applyOutsideHolder(config)
        return {
            from: from.version,
            to: current.version,
            reverted: [...reverted, ...schemaReverted],
            keptEdited,
            keptUnapplied,
            backup,
        }
    }

    // Closes admission, runs `fn` under the config lock, then reopens and
    // dispatches waiting requests in arrival order.
    const runGate = async (fn) => {
        let open
        gate = new Promise((resolve) => {
            open = resolve
        })
        try {
            return await configStore.exclusive(fn)
        } finally {
            gate = null
            open()
            dispatchWaiters()
        }
    }

    // Applies the pending reload or rollback through the gate. Never
    // rejects: the outcome goes into the result and the history.
    const applyPending = () => {
        const p = pending
        if (!p || p.swapping || gate) {
            return Promise.resolve({ ok: true, applied: false })
        }
        p.swapping = true
        const startedAt = now()
        return runGate(() => {
            try {
                const result = p.kind === "rollback" ? rollBack() : swapTo(p)
                pending = null
                endHold()
                record({
                    kind: p.kind,
                    requestedAt: p.requestedAt,
                    appliedAt: now(),
                    from: result.from,
                    to: result.to,
                    ok: true,
                    configChanges: result.configChanges ?? result.reverted,
                    waitedMs: startedAt - p.requestedAt,
                })
                logger?.info?.(
                    { ...result },
                    p.kind === "rollback" ? "core rolled back" : "core reloaded"
                )
                return { ok: true, applied: true, kind: p.kind, ...result }
            } catch (err) {
                dropPending(err.message)
                logger?.warn?.(
                    { err: err.message, code: err.code },
                    "core reload failed"
                )
                return { ok: false, cancelled: true, ...describe(err) }
            }
        })
    }

    const summaryOf = (p) => ({
        kind: p.kind,
        to: p.to,
        requestedAt: p.requestedAt,
        configChanges: p.changes ?? [],
        swapping: p.swapping === true,
    })

    const PREPARE_ATTEMPTS = 3

    // The trigger behind POST /admin/reload: { cancel, rollback, now }.
    // Resolves to the response body; rejects with a ReloadError (or a
    // load / validation error) when preparation fails, leaving everything
    // as it was.
    const trigger = async ({
        cancel = false,
        rollback = false,
        now: applyNow = false,
    } = {}) => {
        // Re-checked synchronously right before acting: nothing below may
        // cancel, replace or roll back while a swap runs. With no swap in
        // progress there's no await at all, so none can start in between.
        while (gate) await gate
        if (cancel) {
            if (!pending) {
                const last = history[0]
                return {
                    ok: true,
                    cancelled: false,
                    reason: last
                        ? `nothing pending; the last ${last.kind} to ${last.to} was ${last.ok ? "applied" : "not applied"}`
                        : "nothing pending",
                }
            }
            const p = dropPending("cancelled")
            return { ok: true, cancelled: true, kind: p.kind, to: p.to }
        }
        if (preparing) {
            throw new ReloadError(
                "RELOAD_IN_PROGRESS",
                "a reload is already being prepared — try again shortly"
            )
        }
        // Apply now on a pending reload applies that very candidate.
        if (applyNow && pending && !rollback) return applyPending()
        let next
        if (rollback) {
            if (!previous) {
                throw new ReloadError(
                    "NOTHING_TO_ROLL_BACK",
                    "no reload to roll back"
                )
            }
            next = {
                kind: "rollback",
                record: null,
                to: previous.record.version,
            }
        } else {
            preparing = true
            let prepared
            try {
                // Preparation awaits the loader, and a swap (a release
                // finding the server idle) can run meanwhile. The check
                // that nothing moved and the change to the pending slot
                // below run in one synchronous step after the last await;
                // a candidate prepared against a core that's no longer
                // current, or while a swap runs, is discarded and prepared
                // again.
                for (let attempt = 1; ; attempt++) {
                    while (gate) await gate
                    const base = current
                    prepared = await prepare()
                    if (!gate && current === base && !pending?.swapping) break
                    if (prepared.record && prepared.record !== base) {
                        maybeDispose(prepared.record)
                    }
                    if (attempt >= PREPARE_ATTEMPTS) {
                        throw new ReloadError(
                            "RELOAD_RACED",
                            "the running core kept changing while the reload was prepared — try again"
                        )
                    }
                }
            } catch (err) {
                record({
                    kind: "reload",
                    requestedAt: now(),
                    from: current.version,
                    ok: false,
                    ...describe(err),
                })
                throw err
            } finally {
                preparing = false
            }
            if (prepared.unchanged) {
                const p = pending
                if (p) dropPending("files match the running core")
                return {
                    ok: true,
                    unchanged: true,
                    ...(p ? { cancelledPending: p.to } : {}),
                }
            }
            next = { kind: "reload", ...prepared }
        }
        // The newest trigger wins; a replacement keeps the place in the
        // wait (and any hold already running).
        const replaced = pending
        pending = {
            ...next,
            requestedAt: replaced?.requestedAt ?? now(),
            swapping: false,
        }
        if (replaced && replaced.record !== pending.record) {
            maybeDispose(replaced.record)
        }
        if (applyNow || active === 0) return applyPending()
        startHoldTimer()
        return {
            ok: true,
            scheduled: true,
            kind: pending.kind,
            to: pending.to,
            configChanges: pending.changes ?? [],
            activeReviews: active,
            waitingFor: runningReviews(),
        }
    }

    const status = () => ({
        coreVersion: current.version,
        reviewVersion: current.reviewVersion ?? null,
        loadedAt: new Date(current.loadedAt).toISOString(),
        previousVersion: previous?.record.version ?? null,
        activeReviews: active,
        pending: pending
            ? {
                  ...summaryOf(pending),
                  holding,
                  holdingSince,
                  heldNow: waiters.filter((w) => w.held).length,
                  releasedAtDeadline,
              }
            : null,
        history: history.slice(),
    })

    // Attaches the initial core (startup has no swap to do it).
    current.core.attach(liveFor(current))

    return {
        admitReview,
        pin,
        trigger,
        status,
        currentCore: () => current.core,
        isIssuedConfig: (config) => issued.has(config),
        // For tests and diagnostics.
        __state: () => ({
            current,
            previous,
            pending,
            active,
            holding,
            waiters,
        }),
    }
}
