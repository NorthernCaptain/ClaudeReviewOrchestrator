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
    snapshotInFlight,
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

    test("'payload built' log carries baseSha=null when source is working-tree", async () => {
        // Defensive: the head-fallback adds baseSha only when source is
        // "head-fallback". The working-tree path must emit baseSha: null
        // in the log without errors (short() handles null but the call
        // site is now explicit — this test pins the contract).
        const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
        await handleReview({
            body: { cwd: "/repo", trigger: "stop_hook" },
            config: minimalConfig(),
            store,
            logger,
            deps: makeDeps({
                buildPayload: () =>
                    makePayload({
                        // makePayload's defaults: source omitted, baseSha
                        // omitted → both undefined in the payload.
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
                        durationMs: 1,
                        rawStdout: "{}",
                        rawStderr: "",
                    },
                }),
            }),
        })
        const built = logger.info.mock.calls.find(
            (c) => c[1] === "payload built"
        )
        expect(built).toBeDefined()
        expect(built[0].source).toBe("working-tree")
        expect(built[0].baseSha).toBeNull()
    })

    test("'payload built' log carries baseSha when source is head-fallback", async () => {
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
                        source: "head-fallback",
                        baseSha: "deadbeef00112233445566778899aabbccddeeff",
                    }),
                runAndParse: async () => ({
                    status: "GOOD_TO_GO",
                    findings: [],
                    raw: {
                        exitCode: 0,
                        durationMs: 1,
                        rawStdout: "{}",
                        rawStderr: "",
                    },
                }),
            }),
        })
        const built = logger.info.mock.calls.find(
            (c) => c[1] === "payload built"
        )
        expect(built[0].source).toBe("head-fallback")
        // Short-form (first 12 chars) lands in the log.
        expect(built[0].baseSha).toBe("deadbeef0011")
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
                raw: {
                    exitCode: 0,
                    durationMs: 1,
                    rawStdout: "{}",
                    rawStderr: "",
                },
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
                raw: {
                    exitCode: 0,
                    durationMs: 1,
                    rawStdout: "{}",
                    rawStderr: "",
                },
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

describe("computeReviewConfigHash — payload.fallbackToHead", () => {
    test("flipping payload.fallbackToHead changes the hash (cache invalidates on flip)", () => {
        const off = computeReviewConfigHash({
            blockingSeverities: ["blocker", "major"],
            ignorePaths: ["a/b/**"],
            extraReviewerInstructions: null,
            limits: { maxPayloadBytes: 1, maxFileBytes: 1, maxFiles: 1 },
            payload: { fallbackToHead: false },
        })
        const on = computeReviewConfigHash({
            blockingSeverities: ["blocker", "major"],
            ignorePaths: ["a/b/**"],
            extraReviewerInstructions: null,
            limits: { maxPayloadBytes: 1, maxFileBytes: 1, maxFiles: 1 },
            payload: { fallbackToHead: true },
        })
        expect(off).not.toBe(on)
    })

    test("absent payload block is equivalent to fallbackToHead=false", () => {
        const absent = computeReviewConfigHash({
            blockingSeverities: ["blocker", "major"],
            ignorePaths: [],
            extraReviewerInstructions: null,
            limits: {},
        })
        const off = computeReviewConfigHash({
            blockingSeverities: ["blocker", "major"],
            ignorePaths: [],
            extraReviewerInstructions: null,
            limits: {},
            payload: { fallbackToHead: false },
        })
        expect(absent).toBe(off)
    })

    test("flipping payload.verifyCleanTree also busts the cache", () => {
        const off = computeReviewConfigHash({
            blockingSeverities: ["blocker", "major"],
            ignorePaths: [],
            extraReviewerInstructions: null,
            limits: {},
            payload: { verifyCleanTree: false },
        })
        const on = computeReviewConfigHash({
            blockingSeverities: ["blocker", "major"],
            ignorePaths: [],
            extraReviewerInstructions: null,
            limits: {},
            payload: { verifyCleanTree: true },
        })
        expect(off).not.toBe(on)
    })

    // v0.1.23 — provider is part of the review policy.
    test("switching the configured provider changes the hash", () => {
        const base = {
            blockingSeverities: ["blocker"],
            ignorePaths: [],
            extraReviewerInstructions: null,
            limits: {},
        }
        const codex = computeReviewConfigHash({
            ...base,
            reviewer: { provider: "codex" },
        })
        const gemini = computeReviewConfigHash({
            ...base,
            reviewer: { provider: "gemini" },
        })
        expect(codex).not.toBe(gemini)
    })

    test("a per-call provider override changes the hash even when config is unchanged", () => {
        const cfg = {
            blockingSeverities: ["blocker"],
            ignorePaths: [],
            extraReviewerInstructions: null,
            limits: {},
            reviewer: { provider: "codex" },
        }
        const noOverride = computeReviewConfigHash(cfg)
        const overridden = computeReviewConfigHash(cfg, "gemini")
        expect(noOverride).not.toBe(overridden)
        // Override matching the config default is identical to no override.
        expect(computeReviewConfigHash(cfg, "codex")).toBe(noOverride)
    })

    test("changing the provider's model busts the hash", () => {
        const a = computeReviewConfigHash({
            blockingSeverities: [],
            ignorePaths: [],
            limits: {},
            reviewer: { provider: "codex" },
            codex: { model: "gpt-5.5" },
        })
        const b = computeReviewConfigHash({
            blockingSeverities: [],
            ignorePaths: [],
            limits: {},
            reviewer: { provider: "codex" },
            codex: { model: "gpt-6" },
        })
        expect(a).not.toBe(b)
    })
})

