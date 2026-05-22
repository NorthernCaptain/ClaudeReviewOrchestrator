/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { handleStatus, __test__ } from "./status.js"

const { redactConfig, summarizeContext, archiveCountsByContext, REDACTED } =
    __test__

const minimalConfig = () => ({
    port: 7777,
    bind: "127.0.0.1",
    authToken: "SECRET-TOKEN-XYZ",
    allowedRoots: ["/Users/leo"],
    codex: {
        binary: "codex",
        model: "gpt-5-codex",
        reasoningEffort: "high",
        ignoreProjectRules: true,
        extraArgs: [],
    },
    limits: {
        maxCodexRounds: 5,
        maxBlocks: 6,
        idleResetMinutes: 10,
        codexTimeoutSeconds: 240,
        maxCodexOutputBytes: 1048576,
        maxPayloadBytes: 262144,
        maxFileBytes: 65536,
        maxFiles: 40,
    },
    ignorePaths: ["**/node_modules/**"],
    blockingSeverities: ["blocker", "major"],
    extraReviewerInstructions: null,
    reviewsDir: "./reviews",
    reviewsRetentionDays: null,
    logging: { dir: "~/.claude/logs", level: "info" },
})

describe("redactConfig", () => {
    test("replaces authToken with REDACTED", () => {
        const r = redactConfig(minimalConfig())
        expect(r.authToken).toBe(REDACTED)
    })

    test("collapses extraReviewerInstructions to '<set>' when present (drops content)", () => {
        const cfg = minimalConfig()
        cfg.extraReviewerInstructions = "Some sensitive project rule."
        const r = redactConfig(cfg)
        expect(r.extraReviewerInstructions).toBe("<set>")
        expect(JSON.stringify(r)).not.toMatch(/sensitive project rule/)
    })

    test("leaves non-sensitive fields intact", () => {
        const r = redactConfig(minimalConfig())
        expect(r.port).toBe(7777)
        expect(r.limits.maxCodexRounds).toBe(5)
        expect(r.codex.model).toBe("gpt-5-codex")
        expect(r.codex.reasoningEffort).toBe("high")
        expect(r.blockingSeverities).toEqual(["blocker", "major"])
    })

    test("tolerates null config", () => {
        expect(redactConfig(null)).toBeNull()
    })

    test("surfaces the gemini reviewer block (provider + model + approvalMode + timeout)", () => {
        const cfg = {
            ...minimalConfig(),
            reviewer: {
                provider: "gemini",
                gemini: {
                    binary: "gemini",
                    model: "auto",
                    approvalMode: "plan",
                    timeoutSeconds: 600,
                    extraArgs: [],
                },
            },
        }
        const r = redactConfig(cfg)
        expect(r.reviewer.provider).toBe("gemini")
        expect(r.reviewer.gemini.model).toBe("auto")
        expect(r.reviewer.gemini.approvalMode).toBe("plan")
        expect(r.reviewer.gemini.timeoutSeconds).toBe(600)
    })

    test("reviewer.gemini is null when only the claude block is present", () => {
        const cfg = {
            ...minimalConfig(),
            reviewer: {
                provider: "claude",
                claude: {
                    binary: "claude",
                    model: "claude-opus-4-7",
                    effort: "high",
                    permissionMode: "bypassPermissions",
                    disallowedTools: [],
                    timeoutSeconds: 240,
                    extraArgs: [],
                },
            },
        }
        const r = redactConfig(cfg)
        expect(r.reviewer.gemini).toBeNull()
        expect(r.reviewer.claude).not.toBeNull()
    })
})

describe("summarizeContext", () => {
    test("drops priorFindings array and files baseline; keeps counts and hashes (truncated)", () => {
        const r = summarizeContext({
            key: "/repo|main",
            repoRoot: "/Users/leo/work/repo",
            branch: "main",
            codexRounds: 3,
            blockCount: 2,
            lastResultStatus: "ISSUES",
            lastReviewedAt: 1779000000000,
            priorFindings: [
                { file: "a.js", line: 1, message: "x" },
                { file: "b.js", line: 2, message: "y" },
            ],
            lastBaseline: {
                headSha: "abc1234567890def",
                promptHash: "p1234567890abcdef1234567890abcdef",
                progressHash: "g1234567890abcdef1234567890abcdef",
                reviewConfigHash: "r1234567890abcdef1234567890abcdef",
                files: { modified: [], untracked: [] }, // dropped
                totalBytes: 8192,
                truncated: false,
            },
        })
        expect(r.codexRounds).toBe(3)
        expect(r.blockCount).toBe(2)
        expect(r.priorFindingsCount).toBe(2)
        expect("priorFindings" in r).toBe(false)
        expect(r.lastBaseline.headSha).toBe("abc123456789")
        expect(r.lastBaseline.promptHash.length).toBeLessThanOrEqual(16)
        // files NOT included.
        expect("files" in r.lastBaseline).toBe(false)
        expect(r.lastReviewedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
        expect(r.repo).toBe("repo")
    })

    test("tolerates a context with no lastBaseline / no lastReviewedAt", () => {
        const r = summarizeContext({
            key: "/x|main",
            repoRoot: "/x",
            branch: "main",
            codexRounds: 0,
            blockCount: 0,
            lastResultStatus: null,
            lastReviewedAt: 0,
            priorFindings: [],
            lastBaseline: null,
        })
        expect(r.lastBaseline).toBeNull()
        expect(r.lastReviewedAt).toBeNull()
        expect(r.priorFindingsCount).toBe(0)
    })
})

describe("archiveCountsByContext", () => {
    test("counts entries per context folder", () => {
        const list = [
            { context: "repo:main", name: "a.json" },
            { context: "repo:main", name: "b.json" },
            { context: "repo:feature__x", name: "c.json" },
        ]
        expect(archiveCountsByContext(list)).toEqual({
            "repo:main": 2,
            "repo:feature__x": 1,
        })
    })

    test("returns {} on null/empty input", () => {
        expect(archiveCountsByContext(null)).toEqual({})
        expect(archiveCountsByContext([])).toEqual({})
    })
})

describe("handleStatus", () => {
    test("returns the documented envelope shape with redaction", () => {
        const store = {
            list: () => [
                {
                    key: "/r|main",
                    repoRoot: "/r",
                    branch: "main",
                    codexRounds: 1,
                    blockCount: 0,
                    lastResultStatus: "GOOD_TO_GO",
                    lastReviewedAt: 1779000000000,
                    priorFindings: [],
                    lastBaseline: null,
                },
            ],
        }
        const archive = {
            list: () => [{ context: "r:main", name: "x.json" }],
        }
        const now = () => 1779000010000
        const startedAt = 1779000000000
        const out = handleStatus({
            store,
            archive,
            config: minimalConfig(),
            startedAt,
            now,
        })
        expect(out.ok).toBe(true)
        expect(out.uptimeSeconds).toBe(10)
        expect(out.contexts).toHaveLength(1)
        expect(out.contexts[0].repo).toBe("r")
        expect(out.archiveCounts).toEqual({ "r:main": 1 })
        expect(out.config.authToken).toBe(REDACTED)
        expect(JSON.stringify(out)).not.toMatch(/SECRET-TOKEN-XYZ/)
    })

    test("tolerates a store that has no list method", () => {
        const out = handleStatus({
            store: {},
            archive: null,
            config: minimalConfig(),
            startedAt: 0,
            now: () => 0,
        })
        expect(out.contexts).toEqual([])
        expect(out.archiveCounts).toEqual({})
    })
})
