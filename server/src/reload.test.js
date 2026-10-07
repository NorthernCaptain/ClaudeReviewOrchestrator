/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { jest } from "@jest/globals"
import {
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createConfigStore } from "./config-store.js"
import { ConfigLockError } from "../../install/config-lock.mjs"
import {
    baseHookLimitMs,
    configChanges,
    createReloadController,
    HISTORY_LIMIT,
    RESTART_ONLY_KEYS,
    requiredHookWaitMs,
} from "./reload.js"

let dir
let configPath
beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "reload-"))
    configPath = path.join(dir, "config.json")
})
afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
})

const base = () => ({
    authToken: "tok",
    port: 7777,
    bind: "127.0.0.1",
    reviewer: { provider: "codex" },
    limits: { maxCodexRounds: 5, codexTimeoutSeconds: 600 },
    reload: { maxWaitMinutes: 5, maxHoldSeconds: 45 },
})
const writeConfig = (obj) => writeFileSync(configPath, JSON.stringify(obj))
const editConfig = (fn) => {
    const c = JSON.parse(readFileSync(configPath, "utf8"))
    fn(c)
    writeConfig(c)
}
const readConfig = () => JSON.parse(readFileSync(configPath, "utf8"))

// A schema: needs limits.maxCodexRounds to be a number, and (for an "old"
// core) refuses keys under limits it doesn't know.
const schema =
    ({ known = null } = {}) =>
    (raw) => {
        if (typeof raw?.limits?.maxCodexRounds !== "number") {
            throw Object.assign(new Error("limits.maxCodexRounds required"), {
                code: "CONFIG_INVALID",
                issues: [
                    {
                        code: "invalid_type",
                        path: ["limits", "maxCodexRounds"],
                    },
                ],
            })
        }
        if (known) {
            const extra = Object.keys(raw.limits).filter(
                (k) => !known.includes(k)
            )
            if (extra.length > 0) {
                throw Object.assign(new Error(`unknown ${extra}`), {
                    code: "CONFIG_INVALID",
                    issues: [
                        {
                            code: "unrecognized_keys",
                            path: ["limits"],
                            keys: extra,
                        },
                    ],
                })
            }
        }
        return structuredClone(raw)
    }

const fakeCore = (version, { validateConfig = schema(), selfCheck } = {}) => {
    const core = {
        version,
        validateConfig,
        live: null,
        selfCheck: jest.fn(selfCheck ?? (() => {})),
        attach: jest.fn((live) => {
            core.live = live
        }),
        dispose: jest.fn(),
    }
    return core
}

// What loadCandidate hands back for a new core version.
const candidate = (version, opts) => {
    const core = fakeCore(version, opts)
    return {
        core,
        module: { validateConfig: core.validateConfig },
        version,
        reviewVersion: `r-${version}`,
        snapshotDir: `/snap/${version}`,
        codexSchemaPath: `/schema/${version}.json`,
    }
}

const fakeTimers = () => {
    let t = 1_000_000
    let seq = 0
    const timers = new Map()
    return {
        now: () => t,
        setTimer: (fn, ms) => {
            const id = ++seq
            timers.set(id, { fn, at: t + ms })
            return id
        },
        clearTimer: (id) => timers.delete(id),
        advance: (ms) => {
            t += ms
            for (const [id, timer] of [...timers].sort(
                (a, b) => a[1].at - b[1].at
            )) {
                if (timer.at <= t && timers.has(id)) {
                    timers.delete(id)
                    timer.fn()
                }
            }
        },
        pending: () => timers.size,
    }
}

const setup = ({
    initialConfig = base(),
    file = initialConfig,
    v1Schema = schema(),
    onApplied = null,
    onPendingChange = undefined,
    withFileLock = undefined,
} = {}) => {
    writeConfig(file)
    const v1 = fakeCore("v1", { validateConfig: v1Schema })
    const timers = fakeTimers()
    const disposed = []
    let next = { same: true }
    const loadCandidate = jest.fn(async () => {
        if (next instanceof Error) throw next
        return next
    })
    let ctl
    const configStore = createConfigStore({
        configPath,
        initial: initialConfig,
        checks: () => ({
            validate: ctl.currentCore().validateConfig,
            selfCheck: ctl.currentCore().selfCheck,
        }),
        now: timers.now,
        ...(withFileLock ? { withFileLock } : {}),
    })
    const applied = []
    ctl = createReloadController({
        initial: {
            core: v1,
            validateConfig: v1.validateConfig,
            version: "v1",
            snapshotDir: "/snap/v1",
        },
        configStore,
        startupConfig: initialConfig,
        liveFor: (record) => ({ forVersion: record.version }),
        loadCandidate,
        buildCore: (loaded, config) => {
            loaded.core.selfCheck(config)
            return loaded.core
        },
        disposeFiles: (record) =>
            disposed.push(record.snapshotDir ?? record.version),
        runningReviews: () => [{ repo: "r" }],
        onApplied: onApplied ?? ((c) => applied.push(c)),
        logger: { info() {}, warn: jest.fn() },
        now: timers.now,
        setTimer: timers.setTimer,
        clearTimer: timers.clearTimer,
        ...(onPendingChange ? { onPendingChange } : {}),
    })
    return {
        ctl,
        v1,
        timers,
        configStore,
        disposed,
        applied,
        loadCandidate,
        willLoad: (value) => {
            next = value
        },
    }
}

