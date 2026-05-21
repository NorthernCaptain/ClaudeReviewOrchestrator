/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { jest } from "@jest/globals"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { handleReview } from "./review.js"
import { ContextError } from "./context.js"
import { createStateStore } from "./state.js"

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
        maxCodexRounds: 3,
        maxBlocks: 2,
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

const makePayload = (overrides = {}) => ({
    headSha: "abc1234",
    files: {
        modified: [{ path: "a.js" }],
        untracked: [],
        deleted: [],
        renamed: [],
        priorFindingContext: [],
    },
    totalBytes: 100,
    truncated: false,
    promptText: "=== FILE: a.js (modified) ===\nbody",
    promptHash: "p-hash-1",
    progressHash: "g-hash-1",
    priorFindingPaths: [],
    empty: false,
    nonBinaryFileCount: 1,
    ...overrides,
})

const makeStoreInMemory = () => {
    const dir = mkdtempSync(path.join(tmpdir(), "review-store-"))
    const filePath = path.join(dir, "state.json")
    const store = createStateStore({ filePath, now: () => 0 })
    store.__dir = dir
    return store
}

const cleanupStore = (store) => {
    rmSync(store.__dir, { recursive: true, force: true })
}

const makeDeps = (over = {}) => ({
    resolveContext: () => happyContext,
    buildPayload: () => makePayload(),
    runAndParse: async () => ({
        status: "GOOD_TO_GO",
        findings: [],
        raw: { durationMs: 12, exitCode: 0, timedOut: false },
    }),
    ...over,
})

describe("handleReview — request validation & error mapping", () => {
    let store
    beforeEach(() => {
        store = makeStoreInMemory()
    })
    afterEach(() => cleanupStore(store))

    test("returns 400 when cwd missing", async () => {
        const r = await handleReview({
            body: {},
            config: minimalConfig(),
            store,
            deps: makeDeps(),
        })
        expect(r.httpStatus).toBe(400)
        expect(r.body.code).toBe("INVALID_REQUEST")
    })

    test("returns 400 with NOT_A_GIT_REPO context error", async () => {
        const r = await handleReview({
            body: { cwd: "/repo" },
            config: minimalConfig(),
            store,
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
        expect(r.body.code).toBe("NOT_A_GIT_REPO")
    })

    test("returns 403 when cwd is outside allowedRoots", async () => {
        const r = await handleReview({
            body: { cwd: "/repo" },
            config: minimalConfig(),
            store,
            deps: makeDeps({
                resolveContext: () => {
                    throw new ContextError("NOT_IN_ALLOWED_ROOT", "nope")
                },
            }),
        })
        expect(r.httpStatus).toBe(403)
    })

    test("escalates with EMPTY_PAYLOAD when no reviewable files", async () => {
        const r = await handleReview({
            body: { cwd: "/repo" },
            config: minimalConfig(),
            store,
            deps: makeDeps({
                buildPayload: () =>
                    makePayload({
                        empty: true,
                        nonBinaryFileCount: 0,
                        promptText: "",
                    }),
            }),
        })
        expect(r.body.status).toBe("ESCALATE")
        expect(r.body.code).toBe("EMPTY_PAYLOAD")
    })
})

describe("handleReview — happy paths", () => {
    let store
    beforeEach(() => {
        store = makeStoreInMemory()
    })
    afterEach(() => cleanupStore(store))

    test("returns GOOD_TO_GO and resets counters", async () => {
        const r = await handleReview({
            body: { cwd: "/repo", trigger: "stop_hook" },
            config: minimalConfig(),
            store,
            deps: makeDeps(),
        })
        expect(r.body.status).toBe("GOOD_TO_GO")
        expect(r.body.state.codexRounds).toBe(0)
        expect(r.body.state.blockCount).toBe(0)
    })

    test("passes ISSUES findings through and consumes blockCount on stop_hook", async () => {
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
            body: { cwd: "/repo", trigger: "stop_hook" },
            config: minimalConfig(),
            store,
            deps: makeDeps({
                runAndParse: async () => ({
                    status: "ISSUES",
                    findings,
                    raw: { durationMs: 20, exitCode: 0, timedOut: false },
                }),
            }),
        })
        expect(r.body.status).toBe("ISSUES")
        expect(r.body.findings).toEqual(findings)
        expect(r.body.state.codexRounds).toBe(1)
        expect(r.body.state.blockCount).toBe(1)
    })

    test("ISSUES from a manual (non stop_hook) trigger does NOT consume blockCount", async () => {
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
            body: { cwd: "/repo", trigger: "mcp_tool" },
            config: minimalConfig(),
            store,
            deps: makeDeps({
                runAndParse: async () => ({
                    status: "ISSUES",
                    findings,
                    raw: { durationMs: 20, exitCode: 0, timedOut: false },
                }),
            }),
        })
        expect(r.body.status).toBe("ISSUES")
        expect(r.body.state.codexRounds).toBe(1)
        expect(r.body.state.blockCount).toBe(0)
    })
})