// v0.1.23 — bugs codex flagged in the provider-switch feature.
describe("handleReview — provider change busts the cache (v0.1.23)", () => {
    let store
    beforeEach(() => {
        store = makeStoreInMemory()
    })
    afterEach(() => cleanupStore(store))

    const payloadOk = () =>
        makePayload({
            files: {
                modified: [{ path: "a.js" }],
                untracked: [],
                deleted: [],
                renamed: [],
                priorFindingContext: [],
            },
            progressHash: "p",
        })

    // Seed a clean terminal-success baseline produced under the CODEX
    // provider, then issue a request whose effective provider is GEMINI.
    const seedCodexBaseline = (cfg) =>
        store.save("/repo|main", {
            repoRoot: "/repo",
            branch: "main",
            lastResultStatus: "GOOD_TO_GO",
            lastBaseline: {
                headSha: "abc",
                progressHash: "p",
                reviewConfigHash: computeReviewConfigHash(cfg),
                files: {
                    modified: [{ path: "a.js" }],
                    untracked: [],
                    deleted: [],
                    renamed: [],
                    priorFindingContext: [],
                },
                totalBytes: 0,
                truncated: false,
            },
            dirtySinceLastReview: false,
        })

    test("dirty-flag fast path does NOT fire after a provider override (runs the new reviewer)", async () => {
        const cfg = { ...minimalConfig(), reviewer: { provider: "codex" } }
        seedCodexBaseline(cfg)
        const runSpy = jest.fn(async () => ({
            status: "GOOD_TO_GO",
            findings: [],
            raw: { durationMs: 1, exitCode: 0 },
        }))
        const pickSpy = jest.fn(() => ({
            name: "gemini",
            runAndParse: runSpy,
            buildArgs: () => [],
            binary: "gemini",
        }))
        const r = await handleReview({
            body: { cwd: "/repo", trigger: "mcp_tool", provider: "gemini" },
            config: cfg,
            store,
            deps: makeDeps({
                buildPayload: payloadOk,
                runAndParse: runSpy,
                pickReviewer: pickSpy,
                currentHeadSha: () => "abc",
                isWorkingTreeClean: () => true,
            }),
        })
        // Fast path would have returned NO_CHANGES without spawning; the
        // provider override must bust it and actually run gemini.
        expect(r.body.status).not.toBe("NO_CHANGES")
        expect(runSpy).toHaveBeenCalledTimes(1)
        expect(pickSpy.mock.calls[0][1]).toBe("gemini")
    })

    test("post-payload NO_CHANGES short-circuit also busts on provider override", async () => {
        const cfg = { ...minimalConfig(), reviewer: { provider: "codex" } }
        // Mark dirty so the fast path is skipped and we reach the
        // unchanged-baseline check (which compares reviewConfigHash).
        store.save("/repo|main", {
            repoRoot: "/repo",
            branch: "main",
            lastResultStatus: "GOOD_TO_GO",
            lastBaseline: {
                headSha: "abc",
                progressHash: "p",
                reviewConfigHash: computeReviewConfigHash(cfg),
                files: {
                    modified: [{ path: "a.js" }],
                    untracked: [],
                    deleted: [],
                    renamed: [],
                    priorFindingContext: [],
                },
                totalBytes: 0,
                truncated: false,
            },
            dirtySinceLastReview: true,
        })
        const runSpy = jest.fn(async () => ({
            status: "GOOD_TO_GO",
            findings: [],
            raw: { durationMs: 1, exitCode: 0 },
        }))
        const r = await handleReview({
            body: { cwd: "/repo", trigger: "mcp_tool", provider: "gemini" },
            config: cfg,
            store,
            deps: makeDeps({
                buildPayload: payloadOk,
                runAndParse: runSpy,
            }),
        })
        expect(r.body.status).not.toBe("NO_CHANGES")
        expect(runSpy).toHaveBeenCalledTimes(1)
    })

    test("same provider on an unchanged tree still fast-paths NO_CHANGES (no regression)", async () => {
        const cfg = { ...minimalConfig(), reviewer: { provider: "codex" } }
        seedCodexBaseline(cfg)
        const runSpy = jest.fn()
        const r = await handleReview({
            body: { cwd: "/repo", trigger: "mcp_tool" }, // no override → codex
            config: cfg,
            store,
            deps: makeDeps({
                buildPayload: payloadOk,
                runAndParse: runSpy,
                currentHeadSha: () => "abc",
                isWorkingTreeClean: () => true,
            }),
        })
        expect(r.body.status).toBe("NO_CHANGES")
        expect(runSpy).not.toHaveBeenCalled()
    })
})

describe("handleReview — in-flight dedup keys force/provider (v0.1.23)", () => {
    let store
    beforeEach(() => {
        store = makeStoreInMemory()
    })
    afterEach(() => cleanupStore(store))

    const spawnPayload = () =>
        makePayload({
            files: {
                modified: [{ path: "a.js" }],
                untracked: [],
                deleted: [],
                renamed: [],
                priorFindingContext: [],
            },
        })

    test("a force request does not attach to an ordinary in-flight review", async () => {
        const inflight = new Map()
        // Pre-seed an in-flight entry under the PLAIN key (effective
        // provider = codex for minimalConfig). If the force request
        // attached to it, it'd resolve to this sentinel.
        const sentinel = Promise.resolve({
            httpStatus: 200,
            body: { status: "SENTINEL_ATTACHED" },
        })
        inflight.set("/repo|main|force=false|provider=codex", sentinel)
        const runSpy = jest.fn(async () => ({
            status: "GOOD_TO_GO",
            findings: [],
            raw: { durationMs: 1, exitCode: 0 },
        }))
        const r = await handleReview({
            body: { cwd: "/repo", trigger: "mcp_tool", force: true },
            config: minimalConfig(),
            store,
            deps: makeDeps({
                buildPayload: spawnPayload,
                runAndParse: runSpy,
                inflight,
            }),
        })
        expect(r.body.status).not.toBe("SENTINEL_ATTACHED")
        expect(runSpy).toHaveBeenCalledTimes(1)
    })

    test("the dedup key uses the EFFECTIVE provider, so a live PUT /provider switch is not attached to the old in-flight run", async () => {
        const inflight = new Map()
        // An in-flight review is running under the OLD provider (codex).
        const sentinel = Promise.resolve({
            httpStatus: 200,
            body: { status: "OLD_PROVIDER_RESULT" },
        })
        inflight.set("/repo|main|force=false|provider=codex", sentinel)
        const runSpy = jest.fn(async () => ({
            status: "GOOD_TO_GO",
            findings: [],
            raw: { durationMs: 1, exitCode: 0 },
        }))
        // The config provider has since been switched to gemini (as a
        // PUT /provider would mutate the live config). A plain request
        // (no per-call override) must key on the effective provider
        // (gemini) and therefore NOT attach to the codex in-flight run.
        const r = await handleReview({
            body: { cwd: "/repo", trigger: "mcp_tool" },
            config: { ...minimalConfig(), reviewer: { provider: "gemini" } },
            store,
            deps: makeDeps({
                buildPayload: spawnPayload,
                runAndParse: runSpy,
                inflight,
            }),
        })
        expect(r.body.status).not.toBe("OLD_PROVIDER_RESULT")
        expect(runSpy).toHaveBeenCalledTimes(1)
    })

    test("two plain requests under the same provider DO share one pipeline (dedup intact)", async () => {
        const inflight = new Map()
        const sentinel = Promise.resolve({
            httpStatus: 200,
            body: { status: "SHARED_RESULT" },
        })
        inflight.set("/repo|main|force=false|provider=codex", sentinel)
        const r = await handleReview({
            body: { cwd: "/repo", trigger: "mcp_tool" },
            config: minimalConfig(), // effective provider = codex
            store,
            deps: makeDeps({ inflight }),
        })
        expect(r.body.status).toBe("SHARED_RESULT")
    })
})

