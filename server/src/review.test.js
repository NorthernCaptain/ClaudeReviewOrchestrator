/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { jest } from "@jest/globals"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
    handleReview,
    computeReviewConfigHash,
    defaultInflight,
} from "./review.js"
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

// Helper for tests that seed lastBaseline. The unchanged-baseline check
// now requires both progressHash AND reviewConfigHash to match — every
// seed that wants to hit the unchanged branch must include the hash for
// the config it's testing under.
const seededBaseline = (progressHash, cfg = minimalConfig()) => ({
    progressHash,
    reviewConfigHash: computeReviewConfigHash(cfg),
})

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
            lastBaseline: seededBaseline("g-hash-1"),
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
            lastBaseline: seededBaseline("g-hash-1"),
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
        // Phase 3 contract: priorFindings is the blocker subset, so
        // blockingFindings mirrors findings on NO_PROGRESS.
        expect(r.body.blockingFindings).toEqual(issueFindings)
        expect(codexSpy).not.toHaveBeenCalled()
        // blockCount consumed (stop_hook trigger).
        expect(r.body.state.blockCount).toBe(1)
        // codexRounds NOT consumed.
        expect(r.body.state.codexRounds).toBe(1)
    })

    test("NO_PROGRESS resanitizes cached priorFindings (drops unsafe paths)", async () => {
        // Simulate legacy/corrupt state that still has an unsafe path
        // from a pre-sanitization run.
        store.save(happyContext.key, {
            ...happyContext,
            codexRounds: 1,
            blockCount: 0,
            lastBaseline: seededBaseline("g-hash-1"),
            priorFindings: [
                {
                    file: "../../secret.txt",
                    line: 1,
                    severity: "blocker",
                    category: "bug",
                    message: "legacy unsafe",
                },
                {
                    file: "a.js",
                    line: 2,
                    severity: "blocker",
                    category: "bug",
                    message: "legit",
                },
            ],
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
        expect(r.body.findings).toEqual([
            expect.objectContaining({ file: "a.js" }),
        ])
        expect(r.body.blockingFindings).toEqual(r.body.findings)
    })

    test("NO_PROGRESS via mcp_tool does NOT increment blockCount", async () => {
        store.save(happyContext.key, {
            ...happyContext,
            codexRounds: 1,
            blockCount: 0,
            lastBaseline: seededBaseline("g-hash-1"),
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

    test("drops findings with unsafe paths (../) and stores only safe in-payload ones", async () => {
        // Payload exposes "src/safe.js"; Codex returns a mix of unsafe
        // paths and one legitimate finding.
        const payload = makePayload({
            files: {
                modified: [{ path: "src/safe.js" }],
                untracked: [],
                deleted: [],
                renamed: [],
                priorFindingContext: [],
            },
        })
        const r = await handleReview({
            body: { cwd: "/repo", trigger: "mcp_tool" },
            config: minimalConfig(),
            store,
            deps: makeDeps({
                buildPayload: () => payload,
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
        expect(r.body.findings).toEqual([
            expect.objectContaining({ file: "src/safe.js" }),
        ])
        expect(r.body.droppedFindings.length).toBe(2)
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
            lastBaseline: seededBaseline("g-hash-1"),
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
            lastBaseline: seededBaseline("g-hash-1"),
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

describe("handleReview — Phase 3: status derivation", () => {
    let store
    beforeEach(() => {
        store = makeStoreInMemory()
    })
    afterEach(() => cleanupStore(store))

    const payloadWith = (paths) =>
        makePayload({
            files: {
                modified: paths.map((p) => ({ path: p })),
                untracked: [],
                deleted: [],
                renamed: [],
                priorFindingContext: [],
            },
        })

    const finding = (over) => ({
        file: "a.js",
        line: 1,
        severity: "blocker",
        category: "bug",
        message: "x",
        ...over,
    })

    test("only-nit findings → GOOD_TO_GO_WITH_NOTES (terminal, counters reset)", async () => {
        // Seed prior state with a non-zero counter to prove the reset.
        store.save(happyContext.key, {
            ...happyContext,
            codexRounds: 2,
            blockCount: 1,
            lastReviewedAt: 1,
            lastResultStatus: "ISSUES",
            priorFindings: [],
            lastBaseline: { progressHash: "OLD" },
        })
        const r = await handleReview({
            body: { cwd: "/repo", trigger: "stop_hook" },
            config: minimalConfig(),
            store,
            deps: makeDeps({
                buildPayload: () => payloadWith(["a.js"]),
                runAndParse: async () => ({
                    status: "ISSUES",
                    findings: [finding({ severity: "nit", message: "tiny" })],
                    raw: { durationMs: 1, exitCode: 0, timedOut: false },
                }),
            }),
        })
        expect(r.body.status).toBe("GOOD_TO_GO_WITH_NOTES")
        expect(r.body.findings).toHaveLength(1)
        expect(r.body.blockingFindings).toEqual([])
        expect(r.body.droppedFindings).toEqual([])
        // Both counters reset (terminal status).
        expect(r.body.state.codexRounds).toBe(0)
        expect(r.body.state.blockCount).toBe(0)
    })

    test("findings with only minor severities → GOOD_TO_GO_WITH_NOTES", async () => {
        const r = await handleReview({
            body: { cwd: "/repo", trigger: "stop_hook" },
            config: minimalConfig(),
            store,
            deps: makeDeps({
                buildPayload: () => payloadWith(["a.js"]),
                runAndParse: async () => ({
                    status: "ISSUES",
                    findings: [finding({ severity: "minor" })],
                    raw: { durationMs: 1, exitCode: 0, timedOut: false },
                }),
            }),
        })
        expect(r.body.status).toBe("GOOD_TO_GO_WITH_NOTES")
    })

    test("mixed blockers + nits → ISSUES with blockingFindings populated", async () => {
        const r = await handleReview({
            body: { cwd: "/repo", trigger: "stop_hook" },
            config: minimalConfig(),
            store,
            deps: makeDeps({
                buildPayload: () => payloadWith(["a.js"]),
                runAndParse: async () => ({
                    status: "ISSUES",
                    findings: [
                        finding({ severity: "blocker", line: 1 }),
                        finding({ severity: "major", line: 2 }),
                        finding({ severity: "nit", line: 3 }),
                        finding({ severity: "minor", line: 4 }),
                    ],
                    raw: { durationMs: 1, exitCode: 0, timedOut: false },
                }),
            }),
        })
        expect(r.body.status).toBe("ISSUES")
        expect(r.body.findings).toHaveLength(4)
        expect(r.body.blockingFindings).toHaveLength(2)
        expect(
            r.body.blockingFindings.every(
                (f) => f.severity === "blocker" || f.severity === "major"
            )
        ).toBe(true)
        // priorFindings tracks ONLY blockers across rounds.
        const persisted = store.get(happyContext)
        expect(persisted.priorFindings).toHaveLength(2)
    })

    test("out-of-payload findings go to droppedFindings, do not enter priorFindings", async () => {
        const payload = payloadWith(["a.js"])
        const r = await handleReview({
            body: { cwd: "/repo", trigger: "stop_hook" },
            config: minimalConfig(),
            store,
            deps: makeDeps({
                buildPayload: () => payload,
                runAndParse: async () => ({
                    status: "ISSUES",
                    findings: [
                        finding({ file: "a.js" }), // legit
                        finding({ file: "unreviewed.js", line: 99 }), // outside payload
                    ],
                    raw: { durationMs: 1, exitCode: 0, timedOut: false },
                }),
            }),
        })
        expect(r.body.findings).toHaveLength(1)
        expect(r.body.findings[0].file).toBe("a.js")
        expect(r.body.droppedFindings).toHaveLength(1)
        expect(r.body.droppedFindings[0].file).toBe("unreviewed.js")
        const persisted = store.get(happyContext)
        expect(persisted.priorFindings).toHaveLength(1)
        expect(persisted.priorFindings[0].file).toBe("a.js")
    })

    test("if every finding is out-of-payload the result collapses to GOOD_TO_GO", async () => {
        const r = await handleReview({
            body: { cwd: "/repo", trigger: "stop_hook" },
            config: minimalConfig(),
            store,
            deps: makeDeps({
                buildPayload: () => payloadWith(["a.js"]),
                runAndParse: async () => ({
                    status: "ISSUES",
                    findings: [finding({ file: "ghost.js" })],
                    raw: { durationMs: 1, exitCode: 0, timedOut: false },
                }),
            }),
        })
        expect(r.body.status).toBe("GOOD_TO_GO")
        expect(r.body.findings).toEqual([])
        expect(r.body.droppedFindings).toHaveLength(1)
        expect(r.body.state.codexRounds).toBe(0)
    })

    test("findings against renamed file's `from` or `to` path are kept", async () => {
        const payload = makePayload({
            files: {
                modified: [],
                untracked: [],
                deleted: [],
                renamed: [{ from: "old.js", to: "new.js" }],
                priorFindingContext: [],
            },
        })
        const r = await handleReview({
            body: { cwd: "/repo", trigger: "stop_hook" },
            config: minimalConfig(),
            store,
            deps: makeDeps({
                buildPayload: () => payload,
                runAndParse: async () => ({
                    status: "ISSUES",
                    findings: [
                        finding({ file: "old.js", line: 1 }),
                        finding({ file: "new.js", line: 2 }),
                    ],
                    raw: { durationMs: 1, exitCode: 0, timedOut: false },
                }),
            }),
        })
        expect(r.body.findings).toHaveLength(2)
        expect(r.body.droppedFindings).toEqual([])
    })

    test("findings against priorFindingContext paths are kept", async () => {
        const payload = makePayload({
            files: {
                modified: [],
                untracked: [],
                deleted: [],
                renamed: [],
                priorFindingContext: [{ path: "untouched.js", missing: false }],
            },
        })
        const r = await handleReview({
            body: { cwd: "/repo", trigger: "stop_hook" },
            config: minimalConfig(),
            store,
            deps: makeDeps({
                buildPayload: () => payload,
                runAndParse: async () => ({
                    status: "ISSUES",
                    findings: [finding({ file: "untouched.js" })],
                    raw: { durationMs: 1, exitCode: 0, timedOut: false },
                }),
            }),
        })
        expect(r.body.findings).toHaveLength(1)
        expect(r.body.droppedFindings).toEqual([])
    })

    test("passes wrapped prompt (system preamble + delimiters) to codex", async () => {
        let receivedPrompt = ""
        await handleReview({
            body: { cwd: "/repo", trigger: "stop_hook" },
            config: minimalConfig(),
            store,
            deps: makeDeps({
                buildPayload: () => payloadWith(["a.js"]),
                runAndParse: async ({ prompt }) => {
                    receivedPrompt = prompt
                    return {
                        status: "GOOD_TO_GO",
                        findings: [],
                        raw: { durationMs: 1, exitCode: 0, timedOut: false },
                    }
                },
            }),
        })
        expect(receivedPrompt).toContain("<<<REVIEW_SYSTEM>>>")
        expect(receivedPrompt).toContain("UNTRUSTED DATA")
        expect(receivedPrompt).toContain("<<<REVIEW_INPUT>>>")
        expect(receivedPrompt).toContain("<<<END_REVIEW_INPUT>>>")
    })

    test("passes extra_instructions through to wrapped prompt", async () => {
        let receivedPrompt = ""
        await handleReview({
            body: {
                cwd: "/repo",
                trigger: "mcp_tool",
                extra_instructions: "Pay attention to auth.",
            },
            config: minimalConfig(),
            store,
            deps: makeDeps({
                buildPayload: () => payloadWith(["a.js"]),
                runAndParse: async ({ prompt }) => {
                    receivedPrompt = prompt
                    return {
                        status: "GOOD_TO_GO",
                        findings: [],
                        raw: { durationMs: 1, exitCode: 0, timedOut: false },
                    }
                },
            }),
        })
        expect(receivedPrompt).toContain("<<<EXTRA_INSTRUCTIONS>>>")
        expect(receivedPrompt).toContain("Pay attention to auth.")
    })

    test("priorFindings flow into the next round's wrapped prompt", async () => {
        // R1: produces ISSUES with one blocker.
        await handleReview({
            body: { cwd: "/repo", trigger: "stop_hook" },
            config: minimalConfig(),
            store,
            deps: makeDeps({
                buildPayload: () => payloadWith(["a.js"]),
                runAndParse: async () => ({
                    status: "ISSUES",
                    findings: [
                        finding({ severity: "blocker", message: "round-1" }),
                    ],
                    raw: { durationMs: 1, exitCode: 0, timedOut: false },
                }),
            }),
        })
        // R2: the wrapped prompt should now contain PRIOR_FINDINGS json with "round-1".
        // Force a fresh progressHash so the unchanged short-circuit doesn't fire.
        let r2Prompt = ""
        const payloadR2 = makePayload({
            files: {
                modified: [{ path: "a.js" }],
                untracked: [],
                deleted: [],
                renamed: [],
                priorFindingContext: [],
            },
            progressHash: "DIFFERENT-HASH",
        })
        await handleReview({
            body: { cwd: "/repo", trigger: "stop_hook" },
            config: minimalConfig(),
            store,
            deps: makeDeps({
                buildPayload: () => payloadR2,
                runAndParse: async ({ prompt }) => {
                    r2Prompt = prompt
                    return {
                        status: "GOOD_TO_GO",
                        findings: [],
                        raw: { durationMs: 1, exitCode: 0, timedOut: false },
                    }
                },
            }),
        })
        expect(r2Prompt).toContain("<<<PRIOR_FINDINGS>>>")
        expect(r2Prompt).toContain("round-1")
    })
})

describe("handleReview — archive integration", () => {
    let store
    let archive
    beforeEach(() => {
        store = makeStoreInMemory()
        archive = { write: jest.fn() }
    })
    afterEach(() => cleanupStore(store))

    const payloadWith = (paths) =>
        makePayload({
            files: {
                modified: paths.map((p) => ({ path: p })),
                untracked: [],
                deleted: [],
                renamed: [],
                priorFindingContext: [],
            },
        })

    const findingOn = (file, sev = "blocker") => ({
        file,
        line: 1,
        severity: sev,
        category: "bug",
        message: "x",
    })

    test("writes archive on GOOD_TO_GO (codex ran)", async () => {
        await handleReview({
            body: { cwd: "/repo", trigger: "stop_hook" },
            config: minimalConfig(),
            store,
            archive,
            deps: makeDeps({
                buildPayload: () => payloadWith(["a.js"]),
            }),
        })
        expect(archive.write).toHaveBeenCalledTimes(1)
        expect(archive.write.mock.calls[0][0].result.status).toBe("GOOD_TO_GO")
    })

    test("writes archive on ISSUES (codex ran)", async () => {
        await handleReview({
            body: { cwd: "/repo", trigger: "stop_hook" },
            config: minimalConfig(),
            store,
            archive,
            deps: makeDeps({
                buildPayload: () => payloadWith(["a.js"]),
                runAndParse: async () => ({
                    status: "ISSUES",
                    findings: [findingOn("a.js", "blocker")],
                    raw: { durationMs: 1, exitCode: 0, timedOut: false },
                }),
            }),
        })
        expect(archive.write).toHaveBeenCalledTimes(1)
        expect(archive.write.mock.calls[0][0].result.status).toBe("ISSUES")
    })

    test("writes archive on Codex ESCALATE (codex ran but failed)", async () => {
        await handleReview({
            body: { cwd: "/repo", trigger: "stop_hook" },
            config: minimalConfig(),
            store,
            archive,
            deps: makeDeps({
                buildPayload: () => payloadWith(["a.js"]),
                runAndParse: async () => ({
                    status: "ESCALATE",
                    reason: "codex output failed schema",
                    raw: { durationMs: 1, exitCode: 0, timedOut: false },
                }),
            }),
        })
        expect(archive.write).toHaveBeenCalledTimes(1)
        const args = archive.write.mock.calls[0][0]
        expect(args.result.status).toBe("ESCALATE")
        expect(args.result.reason).toMatch(/failed schema/)
    })

    test("does NOT write archive on NO_CHANGES (cache hit)", async () => {
        store.save(happyContext.key, {
            ...happyContext,
            codexRounds: 1,
            blockCount: 0,
            lastBaseline: seededBaseline("g-hash-1"),
            priorFindings: [],
            lastReviewedAt: 1,
            lastResultStatus: "GOOD_TO_GO",
        })
        const r = await handleReview({
            body: { cwd: "/repo", trigger: "stop_hook" },
            config: minimalConfig(),
            store,
            archive,
            deps: makeDeps({
                buildPayload: () => payloadWith(["a.js"]),
            }),
        })
        expect(r.body.status).toBe("NO_CHANGES")
        expect(archive.write).not.toHaveBeenCalled()
    })

    test("does NOT write archive on NO_PROGRESS_WITH_OPEN_ISSUES", async () => {
        store.save(happyContext.key, {
            ...happyContext,
            codexRounds: 1,
            blockCount: 0,
            lastBaseline: seededBaseline("g-hash-1"),
            priorFindings: [findingOn("a.js", "blocker")],
            lastReviewedAt: 1,
            lastResultStatus: "ISSUES",
        })
        const r = await handleReview({
            body: { cwd: "/repo", trigger: "stop_hook" },
            config: minimalConfig(),
            store,
            archive,
            deps: makeDeps({
                buildPayload: () => payloadWith(["a.js"]),
            }),
        })
        expect(r.body.status).toBe("NO_PROGRESS_WITH_OPEN_ISSUES")
        expect(archive.write).not.toHaveBeenCalled()
    })

    test("does NOT write archive on CODEX_ERROR_CACHED", async () => {
        store.save(happyContext.key, {
            ...happyContext,
            codexRounds: 1,
            blockCount: 0,
            lastBaseline: seededBaseline("g-hash-1"),
            priorFindings: [],
            lastReviewedAt: 1,
            lastResultStatus: "ESCALATE",
            lastEscalateReason: "codex output failed schema",
        })
        const r = await handleReview({
            body: { cwd: "/repo", trigger: "stop_hook" },
            config: minimalConfig(),
            store,
            archive,
            deps: makeDeps({
                buildPayload: () => payloadWith(["a.js"]),
            }),
        })
        expect(r.body.code).toBe("CODEX_ERROR_CACHED")
        expect(archive.write).not.toHaveBeenCalled()
    })

    test("does NOT write archive on MAX_BLOCKS escalation", async () => {
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
            archive,
            deps: makeDeps(),
        })
        expect(r.body.code).toBe("MAX_BLOCKS")
        expect(archive.write).not.toHaveBeenCalled()
    })

    test("does NOT write archive on EMPTY_PAYLOAD escalation", async () => {
        const r = await handleReview({
            body: { cwd: "/repo", trigger: "stop_hook" },
            config: minimalConfig(),
            store,
            archive,
            deps: makeDeps({
                buildPayload: () =>
                    makePayload({
                        empty: true,
                        nonBinaryFileCount: 0,
                        promptText: "",
                    }),
            }),
        })
        expect(r.body.code).toBe("EMPTY_PAYLOAD")
        expect(archive.write).not.toHaveBeenCalled()
    })

    test("archive captures pre-reset round/blockCount on terminal status", async () => {
        // Seed state at round 1 so this Codex run is round 2; GOOD_TO_GO
        // would zero the live counter but the archive should record 2.
        store.save(happyContext.key, {
            ...happyContext,
            codexRounds: 1,
            blockCount: 1,
            lastReviewedAt: 1,
            lastResultStatus: "ISSUES",
            priorFindings: [findingOn("a.js")],
            lastBaseline: { progressHash: "OLD" },
        })
        await handleReview({
            body: { cwd: "/repo", trigger: "stop_hook" },
            config: minimalConfig(),
            store,
            archive,
            deps: makeDeps({
                buildPayload: () => payloadWith(["a.js"]),
                runAndParse: async () => ({
                    status: "GOOD_TO_GO",
                    findings: [],
                    raw: { durationMs: 1, exitCode: 0, timedOut: false },
                }),
            }),
        })
        expect(archive.write).toHaveBeenCalledTimes(1)
        const args = archive.write.mock.calls[0][0]
        expect(args.round).toBe(2)
        expect(args.blockCount).toBe(0)
    })

    test("archive receives the configured codex.model", async () => {
        await handleReview({
            body: { cwd: "/repo", trigger: "stop_hook" },
            config: {
                ...minimalConfig(),
                codex: { ...minimalConfig().codex, model: "gpt-5-codex" },
            },
            store,
            archive,
            deps: makeDeps({
                buildPayload: () => payloadWith(["a.js"]),
            }),
        })
        const args = archive.write.mock.calls[0][0]
        expect(args.codexRaw.model).toBe("gpt-5-codex")
    })

    test("archive failure does not break the response", async () => {
        const throwingArchive = {
            write: jest.fn(() => {
                throw new Error("disk full")
            }),
        }
        const r = await handleReview({
            body: { cwd: "/repo", trigger: "stop_hook" },
            config: minimalConfig(),
            store,
            archive: throwingArchive,
            deps: makeDeps({
                buildPayload: () => payloadWith(["a.js"]),
            }),
        })
        expect(r.body.status).toBe("GOOD_TO_GO")
        expect(throwingArchive.write).toHaveBeenCalled()
    })
})

describe("handleReview — reviewConfigHash invalidation", () => {
    let store
    beforeEach(() => {
        store = makeStoreInMemory()
    })
    afterEach(() => cleanupStore(store))

    const payloadWith = (paths) =>
        makePayload({
            files: {
                modified: paths.map((p) => ({ path: p })),
                untracked: [],
                deleted: [],
                renamed: [],
                priorFindingContext: [],
            },
        })

    test("policy change (blockingSeverities) invalidates the unchanged-baseline cache", async () => {
        // Seed: a previous NO_PROGRESS-worthy state under the GLOBAL policy.
        const globalCfg = minimalConfig()
        store.save(happyContext.key, {
            ...happyContext,
            codexRounds: 1,
            blockCount: 0,
            lastBaseline: seededBaseline("g-hash-1", globalCfg),
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
            config: globalCfg,
            store,
            deps: makeDeps({
                // Project widens severities → policy hash changes → cache
                // must NOT serve the stale GOOD_TO_GO.
                loadProjectConfig: () => ({
                    blockingSeverities: ["blocker", "major", "minor", "nit"],
                }),
                buildPayload: () => payloadWith(["a.js"]),
                runAndParse: codexSpy,
            }),
        })
        expect(codexSpy).toHaveBeenCalledTimes(1)
        expect(r.body.status).toBe("GOOD_TO_GO")
    })

    test("policy change (extraReviewerInstructions) invalidates the cache", async () => {
        store.save(happyContext.key, {
            ...happyContext,
            codexRounds: 1,
            blockCount: 0,
            lastBaseline: seededBaseline("g-hash-1"),
            priorFindings: [],
            lastReviewedAt: 1,
            lastResultStatus: "GOOD_TO_GO",
        })
        const codexSpy = jest.fn(async () => ({
            status: "GOOD_TO_GO",
            findings: [],
            raw: { durationMs: 1, exitCode: 0, timedOut: false },
        }))
        await handleReview({
            body: { cwd: "/repo", trigger: "stop_hook" },
            config: minimalConfig(),
            store,
            deps: makeDeps({
                loadProjectConfig: () => ({
                    extraReviewerInstructions: "Be stricter.",
                }),
                buildPayload: () => payloadWith(["a.js"]),
                runAndParse: codexSpy,
            }),
        })
        expect(codexSpy).toHaveBeenCalledTimes(1)
    })

    test("identical policy + same progressHash still hits NO_CHANGES", async () => {
        // Seed under the SAME policy: the cache should fire.
        const cfg = minimalConfig()
        const projectCfg = {
            blockingSeverities: ["blocker", "major", "minor"],
        }
        const merged = {
            ...cfg,
            blockingSeverities: projectCfg.blockingSeverities,
        }
        store.save(happyContext.key, {
            ...happyContext,
            codexRounds: 1,
            blockCount: 0,
            lastBaseline: {
                progressHash: "g-hash-1",
                reviewConfigHash: computeReviewConfigHash(merged),
            },
            priorFindings: [],
            lastReviewedAt: 1,
            lastResultStatus: "GOOD_TO_GO",
        })
        const codexSpy = jest.fn()
        const r = await handleReview({
            body: { cwd: "/repo", trigger: "stop_hook" },
            config: cfg,
            store,
            deps: makeDeps({
                loadProjectConfig: () => projectCfg,
                buildPayload: () => payloadWith(["a.js"]),
                runAndParse: codexSpy,
            }),
        })
        expect(codexSpy).not.toHaveBeenCalled()
        expect(r.body.status).toBe("NO_CHANGES")
    })

    test("baselineSummary records reviewConfigHash so subsequent rounds can compare", async () => {
        const r = await handleReview({
            body: { cwd: "/repo", trigger: "stop_hook" },
            config: minimalConfig(),
            store,
            deps: makeDeps({
                buildPayload: () => payloadWith(["a.js"]),
            }),
        })
        expect(r.body.baseline.reviewConfigHash).toEqual(expect.any(String))
        expect(r.body.baseline.reviewConfigHash.length).toBe(64)
    })
})

describe("handleReview — logger plumbing for project config", () => {
    let store
    beforeEach(() => {
        store = makeStoreInMemory()
    })
    afterEach(() => cleanupStore(store))

    test("invokes the supplied logger when the project loader injects one", async () => {
        const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
        await handleReview({
            body: { cwd: "/repo", trigger: "stop_hook" },
            config: minimalConfig(),
            store,
            logger,
            deps: makeDeps({
                // The injected loader receives the logger and uses it.
                loadProjectConfig: ({ logger: l }) => {
                    l?.warn?.({ unknown: ["x"] }, "test warning")
                    return null
                },
                buildPayload: () =>
                    makePayload({
                        files: {
                            modified: [{ path: "a.js" }],
                            untracked: [],
                            deleted: [],
                            renamed: [],
                            priorFindingContext: [],
                        },
                    }),
            }),
        })
        expect(logger.warn).toHaveBeenCalled()
    })
})

describe("handleReview — pipeline log emissions", () => {
    let store
    beforeEach(() => {
        store = makeStoreInMemory()
    })
    afterEach(() => cleanupStore(store))

    const messagesFor = (spy) =>
        spy.mock.calls.map((c) => (typeof c[1] === "string" ? c[1] : c[0]))

    test("emits structured info lines through the full happy path", async () => {
        const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
        await handleReview({
            body: { cwd: "/repo", trigger: "stop_hook" },
            config: minimalConfig(),
            store,
            logger,
            requestId: "RID-PIPE-1",
            deps: makeDeps({
                buildPayload: () =>
                    makePayload({
                        files: {
                            modified: [{ path: "a.js" }],
                            untracked: [],
                            deleted: [],
                            renamed: [],
                            priorFindingContext: [],
                        },
                    }),
                runAndParse: async () => ({
                    status: "GOOD_TO_GO",
                    findings: [],
                    raw: {
                        exitCode: 0,
                        durationMs: 12,
                        rawStdout: "{}",
                        rawStderr: "",
                    },
                }),
            }),
        })
        const msgs = messagesFor(logger.info)
        // The cardinal sequence — request received → context resolved →
        // config resolved → state loaded → payload built → cache decision
        // → spawning codex → codex finished → review result.
        const want = [
            "review request received",
            "context resolved",
            "config resolved",
            "state loaded",
            "payload built",
            "cache decision",
            "spawning reviewer",
            "reviewer finished",
            "review result",
        ]
        for (const phrase of want) {
            expect(msgs).toContain(phrase)
        }
    })

    test("emits a stderr-tail warning when codex fails", async () => {
        const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
        await handleReview({
            body: { cwd: "/repo", trigger: "stop_hook" },
            config: minimalConfig(),
            store,
            logger,
            deps: makeDeps({
                buildPayload: () =>
                    makePayload({
                        files: {
                            modified: [{ path: "a.js" }],
                            untracked: [],
                            deleted: [],
                            renamed: [],
                            priorFindingContext: [],
                        },
                    }),
                runAndParse: async () => ({
                    status: "ESCALATE",
                    reason: "codex exited with code 1",
                    raw: {
                        exitCode: 1,
                        durationMs: 100,
                        rawStdout: "",
                        rawStderr:
                            "ERROR: You've hit your usage limit. Try again later.",
                    },
                }),
            }),
        })
        const warnMsgs = messagesFor(logger.warn)
        expect(warnMsgs).toContain("reviewer stderr/stdout tail")
        // The tail field must contain the actual error text so a user
        // tailing the log can see WHY the reviewer failed without
        // grepping the archive directory.
        const tailCall = logger.warn.mock.calls.find(
            (c) => c[1] === "reviewer stderr/stdout tail"
        )
        expect(tailCall[0].stderrTail).toMatch(/usage limit/i)
    })

    test("emits EMPTY_PAYLOAD warning and skips spawn", async () => {
        const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
        const runSpy = jest.fn()
        await handleReview({
            body: { cwd: "/repo", trigger: "stop_hook" },
            config: minimalConfig(),
            store,
            logger,
            deps: makeDeps({
                buildPayload: () =>
                    makePayload({
                        empty: true,
                        nonBinaryFileCount: 0,
                    }),
                runAndParse: runSpy,
            }),
        })
        expect(runSpy).not.toHaveBeenCalled()
        const warnMsgs = messagesFor(logger.warn)
        expect(warnMsgs).toContain("EMPTY_PAYLOAD — skipping reviewer")
    })

    test("dispatches via pickReviewer; log records the provider", async () => {
        const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
        // Inject a custom picker so we know exactly which adapter the
        // pipeline reached for.
        const adapterRun = jest.fn(async () => ({
            status: "GOOD_TO_GO",
            findings: [],
            raw: { exitCode: 0, durationMs: 5, rawStdout: "{}", rawStderr: "" },
        }))
        const pickReviewer = jest.fn(() => ({
            name: "claude",
            binary: "claude",
            runAndParse: adapterRun,
            buildArgs: () => ["-p", "--bare"],
        }))
        await handleReview({
            body: { cwd: "/repo", trigger: "stop_hook" },
            config: minimalConfig(),
            store,
            logger,
            deps: makeDeps({
                pickReviewer,
                // Force the picker's adapter to be reached — otherwise
                // the makeDeps default runAndParse would shadow it.
                runAndParse: undefined,
                buildPayload: () =>
                    makePayload({
                        files: {
                            modified: [{ path: "a.js" }],
                            untracked: [],
                            deleted: [],
                            renamed: [],
                            priorFindingContext: [],
                        },
                    }),
            }),
        })
        expect(pickReviewer).toHaveBeenCalled()
        expect(adapterRun).toHaveBeenCalled()
        // The pipeline records which provider ran in the "spawning
        // reviewer" line so the log is unambiguous.
        const spawnCall = logger.info.mock.calls.find(
            (c) => c[1] === "spawning reviewer"
        )
        expect(spawnCall?.[0].provider).toBe("claude")
    })

    test("/review response body's codex sub-object carries provider so the hook can render a provider-aware header", async () => {
        // Confirm the contract that hooks/stop-review.mjs depends on:
        // response.codex.provider names the reviewer that actually ran.
        const adapterRun = jest.fn(async () => ({
            status: "GOOD_TO_GO",
            findings: [],
            raw: {
                exitCode: 0,
                durationMs: 5,
                rawStdout: "{}",
                rawStderr: "",
            },
        }))
        const pickReviewer = jest.fn(() => ({
            name: "gemini",
            binary: "gemini",
            runAndParse: adapterRun,
            buildArgs: () => ["-p"],
        }))
        const r = await handleReview({
            body: { cwd: "/repo", trigger: "manual" },
            config: minimalConfig(),
            store,
            deps: makeDeps({
                pickReviewer,
                runAndParse: undefined,
                buildPayload: () =>
                    makePayload({
                        files: {
                            modified: [{ path: "a.js" }],
                            untracked: [],
                            deleted: [],
                            renamed: [],
                            priorFindingContext: [],
                        },
                    }),
            }),
        })
        expect(r.body.codex.provider).toBe("gemini")
    })
})

describe("handleReview — project config integration", () => {
    let store
    beforeEach(() => {
        store = makeStoreInMemory()
    })
    afterEach(() => cleanupStore(store))

    const payloadWith = (paths) =>
        makePayload({
            files: {
                modified: paths.map((p) => ({ path: p })),
                untracked: [],
                deleted: [],
                renamed: [],
                priorFindingContext: [],
            },
        })

    const niteOnly = (file) => ({
        file,
        line: 1,
        severity: "nit",
        category: "style",
        message: "tiny",
    })

    test("project blockingSeverities widens what counts as blocking", async () => {
        // With default global blockingSeverities ["blocker","major"], a nit
        // would be GOOD_TO_GO_WITH_NOTES. The project widens to include nit,
        // so the same result is ISSUES.
        const r = await handleReview({
            body: { cwd: "/repo", trigger: "stop_hook" },
            config: minimalConfig(),
            store,
            deps: makeDeps({
                loadProjectConfig: () => ({
                    blockingSeverities: ["blocker", "major", "minor", "nit"],
                }),
                buildPayload: () => payloadWith(["a.js"]),
                runAndParse: async () => ({
                    status: "ISSUES",
                    findings: [niteOnly("a.js")],
                    raw: { durationMs: 1, exitCode: 0, timedOut: false },
                }),
            }),
        })
        expect(r.body.status).toBe("ISSUES")
        expect(r.body.blockingFindings).toHaveLength(1)
    })

    test("project limits.maxFiles flows into buildPayload via the merged config", async () => {
        let seenConfig = null
        await handleReview({
            body: { cwd: "/repo", trigger: "mcp_tool" },
            config: minimalConfig(),
            store,
            deps: makeDeps({
                loadProjectConfig: () => ({
                    limits: { maxFiles: 7 },
                }),
                buildPayload: (args) => {
                    seenConfig = args.config
                    return payloadWith(["a.js"])
                },
            }),
        })
        expect(seenConfig.limits.maxFiles).toBe(7)
        // Other limit keys fall back to global.
        expect(seenConfig.limits.maxPayloadBytes).toBe(
            minimalConfig().limits.maxPayloadBytes
        )
    })

    test("project extraReviewerInstructions reaches the wrapped prompt before caller extras", async () => {
        let receivedPrompt = ""
        await handleReview({
            body: {
                cwd: "/repo",
                trigger: "mcp_tool",
                extra_instructions: "Caller note: focus on auth.",
            },
            config: minimalConfig(),
            store,
            deps: makeDeps({
                loadProjectConfig: () => ({
                    extraReviewerInstructions: "Project rule: Express 5 only.",
                }),
                buildPayload: () => payloadWith(["a.js"]),
                runAndParse: async ({ prompt }) => {
                    receivedPrompt = prompt
                    return {
                        status: "GOOD_TO_GO",
                        findings: [],
                        raw: {
                            durationMs: 1,
                            exitCode: 0,
                            timedOut: false,
                        },
                    }
                },
            }),
        })
        const start = receivedPrompt.indexOf("<<<EXTRA_INSTRUCTIONS>>>")
        const end = receivedPrompt.indexOf("<<<END_EXTRA_INSTRUCTIONS>>>")
        expect(start).toBeGreaterThan(-1)
        const section = receivedPrompt.slice(start, end)
        expect(section).toMatch(/Project rule: Express 5 only\./)
        expect(section).toMatch(/Caller note: focus on auth\./)
        // Project comes before caller.
        expect(section.indexOf("Project rule")).toBeLessThan(
            section.indexOf("Caller note")
        )
    })

    test("project extraReviewerInstructions alone (no caller extras) is wrapped", async () => {
        let receivedPrompt = ""
        await handleReview({
            body: { cwd: "/repo", trigger: "stop_hook" },
            config: minimalConfig(),
            store,
            deps: makeDeps({
                loadProjectConfig: () => ({
                    extraReviewerInstructions: "Project rule only.",
                }),
                buildPayload: () => payloadWith(["a.js"]),
                runAndParse: async ({ prompt }) => {
                    receivedPrompt = prompt
                    return {
                        status: "GOOD_TO_GO",
                        findings: [],
                        raw: {
                            durationMs: 1,
                            exitCode: 0,
                            timedOut: false,
                        },
                    }
                },
            }),
        })
        expect(receivedPrompt).toContain("<<<EXTRA_INSTRUCTIONS>>>")
        expect(receivedPrompt).toContain("Project rule only.")
    })

    test("when neither project nor caller supplies extras, no EXTRA section emitted", async () => {
        let receivedPrompt = ""
        await handleReview({
            body: { cwd: "/repo", trigger: "stop_hook" },
            config: minimalConfig(),
            store,
            deps: makeDeps({
                loadProjectConfig: () => null,
                buildPayload: () => payloadWith(["a.js"]),
                runAndParse: async ({ prompt }) => {
                    receivedPrompt = prompt
                    return {
                        status: "GOOD_TO_GO",
                        findings: [],
                        raw: {
                            durationMs: 1,
                            exitCode: 0,
                            timedOut: false,
                        },
                    }
                },
            }),
        })
        expect(receivedPrompt).not.toContain("<<<END_EXTRA_INSTRUCTIONS>>>")
    })

    test("project ignorePaths flows into buildPayload via the merged config", async () => {
        let seenConfig = null
        await handleReview({
            body: { cwd: "/repo", trigger: "mcp_tool" },
            config: minimalConfig(),
            store,
            deps: makeDeps({
                loadProjectConfig: () => ({
                    ignorePaths: ["docs/**", "**/__snapshots__/**"],
                }),
                buildPayload: (args) => {
                    seenConfig = args.config
                    return payloadWith(["a.js"])
                },
            }),
        })
        expect(seenConfig.ignorePaths).toEqual([
            "docs/**",
            "**/__snapshots__/**",
        ])
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

describe("handleReview — in-flight dedup", () => {
    let store
    beforeEach(() => {
        store = makeStoreInMemory()
    })
    afterEach(() => cleanupStore(store))

    const payloadFor = (path = "a.js") =>
        makePayload({
            files: {
                modified: [{ path }],
                untracked: [],
                deleted: [],
                renamed: [],
                priorFindingContext: [],
            },
        })

    test("concurrent requests for the same context attach to one pipeline", async () => {
        // The shared runAndParse stub blocks until release() is called.
        // Without dedup, two parallel handleReview calls would each
        // invoke runAndParse once. With dedup, only the first does and
        // the second attaches to the first's promise.
        let release
        const gate = new Promise((r) => {
            release = r
        })
        const runAndParse = jest.fn(async () => {
            await gate
            return {
                status: "GOOD_TO_GO",
                findings: [],
                raw: { exitCode: 0, durationMs: 1, rawStdout: "{}", rawStderr: "" },
            }
        })

        const inflight = new Map()
        const deps = makeDeps({
            buildPayload: () => payloadFor(),
            runAndParse,
            inflight,
        })

        const p1 = handleReview({
            body: { cwd: "/repo", trigger: "stop_hook" },
            config: minimalConfig(),
            store,
            deps,
        })
        const p2 = handleReview({
            body: { cwd: "/repo", trigger: "stop_hook" },
            config: minimalConfig(),
            store,
            deps,
        })

        // Let microtasks settle so p2 has had a chance to enter
        // handleReview, resolve context, and either attach or spawn.
        await Promise.resolve()
        await Promise.resolve()

        // Map should hold the in-flight promise for the context.
        expect(inflight.size).toBe(1)

        release()
        const [r1, r2] = await Promise.all([p1, p2])

        expect(r1.body.status).toBe("GOOD_TO_GO")
        expect(r2.body.status).toBe("GOOD_TO_GO")
        // The same response is handed to both attachers.
        expect(r1).toBe(r2)
        // Only one reviewer spawn even though there were two callers.
        expect(runAndParse).toHaveBeenCalledTimes(1)
        // Map is empty after both resolved.
        expect(inflight.size).toBe(0)
    })

    test("sequential requests do not share a promise (inflight cleared between calls)", async () => {
        const runAndParse = jest.fn(async () => ({
            status: "GOOD_TO_GO",
            findings: [],
            raw: { exitCode: 0, durationMs: 1, rawStdout: "{}", rawStderr: "" },
        }))
        const inflight = new Map()
        // Vary the progressHash per call so the NO_CHANGES short-circuit
        // doesn't kick in — this test is about inflight bookkeeping, not
        // about the cache.
        let i = 0
        const deps = makeDeps({
            buildPayload: () =>
                makePayload({
                    files: {
                        modified: [{ path: "a.js" }],
                        untracked: [],
                        deleted: [],
                        renamed: [],
                        priorFindingContext: [],
                    },
                    progressHash: `seq-${++i}`,
                }),
            runAndParse,
            inflight,
        })

        await handleReview({
            body: { cwd: "/repo", trigger: "stop_hook" },
            config: minimalConfig(),
            store,
            deps,
        })
        expect(inflight.size).toBe(0)
        await handleReview({
            body: { cwd: "/repo", trigger: "stop_hook" },
            config: minimalConfig(),
            store,
            deps,
        })
        expect(runAndParse).toHaveBeenCalledTimes(2)
        expect(inflight.size).toBe(0)
    })

    test("map slot is cleared even when the pipeline throws", async () => {
        const runAndParse = jest.fn(async () => {
            throw new Error("reviewer exploded")
        })
        const inflight = new Map()
        const deps = makeDeps({
            buildPayload: () => payloadFor(),
            runAndParse,
            inflight,
        })

        // The error path is caught inside handleReview and surfaced as
        // an ESCALATE envelope, so this resolves rather than throws.
        const r = await handleReview({
            body: { cwd: "/repo", trigger: "stop_hook" },
            config: minimalConfig(),
            store,
            deps,
        })
        expect(r.body.status).toBe("ESCALATE")
        expect(inflight.size).toBe(0)
    })

    test("different contexts run in parallel without dedup interference", async () => {
        let releaseA, releaseB
        const gateA = new Promise((r) => {
            releaseA = r
        })
        const gateB = new Promise((r) => {
            releaseB = r
        })
        const runAndParse = jest.fn(async ({ repoRoot }) => {
            await (repoRoot.endsWith("/a") ? gateA : gateB)
            return {
                status: "GOOD_TO_GO",
                findings: [],
                raw: { exitCode: 0, durationMs: 1, rawStdout: "{}", rawStderr: "" },
            }
        })
        const inflight = new Map()
        const depsA = makeDeps({
            resolveContext: () => ({
                repo: "a",
                repoRoot: "/repo/a",
                branch: "main",
                key: "/repo/a|main",
            }),
            buildPayload: () => payloadFor(),
            runAndParse,
            inflight,
        })
        const depsB = makeDeps({
            resolveContext: () => ({
                repo: "b",
                repoRoot: "/repo/b",
                branch: "main",
                key: "/repo/b|main",
            }),
            buildPayload: () => payloadFor(),
            runAndParse,
            inflight,
        })

        const pA = handleReview({
            body: { cwd: "/repo/a", trigger: "stop_hook" },
            config: minimalConfig(),
            store,
            deps: depsA,
        })
        const pB = handleReview({
            body: { cwd: "/repo/b", trigger: "stop_hook" },
            config: minimalConfig(),
            store,
            deps: depsB,
        })

        await Promise.resolve()
        await Promise.resolve()
        expect(inflight.size).toBe(2)

        releaseA()
        releaseB()
        await Promise.all([pA, pB])
        // Both spawned independently — no false dedup across contexts.
        expect(runAndParse).toHaveBeenCalledTimes(2)
        expect(inflight.size).toBe(0)
    })

    test("defaultInflight is a shared Map at module scope (sanity)", () => {
        expect(defaultInflight).toBeInstanceOf(Map)
    })
})
