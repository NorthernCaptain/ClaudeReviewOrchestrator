/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { jest } from "@jest/globals"
import { readFileSync } from "node:fs"
import { createReviewEntry } from "./index.js"

const resources = {
    "review/codex-output.schema.json": readFileSync(
        new URL("./codex-output.schema.json", import.meta.url)
    ),
}

const happyContext = {
    repo: "repo",
    repoRoot: "/repo",
    branch: "main",
    key: "/repo|main",
}

const memoryStore = () => {
    const contexts = {}
    return {
        get: (ctx) => ({ ...(contexts[ctx.key] ?? { ...ctx }) }),
        peek: (key) => contexts[key] ?? null,
        save: (key, next) => {
            contexts[key] = { ...(contexts[key] ?? {}), ...next, key }
            return { ...contexts[key] }
        },
    }
}

const makeLive = (runAndParse) => ({
    config: {
        allowedRoots: ["/repo"],
        codex: { binary: "codex", model: "m", extraArgs: [] },
        limits: {
            maxCodexRounds: 5,
            maxBlocks: 6,
            codexTimeoutSeconds: 60,
            maxPayloadBytes: 262144,
            maxFileBytes: 65536,
            maxFiles: 40,
        },
        ignorePaths: [],
        blockingSeverities: ["blocker", "major"],
    },
    store: memoryStore(),
    archive: null,
    logger: { info() {}, warn() {}, error() {} },
    metrics: { record: jest.fn() },
    deps: {
        git: async () => {
            throw new Error("not a git repository")
        },
        resolveContext: () => happyContext,
        loadProjectConfig: () => null,
        buildPayload: () => ({
            headSha: "abc",
            files: {
                modified: [{ path: "a.js" }],
                untracked: [],
                deleted: [],
                renamed: [],
                priorFindingContext: [],
            },
            totalBytes: 10,
            truncated: false,
            promptText: "P",
            promptHash: "p",
            progressHash: "g",
            priorFindingPaths: [],
            empty: false,
            nonBinaryFileCount: 1,
        }),
        runAndParse,
    },
})

const okReview = () =>
    jest.fn(async () => ({
        status: "GOOD_TO_GO",
        findings: [],
        raw: { durationMs: 1, exitCode: 0, timedOut: false },
    }))

describe("createReviewEntry", () => {
    test("refuses staging without the output schema", () => {
        expect(() =>
            createReviewEntry({ resources: {}, getLive: () => null })
        ).toThrow(/core resource missing/)
    })

    test("POST /review runs on the live capabilities with this core's schema", async () => {
        const runAndParse = okReview()
        const live = makeLive(runAndParse)
        const review = createReviewEntry({ resources, getLive: () => live })
        const res = {
            status(c) {
                this.statusCode = c
                return this
            },
            json(b) {
                this.body = b
                return this
            },
        }
        await review.routes.review({ body: { cwd: "/repo" } }, res)
        expect(res.statusCode).toBe(200)
        expect(res.body.status).toBe("GOOD_TO_GO")
        expect(runAndParse.mock.calls[0][0].schema).toBe(review.schema)
        expect(live.metrics.record).toHaveBeenCalledWith(res.body)
    })

    test("request_review runs on the live capabilities with this core's schema", async () => {
        const runAndParse = okReview()
        const live = makeLive(runAndParse)
        const review = createReviewEntry({ resources, getLive: () => live })
        const out = await review.mcp.requestReview({
            args: { cwd: "/repo" },
            requestId: 1,
            mcpServer: null,
        })
        expect(out.structuredContent.status).toBe("GOOD_TO_GO")
        expect(runAndParse.mock.calls[0][0].schema).toBe(review.schema)
        expect(review.mcp.toolDef.name).toBe("request_review")
    })

    test("selfCheck rejects a config whose provider this core can't run", () => {
        const review = createReviewEntry({ resources, getLive: () => null })
        expect(() => review.selfCheck({})).not.toThrow()
        expect(() =>
            review.selfCheck({ reviewer: { provider: "nope" } })
        ).toThrow(/unknown reviewer.provider/)
    })

    test("the codex schema path comes from staging", () => {
        const review = createReviewEntry({
            resources,
            codexSchemaPath: null,
            getLive: () => null,
        })
        expect(() => review.schema.codexStrictPath()).toThrow(
            /no codex schema path/
        )
    })
})