describe("configChanges + baseHookLimitMs", () => {
    test("lists dotted leaf keys that differ, arrays as values", () => {
        expect(
            configChanges(
                { a: { b: 1, c: [1] }, d: 1 },
                { a: { b: 2, c: [1] }, e: 1 }
            )
        ).toEqual(["a.b", "d", "e"])
    })

    test("the hook limit follows the hooks' own rules", () => {
        expect(baseHookLimitMs({ limits: { codexTimeoutSeconds: 600 } })).toBe(
            660_000
        )
        expect(baseHookLimitMs({ hook: { fetchTimeoutSeconds: 90 } })).toBe(
            90_000
        )
    })

    test("restart-only keys are the documented ones", () => {
        expect(RESTART_ONLY_KEYS).toEqual([
            "port",
            "bind",
            "logging.dir",
            "reviewsDir",
            "reviewsRetentionDays",
        ])
    })
})

describe("startup", () => {
    test("attaches the initial core; status reports it", () => {
        const { ctl, v1 } = setup()
        expect(v1.attach).toHaveBeenCalledWith({ forVersion: "v1" })
        expect(ctl.status()).toMatchObject({
            coreVersion: "v1",
            previousVersion: null,
            activeReviews: 0,
            pending: null,
            history: [],
        })
    })
})

describe("trigger — preparing", () => {
    test("unchanged code and config is a no-op", async () => {
        const { ctl, disposed } = setup()
        expect(await ctl.trigger()).toEqual({ ok: true, unchanged: true })
        expect(disposed).toEqual([])
        expect(ctl.status().history).toEqual([])
    })

    test("a config-only edit is applied as a reload on the running core", async () => {
        const { ctl, v1, configStore, applied } = setup()
        editConfig((c) => {
            c.limits.maxCodexRounds = 9
        })
        const r = await ctl.trigger()
        expect(r).toMatchObject({
            ok: true,
            applied: true,
            from: "v1",
            to: "v1",
            configChanges: ["limits.maxCodexRounds"],
        })
        expect(configStore.current().limits.maxCodexRounds).toBe(9)
        expect(v1.selfCheck).toHaveBeenCalled()
        expect(v1.attach).toHaveBeenCalledTimes(1)
        expect(applied).toHaveLength(1)
        expect(ctl.status()).toMatchObject({ previousVersion: "v1" })
    })

    test("new code with nothing running swaps immediately", async () => {
        const { ctl, willLoad, v1 } = setup()
        const v2 = candidate("v2")
        willLoad(v2)
        const r = await ctl.trigger()
        expect(r).toMatchObject({
            ok: true,
            applied: true,
            from: "v1",
            to: "v2",
        })
        expect(ctl.currentCore()).toBe(v2.core)
        expect(v2.core.attach).toHaveBeenCalledWith({ forVersion: "v2" })
        expect(v1.dispose).not.toHaveBeenCalled()
        expect(ctl.status().history[0]).toMatchObject({
            kind: "reload",
            ok: true,
            from: "v1",
            to: "v2",
        })
    })

    test.each([
        ["an import error", Object.assign(new Error("boom"), { code: "X" })],
        [
            "a contract mismatch",
            Object.assign(new Error("api"), { code: "CORE_API_MISMATCH" }),
        ],
    ])("%s keeps the current core", async (_label, err) => {
        const { ctl, willLoad, v1 } = setup()
        willLoad(err)
        await expect(ctl.trigger()).rejects.toBe(err)
        expect(ctl.currentCore()).toBe(v1)
        expect(ctl.status().history[0]).toMatchObject({
            ok: false,
            code: err.code,
        })
    })

    test("a self-check failure is rejected and its snapshot deleted", async () => {
        const { ctl, willLoad, disposed } = setup()
        willLoad(
            candidate("v2", {
                selfCheck: () => {
                    throw new Error("can't render")
                },
            })
        )
        await expect(ctl.trigger()).rejects.toThrow("can't render")
        expect(disposed).toEqual(["/snap/v2"])
        expect(ctl.status().coreVersion).toBe("v1")
    })

    test("an invalid config or a restart-only edit is rejected before any core is built", async () => {
        const { ctl, willLoad, disposed } = setup()
        editConfig((c) => {
            c.port = 8888
        })
        willLoad(candidate("v2"))
        await expect(ctl.trigger()).rejects.toMatchObject({
            code: "RESTART_ONLY_KEY",
            message: "port can only change with a restart",
        })
        expect(disposed).toEqual(["/snap/v2"])
        editConfig((c) => {
            c.port = 7777
            delete c.limits.maxCodexRounds
        })
        await expect(ctl.trigger()).rejects.toMatchObject({
            code: "CONFIG_INVALID",
        })
    })

    test("a trigger while one is being prepared gets 409", async () => {
        const { ctl, loadCandidate } = setup()
        let finish
        loadCandidate.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finish = () => resolve({ same: true })
                })
        )
        const first = ctl.trigger()
        await Promise.resolve()
        await expect(ctl.trigger()).rejects.toMatchObject({
            code: "RELOAD_IN_PROGRESS",
            httpStatus: 409,
        })
        finish()
        await first
    })

    test("authToken in the file is not a reload setting", async () => {
        const { ctl, configStore } = setup()
        editConfig((c) => {
            c.authToken = "rotated"
        })
        expect(await ctl.trigger()).toEqual({ ok: true, unchanged: true })
        expect(configStore.current().authToken).toBe("tok")
    })
})

