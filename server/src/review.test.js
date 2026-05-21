/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { handleReview } from "./review.js"
import { ContextError } from "./context.js"

const minimalConfig = () => ({
    port: 7777,
    bind: "127.0.0.1",
    authToken: "tok",
    allowedRoots: ["/repo"],
    codex: {
        binary: "codex",
        model: "gpt-5-codex",
        ignoreProjectRules: true,
        extraArgs: [],
    },
    limits: {
        maxCodexRounds: 5,
        maxBlocks: 6,
        idleResetMinutes: 10,
        codexTimeoutSeconds: 240,
        maxPayloadBytes: 262144,
        maxFileBytes: 65536,
        maxFiles: 40,
    },
    ignorePaths: [],
    blockingSeverities: ["blocker", "major"],
})

const happyContext = {
    repo: "repo",
    repoRoot: "/repo",
    branch: "main",
    key: "/repo|main",
}

const happyPayload = {
    headSha: "abc1234",
    files: {
        modified: [{ path: "a.js" }],
        untracked: [],
        deleted: [],
        renamed: [],
    },
    totalBytes: 100,
    truncated: false,
    promptText: "=== FILE: a.js (modified) ===\nbody",
    empty: false,
    nonBinaryFileCount: 1,
}

const makeDeps = (over = {}) => ({
    resolveContext: () => happyContext,
    buildPayload: () => happyPayload,
    runAndParse: async () => ({
        status: "GOOD_TO_GO",
        findings: [],
        raw: { durationMs: 123, exitCode: 0, timedOut: false },
    }),
    ...over,
})

describe("handleReview", () => {
    test("returns 400 when cwd missing", async () => {
        const r = await handleReview({
            body: {},
            config: minimalConfig(),
            deps: makeDeps(),
        })
        expect(r.httpStatus).toBe(400)
        expect(r.body.status).toBe("ESCALATE")
        expect(r.body.code).toBe("INVALID_REQUEST")
    })

    test("returns 400 with NOT_A_GIT_REPO context error", async () => {
        const r = await handleReview({
            body: { cwd: "/repo" },
            config: minimalConfig(),
            deps: makeDeps({
                resolveContext: () => {
                    throw new ContextError(
                        "NOT_A_GIT_REPO",
                        "not a git repository"
                    )
                },
            }),
        })
        expect(r.httpStatus).toBe(400)
        expect(r.body.status).toBe("ESCALATE")
        expect(r.body.code).toBe("NOT_A_GIT_REPO")
    })

    test("returns 403 when cwd is outside allowedRoots", async () => {
        const r = await handleReview({
            body: { cwd: "/repo" },
            config: minimalConfig(),
            deps: makeDeps({
                resolveContext: () => {
                    throw new ContextError("NOT_IN_ALLOWED_ROOT", "nope")
                },
            }),
        })
        expect(r.httpStatus).toBe(403)
        expect(r.body.code).toBe("NOT_IN_ALLOWED_ROOT")
    })

    test("escalates with EMPTY_PAYLOAD when no reviewable files", async () => {
        const r = await handleReview({
            body: { cwd: "/repo" },
            config: minimalConfig(),
            deps: makeDeps({
                buildPayload: () => ({
                    ...happyPayload,
                    empty: true,
                    nonBinaryFileCount: 0,
                    promptText: "",
                }),
            }),
        })
        expect(r.httpStatus).toBe(200)
        expect(r.body.status).toBe("ESCALATE")
        expect(r.body.code).toBe("EMPTY_PAYLOAD")
    })

    test("returns stable envelope with GOOD_TO_GO from codex", async () => {
        const r = await handleReview({
            body: { cwd: "/repo" },
            config: minimalConfig(),
            deps: makeDeps(),
        })
        expect(r.httpStatus).toBe(200)
        expect(r.body.status).toBe("GOOD_TO_GO")
        expect(r.body.findings).toEqual([])
        expect(r.body.blockingFindings).toEqual([])
        expect(r.body.droppedFindings).toEqual([])
        expect(r.body.context.repoRoot).toBe("/repo")
        expect(r.body.baseline.headSha).toBe("abc1234")
        expect(r.body.codex.exitCode).toBe(0)
    })

    test("passes ISSUES findings through unchanged in Phase 1", async () => {
        const findings = [
            {
                file: "a.js",
                line: 1,
                severity: "blocker",
                category: "bug",
                message: "boom",
            },
        ]
        const r = await handleReview({
            body: { cwd: "/repo" },
            config: minimalConfig(),
            deps: makeDeps({
                runAndParse: async () => ({
                    status: "ISSUES",
                    findings,
                    raw: {
                        durationMs: 200,
                        exitCode: 0,
                        timedOut: false,
                    },
                }),
            }),
        })
        expect(r.body.status).toBe("ISSUES")
        expect(r.body.findings).toEqual(findings)
        // Phase 1: blockingFindings stays empty; Phase 3 fills it.
        expect(r.body.blockingFindings).toEqual([])
    })

    test("escalates with CODEX_ERROR when codex returns ESCALATE", async () => {
        const r = await handleReview({
            body: { cwd: "/repo" },
            config: minimalConfig(),
            deps: makeDeps({
                runAndParse: async () => ({
                    status: "ESCALATE",
                    reason: "codex output failed schema",
                    raw: { durationMs: 5, exitCode: 0, timedOut: false },
                }),
            }),
        })
        expect(r.body.status).toBe("ESCALATE")
        expect(r.body.code).toBe("CODEX_ERROR")
        expect(r.body.reason).toMatch(/failed schema/)
    })

    test("returns 502 when runAndParse throws", async () => {
        const r = await handleReview({
            body: { cwd: "/repo" },
            config: minimalConfig(),
            deps: makeDeps({
                runAndParse: async () => {
                    throw new Error("codex spawn failed")
                },
            }),
        })
        expect(r.httpStatus).toBe(502)
        expect(r.body.status).toBe("ESCALATE")
        expect(r.body.reason).toMatch(/codex spawn failed/)
    })

    test("escalates with INTERNAL_ERROR when a non-ContextError has no message", async () => {
        const r = await handleReview({
            body: { cwd: "/repo" },
            config: minimalConfig(),
            deps: makeDeps({
                resolveContext: () => {
                    // Throw a value that's not a proper Error.
                    throw {}
                },
            }),
        })
        expect(r.body.code).toBe("INTERNAL_ERROR")
        expect(r.body.reason).toBe("unknown error")
    })

    test("envelope spreads extras when extra is omitted (default {})", async () => {
        // Hit the default-argument branch of envelope() by triggering an
        // INVALID_REQUEST without supplying any extras downstream.
        const r = await handleReview({
            body: undefined,
            config: minimalConfig(),
            deps: makeDeps(),
        })
        expect(r.body.status).toBe("ESCALATE")
        expect(r.body.code).toBe("INVALID_REQUEST")
    })

    test("returns 500 when buildPayload throws", async () => {
        const r = await handleReview({
            body: { cwd: "/repo" },
            config: minimalConfig(),
            deps: makeDeps({
                buildPayload: () => {
                    throw new Error("git blew up")
                },
            }),
        })
        expect(r.httpStatus).toBe(500)
        expect(r.body.reason).toMatch(/git blew up/)
    })
})
