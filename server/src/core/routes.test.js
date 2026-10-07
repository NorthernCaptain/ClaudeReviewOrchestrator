/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { jest } from "@jest/globals"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createConfigStore } from "../config-store.js"
import { DASHBOARD_API } from "./dashboard.js"
import { createUiEntry } from "./routes.js"

let dir
beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "routes-"))
})
afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
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
    res.send = (b) => {
        res.body = b
        return res
    }
    return res
}

const makeLive = () => {
    const contexts = [
        {
            key: "/repo|main",
            repoRoot: "/repo",
            branch: "main",
            exclusions: [],
        },
    ]
    const config = {
        allowedRoots: ["/repo"],
        reviewer: { provider: "codex" },
        codex: { model: "gpt-6.1-sol", reasoningEffort: "high" },
        limits: { maxCodexRounds: 5, maxBlocks: 6 },
        blockingSeverities: ["blocker", "major"],
    }
    // The shell's real config holder over a temp config.json.
    const configPath = path.join(dir, "config.json")
    writeFileSync(configPath, JSON.stringify(config))
    const configStore = createConfigStore({
        configPath,
        initial: config,
        checks: () => ({ validate: (raw) => raw, selfCheck: () => {} }),
    })
    return {
        get config() {
            return configStore.current()
        },
        configTransaction: (delta) => configStore.mutate(delta),
        readFile: () => JSON.parse(readFileSync(configPath, "utf8")),
        store: {
            list: () => contexts,
            reset: jest.fn(() => ({
                codexRounds: 0,
                blockCount: 0,
                lastResultStatus: null,
            })),
            peek: (key) => contexts.find((c) => c.key === key) ?? null,
            save: jest.fn((key, next) => ({ ...next, key })),
        },
        archive: { readRecent: () => [] },
        metrics: null,
        logger: { info() {}, warn() {}, error() {} },
        registries: { inflightMeta: new Map() },
        deps: {},
    }
}

// A dashboard action as the current page sends it.
const pageReq = (body, api = String(DASHBOARD_API)) => ({
    body,
    get: (name) =>
        name.toLowerCase() === "x-dashboard-api"
            ? (api ?? undefined)
            : undefined,
})

const entry = (live) =>
    createUiEntry({
        getLive: () => live,
        packageVersion: "1.2.3",
        startedAt: 0,
    })

describe("createUiEntry — dashboard mutations", () => {
    test("reset clears the named context through the store", async () => {
        const live = makeLive()
        const res = mkRes()
        await entry(live).routes.dashboardMutations.reset(
            pageReq({ contextKey: "/repo|main" }),
            res
        )
        expect(res.statusCode).toBe(200)
        expect(live.store.reset).toHaveBeenCalledWith({
            key: "/repo|main",
            repoRoot: "/repo",
            branch: "main",
        })
    })

    test.each([
        [
            "provider",
            { provider: "claude" },
            (c) => c.reviewer.provider,
            "claude",
        ],
        [
            "reviewerPreset",
            { preset: "gpt-6-astra:medium" },
            (c) => c.codex.model,
            "gpt-6-astra",
        ],
        ["maxRounds", { value: 7 }, (c) => c.limits.maxCodexRounds, 7],
        ["maxBlocks", { value: 3 }, (c) => c.limits.maxBlocks, 3],
        [
            "blockingSeverities",
            { value: ["blocker"] },
            (c) => c.blockingSeverities,
            ["blocker"],
        ],
    ])(
        "%s commits to the live holder and config.json through a transaction",
        async (key, body, read, expected) => {
            const live = makeLive()
            const res = mkRes()
            await entry(live).routes.dashboardMutations[key](pageReq(body), res)
            expect(res.statusCode).toBe(200)
            expect(res.body.revision).toBe(1)
            expect(read(live.config)).toEqual(expected)
            expect(read(live.readFile())).toEqual(expected)
        }
    )

    test("exclusions go to the live store", async () => {
        const live = makeLive()
        const res = mkRes()
        await entry(live).routes.dashboardMutations.exclusions(
            pageReq({
                contextKey: "/repo|main",
                action: "add",
                file: "a.js",
                message: "m",
            }),
            res
        )
        expect(res.statusCode).toBe(200)
        expect(live.store.save).toHaveBeenCalled()
    })

    test.each([
        ["another API version", "0"],
        ["no API header", null],
    ])(
        "a page with %s is told to reload, and nothing changes",
        async (_label, api) => {
            const live = makeLive()
            for (const key of Object.keys(
                entry(live).routes.dashboardMutations
            )) {
                const res = mkRes()
                await entry(live).routes.dashboardMutations[key](
                    pageReq({ value: 7, contextKey: "/repo|main" }, api),
                    res
                )
                expect(res.statusCode).toBe(409)
                expect(res.body).toEqual({
                    ok: false,
                    code: "PAGE_OUTDATED",
                    error: "page is outdated — reload",
                })
            }
            expect(live.store.reset).not.toHaveBeenCalled()
            expect(live.config.limits.maxCodexRounds).toBe(5)
        }
    )
})

describe("createUiEntry — pages and probes", () => {
    test("the dashboard page renders with the package version", () => {
        const res = mkRes()
        entry(makeLive()).routes.dashboardPage({}, res)
        expect(res.statusCode).toBe(200)
        expect(res.body).toContain("v1.2.3")
    })

    test("status reports the package version and start time", () => {
        const res = mkRes()
        entry(makeLive()).routes.status({}, res)
        expect(res.body).toMatchObject({ ok: true, version: "1.2.3" })
        expect(res.body.startedAt).toBe(new Date(0).toISOString())
    })

    test("every request reads the live capabilities afresh", () => {
        let live = makeLive()
        const ui = createUiEntry({
            getLive: () => live,
            packageVersion: "1",
            startedAt: 0,
        })
        const meta = {
            contextKey: "k",
            repo: "r",
            branch: "b",
            provider: "codex",
            force: false,
            startedAt: Date.now(),
        }
        live = {
            ...makeLive(),
            registries: { inflightMeta: new Map([["k", meta]]) },
        }
        const res = mkRes()
        ui.routes.inflight({}, res)
        expect(res.body.inFlight).toHaveLength(1)
    })

    test("inflight carries the running core's version and the reload stamp", () => {
        const shell = {
            coreVersion: "c2",
            reload: { previousVersion: "c1", activeReviews: 0, history: [] },
        }
        const res = mkRes()
        entry({ ...makeLive(), shellStatus: () => shell }).routes.inflight(
            {},
            res
        )
        expect(res.body.coreVersion).toBe("c2")
        expect(JSON.parse(res.body.reloadStamp)).toEqual([
            "c2",
            "c1",
            0,
            null,
            null,
        ])
    })

    test("the page embeds the shell's state and this start's dashboard token", () => {
        const res = mkRes()
        entry({
            ...makeLive(),
            dashboard: { csrfToken: "tok-123" },
            shellStatus: () => ({
                shellVersion: "s1",
                coreVersion: "c1",
                reload: { loadedAt: null, history: [] },
            }),
        }).routes.dashboardPage({}, res)
        expect(res.body).toContain('data-csrf="tok-123"')
        expect(res.body).toContain('data-core-version="c1"')
        expect(res.body).toContain("shell <code>s1</code>")
    })

    test("selfCheck renders the dashboard for the candidate config", () => {
        const ui = entry(makeLive())
        expect(() =>
            ui.selfCheck({ reviewer: { provider: "gemini" } })
        ).not.toThrow()
    })
})