describe("scheduling while reviews run", () => {
    test("scheduled, then swapped the moment the last review releases", async () => {
        const { ctl, willLoad } = setup()
        const ticket = await ctl.admitReview()
        willLoad(candidate("v2"))
        const r = await ctl.trigger()
        expect(r).toMatchObject({
            ok: true,
            scheduled: true,
            to: "v2",
            activeReviews: 1,
            waitingFor: [{ repo: "r" }],
        })
        expect(ctl.status().pending).toMatchObject({ kind: "reload", to: "v2" })
        ticket.release()
        await new Promise((r2) => setImmediate(r2))
        expect(ctl.status().coreVersion).toBe("v2")
        expect(ctl.status().pending).toBeNull()
        const next = await ctl.admitReview()
        expect(next.version).toBe("v2")
    })

    test("a second trigger replaces the pending candidate, which is disposed", async () => {
        const { ctl, willLoad, disposed } = setup()
        await ctl.admitReview()
        const v2 = candidate("v2")
        willLoad(v2)
        await ctl.trigger()
        willLoad(candidate("v3"))
        await ctl.trigger()
        expect(ctl.status().pending.to).toBe("v3")
        expect(v2.core.dispose).toHaveBeenCalled()
        expect(disposed).toEqual(["/snap/v2"])
    })

    test("cancel drops the pending reload and disposes its candidate", async () => {
        const { ctl, willLoad, disposed } = setup()
        await ctl.admitReview()
        willLoad(candidate("v2"))
        await ctl.trigger()
        expect(await ctl.trigger({ cancel: true })).toMatchObject({
            ok: true,
            cancelled: true,
            to: "v2",
        })
        expect(disposed).toEqual(["/snap/v2"])
        expect(await ctl.trigger({ cancel: true })).toMatchObject({
            cancelled: false,
            reason: "nothing pending; the last reload to v2 was not applied",
        })
    })

    test("a pending config-only reload that's cancelled or replaced never disposes the running core", async () => {
        const { ctl, willLoad, v1, disposed } = setup()
        await ctl.admitReview()
        editConfig((c) => {
            c.limits.maxCodexRounds = 9
        })
        await ctl.trigger()
        editConfig((c) => {
            c.limits.maxCodexRounds = 10
        })
        await ctl.trigger()
        await ctl.trigger({ cancel: true })
        willLoad(candidate("v2"))
        await ctl.trigger()
        expect(v1.dispose).not.toHaveBeenCalled()
        expect(disposed).toEqual([])
    })

    test("files reverted to the running state cancel the pending reload", async () => {
        const { ctl, willLoad, disposed } = setup()
        await ctl.admitReview()
        willLoad(candidate("v2"))
        await ctl.trigger()
        willLoad({ same: true })
        expect(await ctl.trigger()).toEqual({
            ok: true,
            unchanged: true,
            cancelledPending: "v2",
        })
        expect(disposed).toEqual(["/snap/v2"])
    })

    test("a failing second trigger leaves the validated pending reload in place", async () => {
        const { ctl, willLoad, timers } = setup()
        const t = await ctl.admitReview()
        willLoad(candidate("v2"))
        await ctl.trigger()
        timers.advance(5 * 60_000)
        const held = ctl.admitReview()
        willLoad(Object.assign(new Error("syntax"), { code: "CORE_X" }))
        await expect(ctl.trigger()).rejects.toThrow("syntax")
        expect(ctl.status().pending).toMatchObject({ to: "v2", holding: true })
        expect(ctl.status().pending.heldNow).toBe(1)
        t.release()
        expect((await held).version).toBe("v2")
    })
})

describe("swap-time checks", () => {
    const pendingV2 = async (opts) => {
        const env = setup(opts)
        const ticket = await env.ctl.admitReview()
        env.willLoad(candidate("v2"))
        await env.ctl.trigger()
        return { ...env, ticket }
    }
    const settle = () => new Promise((r) => setImmediate(r))

    test("a config that turns invalid before the swap cancels it", async () => {
        const { ctl, ticket, disposed } = await pendingV2()
        editConfig((c) => {
            delete c.limits.maxCodexRounds
        })
        ticket.release()
        await settle()
        expect(ctl.status()).toMatchObject({ coreVersion: "v1", pending: null })
        expect(ctl.status().history[0]).toMatchObject({ ok: false })
        expect(disposed).toEqual(["/snap/v2"])
    })

    test("a port edit made while the reload waits cancels it at the swap", async () => {
        const { ctl, ticket } = await pendingV2()
        editConfig((c) => {
            c.bind = "0.0.0.0"
        })
        ticket.release()
        await settle()
        expect(ctl.status().coreVersion).toBe("v1")
        expect(ctl.status().history[0].error).toMatch(/bind/)
    })

    test("a reviewer timeout raised after preparation is rejected; lowering it swaps", async () => {
        const raised = await pendingV2()
        editConfig((c) => {
            c.limits.codexTimeoutSeconds = 620
        })
        raised.ticket.release()
        await settle()
        expect(raised.ctl.status().coreVersion).toBe("v1")
        expect(raised.ctl.status().history[0].error).toMatch(
            /reviewer timeout raised after the reload was prepared/
        )

        rmSync(configPath)
        const lowered = await pendingV2()
        editConfig((c) => {
            c.limits.codexTimeoutSeconds = 300
        })
        lowered.ticket.release()
        await settle()
        expect(lowered.ctl.status().coreVersion).toBe("v2")
        expect(lowered.configStore.current().limits.codexTimeoutSeconds).toBe(
            300
        )
    })

    test("a dashboard edit and a manual edit made while waiting both apply", async () => {
        const { ctl, ticket, configStore } = await pendingV2()
        await configStore.mutate([[["limits", "maxCodexRounds"], 7]])
        editConfig((c) => {
            c.reviewer.provider = "claude"
        })
        ticket.release()
        await settle()
        expect(configStore.current()).toMatchObject({
            limits: { maxCodexRounds: 7 },
            reviewer: { provider: "claude" },
        })
    })

    test("a candidate whose attach throws leaves everything as it was", async () => {
        const env = setup()
        const ticket = await env.ctl.admitReview()
        const v2 = candidate("v2")
        v2.core.attach.mockImplementation(() => {
            throw new Error("attach broke")
        })
        env.willLoad(v2)
        await env.ctl.trigger()
        const before = env.configStore.current()
        ticket.release()
        await settle()
        expect(env.ctl.currentCore()).toBe(env.v1)
        expect(env.configStore.current()).toBe(before)
        expect(v2.core.dispose).toHaveBeenCalled()
        expect(env.ctl.status().history[0].error).toMatch(/attach broke/)
    })
})

