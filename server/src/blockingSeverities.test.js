/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import {
    handleSetBlockingSeverities,
    SEVERITY_ORDER,
} from "./blockingSeverities.js"

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
    blockingSeverities: ["blocker", "major"],
    ...overrides,
})

describe("handleSetBlockingSeverities", () => {
    test("exposes the canonical severity order", () => {
        expect(SEVERITY_ORDER).toEqual(["blocker", "major", "minor", "nit"])
    })

    test("400 when value is missing or not an array", () => {
        const r1 = handleSetBlockingSeverities({ body: {}, config: cfg() })
        expect(r1.httpStatus).toBe(400)
        expect(r1.body.ok).toBe(false)

        const r2 = handleSetBlockingSeverities({
            body: { value: "blocker" },
            config: cfg(),
        })
        expect(r2.httpStatus).toBe(400)
    })

    test("accepts an empty array as the 'nothing blocks' policy", () => {
        const config = cfg()
        const fs = fakeFs(
            JSON.stringify({ blockingSeverities: ["blocker", "major"] })
        )
        const r = handleSetBlockingSeverities({
            body: { value: [] },
            config,
            configPath: "/x.json",
            deps: { fs },
        })
        expect(r.httpStatus).toBe(200)
        expect(r.body.value).toEqual([])
        expect(config.blockingSeverities).toEqual([])
        expect(JSON.parse(fs.read()).blockingSeverities).toEqual([])
    })

    test("400 when value contains an invalid severity", () => {
        const r = handleSetBlockingSeverities({
            body: { value: ["blocker", "bogus"] },
            config: cfg(),
        })
        expect(r.httpStatus).toBe(400)
        expect(r.body.error).toContain("bogus")
    })

    test("mutates the live config and persists to disk", () => {
        const config = cfg()
        const fs = fakeFs(
            JSON.stringify(
                { blockingSeverities: ["blocker", "major"] },
                null,
                2
            )
        )
        const r = handleSetBlockingSeverities({
            body: { value: ["blocker", "major", "minor"] },
            config,
            configPath: "/tmp/whatever.json",
            deps: { fs },
        })
        expect(r.httpStatus).toBe(200)
        expect(r.body).toEqual(
            expect.objectContaining({
                ok: true,
                value: ["blocker", "major", "minor"],
                previous: ["blocker", "major"],
                persisted: true,
            })
        )
        expect(config.blockingSeverities).toEqual(["blocker", "major", "minor"])
        const persisted = JSON.parse(fs.read())
        expect(persisted.blockingSeverities).toEqual([
            "blocker",
            "major",
            "minor",
        ])
    })

    test("normalizes out-of-order / duplicate input into canonical order", () => {
        const config = cfg()
        const fs = fakeFs(JSON.stringify({}))
        const r = handleSetBlockingSeverities({
            body: { value: ["minor", "blocker", "blocker"] },
            config,
            configPath: "/x.json",
            deps: { fs },
        })
        expect(r.httpStatus).toBe(200)
        expect(r.body.value).toEqual(["blocker", "minor"])
        expect(config.blockingSeverities).toEqual(["blocker", "minor"])
    })

    test("previous is null when config had no prior array", () => {
        const config = {}
        const fs = fakeFs(JSON.stringify({}))
        const r = handleSetBlockingSeverities({
            body: { value: ["blocker"] },
            config,
            configPath: "/x.json",
            deps: { fs },
        })
        expect(r.httpStatus).toBe(200)
        expect(r.body.previous).toBeNull()
        expect(config.blockingSeverities).toEqual(["blocker"])
    })

    test("reports persistError when disk write fails (live still mutates)", () => {
        const config = cfg()
        const fs = {
            readFileSync: () => JSON.stringify({ blockingSeverities: [] }),
            writeFileSync: () => {
                throw new Error("EROFS")
            },
        }
        let warnCalls = 0
        const r = handleSetBlockingSeverities({
            body: { value: ["blocker", "major", "minor", "nit"] },
            config,
            configPath: "/x.json",
            deps: { fs },
            logger: { warn: () => warnCalls++, info: () => {} },
        })
        expect(r.httpStatus).toBe(200)
        expect(r.body.ok).toBe(true)
        expect(r.body.persisted).toBe(false)
        expect(r.body.persistError).toContain("EROFS")
        expect(config.blockingSeverities).toEqual([
            "blocker",
            "major",
            "minor",
            "nit",
        ])
        expect(warnCalls).toBe(1)
    })
})