// v0.1.24 — distinct result-sharing keys must NOT let two state-mutating
// pipelines for the same context run concurrently (they'd race the
// store.get → store.save read-modify-write). A force/provider request
// serializes BEHIND any in-flight same-context review.
describe("handleReview — same-context pipelines are serialized (v0.1.24)", () => {
    let store
    beforeEach(() => {
        store = makeStoreInMemory()
    })
    afterEach(() => cleanupStore(store))

    const payloadFor = () =>
        makePayload({
            files: {
                modified: [{ path: "a.js" }],
                untracked: [],
                deleted: [],
                renamed: [],
                priorFindingContext: [],
            },
        })

    const flush = () => new Promise((r) => setTimeout(r, 0))

    test("a force request does not run its reviewer until the in-flight plain review finishes", async () => {
        let active = 0
        let maxActive = 0
        let releaseFirst
        const firstGate = new Promise((r) => {
            releaseFirst = r
        })
        let firstCall = true
        const runAndParse = jest.fn(async () => {
            active += 1
            maxActive = Math.max(maxActive, active)
            if (firstCall) {
                firstCall = false
                await firstGate // hold the plain review open
            }
            active -= 1
            return {
                status: "GOOD_TO_GO",
                findings: [],
                raw: {
                    exitCode: 0,
                    durationMs: 1,
                    rawStdout: "{}",
                    rawStderr: "",
                },
            }
        })
        const inflight = new Map()
        const contextChains = new Map()
        const deps = makeDeps({
            buildPayload: payloadFor,
            runAndParse,
            inflight,
            contextChains,
        })

        const pPlain = handleReview({
            body: { cwd: "/repo", trigger: "stop_hook" },
            config: minimalConfig(),
            store,
            deps,
        })
        const pForce = handleReview({
            body: { cwd: "/repo", trigger: "mcp_tool", force: true },
            config: minimalConfig(),
            store,
            deps,
        })

        await flush()
        // Only the plain review's reviewer is running; the force request
        // is queued behind the context chain, not spawning concurrently.
        expect(runAndParse).toHaveBeenCalledTimes(1)
        expect(active).toBe(1)
        // Two distinct result-sharing slots exist (plain + force)…
        expect(inflight.size).toBe(2)
        // …but only one chain tail per context.
        expect(contextChains.size).toBe(1)

        releaseFirst()
        await Promise.all([pPlain, pForce])

        // Both pipelines ran, but never at the same time — the core
        // guarantee: no concurrent store.get → store.save race.
        expect(runAndParse).toHaveBeenCalledTimes(2)
        expect(maxActive).toBe(1)
        // Slots cleaned up.
        expect(inflight.size).toBe(0)
        expect(contextChains.size).toBe(0)
    })
})