describe("starvation guard", () => {
    const pendingWithReview = async () => {
        const env = setup()
        const ticket = await env.ctl.admitReview()
        env.willLoad(candidate("v2"))
        await env.ctl.trigger()
        return { ...env, ticket }
    }

    test("after maxWaitMinutes new reviews are held, uncounted, then run on the new core in order", async () => {
        const { ctl, timers, ticket } = await pendingWithReview()
        timers.advance(5 * 60_000 - 1)
        const early = await ctl.admitReview()
        expect(early.version).toBe("v1")
        early.release()
        timers.advance(1)
        expect(ctl.status().pending.holding).toBe(true)
        const order = []
        const a = ctl.admitReview().then((t) => order.push(["a", t.version]))
        const b = ctl.admitReview().then((t) => order.push(["b", t.version]))
        expect(ctl.status().activeReviews).toBe(1)
        expect(ctl.status().pending.heldNow).toBe(2)
        ticket.release()
        await Promise.all([a, b])
        expect(order).toEqual([
            ["a", "v2"],
            ["b", "v2"],
        ])
    })

    test("a held request reaching maxHoldSeconds runs on the current core, counted", async () => {
        const { ctl, timers } = await pendingWithReview()
        timers.advance(5 * 60_000)
        const held = ctl.admitReview()
        timers.advance(45_000)
        const t = await held
        expect(t.version).toBe("v1")
        expect(ctl.status().activeReviews).toBe(2)
        expect(ctl.status().pending.releasedAtDeadline).toBe(1)
    })

    test("the hold is clamped so the hooks' published wait stays under their cap", async () => {
        const env = setup({
            initialConfig: {
                ...base(),
                limits: { maxCodexRounds: 5, codexTimeoutSeconds: 1670 },
            },
        })
        await env.ctl.admitReview()
        env.willLoad(candidate("v2"))
        await env.ctl.trigger()
        env.timers.advance(5 * 60_000)
        const held = env.ctl.admitReview()
        // 1740 s cap − (1670 + 60) s published = 10 s of hold.
        env.timers.advance(10_000)
        expect((await held).version).toBe("v1")
    })

    test("cancel releases every held request onto the current core, in order", async () => {
        const { ctl, timers } = await pendingWithReview()
        timers.advance(5 * 60_000)
        const order = []
        const a = ctl.admitReview().then((t) => order.push(t.version))
        const b = ctl.admitReview().then((t) => order.push(t.version))
        await ctl.trigger({ cancel: true })
        await Promise.all([a, b])
        expect(order).toEqual(["v1", "v1"])
        expect(timers.pending()).toBe(0)
    })

    test("a held request whose deadline passes first leaves with DEADLINE_EXCEEDED", async () => {
        const { ctl, timers } = await pendingWithReview()
        timers.advance(5 * 60_000)
        const held = ctl.admitReview({ deadline: timers.now() + 1000 })
        timers.advance(1000)
        await expect(held).rejects.toMatchObject({ code: "DEADLINE_EXCEEDED" })
        expect(ctl.status().pending.heldNow).toBe(0)
    })
})

describe("apply now", () => {
    test("swaps at once; the running review finishes on the old core, which stays as previous", async () => {
        const { ctl, willLoad, v1, disposed } = setup()
        const running = await ctl.admitReview()
        willLoad(candidate("v2"))
        const r = await ctl.trigger({ now: true })
        expect(r).toMatchObject({ applied: true, from: "v1", to: "v2" })
        expect(running.core).toBe(v1)
        expect((await ctl.admitReview()).version).toBe("v2")
        running.release()
        expect(v1.dispose).not.toHaveBeenCalled()
        // A later swap pushes v1 out of previous; it's disposed then.
        willLoad(candidate("v3"))
        await ctl.trigger({ now: true })
        expect(v1.dispose).toHaveBeenCalled()
        expect(disposed).toEqual(["/snap/v1"])
    })

    test("on a pending reload it applies that candidate", async () => {
        const { ctl, willLoad, loadCandidate } = setup()
        await ctl.admitReview()
        willLoad(candidate("v2"))
        await ctl.trigger()
        expect(await ctl.trigger({ now: true })).toMatchObject({
            applied: true,
            to: "v2",
        })
        expect(loadCandidate).toHaveBeenCalledTimes(1)
    })

    test("a failing swap-time check changes nothing", async () => {
        const { ctl, willLoad } = setup()
        await ctl.admitReview()
        willLoad(candidate("v2"))
        await ctl.trigger()
        editConfig((c) => {
            c.port = 1
        })
        expect(await ctl.trigger({ now: true })).toMatchObject({
            ok: false,
            code: "RESTART_ONLY_KEY",
        })
        expect(ctl.status().coreVersion).toBe("v1")
    })
})

describe("dispose by reference and pins", () => {
    test("a swap disposes only the core that drops out of current and previous", async () => {
        const { ctl, willLoad, v1, disposed } = setup()
        willLoad(candidate("v2"))
        await ctl.trigger()
        expect(disposed).toEqual([])
        const v3 = candidate("v3")
        willLoad(v3)
        await ctl.trigger()
        expect(v1.dispose).toHaveBeenCalled()
        expect(disposed).toEqual(["/snap/v1"])
    })

    test("a dropped-out core isn't disposed while a request is still pinned to it", async () => {
        const { ctl, willLoad, v1 } = setup()
        const pinned = ctl.pin()
        willLoad(candidate("v2"))
        await ctl.trigger()
        willLoad(candidate("v3"))
        await ctl.trigger()
        expect(v1.dispose).not.toHaveBeenCalled()
        pinned.release()
        pinned.release()
        expect(v1.dispose).toHaveBeenCalledTimes(1)
    })
})