describe("handleReview — change detection", () => {
    let store
    beforeEach(() => {
        store = makeStoreInMemory()
    })
    afterEach(() => cleanupStore(store))

    const issueFindings = [
        {
            file: "a.js",
            line: 1,
            severity: "blocker",
            category: "bug",
            message: "x",
        },
    ]

    test("unchanged baseline + last status GOOD_TO_GO → NO_CHANGES", async () => {
        // Seed: a GOOD_TO_GO result already persisted.
        store.save(happyContext.key, {
            ...happyContext,
            codexRounds: 0,
            blockCount: 0,
            lastBaseline: { progressHash: "g-hash-1" },
            priorFindings: [],
            lastReviewedAt: 1,
            lastResultStatus: "GOOD_TO_GO",
        })
        const codexSpy = jest.fn(async () => ({
            status: "GOOD_TO_GO",
            findings: [],
            raw: { durationMs: 1, exitCode: 0, timedOut: false },
        }))
        const r = await handleReview({
            body: { cwd: "/repo", trigger: "stop_hook" },
            config: minimalConfig(),
            store,
            deps: makeDeps({ runAndParse: codexSpy }),
        })
        expect(r.body.status).toBe("NO_CHANGES")
        expect(codexSpy).not.toHaveBeenCalled()
    })

    test("unchanged baseline + last status ISSUES → NO_PROGRESS_WITH_OPEN_ISSUES (no codex call)", async () => {
        store.save(happyContext.key, {
            ...happyContext,
            codexRounds: 1,
            blockCount: 0,
            lastBaseline: { progressHash: "g-hash-1" },
            priorFindings: issueFindings,
            lastReviewedAt: 1,
            lastResultStatus: "ISSUES",
        })
        const codexSpy = jest.fn()
        const r = await handleReview({
            body: { cwd: "/repo", trigger: "stop_hook" },
            config: minimalConfig(),
            store,
            deps: makeDeps({ runAndParse: codexSpy }),
        })
        expect(r.body.status).toBe("NO_PROGRESS_WITH_OPEN_ISSUES")
        expect(r.body.findings).toEqual(issueFindings)
        expect(codexSpy).not.toHaveBeenCalled()
        // blockCount consumed (stop_hook trigger).
        expect(r.body.state.blockCount).toBe(1)
        // codexRounds NOT consumed.
        expect(r.body.state.codexRounds).toBe(1)
    })

    test("NO_PROGRESS via mcp_tool does NOT increment blockCount", async () => {
        store.save(happyContext.key, {
            ...happyContext,
            codexRounds: 1,
            blockCount: 0,
            lastBaseline: { progressHash: "g-hash-1" },
            priorFindings: issueFindings,
            lastReviewedAt: 1,
            lastResultStatus: "ISSUES",
        })
        const r = await handleReview({
            body: { cwd: "/repo", trigger: "mcp_tool" },
            config: minimalConfig(),
            store,
            deps: makeDeps(),
        })
        expect(r.body.status).toBe("NO_PROGRESS_WITH_OPEN_ISSUES")
        expect(r.body.state.blockCount).toBe(0)
    })

    test("changed progressHash → codex IS called", async () => {
        store.save(happyContext.key, {
            ...happyContext,
            codexRounds: 1,
            lastBaseline: { progressHash: "OLD-HASH" },
            priorFindings: issueFindings,
            lastReviewedAt: 1,
            lastResultStatus: "ISSUES",
        })
        const codexSpy = jest.fn(async () => ({
            status: "GOOD_TO_GO",
            findings: [],
            raw: { durationMs: 1, exitCode: 0, timedOut: false },
        }))
        const r = await handleReview({
            body: { cwd: "/repo", trigger: "stop_hook" },
            config: minimalConfig(),
            store,
            deps: makeDeps({ runAndParse: codexSpy }),
        })
        expect(codexSpy).toHaveBeenCalled()
        expect(r.body.status).toBe("GOOD_TO_GO")
    })
})