describe("handleReview — change-notification fast path (v0.1.11)", () => {
    let store
    beforeEach(() => {
        store = makeStoreInMemory()
    })
    afterEach(() => cleanupStore(store))

    const seed = (overrides = {}) => {
        store.save("/repo|main", {
            repoRoot: "/repo",
            branch: "main",
            lastResultStatus: "GOOD_TO_GO",
            lastBaseline: {
                headSha: "abc",
                progressHash: "p",
                // Must match the effective review policy hash for the
                // fast path to fire (v0.1.23 — provider is part of it).
                reviewConfigHash: computeReviewConfigHash(minimalConfig()),
                files: {
                    modified: [],
                    untracked: [],
                    deleted: [],
                    renamed: [],
                    priorFindingContext: [],
                },
                totalBytes: 0,
                truncated: false,
            },
            dirtySinceLastReview: false,
            lastChangeAt: 1700,
            ...overrides,
        })
    }

    test("when dirty=false AND last status terminal-success AND HEAD matches AND tree clean → NO_CHANGES, no buildPayload", async () => {
        seed() // seed sets lastBaseline.headSha = "abc"
        const buildSpy = jest.fn()
        const runSpy = jest.fn()
        const r = await handleReview({
            body: { cwd: "/repo", trigger: "stop_hook" },
            config: minimalConfig(),
            store,
            deps: makeDeps({
                buildPayload: buildSpy,
                runAndParse: runSpy,
                currentHeadSha: () => "abc", // matches the cached baseline
                isWorkingTreeClean: () => true,
            }),
        })
        expect(r.body.status).toBe("NO_CHANGES")
        // No payload was built, no reviewer was spawned.
        expect(buildSpy).not.toHaveBeenCalled()
        expect(runSpy).not.toHaveBeenCalled()
    })

    test("with verifyCleanTree=true, falls through when tree probe disagrees (IDE-edit guard)", async () => {
        // payload.verifyCleanTree must be ON for the second probe to
        // run. HEAD matches the cached baseline but the tree is dirty
        // — e.g. the user edited in their IDE without a PostToolUse
        // ping. Fast path MUST defer so the edits get reviewed.
        seed()
        const cfg = { ...minimalConfig() }
        cfg.payload = { ...(cfg.payload ?? {}), verifyCleanTree: true }
        const buildSpy = jest.fn(() =>
            makePayload({
                files: {
                    modified: [{ path: "a.js" }],
                    untracked: [],
                    deleted: [],
                    renamed: [],
                    priorFindingContext: [],
                },
            })
        )
        const runSpy = jest.fn(async () => ({
            status: "GOOD_TO_GO",
            findings: [],
            raw: { exitCode: 0, durationMs: 1, rawStdout: "{}", rawStderr: "" },
        }))
        const r = await handleReview({
            body: { cwd: "/repo", trigger: "stop_hook" },
            config: cfg,
            store,
            deps: makeDeps({
                buildPayload: buildSpy,
                runAndParse: runSpy,
                currentHeadSha: () => "abc", // matches seeded baseline
                isWorkingTreeClean: () => false,
            }),
        })
        expect(buildSpy).toHaveBeenCalled()
        expect(r.body.status).toBe("GOOD_TO_GO")
    })

    test("with verifyCleanTree=false (default), trusts the dirty flag and skips the tree probe", async () => {
        // Even if the tree IS dirty (e.g. an IDE edit slipped past
        // the PostToolUse hook), with verifyCleanTree off the fast
        // path trusts dirty=false → returns NO_CHANGES. This is the
        // user-opted-in trade-off when they work mostly via Claude.
        seed()
        const treeCleanSpy = jest.fn(() => false) // would say "dirty" if asked
        const buildSpy = jest.fn()
        const r = await handleReview({
            body: { cwd: "/repo", trigger: "stop_hook" },
            config: minimalConfig(), // verifyCleanTree omitted → defaults off
            store,
            deps: makeDeps({
                buildPayload: buildSpy,
                runAndParse: async () => ({
                    status: "GOOD_TO_GO",
                    findings: [],
                    raw: {
                        exitCode: 0,
                        durationMs: 1,
                        rawStdout: "{}",
                        rawStderr: "",
                    },
                }),
                currentHeadSha: () => "abc",
                isWorkingTreeClean: treeCleanSpy,
            }),
        })
        expect(r.body.status).toBe("NO_CHANGES")
        // Tree probe is NOT called when the setting is off.
        expect(treeCleanSpy).not.toHaveBeenCalled()
        expect(buildSpy).not.toHaveBeenCalled()
    })

    test("falls through when HEAD has moved (commit/pull/rebase outside Claude)", async () => {
        // Working tree clean and dirty=false, but git rev-parse HEAD
        // returns a different SHA than the cached baseline — the user
        // committed in a terminal. Fast path MUST defer.
        seed()
        const buildSpy = jest.fn(() =>
            makePayload({
                files: {
                    modified: [{ path: "a.js" }],
                    untracked: [],
                    deleted: [],
                    renamed: [],
                    priorFindingContext: [],
                },
            })
        )
        const runSpy = jest.fn(async () => ({
            status: "GOOD_TO_GO",
            findings: [],
            raw: { exitCode: 0, durationMs: 1, rawStdout: "{}", rawStderr: "" },
        }))
        const r = await handleReview({
            body: { cwd: "/repo", trigger: "stop_hook" },
            config: minimalConfig(),
            store,
            deps: makeDeps({
                buildPayload: buildSpy,
                runAndParse: runSpy,
                isWorkingTreeClean: () => true,
                currentHeadSha: () => "def456new", // != seed's "abc"
            }),
        })
        expect(buildSpy).toHaveBeenCalled()
        expect(r.body.status).toBe("GOOD_TO_GO")
    })

    test("falls through when currentHeadSha cannot be read", async () => {
        // Conservative: if we can't probe HEAD, defer to slow path
        // rather than serve a possibly-stale cached NO_CHANGES.
        seed()
        const buildSpy = jest.fn(() =>
            makePayload({
                files: {
                    modified: [{ path: "a.js" }],
                    untracked: [],
                    deleted: [],
                    renamed: [],
                    priorFindingContext: [],
                },
            })
        )
        await handleReview({
            body: { cwd: "/repo", trigger: "stop_hook" },
            config: minimalConfig(),
            store,
            deps: makeDeps({
                buildPayload: buildSpy,
                runAndParse: async () => ({
                    status: "GOOD_TO_GO",
                    findings: [],
                    raw: {
                        exitCode: 0,
                        durationMs: 1,
                        rawStdout: "{}",
                        rawStderr: "",
                    },
                }),
                isWorkingTreeClean: () => true,
                currentHeadSha: () => null,
            }),
        })
        expect(buildSpy).toHaveBeenCalled()
    })

    test("does not call isWorkingTreeClean when HEAD has moved (short-circuit)", async () => {
        // Optimization: skip the second git probe when HEAD mismatch
        // already disqualifies the fast path.
        seed()
        const treeCleanSpy = jest.fn(() => true)
        await handleReview({
            body: { cwd: "/repo", trigger: "stop_hook" },
            config: minimalConfig(),
            store,
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
                        durationMs: 1,
                        rawStdout: "{}",
                        rawStderr: "",
                    },
                }),
                isWorkingTreeClean: treeCleanSpy,
                currentHeadSha: () => "different",
            }),
        })
        expect(treeCleanSpy).not.toHaveBeenCalled()
    })

    test("does NOT fast-path when last status is ISSUES (even with dirty=false + clean tree)", async () => {
        // ISSUES is terminal-with-issues, not terminal-success. The
        // existing cache logic (NO_PROGRESS_WITH_OPEN_ISSUES) handles
        // it correctly downstream — fast path must not steal that.
        seed({ lastResultStatus: "ISSUES" })
        const buildSpy = jest.fn(() =>
            makePayload({
                files: {
                    modified: [{ path: "a.js" }],
                    untracked: [],
                    deleted: [],
                    renamed: [],
                    priorFindingContext: [],
                },
            })
        )
        await handleReview({
            body: { cwd: "/repo", trigger: "stop_hook" },
            config: minimalConfig(),
            store,
            deps: makeDeps({
                buildPayload: buildSpy,
                runAndParse: async () => ({
                    status: "GOOD_TO_GO",
                    findings: [],
                    raw: {
                        exitCode: 0,
                        durationMs: 1,
                        rawStdout: "{}",
                        rawStderr: "",
                    },
                }),
                isWorkingTreeClean: () => true,
            }),
        })
        expect(buildSpy).toHaveBeenCalled()
    })

    test("does NOT fast-path when dirty=true (notification received since last review)", async () => {
        seed({ dirtySinceLastReview: true })
        const buildSpy = jest.fn(() =>
            makePayload({
                files: {
                    modified: [{ path: "a.js" }],
                    untracked: [],
                    deleted: [],
                    renamed: [],
                    priorFindingContext: [],
                },
            })
        )
        await handleReview({
            body: { cwd: "/repo", trigger: "stop_hook" },
            config: minimalConfig(),
            store,
            deps: makeDeps({
                buildPayload: buildSpy,
                runAndParse: async () => ({
                    status: "GOOD_TO_GO",
                    findings: [],
                    raw: {
                        exitCode: 0,
                        durationMs: 1,
                        rawStdout: "{}",
                        rawStderr: "",
                    },
                }),
                isWorkingTreeClean: () => true,
            }),
        })
        expect(buildSpy).toHaveBeenCalled()
    })

    test("does NOT fast-path on a fresh context (no lastBaseline yet)", async () => {
        // No seed — context starts blank. dirty defaults to true.
        const buildSpy = jest.fn(() =>
            makePayload({
                files: {
                    modified: [{ path: "a.js" }],
                    untracked: [],
                    deleted: [],
                    renamed: [],
                    priorFindingContext: [],
                },
            })
        )
        await handleReview({
            body: { cwd: "/repo", trigger: "stop_hook" },
            config: minimalConfig(),
            store,
            deps: makeDeps({
                buildPayload: buildSpy,
                runAndParse: async () => ({
                    status: "GOOD_TO_GO",
                    findings: [],
                    raw: {
                        exitCode: 0,
                        durationMs: 1,
                        rawStdout: "{}",
                        rawStderr: "",
                    },
                }),
                isWorkingTreeClean: () => true,
            }),
        })
        expect(buildSpy).toHaveBeenCalled()
    })

    test("terminal success (GOOD_TO_GO) clears dirtySinceLastReview to false", async () => {
        store.save("/repo|main", {
            repoRoot: "/repo",
            branch: "main",
            dirtySinceLastReview: true,
        })
        await handleReview({
            body: { cwd: "/repo", trigger: "stop_hook" },
            config: minimalConfig(),
            store,
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
                        durationMs: 1,
                        rawStdout: "{}",
                        rawStderr: "",
                    },
                }),
            }),
        })
        // Read via the store helper (clones); the in-memory store the
        // test uses preserves the latest value.
        const after = store.get({
            key: "/repo|main",
            repoRoot: "/repo",
            branch: "main",
        })
        expect(after.dirtySinceLastReview).toBe(false)
    })

    test("ISSUES leaves dirtySinceLastReview true (work pending)", async () => {
        store.save("/repo|main", {
            repoRoot: "/repo",
            branch: "main",
            dirtySinceLastReview: true,
        })
        await handleReview({
            body: { cwd: "/repo", trigger: "stop_hook" },
            config: minimalConfig(),
            store,
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
                    status: "ISSUES",
                    findings: [
                        {
                            file: "a.js",
                            line: 1,
                            severity: "blocker",
                            category: "bug",
                            message: "boom",
                        },
                    ],
                    raw: {
                        exitCode: 0,
                        durationMs: 1,
                        rawStdout: "{}",
                        rawStderr: "",
                    },
                }),
            }),
        })
        const after = store.get({
            key: "/repo|main",
            repoRoot: "/repo",
            branch: "main",
        })
        expect(after.dirtySinceLastReview).toBe(true)
    })
})