describe("races and post-commit work", () => {
    test("a swap landing while a replacement prepares makes it prepare again against the new core", async () => {
        const { ctl, willLoad, loadCandidate } = setup()
        const t = await ctl.admitReview()
        const v2 = candidate("v2")
        willLoad(v2)
        await ctl.trigger()
        let finishLoad
        loadCandidate.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finishLoad = () => resolve(candidate("v3"))
                })
        )
        loadCandidate.mockImplementation(async () => candidate("v3"))
        const replacement = ctl.trigger()
        await new Promise((r) => setImmediate(r))
        t.release()
        await new Promise((r) => setImmediate(r))
        expect(ctl.status().coreVersion).toBe("v2")
        finishLoad()
        expect(await replacement).toMatchObject({
            applied: true,
            from: "v2",
            to: "v3",
        })
        expect(ctl.status().previousVersion).toBe("v2")
        expect(v2.core.dispose).not.toHaveBeenCalled()
        expect(loadCandidate).toHaveBeenCalledTimes(3)
    })

    test("a release landing just as preparation finishes still never touches the swapping candidate", async () => {
        const { ctl, willLoad, loadCandidate } = setup()
        const t = await ctl.admitReview()
        const v2 = candidate("v2")
        willLoad(v2)
        await ctl.trigger()
        // The loader's own promise settles with the release queued right
        // behind it, so the swap starts in the gap after preparation.
        loadCandidate.mockImplementationOnce(async () => {
            queueMicrotask(() => t.release())
            return candidate("v3")
        })
        loadCandidate.mockImplementation(async () => candidate("v3"))
        const r = await ctl.trigger()
        expect(r).toMatchObject({ applied: true, from: "v2", to: "v3" })
        expect(ctl.status().previousVersion).toBe("v2")
        expect(v2.core.dispose).not.toHaveBeenCalled()
    })

    test("a cleanup failure while disposing an old core never fails the swap", async () => {
        const env = setup()
        const warn = jest.fn()
        let n = 0
        const ctl = createReloadController({
            initial: {
                core: fakeCore("a"),
                validateConfig: schema(),
                version: "a",
            },
            configStore: env.configStore,
            startupConfig: base(),
            liveFor: () => ({}),
            loadCandidate: async () => candidate("v" + ++n),
            buildCore: (loaded) => loaded.core,
            disposeFiles: () => {
                throw Object.assign(new Error("EACCES"), { code: "EACCES" })
            },
            logger: { info() {}, warn },
        })
        await ctl.trigger()
        const r = await ctl.trigger()
        expect(r).toMatchObject({ ok: true, applied: true })
        expect(warn).toHaveBeenCalledWith(
            expect.objectContaining({ err: "EACCES" }),
            expect.stringMatching(/files failed/)
        )
    })

    test("a cancel arriving just as the last review releases never disposes a swapping candidate", async () => {
        const { ctl, willLoad } = setup()
        const t = await ctl.admitReview()
        const v2 = candidate("v2")
        willLoad(v2)
        await ctl.trigger()
        queueMicrotask(() => t.release())
        const r = await ctl.trigger({ cancel: true })
        await new Promise((resolve) => setImmediate(resolve))
        if (r.cancelled) {
            expect(ctl.status().coreVersion).toBe("v1")
        } else {
            expect(ctl.status().coreVersion).toBe("v2")
            expect(v2.core.dispose).not.toHaveBeenCalled()
        }
        expect(ctl.currentCore().dispose.mock.calls.length).toBe(0)
    })

    test("a failing post-commit step never turns an applied swap into a failure", async () => {
        const { ctl, willLoad } = setup({
            onApplied: () => {
                throw new Error("bad level")
            },
        })
        willLoad(candidate("v2"))
        expect(await ctl.trigger()).toMatchObject({ ok: true, applied: true })
        expect(ctl.status().coreVersion).toBe("v2")
    })
})

describe("swap gate", () => {
    test("a review arriving while a config transaction holds the lock waits, then runs on the new core", async () => {
        const { ctl, willLoad, configStore } = setup()
        let unlock
        const held = configStore.exclusive(
            () =>
                new Promise((r) => {
                    unlock = r
                })
        )
        willLoad(candidate("v2"))
        const swap = ctl.trigger()
        await new Promise((r) => setImmediate(r))
        const review = ctl.admitReview()
        expect(ctl.status().activeReviews).toBe(0)
        unlock()
        await held
        expect(await swap).toMatchObject({ applied: true })
        expect((await review).version).toBe("v2")
    })

    test("a cancel arriving during the gated swap waits, then reports it applied", async () => {
        const { ctl, willLoad, configStore } = setup()
        let unlock
        configStore.exclusive(
            () =>
                new Promise((r) => {
                    unlock = r
                })
        )
        willLoad(candidate("v2"))
        const swap = ctl.trigger()
        await new Promise((r) => setImmediate(r))
        const cancel = ctl.trigger({ cancel: true })
        unlock()
        await swap
        expect(await cancel).toMatchObject({
            cancelled: false,
            reason: "nothing pending; the last reload to v2 was applied",
        })
    })
})

