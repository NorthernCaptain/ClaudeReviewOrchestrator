/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import {
    handleSetMaxRounds,
    MIN_MAX_ROUNDS,
    MAX_MAX_ROUNDS,
} from "./maxRounds.js"

const fakeFs = (initial) => {
    let stored = initial
    return {
        readFileSync: () => stored,
        writeFileSync: (_p, data) => {
            stored = data
        },
        read: () => stored,
    }
}

const cfg = (overrides = {}) => ({
    limits: { maxCodexRounds: 5 },
    reviewer: {},
    ...overrides,
})

describe("handleSetMaxRounds", () => {
    test("400 when value is missing or non-numeric", () => {
        const r1 = handleSetMaxRounds({ body: {}, config: cfg() })
        expect(r1.httpStatus).toBe(400)
        expect(r1.body.ok).toBe(false)

        const r2 = handleSetMaxRounds({
            body: { value: "x" },
            config: cfg(),
        })
        expect(r2.httpStatus).toBe(400)
    })

    test("400 when value is out of range", () => {
        const below = handleSetMaxRounds({
            body: { value: MIN_MAX_ROUNDS - 1 },
            config: cfg(),
        })
        expect(below.httpStatus).toBe(400)
        const above = handleSetMaxRounds({
            body: { value: MAX_MAX_ROUNDS + 1 },
            config: cfg(),
        })
        expect(above.httpStatus).toBe(400)
    })

    test("mutates the live config and persists to disk", () => {
        const config = cfg()
        const fs = fakeFs(
            JSON.stringify({ limits: { maxCodexRounds: 5 } }, null, 2)
        )
        const r = handleSetMaxRounds({
            body: { value: 12 },
            config,
            configPath: "/tmp/whatever.json",
            deps: { fs },
        })
        expect(r.httpStatus).toBe(200)
        expect(r.body).toEqual(
            expect.objectContaining({
                ok: true,
                value: 12,
                previous: 5,
                persisted: true,
            })
        )
        expect(config.limits.maxCodexRounds).toBe(12)
        const persisted = JSON.parse(fs.read())
        expect(persisted.limits.maxCodexRounds).toBe(12)
    })

    test("truncates non-integer numeric input before applying", () => {
        const config = cfg()
        const fs = fakeFs(
            JSON.stringify({ limits: { maxCodexRounds: 5 } }, null, 2)
        )
        const r = handleSetMaxRounds({
            body: { value: 7.9 },
            config,
            configPath: "/x.json",
            deps: { fs },
        })
        expect(r.httpStatus).toBe(200)
        expect(r.body.value).toBe(7)
        expect(config.limits.maxCodexRounds).toBe(7)
    })

    test("reports persistError when disk write fails (live still mutates)", () => {
        const config = cfg()
        const fs = {
            readFileSync: () =>
                JSON.stringify({ limits: { maxCodexRounds: 5 } }),
            writeFileSync: () => {
                throw new Error("EROFS")
            },
        }
        let warnCalls = 0
        const r = handleSetMaxRounds({
            body: { value: 9 },
            config,
            configPath: "/x.json",
            deps: { fs },
            logger: { warn: () => warnCalls++, info: () => {} },
        })
        expect(r.httpStatus).toBe(200)
        expect(r.body.ok).toBe(true)
        expect(r.body.persisted).toBe(false)
        expect(r.body.persistError).toContain("EROFS")
        expect(config.limits.maxCodexRounds).toBe(9)
        expect(warnCalls).toBe(1)
    })

    test("creates limits block when it doesn't exist in the source config", () => {
        const config = {}
        const fs = fakeFs(JSON.stringify({}))
        const r = handleSetMaxRounds({
            body: { value: 3 },
            config,
            configPath: "/x.json",
            deps: { fs },
        })
        expect(r.httpStatus).toBe(200)
        expect(config.limits.maxCodexRounds).toBe(3)
        expect(JSON.parse(fs.read()).limits.maxCodexRounds).toBe(3)
    })
})