describe("handleReview — ESCALATE notification gate (v0.1.14)", () => {
    let store
    beforeEach(() => {
        store = makeStoreInMemory()
    })
    afterEach(() => cleanupStore(store))

    const payloadOk = () =>
        makePayload({
            files: {
                modified: [{ path: "a.js" }],
                untracked: [],
                deleted: [],
                renamed: [],
                priorFindingContext: [],
            },
        })

    test("first CODEX_ERROR sets notifyUser=true and flips escalateNotified", async () => {
        const r = await handleReview({
            body: { cwd: "/repo", trigger: "stop_hook" },
            config: minimalConfig(),
            store,
            deps: makeDeps({
                buildPayload: payloadOk,
                runAndParse: async () => ({
                    status: "ESCALATE",
                    reason: "codex exited with code 1",
                    raw: {
                        exitCode: 1,
                        durationMs: 10,
                        rawStdout: "",
                        rawStderr: "boom",
                    },
                }),
            }),
        })
        expect(r.body.status).toBe("ESCALATE")
        expect(r.body.code).toBe("CODEX_ERROR")
        expect(r.body.notifyUser).toBe(true)
        const after = store.get({
            key: "/repo|main",
            repoRoot: "/repo",
            branch: "main",
        })
        expect(after.escalateNotified).toBe(true)
    })

    test("second CODEX_ERROR_CACHED returns notifyUser=false (gate stays)", async () => {
        // Seed prior failure: lastResultStatus=ESCALATE, escalateNotified=true.
        store.save("/repo|main", {
            repoRoot: "/repo",
            branch: "main",
            lastResultStatus: "ESCALATE",
            lastEscalateReason: "old fail",
            lastBaseline: {
                headSha: "abc",
                progressHash: "p",
                reviewConfigHash: computeReviewConfigHash(minimalConfig()),
                files: {
                    modified: [{ path: "a.js" }],
                    untracked: [],
                    deleted: [],
                    renamed: [],
                    priorFindingContext: [],
                },
                totalBytes: 0,
                truncated: false,
            },
            escalateNotified: true,
        })
        const r = await handleReview({
            body: { cwd: "/repo", trigger: "stop_hook" },
            config: minimalConfig(),
            store,
            deps: makeDeps({
                buildPayload: () =>
                    makePayload({
                        // Same progressHash as seeded → cache hits.
                        files: {
                            modified: [{ path: "a.js" }],
                            untracked: [],
                            deleted: [],
                            renamed: [],
                            priorFindingContext: [],
                        },
                        progressHash: "p",
                    }),
                runAndParse: async () => {
                    throw new Error("reviewer should NOT spawn on cache hit")
                },
            }),
        })
        expect(r.body.status).toBe("ESCALATE")
        expect(r.body.code).toBe("CODEX_ERROR_CACHED")
        expect(r.body.notifyUser).toBe(false)
    })

    test("cached path that finds escalateNotified=false (e.g. server restart) returns notifyUser=true", async () => {
        // Seed prior failure but with the gate cleared — simulates a
        // server restart that loaded state but the flag was somehow
        // missing (or a /reset before our v0.1.14 upgrade).
        store.save("/repo|main", {
            repoRoot: "/repo",
            branch: "main",
            lastResultStatus: "ESCALATE",
            lastEscalateReason: "old fail",
            lastBaseline: {
                headSha: "abc",
                progressHash: "p",
                reviewConfigHash: computeReviewConfigHash(minimalConfig()),
                files: {
                    modified: [{ path: "a.js" }],
                    untracked: [],
                    deleted: [],
                    renamed: [],
                    priorFindingContext: [],
                },
                totalBytes: 0,
                truncated: false,
            },
            escalateNotified: false,
        })
        const r = await handleReview({
            body: { cwd: "/repo", trigger: "stop_hook" },
            config: minimalConfig(),
            store,
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
                        progressHash: "p",
                    }),
                runAndParse: async () => {
                    throw new Error("should not spawn")
                },
            }),
        })
        expect(r.body.code).toBe("CODEX_ERROR_CACHED")
        expect(r.body.notifyUser).toBe(true)
    })

    test("transient-auth CODEX_ERROR skips cache poisoning (lastBaseline not saved)", async () => {
        await handleReview({
            body: { cwd: "/repo", trigger: "stop_hook" },
            config: minimalConfig(),
            store,
            deps: makeDeps({
                buildPayload: payloadOk,
                runAndParse: async () => ({
                    status: "ESCALATE",
                    reason: "codex exited with code 1",
                    raw: {
                        exitCode: 1,
                        durationMs: 10,
                        rawStdout: "",
                        rawStderr:
                            "ERROR: You've hit your usage limit. Try again at...",
                    },
                }),
            }),
        })
        const after = store.get({
            key: "/repo|main",
            repoRoot: "/repo",
            branch: "main",
        })
        // Cache is NOT poisoned — lastResultStatus stays null / not ESCALATE.
        expect(after.lastResultStatus).not.toBe("ESCALATE")
        expect(after.lastBaseline).toBeNull()
        // But the notification gate IS set so we don't re-pester.
        expect(after.escalateNotified).toBe(true)
    })

    test("transient-auth signatures match across reason patterns", async () => {
        const patterns = [
            "ERROR: You've hit your usage limit",
            "When using Gemini API, you must specify the GEMINI_API_KEY",
            "Not logged in · Please run /login",
            "401 Unauthorized",
            "rate limit exceeded",
            "quota exceeded",
        ]
        for (const reason of patterns) {
            cleanupStore(store)
            store = makeStoreInMemory()
            await handleReview({
                body: { cwd: "/repo", trigger: "stop_hook" },
                config: minimalConfig(),
                store,
                deps: makeDeps({
                    buildPayload: payloadOk,
                    runAndParse: async () => ({
                        status: "ESCALATE",
                        reason,
                        raw: {
                            exitCode: 1,
                            durationMs: 1,
                            rawStdout: "",
                            rawStderr: "",
                        },
                    }),
                }),
            })
            const after = store.get({
                key: "/repo|main",
                repoRoot: "/repo",
                branch: "main",
            })
            expect(after.lastBaseline).toBeNull()
        }
    })

    test("non-auth CODEX_ERROR DOES poison the cache (the original behavior)", async () => {
        await handleReview({
            body: { cwd: "/repo", trigger: "stop_hook" },
            config: minimalConfig(),
            store,
            deps: makeDeps({
                buildPayload: payloadOk,
                runAndParse: async () => ({
                    status: "ESCALATE",
                    reason: "schema validation failed",
                    raw: {
                        exitCode: 1,
                        durationMs: 10,
                        rawStdout: "",
                        rawStderr: "",
                    },
                }),
            }),
        })
        const after = store.get({
            key: "/repo|main",
            repoRoot: "/repo",
            branch: "main",
        })
        expect(after.lastResultStatus).toBe("ESCALATE")
        expect(after.lastBaseline).not.toBeNull()
    })

    test("EMPTY_PAYLOAD returns notifyUser=false explicitly", async () => {
        const r = await handleReview({
            body: { cwd: "/repo", trigger: "stop_hook" },
            config: minimalConfig(),
            store,
            deps: makeDeps({
                buildPayload: () =>
                    makePayload({
                        empty: true,
                        nonBinaryFileCount: 0,
                    }),
            }),
        })
        expect(r.body.code).toBe("EMPTY_PAYLOAD")
        expect(r.body.notifyUser).toBe(false)
    })

    test("MAX_BLOCKS includes notifyUser and flips the gate", async () => {
        // Pre-load blockCount at the cap so the pre-check fires.
        store.save("/repo|main", {
            repoRoot: "/repo",
            branch: "main",
            blockCount: 6, // default cap
            escalateNotified: false,
        })
        const r = await handleReview({
            body: { cwd: "/repo", trigger: "stop_hook" },
            config: minimalConfig(), // maxBlocks: 6
            store,
            deps: makeDeps({
                buildPayload: payloadOk,
                runAndParse: async () => ({
                    status: "GOOD_TO_GO",
                    findings: [],
                    raw: {
                        exitCode: 0,
                        durationMs: 1,
                        rawStdout: "{}",
                        rawStderr: "",
                    },
                }),
            }),
        })
        expect(r.body.code).toBe("MAX_BLOCKS")
        expect(r.body.notifyUser).toBe(true)
        const after = store.get({
            key: "/repo|main",
            repoRoot: "/repo",
            branch: "main",
        })
        expect(after.escalateNotified).toBe(true)
    })

    test("any non-ESCALATE terminal review clears escalateNotified (recovery)", async () => {
        // Seed gate=true (Claude was already told about a prior fail).
        store.save("/repo|main", {
            repoRoot: "/repo",
            branch: "main",
            escalateNotified: true,
        })
        await handleReview({
            body: { cwd: "/repo", trigger: "stop_hook" },
            config: minimalConfig(),
            store,
            deps: makeDeps({
                buildPayload: payloadOk,
                runAndParse: async () => ({
                    status: "GOOD_TO_GO",
                    findings: [],
                    raw: {
                        exitCode: 0,
                        durationMs: 1,
                        rawStdout: "{}",
                        rawStderr: "",
                    },
                }),
            }),
        })
        const after = store.get({
            key: "/repo|main",
            repoRoot: "/repo",
            branch: "main",
        })
        expect(after.escalateNotified).toBe(false)
    })

    test("ISSUES also clears the gate (reviewer recovered, just found things)", async () => {
        store.save("/repo|main", {
            repoRoot: "/repo",
            branch: "main",
            escalateNotified: true,
        })
        await handleReview({
            body: { cwd: "/repo", trigger: "stop_hook" },
            config: minimalConfig(),
            store,
            deps: makeDeps({
                buildPayload: payloadOk,
                runAndParse: async () => ({
                    status: "ISSUES",
                    findings: [
                        {
                            file: "a.js",
                            line: 1,
                            severity: "blocker",
                            category: "bug",
                            message: "boom",
                        },
                    ],
                    raw: {
                        exitCode: 0,
                        durationMs: 1,
                        rawStdout: "{}",
                        rawStderr: "",
                    },
                }),
            }),
        })
        const after = store.get({
            key: "/repo|main",
            repoRoot: "/repo",
            branch: "main",
        })
        expect(after.escalateNotified).toBe(false)
    })

    // v0.1.15 — notifyUser gate is Stop-hook-scoped. Manual MCP
    // request_review calls must NOT flip the gate, otherwise the
    // Stop hook that comes after a manual call would never get its
    // chance to block Claude with the "REVIEWER FAILURE" reason.
    test("manual MCP ESCALATE does NOT consume the gate (Stop hook still notifies later)", async () => {
        // Round 1: manual request_review (non-stop trigger) — reviewer
        // explodes. Gate must stay false, response must say notifyUser=false.
        const r1 = await handleReview({
            body: { cwd: "/repo", trigger: "manual" },
            config: minimalConfig(),
            store,
            deps: makeDeps({
                buildPayload: payloadOk,
                runAndParse: async () => ({
                    status: "ESCALATE",
                    reason: "codex exited with code 1",
                    raw: {
                        exitCode: 1,
                        durationMs: 10,
                        rawStdout: "",
                        rawStderr: "",
                    },
                }),
            }),
        })
        expect(r1.body.code).toBe("CODEX_ERROR")
        expect(r1.body.notifyUser).toBe(false)
        const afterManual = store.get({
            key: "/repo|main",
            repoRoot: "/repo",
            branch: "main",
        })
        expect(afterManual.escalateNotified).toBe(false)

        // Round 2: Stop hook fires for the same context. Cache will
        // short-circuit (lastResultStatus=ESCALATE). Gate is still
        // false → notifyUser must be true so Claude gets the block.
        const r2 = await handleReview({
            body: { cwd: "/repo", trigger: "stop_hook" },
            config: minimalConfig(),
            store,
            deps: makeDeps({
                buildPayload: payloadOk,
                runAndParse: async () => {
                    throw new Error("cache hit expected, no spawn")
                },
            }),
        })
        expect(r2.body.code).toBe("CODEX_ERROR_CACHED")
        expect(r2.body.notifyUser).toBe(true)
        const afterStop = store.get({
            key: "/repo|main",
            repoRoot: "/repo",
            branch: "main",
        })
        expect(afterStop.escalateNotified).toBe(true)
    })

    test("MAX_CODEX_ROUNDS on manual trigger: notifyUser=false, gate untouched", async () => {
        store.save("/repo|main", {
            repoRoot: "/repo",
            branch: "main",
            codexRounds: 10, // default cap
            escalateNotified: false,
        })
        const r = await handleReview({
            body: { cwd: "/repo", trigger: "manual" },
            config: minimalConfig(),
            store,
            deps: makeDeps({
                buildPayload: payloadOk,
            }),
        })
        expect(r.body.code).toBe("MAX_CODEX_ROUNDS")
        expect(r.body.notifyUser).toBe(false)
        const after = store.get({
            key: "/repo|main",
            repoRoot: "/repo",
            branch: "main",
        })
        expect(after.escalateNotified).toBe(false)
    })
})