describe("rollback", () => {
    test("needs a previous core", async () => {
        const { ctl } = setup()
        await expect(ctl.trigger({ rollback: true })).rejects.toMatchObject({
            code: "NOTHING_TO_ROLL_BACK",
        })
    })

    test("after a config-only reload: changed keys revert in memory and on disk, a dashboard edit is kept", async () => {
        const { ctl, configStore } = setup()
        editConfig((c) => {
            c.limits.maxCodexRounds = 9
            c.reviewer.provider = "claude"
        })
        await ctl.trigger()
        await configStore.mutate([[["reviewer", "provider"], "gemini"]])
        editConfig((c) => {
            c.authToken = "rotated"
        })
        const r = await ctl.trigger({ rollback: true })
        expect(r).toMatchObject({
            applied: true,
            kind: "rollback",
            reverted: ["limits.maxCodexRounds"],
            keptEdited: ["reviewer.provider"],
            keptUnapplied: [],
        })
        expect(configStore.current().limits.maxCodexRounds).toBe(5)
        expect(configStore.current().reviewer.provider).toBe("gemini")
        const onDisk = readConfig()
        expect(onDisk.limits.maxCodexRounds).toBe(5)
        expect(onDisk.authToken).toBe("rotated")
        expect(
            readdirSync(dir).some((n) => n.startsWith("config.json.bak-"))
        ).toBe(true)
        expect(r.backup).toContain("config.json.bak-")
    })

    test("an unapplied manual edit to a key the reload changed is kept and reported", async () => {
        const { ctl, configStore } = setup()
        editConfig((c) => {
            c.limits.maxCodexRounds = 9
            c.reviewer.provider = "claude"
        })
        await ctl.trigger()
        editConfig((c) => {
            c.limits.maxCodexRounds = 11
        })
        const r = await ctl.trigger({ rollback: true })
        expect(r).toMatchObject({
            reverted: ["reviewer.provider"],
            keptUnapplied: ["limits.maxCodexRounds"],
        })
        expect(configStore.current().limits.maxCodexRounds).toBe(9)
        expect(readConfig()).toMatchObject({
            limits: { maxCodexRounds: 11 },
            reviewer: { provider: "codex" },
        })
    })

    test("defaults and normalized values aren't mistaken for manual edits", async () => {
        // A schema that fills limits.maxCodexRounds with its default (5).
        const defaulting = (raw) => {
            const out = structuredClone(raw)
            out.limits = { maxCodexRounds: 5, ...(out.limits ?? {}) }
            return out
        }
        const { ctl, configStore } = setup({
            initialConfig: {
                ...base(),
                limits: { maxCodexRounds: 9, codexTimeoutSeconds: 600 },
            },
            v1Schema: defaulting,
        })
        editConfig((c) => {
            delete c.limits.maxCodexRounds
        })
        expect(await ctl.trigger()).toMatchObject({
            applied: true,
            configChanges: ["limits.maxCodexRounds"],
        })
        expect(configStore.current().limits.maxCodexRounds).toBe(5)
        const r = await ctl.trigger({ rollback: true })
        expect(r).toMatchObject({
            reverted: ["limits.maxCodexRounds"],
            keptUnapplied: [],
        })
        expect(configStore.current().limits.maxCodexRounds).toBe(9)
        expect(readConfig().limits.maxCodexRounds).toBe(9)
    })

    test("an unrelated invalid key in the file doesn't stop unchanged keys from reverting", async () => {
        // A schema with a default and path expansion, which also refuses a
        // bad logging level.
        const normalizing = (raw) => {
            if (raw?.logging?.level === "bogus") {
                throw Object.assign(new Error("logging.level"), {
                    code: "CONFIG_INVALID",
                })
            }
            const out = structuredClone(raw)
            out.limits = { maxCodexRounds: 5, ...(out.limits ?? {}) }
            out.allowedRoots = (out.allowedRoots ?? []).map((r) =>
                r === "~" ? "/home/me" : r
            )
            return out
        }
        const initial = {
            ...base(),
            allowedRoots: ["/tmp"],
            limits: { maxCodexRounds: 9, codexTimeoutSeconds: 600 },
        }
        const { ctl, configStore } = setup({
            initialConfig: initial,
            v1Schema: normalizing,
        })
        editConfig((c) => {
            c.allowedRoots = ["~"]
            delete c.limits.maxCodexRounds
        })
        await ctl.trigger()
        expect(configStore.current()).toMatchObject({
            allowedRoots: ["/home/me"],
            limits: { maxCodexRounds: 5 },
        })
        editConfig((c) => {
            c.logging = { level: "bogus" }
        })
        const r = await ctl.trigger({ rollback: true })
        expect(r).toMatchObject({ applied: true, keptUnapplied: [] })
        expect(r.reverted.sort()).toEqual([
            "allowedRoots",
            "limits.maxCodexRounds",
        ])
        expect(configStore.current()).toMatchObject({
            allowedRoots: ["/tmp"],
            limits: { maxCodexRounds: 9 },
        })
        expect(readConfig()).toMatchObject({
            allowedRoots: ["/tmp"],
            limits: { maxCodexRounds: 9 },
            logging: { level: "bogus" },
        })
    })

    test("a key only the newer schema accepts goes back too, and is listed", async () => {
        const { ctl, willLoad, configStore, v1 } = setup({
            v1Schema: schema({
                known: ["maxCodexRounds", "codexTimeoutSeconds"],
            }),
        })
        editConfig((c) => {
            c.limits.newCap = 3
        })
        willLoad(candidate("v2"))
        await ctl.trigger()
        await configStore.mutate([[["limits", "newCap"], 4]])
        const r = await ctl.trigger({ rollback: true })
        expect(r.reverted).toEqual(["limits.newCap"])
        expect(configStore.current().limits.newCap).toBeUndefined()
        expect(readConfig().limits.newCap).toBeUndefined()
        expect(ctl.currentCore()).toBe(v1)
    })

    test("a rollback of a rollback re-applies the reload", async () => {
        const { ctl, willLoad, configStore } = setup()
        editConfig((c) => {
            c.limits.maxCodexRounds = 9
        })
        willLoad(candidate("v2"))
        await ctl.trigger()
        await ctl.trigger({ rollback: true })
        expect(ctl.status().coreVersion).toBe("v1")
        expect(configStore.current().limits.maxCodexRounds).toBe(5)
        await ctl.trigger({ rollback: true })
        expect(ctl.status().coreVersion).toBe("v2")
        expect(configStore.current().limits.maxCodexRounds).toBe(9)
    })

    test("is refused when the previous core's self-check fails, changing nothing", async () => {
        const { ctl, willLoad, v1, configStore } = setup()
        editConfig((c) => {
            c.limits.maxCodexRounds = 9
        })
        willLoad(candidate("v2"))
        await ctl.trigger()
        v1.selfCheck.mockImplementation(() => {
            throw new Error("old core can't")
        })
        const r = await ctl.trigger({ rollback: true })
        expect(r).toMatchObject({ ok: false, cancelled: true })
        expect(ctl.status().coreVersion).toBe("v2")
        expect(configStore.current().limits.maxCodexRounds).toBe(9)
        expect(readConfig().limits.maxCodexRounds).toBe(9)
    })

    test("follows the idle rule and disposes nothing", async () => {
        const { ctl, willLoad, v1 } = setup()
        willLoad(candidate("v2"))
        await ctl.trigger()
        const t = await ctl.admitReview()
        expect(await ctl.trigger({ rollback: true })).toMatchObject({
            scheduled: true,
            kind: "rollback",
            to: "v1",
        })
        t.release()
        await new Promise((r) => setImmediate(r))
        expect(ctl.status().coreVersion).toBe("v1")
        expect(v1.dispose).not.toHaveBeenCalled()
    })
})

