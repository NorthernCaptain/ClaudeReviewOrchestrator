/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { readFileSync } from "node:fs"

const SCHEMA = readFileSync(
    new URL("./review/codex-output.schema.json", import.meta.url)
)

const staging = (over = {}) =>
    Object.freeze({
        resources: { "review/codex-output.schema.json": SCHEMA },
        version: "abc123",
        packageVersion: "1.2.3",
        startedAt: 1000,
        codexSchemaPath: null,
        ...over,
    })

const liveFor = (over = {}) => ({
    config: { allowedRoots: ["/repo"] },
    configPath: "/cfg.json",
    store: { list: () => [] },
    archive: null,
    metrics: null,
    logger: { info() {}, warn() {}, error() {} },
    registries: {
        inflight: new Map(),
        contextChains: new Map(),
        inflightMeta: new Map(),
    },
    deps: {},
    ...over,
})

const mkRes = () => {
    const res = { headers: {}, statusCode: 200, body: null }
    res.setHeader = (k, v) => {
        res.headers[k.toLowerCase()] = v
    }
    res.status = (c) => {
        res.statusCode = c
        return res
    }
    res.json = (b) => {
        res.body = b
        return res
    }
    return res
}

describe("importing the core", () => {
    test("has no side effects: no handles, timers or process listeners", async () => {
        const handles = process.getActiveResourcesInfo().sort()
        const events = ["exit", "SIGINT", "SIGTERM", "uncaughtException"]
        const listeners = events.map((e) => process.listenerCount(e))
        const core = await import("./index.js")
        expect(typeof core.createCore).toBe("function")
        expect(process.getActiveResourcesInfo().sort()).toEqual(handles)
        expect(events.map((e) => process.listenerCount(e))).toEqual(listeners)
    })
})

describe("static exports", () => {
    test("expose the contract and config validation before any core exists", async () => {
        const { CORE_API, STATE_FORMAT, validateConfig } =
            await import("./index.js")
        expect(CORE_API).toBe(1)
        expect(STATE_FORMAT).toBe(1)
        expect(validateConfig({ authToken: "t" }).port).toBe(7777)
    })
})

describe("createCore", () => {
    let createCore
    beforeAll(async () => {
        ;({ createCore } = await import("./index.js"))
    })

    test("returns a frozen instance with the full contract", () => {
        const core = createCore(staging())
        expect(Object.isFrozen(core)).toBe(true)
        expect(Object.isFrozen(core.routes)).toBe(true)
        expect(core).toMatchObject({
            api: 1,
            stateFormat: 1,
            version: "abc123",
        })
        expect(core.mcp.toolDefs.map((d) => d.name)).toEqual([
            "request_review",
            "reset_review_context",
        ])
        expect(core.resources["review/codex-output.schema.json"]).toBe(SCHEMA)
    })

    test("refuses staging without the output schema resource", () => {
        expect(() => createCore(staging({ resources: {} }))).toThrow(
            /core resource missing: review\/codex-output.schema.json/
        )
    })

    test("routes need attach; dispose detaches again", () => {
        const core = createCore(staging())
        expect(() => core.routes.inflight({}, mkRes())).toThrow(/not attached/)
        const live = liveFor()
        live.registries.inflightMeta.set("k", {
            contextKey: "/repo|main",
            repo: "repo",
            branch: "main",
            provider: "codex",
            force: false,
            startedAt: Date.now(),
        })
        core.attach(live)
        const res = mkRes()
        core.routes.inflight({}, res)
        expect(res.headers["cache-control"]).toBe("no-store")
        expect(res.body.inFlight).toEqual([
            expect.objectContaining({ contextKey: "/repo|main" }),
        ])
        core.dispose()
        expect(() => core.routes.inflight({}, mkRes())).toThrow(/not attached/)
    })

    test("attach is a pure reference assignment: nothing reads live until a request", () => {
        const core = createCore(staging())
        const live = new Proxy(
            {},
            {
                get: () => {
                    throw new Error("read during attach")
                },
            }
        )
        expect(() => core.attach(live)).not.toThrow()
    })

    test("selfCheck accepts a runnable config and rejects one it can't run", () => {
        const core = createCore(staging())
        expect(() =>
            core.selfCheck({ reviewer: { provider: "claude" } })
        ).not.toThrow()
        expect(() =>
            core.selfCheck({ reviewer: { provider: "nope" } })
        ).toThrow(/unknown reviewer.provider/)
    })

    test("summarizeConfig carries the package version", () => {
        const core = createCore(staging())
        expect(core.summarizeConfig({}).version).toBe("1.2.3")
    })
})