// v0.1.18 — Forced reviews bypass every short-circuit and every
// safety cap. Used by the MCP `request_review` tool when the user
// explicitly asks Claude for a fresh review.
describe("handleReview — force: true (v0.1.18)", () => {
    let store
    beforeEach(() => {
        store = makeStoreInMemory()
    })
    afterEach(() => cleanupStore(store))

    const payloadOk = () =>
        makePayload({
            files: {
                modified: [{ path: "a.js" }],
                untracked: [],
                deleted: [],
                renamed: [],
                priorFindingContext: [],
            },
        })

    test("bypasses the dirty-flag fast path (still spawns reviewer)", async () => {
        // Seed a state that would normally fast-path NO_CHANGES.
        store.save("/repo|main", {
            repoRoot: "/repo",
            branch: "main",
            lastResultStatus: "GOOD_TO_GO",
            lastBaseline: {
                headSha: "abc",
                progressHash: "p",
                reviewConfigHash: "c",
                files: {
                    modified: [],
                    untracked: [],
                    deleted: [],
                    renamed: [],
                    priorFindingContext: [],
                },
                totalBytes: 0,
                truncated: false,
            },
            dirtySinceLastReview: false,
        })
        const runSpy = jest.fn(async () => ({
            status: "GOOD_TO_GO",
            findings: [],
            raw: { durationMs: 1, exitCode: 0 },
        }))
        const r = await handleReview({
            body: { cwd: "/repo", trigger: "mcp_tool", force: true },
            config: minimalConfig(),
            store,
            deps: makeDeps({
                buildPayload: payloadOk,
                runAndParse: runSpy,
                currentHeadSha: () => "abc",
                isWorkingTreeClean: () => true,
            }),
        })
        expect(r.body.status).toBe("GOOD_TO_GO")
        expect(runSpy).toHaveBeenCalledTimes(1)
    })

    test("bypasses the unchanged-baseline NO_CHANGES short-circuit", async () => {
        store.save("/repo|main", {
            repoRoot: "/repo",
            branch: "main",
            lastResultStatus: "GOOD_TO_GO",
            lastBaseline: seededBaseline("p"),
        })
        const runSpy = jest.fn(async () => ({
            status: "GOOD_TO_GO",
            findings: [],
            raw: { durationMs: 1, exitCode: 0 },
        }))
        const r = await handleReview({
            body: { cwd: "/repo", trigger: "mcp_tool", force: true },
            config: minimalConfig(),
            store,
            deps: makeDeps({
                // Same progressHash as cached → would normally NO_CHANGES.
                buildPayload: () =>
                    makePayload({
                        files: {
                            modified: [{ path: "a.js" }],
                            untracked: [],
                            deleted: [],
                            renamed: [],
                            priorFindingContext: [],
                        },
                        progressHash: "p",
                    }),
                runAndParse: runSpy,
            }),
        })
        expect(r.body.status).toBe("GOOD_TO_GO")
        expect(runSpy).toHaveBeenCalledTimes(1)
    })

    test("bypasses the CODEX_ERROR_CACHED short-circuit", async () => {
        store.save("/repo|main", {
            repoRoot: "/repo",
            branch: "main",
            lastResultStatus: "ESCALATE",
            lastEscalateReason: "old fail",
            lastBaseline: seededBaseline("p"),
        })
        const runSpy = jest.fn(async () => ({
            status: "GOOD_TO_GO",
            findings: [],
            raw: { durationMs: 1, exitCode: 0 },
        }))
        const r = await handleReview({
            body: { cwd: "/repo", trigger: "mcp_tool", force: true },
            config: minimalConfig(),
            store,
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
                        progressHash: "p",
                    }),
                runAndParse: runSpy,
            }),
        })
        expect(r.body.status).toBe("GOOD_TO_GO")
        expect(runSpy).toHaveBeenCalledTimes(1)
    })

    test("bypasses MAX_BLOCKS even on stop_hook trigger", async () => {
        store.save("/repo|main", {
            repoRoot: "/repo",
            branch: "main",
            blockCount: 6,
        })
        const runSpy = jest.fn(async () => ({
            status: "GOOD_TO_GO",
            findings: [],
            raw: { durationMs: 1, exitCode: 0 },
        }))
        const r = await handleReview({
            body: { cwd: "/repo", trigger: "stop_hook", force: true },
            config: minimalConfig(),
            store,
            deps: makeDeps({ buildPayload: payloadOk, runAndParse: runSpy }),
        })
        expect(r.body.code).not.toBe("MAX_BLOCKS")
        expect(r.body.status).toBe("GOOD_TO_GO")
        expect(runSpy).toHaveBeenCalledTimes(1)
    })

    test("bypasses MAX_CODEX_ROUNDS", async () => {
        store.save("/repo|main", {
            repoRoot: "/repo",
            branch: "main",
            codexRounds: 10,
        })
        const runSpy = jest.fn(async () => ({
            status: "GOOD_TO_GO",
            findings: [],
            raw: { durationMs: 1, exitCode: 0 },
        }))
        const r = await handleReview({
            body: { cwd: "/repo", trigger: "mcp_tool", force: true },
            config: minimalConfig(),
            store,
            deps: makeDeps({ buildPayload: payloadOk, runAndParse: runSpy }),
        })
        expect(r.body.code).not.toBe("MAX_CODEX_ROUNDS")
        expect(runSpy).toHaveBeenCalledTimes(1)
    })

    test("force=false (default) still short-circuits NO_CHANGES (regression)", async () => {
        store.save("/repo|main", {
            repoRoot: "/repo",
            branch: "main",
            lastResultStatus: "GOOD_TO_GO",
            lastBaseline: seededBaseline("p"),
        })
        const runSpy = jest.fn()
        const r = await handleReview({
            body: { cwd: "/repo", trigger: "mcp_tool" },
            config: minimalConfig(),
            store,
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
                        progressHash: "p",
                    }),
                runAndParse: runSpy,
            }),
        })
        expect(r.body.status).toBe("NO_CHANGES")
        expect(runSpy).not.toHaveBeenCalled()
    })

    test("provider override is forwarded to pickReviewer", async () => {
        const pickSpy = jest.fn(() => ({
            name: "gemini",
            runAndParse: async () => ({
                status: "GOOD_TO_GO",
                findings: [],
                raw: { durationMs: 1, exitCode: 0 },
            }),
            buildArgs: () => ["gemini-arg"],
            binary: "gemini",
        }))
        await handleReview({
            body: {
                cwd: "/repo",
                trigger: "mcp_tool",
                provider: "gemini",
            },
            // Server is configured for codex; the override should win.
            config: { ...minimalConfig(), reviewer: { provider: "codex" } },
            store,
            deps: makeDeps({
                buildPayload: payloadOk,
                pickReviewer: pickSpy,
            }),
        })
        expect(pickSpy).toHaveBeenCalledTimes(1)
        // Second arg = override.
        expect(pickSpy.mock.calls[0][1]).toBe("gemini")
    })

    test("missing provider override falls through to config default", async () => {
        const pickSpy = jest.fn(() => ({
            name: "codex",
            runAndParse: async () => ({
                status: "GOOD_TO_GO",
                findings: [],
                raw: { durationMs: 1, exitCode: 0 },
            }),
            buildArgs: () => [],
            binary: "codex",
        }))
        await handleReview({
            body: { cwd: "/repo", trigger: "mcp_tool" },
            config: minimalConfig(),
            store,
            deps: makeDeps({
                buildPayload: payloadOk,
                pickReviewer: pickSpy,
            }),
        })
        expect(pickSpy.mock.calls[0][1]).toBeNull()
    })
})