describe("admission bookkeeping", () => {
    test("an admitted review is counted, pinned and gets an issued, frozen config", async () => {
        const { ctl } = setup()
        const t = await ctl.admitReview()
        expect(ctl.status().activeReviews).toBe(1)
        expect(ctl.isIssuedConfig(t.config)).toBe(true)
        expect(ctl.isIssuedConfig({ ...t.config })).toBe(false)
        expect(Object.isFrozen(t.config.limits)).toBe(true)
        t.release()
        t.release()
        expect(ctl.status().activeReviews).toBe(0)
    })

    test("history keeps the last 20 entries", async () => {
        const { ctl, willLoad } = setup()
        willLoad(Object.assign(new Error("x"), { code: "X" }))
        for (let i = 0; i < HISTORY_LIMIT + 3; i++) {
            await ctl.trigger().catch(() => {})
        }
        expect(ctl.status().history).toHaveLength(HISTORY_LIMIT)
    })
})

describe("requiredHookWaitMs", () => {
    test("the configured reviewer's timeout + 60 s, or a pinned hook limit", () => {
        const defaults = {
            reviewer: {
                provider: "codex",
                claude: { timeoutSeconds: 600 },
                gemini: { timeoutSeconds: 900 },
            },
            limits: { codexTimeoutSeconds: 240 },
        }
        expect(requiredHookWaitMs(defaults)).toBe(300_000)
        expect(
            requiredHookWaitMs({
                ...defaults,
                reviewer: { ...defaults.reviewer, provider: "gemini" },
            })
        ).toBe(960_000)
        expect(
            requiredHookWaitMs({
                reviewer: { provider: "claude" },
                limits: { codexTimeoutSeconds: 120 },
            })
        ).toBe(180_000)
        expect(
            requiredHookWaitMs({
                ...defaults,
                hook: { fetchTimeoutSeconds: 90 },
            })
        ).toBe(90_000)
        expect(requiredHookWaitMs({})).toBe(660_000)
    })
})

describe("the published hook wait and the config lock", () => {
    const raiseTimeout = (seconds) =>
        editConfig((c) => {
            c.limits.codexTimeoutSeconds = seconds
        })

    test("idle: the running config's wait; pending: the larger one plus the hold, republished on each change", async () => {
        const onPendingChange = jest.fn()
        const { ctl } = setup({ onPendingChange })
        expect(ctl.publishedHookTimeoutMs()).toBe(660_000)
        const ticket = await ctl.admitReview()
        raiseTimeout(900)
        expect(await ctl.trigger()).toMatchObject({ scheduled: true })
        expect(onPendingChange).toHaveBeenCalledTimes(1)
        expect(ctl.publishedHookTimeoutMs()).toBe(960_000 + 45_000)
        ticket.release()
        await new Promise((r) => setImmediate(r))
        await new Promise((r) => setImmediate(r))
        expect(ctl.status().pending).toBeNull()
        expect(onPendingChange).toHaveBeenCalledTimes(2)
        expect(ctl.publishedHookTimeoutMs()).toBe(960_000)
    })

    test("the hold is clamped so the published wait stays within the hooks' cap", async () => {
        const { ctl } = setup()
        const ticket = await ctl.admitReview()
        raiseTimeout(1680)
        await ctl.trigger()
        expect(ctl.publishedHookTimeoutMs()).toBe(1_740_000)
        ticket.release()
    })

    test("a pending rollback publishes the larger of now and the config it restores", async () => {
        const { ctl } = setup()
        raiseTimeout(300)
        await ctl.trigger()
        expect(ctl.publishedHookTimeoutMs()).toBe(360_000)
        const ticket = await ctl.admitReview()
        await ctl.trigger({ rollback: true })
        expect(ctl.publishedHookTimeoutMs()).toBe(660_000 + 45_000)
        ticket.release()
    })

    test("a failing pending-change listener is logged, not fatal", async () => {
        const { ctl } = setup({
            onPendingChange: () => {
                throw new Error("listener broke")
            },
        })
        const ticket = await ctl.admitReview()
        raiseTimeout(900)
        await expect(ctl.trigger()).resolves.toMatchObject({ scheduled: true })
        ticket.release()
    })

    test("swaps run under the config lock; a lock held elsewhere fails the reload and reopens admission", async () => {
        const locked = []
        let refuse = false
        const withFileLock = async (p, fn) => {
            if (refuse) {
                throw new ConfigLockError(
                    "config.json is locked by another writer — try again"
                )
            }
            locked.push(p)
            return fn()
        }
        const { ctl } = setup({ withFileLock })
        raiseTimeout(900)
        expect(await ctl.trigger()).toMatchObject({ applied: true })
        expect(locked).toEqual([configPath])
        raiseTimeout(1000)
        refuse = true
        const r = await ctl.trigger()
        expect(r).toMatchObject({
            ok: false,
            cancelled: true,
            code: "CONFIG_LOCKED",
        })
        expect(ctl.status().pending).toBeNull()
        expect(ctl.status().history[0]).toMatchObject({
            ok: false,
            error: /locked by another writer/,
        })
        const ticket = await ctl.admitReview()
        expect(ticket.config.limits.codexTimeoutSeconds).toBe(900)
        ticket.release()
    })
})