describe("handleReview — cap escalations", () => {
    let store
    beforeEach(() => {
        store = makeStoreInMemory()
    })
    afterEach(() => cleanupStore(store))

    test("ESCALATE with MAX_BLOCKS once blockCount cap is hit (stop_hook only)", async () => {
        const cfg = minimalConfig()
        store.save(happyContext.key, {
            ...happyContext,
            codexRounds: 1,
            blockCount: cfg.limits.maxBlocks,
            lastReviewedAt: 1,
            lastResultStatus: "ISSUES",
            priorFindings: [],
            lastBaseline: { progressHash: "g" },
        })
        const r = await handleReview({
            body: { cwd: "/repo", trigger: "stop_hook" },
            config: cfg,
            store,
            deps: makeDeps(),
        })
        expect(r.body.status).toBe("ESCALATE")
        expect(r.body.code).toBe("MAX_BLOCKS")
    })

    test("ESCALATE with MAX_CODEX_ROUNDS when codexRounds cap is hit", async () => {
        const cfg = minimalConfig()
        store.save(happyContext.key, {
            ...happyContext,
            codexRounds: cfg.limits.maxCodexRounds,
            blockCount: 0,
            lastReviewedAt: 1,
            lastResultStatus: "ISSUES",
            priorFindings: [],
            lastBaseline: { progressHash: "OLD" },
        })
        const r = await handleReview({
            body: { cwd: "/repo", trigger: "mcp_tool" },
            config: cfg,
            store,
            deps: makeDeps({
                runAndParse: async () => {
                    throw new Error("codex should not have been spawned")
                },
            }),
        })
        expect(r.body.status).toBe("ESCALATE")
        expect(r.body.code).toBe("MAX_CODEX_ROUNDS")
    })

    test("mcp_tool calls bypass the MAX_BLOCKS cap", async () => {
        const cfg = minimalConfig()
        store.save(happyContext.key, {
            ...happyContext,
            codexRounds: 0,
            blockCount: cfg.limits.maxBlocks,
            lastReviewedAt: 1,
            lastResultStatus: "ISSUES",
            priorFindings: [],
            lastBaseline: { progressHash: "OLD" },
        })
        const r = await handleReview({
            body: { cwd: "/repo", trigger: "mcp_tool" },
            config: cfg,
            store,
            deps: makeDeps(),
        })
        // Codex ran (because progressHash differs from OLD), GOOD_TO_GO
        // reset the counters.
        expect(r.body.status).toBe("GOOD_TO_GO")
    })
})

describe("handleReview — codex errors", () => {
    let store
    beforeEach(() => {
        store = makeStoreInMemory()
    })
    afterEach(() => cleanupStore(store))

    test("escalates with CODEX_ERROR when codex returns ESCALATE", async () => {
        const r = await handleReview({
            body: { cwd: "/repo", trigger: "stop_hook" },
            config: minimalConfig(),
            store,
            deps: makeDeps({
                runAndParse: async () => ({
                    status: "ESCALATE",
                    reason: "codex output failed schema",
                    raw: { durationMs: 5, exitCode: 0, timedOut: false },
                }),
            }),
        })
        expect(r.body.code).toBe("CODEX_ERROR")
        expect(r.body.reason).toMatch(/failed schema/)
        // Still counted as a codexRounds increment so a busted reviewer
        // can't burn unlimited rounds.
        expect(r.body.state.codexRounds).toBe(1)
    })

    test("returns 502 when runAndParse throws", async () => {
        const r = await handleReview({
            body: { cwd: "/repo" },
            config: minimalConfig(),
            store,
            deps: makeDeps({
                runAndParse: async () => {
                    throw new Error("codex spawn failed")
                },
            }),
        })
        expect(r.httpStatus).toBe(502)
        expect(r.body.reason).toMatch(/codex spawn failed/)
    })

    test("returns 500 when buildPayload throws", async () => {
        const r = await handleReview({
            body: { cwd: "/repo" },
            config: minimalConfig(),
            store,
            deps: makeDeps({
                buildPayload: () => {
                    throw new Error("git blew up")
                },
            }),
        })
        expect(r.httpStatus).toBe(500)
    })
})

describe("handleReview — finding-path sanitization", () => {
    let store
    beforeEach(() => {
        store = makeStoreInMemory()
    })
    afterEach(() => cleanupStore(store))

    test("drops findings with unsafe paths (../) and stores only safe ones", async () => {
        // Codex returns a mix of safe and unsafe paths.
        const r = await handleReview({
            body: { cwd: "/repo", trigger: "mcp_tool" },
            config: minimalConfig(),
            store,
            deps: makeDeps({
                runAndParse: async () => ({
                    status: "ISSUES",
                    findings: [
                        {
                            file: "../../secret.txt",
                            line: 1,
                            severity: "blocker",
                            category: "bug",
                            message: "evil",
                        },
                        {
                            file: "src/safe.js",
                            line: 2,
                            severity: "blocker",
                            category: "bug",
                            message: "real issue",
                        },
                        {
                            file: "/etc/passwd",
                            line: 3,
                            severity: "major",
                            category: "security",
                            message: "absolute path",
                        },
                    ],
                    raw: { durationMs: 1, exitCode: 0, timedOut: false },
                }),
            }),
        })
        expect(r.body.status).toBe("ISSUES")
        // Returned findings list contains only the safe entry.
        expect(r.body.findings).toEqual([
            expect.objectContaining({ file: "src/safe.js" }),
        ])
        // Stored priorFindings reflect the same.
        const persisted = store.get(happyContext)
        expect(persisted.priorFindings).toEqual([
            expect.objectContaining({ file: "src/safe.js" }),
        ])
    })
})