// v0.1.28 — in-flight observability registry feeding the dashboard.
describe("snapshotInFlight (v0.1.28)", () => {
    let store
    beforeEach(() => {
        store = makeStoreInMemory()
    })
    afterEach(() => cleanupStore(store))

    test("empty registry snapshots to []", () => {
        expect(snapshotInFlight(() => 0, new Map())).toEqual([])
    })

    test("maps entries to {repo,branch,provider,force,startedAt,elapsedMs}, oldest first", () => {
        const meta = new Map([
            [
                "k2",
                {
                    contextKey: "/b|main",
                    repo: "b",
                    branch: "main",
                    provider: "codex",
                    force: false,
                    startedAt: 2000,
                },
            ],
            [
                "k1",
                {
                    contextKey: "/a|dev",
                    repo: "a",
                    branch: "dev",
                    provider: "gemini",
                    force: true,
                    startedAt: 1000,
                },
            ],
        ])
        const out = snapshotInFlight(() => 5000, meta)
        expect(out).toHaveLength(2)
        // Sorted by startedAt ascending.
        expect(out[0].repo).toBe("a")
        expect(out[0].elapsedMs).toBe(4000)
        expect(out[0].force).toBe(true)
        expect(out[1].repo).toBe("b")
        expect(out[1].elapsedMs).toBe(3000)
    })

    test("a running review registers, then clears on completion", async () => {
        let release
        const gate = new Promise((r) => {
            release = r
        })
        const runAndParse = jest.fn(async () => {
            await gate
            return {
                status: "GOOD_TO_GO",
                findings: [],
                raw: {
                    exitCode: 0,
                    durationMs: 1,
                    rawStdout: "{}",
                    rawStderr: "",
                },
            }
        })
        const inflightMeta = new Map()
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
                }),
            runAndParse,
            inflight: new Map(),
            contextChains: new Map(),
            inflightMeta,
        })
        const p = handleReview({
            body: { cwd: "/repo", trigger: "stop_hook" },
            config: minimalConfig(),
            store,
            deps,
            now: () => 10000,
        })
        // Let the pipeline register before the gated reviewer call.
        await Promise.resolve()
        await Promise.resolve()
        const mid = snapshotInFlight(() => 12500, inflightMeta)
        expect(mid).toHaveLength(1)
        expect(mid[0].repo).toBe("repo")
        expect(mid[0].branch).toBe("main")
        expect(mid[0].startedAt).toBe(10000)
        expect(mid[0].elapsedMs).toBe(2500)

        release()
        await p
        // Cleared once the pipeline settles.
        expect(snapshotInFlight(() => 0, inflightMeta)).toEqual([])
    })
})