describe("rollback never restores what config.json owns", () => {
    const rotation = (n) => ({
        tokenHash: `h${n}`,
        previousTokenHash: `h${n - 1}`,
        grace: "default",
        at: "2026-10-07T12:00:00.000Z",
    })

    test("a rotation picked up by a reload survives its rollback, in the file and out of the reverted list", async () => {
        const { ctl, configStore } = setup()
        editConfig((c) => {
            c.authToken = "rotated"
            c.auth = { rotations: [rotation(1)] }
            c.limits.maxCodexRounds = 9
        })
        await ctl.trigger()
        expect(configStore.current().auth.rotations).toHaveLength(1)
        const r = await ctl.trigger({ rollback: true })
        expect(r.reverted).toEqual(["limits.maxCodexRounds"])
        expect(readConfig()).toMatchObject({
            authToken: "rotated",
            auth: { rotations: [rotation(1)] },
            limits: { maxCodexRounds: 5 },
        })
    })

    test("a later rotation isn't undone either", async () => {
        const { ctl } = setup()
        editConfig((c) => {
            c.auth = { rotations: [rotation(1)] }
            c.limits.maxCodexRounds = 9
        })
        await ctl.trigger()
        editConfig((c) => {
            c.authToken = "again"
            c.auth.rotations.push(rotation(2))
        })
        await ctl.trigger({ rollback: true })
        expect(readConfig().auth.rotations).toEqual([rotation(1), rotation(2)])
        expect(readConfig().authToken).toBe("again")
    })

    // v1 knows no top-level "auth".
    const preAuthSchema = (raw) => {
        if (raw.auth !== undefined) {
            throw Object.assign(new Error("unknown auth"), {
                code: "CONFIG_INVALID",
                issues: [
                    { code: "unrecognized_keys", path: [], keys: ["auth"] },
                ],
            })
        }
        return schema()(raw)
    }

    test("a rollback to a core that can't accept the file's rotation history is refused, changing nothing", async () => {
        const { ctl, willLoad, configStore } = setup({
            v1Schema: preAuthSchema,
        })
        editConfig((c) => {
            c.auth = { rotations: [rotation(1)], previousTokenGraceHours: 2 }
        })
        willLoad(candidate("v2"))
        await ctl.trigger()
        const fileBefore = readConfig()
        await expect(ctl.trigger({ rollback: true })).resolves.toMatchObject({
            ok: false,
            code: "ROLLBACK_DROPS_FILE_OWNED_KEYS",
            error: /doesn't accept auth\.rotations/,
        })
        expect(ctl.status().coreVersion).toBe("v2")
        expect(readConfig()).toEqual(fileBefore)
        // Config transactions keep working on the core that stayed.
        await expect(
            configStore.mutate([[["limits", "maxCodexRounds"], 7]])
        ).resolves.toMatchObject({ revision: expect.any(Number) })
    })

    test("a rejected field inside a rotation record is refused too", async () => {
        const oldRecordShape = (raw) => {
            const bad = (raw.auth?.rotations ?? []).findIndex((r) => r.extra)
            if (bad >= 0) {
                throw Object.assign(new Error("unknown extra"), {
                    code: "CONFIG_INVALID",
                    issues: [
                        {
                            code: "unrecognized_keys",
                            path: ["auth", "rotations", bad],
                            keys: ["extra"],
                        },
                    ],
                })
            }
            return schema()(raw)
        }
        const { ctl, willLoad } = setup({ v1Schema: oldRecordShape })
        editConfig((c) => {
            c.auth = { rotations: [{ ...rotation(1), extra: 1 }] }
        })
        willLoad(candidate("v2"))
        await ctl.trigger()
        await expect(ctl.trigger({ rollback: true })).resolves.toMatchObject({
            ok: false,
            code: "ROLLBACK_DROPS_FILE_OWNED_KEYS",
        })
    })

    test("without rotation history, a schema rollback drops the auth block and edits keep working", async () => {
        const { ctl, willLoad, configStore } = setup({
            v1Schema: preAuthSchema,
        })
        editConfig((c) => {
            c.auth = { previousTokenGraceHours: 2 }
        })
        willLoad(candidate("v2"))
        await ctl.trigger()
        const r = await ctl.trigger({ rollback: true })
        expect(r).toMatchObject({ applied: true })
        expect(r.reverted.sort()).toEqual([
            "auth",
            "auth.previousTokenGraceHours",
        ])
        expect(configStore.current().auth).toBeUndefined()
        expect(readConfig().auth).toBeUndefined()
        await expect(
            configStore.mutate([[["limits", "maxCodexRounds"], 7]])
        ).resolves.toMatchObject({ revision: expect.any(Number) })
    })
})
