/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { jest } from "@jest/globals"
import { createUiEntry } from "./routes.js"

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

const memoryFs = (initial) => {
    const files = { "/cfg.json": JSON.stringify(initial) }
    return {
        files,
        readFileSync: (p) => files[p],
        writeFileSync: (p, data) => {
            files[p] = data
        },
    }
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
    return {
        config,
        configPath: "/cfg.json",
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
        deps: { fs: memoryFs(config) },
    }
}

const entry = (live) =>
    createUiEntry({
        getLive: () => live,
        shellVersion: "1.2.3",
        startedAt: 0,
    })

describe("createUiEntry — dashboard mutations", () => {
    test("reset clears the named context through the store", async () => {
        const live = makeLive()
        const res = mkRes()
        await entry(live).routes.dashboardMutations.reset(
            { body: { contextKey: "/repo|main" } },
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
        "%s mutates the live config and persists to its configPath",
        async (key, body, read, expected) => {
            const live = makeLive()
            const res = mkRes()
            await entry(live).routes.dashboardMutations[key]({ body }, res)
            expect(res.statusCode).toBe(200)
            expect(read(live.config)).toEqual(expected)
            const onDisk = JSON.parse(live.deps.fs.files["/cfg.json"])
            expect(read(onDisk)).toEqual(expected)
        }
    )

    test("exclusions go to the live store", async () => {
        const live = makeLive()
        const res = mkRes()
        await entry(live).routes.dashboardMutations.exclusions(
            {
                body: {
                    contextKey: "/repo|main",
                    action: "add",
                    file: "a.js",
                    message: "m",
                },
            },
            res
        )
        expect(res.statusCode).toBe(200)
        expect(live.store.save).toHaveBeenCalled()
    })
})

describe("createUiEntry — pages and probes", () => {
    test("the dashboard page renders with the shell's version", () => {
        const res = mkRes()
        entry(makeLive()).routes.dashboardPage({}, res)
        expect(res.statusCode).toBe(200)
        expect(res.body).toContain("v1.2.3")
    })

    test("status reports the shell's version and start time", () => {
        const res = mkRes()
        entry(makeLive()).routes.status({}, res)
        expect(res.body).toMatchObject({ ok: true, version: "1.2.3" })
        expect(res.body.startedAt).toBe(new Date(0).toISOString())
    })

    test("every request reads the live capabilities afresh", () => {
        let live = makeLive()
        const ui = createUiEntry({
            getLive: () => live,
            shellVersion: "1",
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

    test("selfCheck renders the dashboard for the candidate config", () => {
        const ui = entry(makeLive())
        expect(() =>
            ui.selfCheck({ reviewer: { provider: "gemini" } })
        ).not.toThrow()
    })
})
