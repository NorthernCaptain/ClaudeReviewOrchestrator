/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import {
    handleSetMaxBlocks,
    MIN_MAX_BLOCKS,
    MAX_MAX_BLOCKS,
} from "./maxBlocks.js"

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
    limits: { maxBlocks: 6 },
    reviewer: {},
    ...overrides,
})

describe("handleSetMaxBlocks", () => {
    test("400 when value is missing or non-numeric", () => {
        const r1 = handleSetMaxBlocks({ body: {}, config: cfg() })
        expect(r1.httpStatus).toBe(400)
        expect(r1.body.ok).toBe(false)

        const r2 = handleSetMaxBlocks({
            body: { value: "x" },
            config: cfg(),
        })
        expect(r2.httpStatus).toBe(400)
    })

    test("400 when value is out of range", () => {
        const below = handleSetMaxBlocks({
            body: { value: MIN_MAX_BLOCKS - 1 },
            config: cfg(),
        })
        expect(below.httpStatus).toBe(400)
        const above = handleSetMaxBlocks({
            body: { value: MAX_MAX_BLOCKS + 1 },
            config: cfg(),
        })
        expect(above.httpStatus).toBe(400)
    })

    test("mutates the live config and persists to disk", () => {
        const config = cfg()
        const fs = fakeFs(JSON.stringify({ limits: { maxBlocks: 6 } }, null, 2))
        const r = handleSetMaxBlocks({
            body: { value: 8 },
            config,
            configPath: "/tmp/whatever.json",
            deps: { fs },
        })
        expect(r.httpStatus).toBe(200)
        expect(r.body).toEqual(
            expect.objectContaining({
                ok: true,
                value: 8,
                previous: 6,
                persisted: true,
            })
        )
        expect(config.limits.maxBlocks).toBe(8)
        expect(JSON.parse(fs.read()).limits.maxBlocks).toBe(8)
    })

    test("truncates non-integer numeric input before applying", () => {
        const config = cfg()
        const fs = fakeFs(JSON.stringify({ limits: { maxBlocks: 6 } }, null, 2))
        const r = handleSetMaxBlocks({
            body: { value: 9.7 },
            config,
            configPath: "/x.json",
            deps: { fs },
        })
        expect(r.httpStatus).toBe(200)
        expect(r.body.value).toBe(9)
        expect(config.limits.maxBlocks).toBe(9)
    })

    test("reports persistError when disk write fails (live still mutates)", () => {
        const config = cfg()
        const fs = {
            readFileSync: () => JSON.stringify({ limits: { maxBlocks: 6 } }),
            writeFileSync: () => {
                throw new Error("EROFS")
            },
        }
        let warnCalls = 0
        const r = handleSetMaxBlocks({
            body: { value: 10 },
            config,
            configPath: "/x.json",
            deps: { fs },
            logger: { warn: () => warnCalls++, info: () => {} },
        })
        expect(r.httpStatus).toBe(200)
        expect(r.body.ok).toBe(true)
        expect(r.body.persisted).toBe(false)
        expect(r.body.persistError).toContain("EROFS")
        expect(config.limits.maxBlocks).toBe(10)
        expect(warnCalls).toBe(1)
    })

    test("creates limits block when it doesn't exist in the source config", () => {
        const config = {}
        const fs = fakeFs(JSON.stringify({}))
        const r = handleSetMaxBlocks({
            body: { value: 4 },
            config,
            configPath: "/x.json",
            deps: { fs },
        })
        expect(r.httpStatus).toBe(200)
        expect(config.limits.maxBlocks).toBe(4)
        expect(JSON.parse(fs.read()).limits.maxBlocks).toBe(4)
    })
})