describe("handleReview — unchanged ESCALATE short-circuit", () => {
    let store
    beforeEach(() => {
        store = makeStoreInMemory()
    })
    afterEach(() => cleanupStore(store))

    test("unchanged baseline + last status ESCALATE returns cached CODEX_ERROR_CACHED without spawning codex", async () => {
        store.save(happyContext.key, {
            ...happyContext,
            codexRounds: 1,
            blockCount: 0,
            lastBaseline: { progressHash: "g-hash-1" },
            lastReviewedAt: 1,
            lastResultStatus: "ESCALATE",
            lastEscalateReason: "codex output failed schema",
            priorFindings: [],
        })
        const codexSpy = jest.fn()
        const r = await handleReview({
            body: { cwd: "/repo", trigger: "stop_hook" },
            config: minimalConfig(),
            store,
            deps: makeDeps({ runAndParse: codexSpy }),
        })
        expect(codexSpy).not.toHaveBeenCalled()
        expect(r.body.status).toBe("ESCALATE")
        expect(r.body.code).toBe("CODEX_ERROR_CACHED")
        expect(r.body.reason).toMatch(/failed schema/)
        // codexRounds did NOT increment because codex didn't run.
        expect(r.body.state.codexRounds).toBe(1)
        // blockCount DID increment because this was a stop_hook.
        expect(r.body.state.blockCount).toBe(1)
    })

    test("unchanged ESCALATE via mcp_tool does not consume blockCount", async () => {
        store.save(happyContext.key, {
            ...happyContext,
            codexRounds: 1,
            blockCount: 0,
            lastBaseline: { progressHash: "g-hash-1" },
            lastReviewedAt: 1,
            lastResultStatus: "ESCALATE",
            lastEscalateReason: "codex output failed schema",
            priorFindings: [],
        })
        const codexSpy = jest.fn()
        const r = await handleReview({
            body: { cwd: "/repo", trigger: "mcp_tool" },
            config: minimalConfig(),
            store,
            deps: makeDeps({ runAndParse: codexSpy }),
        })
        expect(codexSpy).not.toHaveBeenCalled()
        expect(r.body.status).toBe("ESCALATE")
        expect(r.body.state.blockCount).toBe(0)
    })

    test("ESCALATE persists lastEscalateReason so the next call can surface it", async () => {
        await handleReview({
            body: { cwd: "/repo", trigger: "stop_hook" },
            config: minimalConfig(),
            store,
            deps: makeDeps({
                runAndParse: async () => ({
                    status: "ESCALATE",
                    reason: "codex output unparseable",
                    raw: { durationMs: 1, exitCode: 0, timedOut: false },
                }),
            }),
        })
        const persisted = store.get(happyContext)
        expect(persisted.lastResultStatus).toBe("ESCALATE")
        expect(persisted.lastEscalateReason).toBe("codex output unparseable")
    })
})

describe("handleReview — state persistence", () => {
    let store
    beforeEach(() => {
        store = makeStoreInMemory()
    })
    afterEach(() => cleanupStore(store))

    test("seeds priorFindings into buildPayload on the next call", async () => {
        const findings = [
            {
                file: "a.js",
                line: 1,
                severity: "blocker",
                category: "bug",
                message: "x",
            },
        ]
        // First call: ISSUES result.
        await handleReview({
            body: { cwd: "/repo", trigger: "stop_hook" },
            config: minimalConfig(),
            store,
            deps: makeDeps({
                runAndParse: async () => ({
                    status: "ISSUES",
                    findings,
                    raw: { durationMs: 1, exitCode: 0, timedOut: false },
                }),
            }),
        })

        // Second call: assert buildPayload received priorFindings.
        let seenPriorFindings = null
        await handleReview({
            body: { cwd: "/repo", trigger: "stop_hook" },
            config: minimalConfig(),
            store,
            deps: makeDeps({
                buildPayload: (args) => {
                    seenPriorFindings = args.priorFindings
                    // Pretend progressHash is different so codex runs.
                    return makePayload({ progressHash: "different" })
                },
                runAndParse: async () => ({
                    status: "GOOD_TO_GO",
                    findings: [],
                    raw: { durationMs: 1, exitCode: 0, timedOut: false },
                }),
            }),
        })
        expect(seenPriorFindings).toEqual(findings)
    })
})
