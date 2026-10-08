/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { jest } from "@jest/globals"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
    asContent,
    reviewRequestHandler,
    repoInClientRoots,
    ROOTS_PROBE_TIMEOUT_MS,
    REQUEST_REVIEW_INPUT_SHAPE,
    REQUEST_REVIEW_TOOL,
    __test__,
} from "./mcp.js"
import { createStateStore } from "../../state.js"

const { summarizeReview } = __test__

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
        maxCodexOutputBytes: 1024 * 1024,
        maxPayloadBytes: 262144,
        maxFileBytes: 65536,
        maxFiles: 40,
    },
    ignorePaths: [],
    blockingSeverities: ["blocker", "major"],
    extraReviewerInstructions: null,
})

const happyContext = {
    repo: "repo",
    repoRoot: "/repo",
    branch: "main",
    key: "/repo|main",
}

const makeStore = () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mcp-store-"))
    const store = createStateStore({
        filePath: path.join(dir, "state.json"),
        now: () => 0,
    })
    store.__dir = dir
    return store
}

const cleanup = (store) => rmSync(store.__dir, { recursive: true, force: true })

const happyDeps = () => ({
    resolveContext: () => happyContext,
    loadProjectConfig: () => null,
    buildPayload: () => ({
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
        promptText: "PAYLOAD",
        promptHash: "p",
        progressHash: "g",
        priorFindingPaths: [],
        empty: false,
        nonBinaryFileCount: 1,
    }),
    runAndParse: async () => ({
        status: "GOOD_TO_GO",
        findings: [],
        raw: {
            durationMs: 12,
            exitCode: 0,
            timedOut: false,
            model: "gpt-5-codex",
        },
    }),
})

describe("summarizers", () => {
    test("summarizeReview captures status, counters, and findings counts", () => {
        const out = summarizeReview({
            status: "ISSUES",
            findings: [
                { severity: "blocker" },
                { severity: "blocker" },
                { severity: "nit" },
            ],
            blockingFindings: [
                { severity: "blocker" },
                { severity: "blocker" },
            ],
            droppedFindings: [{}],
            state: { codexRounds: 2, blockCount: 1 },
        })
        expect(out).toMatch(/Status: ISSUES/)
        expect(out).toMatch(/Findings: 3 \(blocking: 2, dropped: 1\)/)
        expect(out).toMatch(/codexRounds=2/)
    })

    test("summarizeReview surfaces reason and code on ESCALATE", () => {
        const out = summarizeReview({
            status: "ESCALATE",
            reason: "codex output failed schema",
            code: "CODEX_ERROR",
            findings: [],
            blockingFindings: [],
            droppedFindings: [],
        })
        expect(out).toMatch(/Reason: codex output failed schema/)
        expect(out).toMatch(/Code: CODEX_ERROR/)
    })
})

describe("asContent", () => {
    test("returns text + fenced JSON + structuredContent", () => {
        const out = asContent("hello", { foo: 1 })
        expect(out.content[0]).toEqual({ type: "text", text: "hello" })
        expect(out.content[1].text).toMatch(/```json/)
        expect(out.content[1].text).toMatch(/"foo": 1/)
        expect(out.structuredContent).toEqual({ foo: 1 })
    })
})

describe("reviewRequestHandler", () => {
    let store
    beforeEach(() => {
        store = makeStore()
    })
    afterEach(() => cleanup(store))

    test("invokes handleReview with trigger:mcp_tool and shapes a CallToolResult", async () => {
        const out = await reviewRequestHandler({
            args: { cwd: "/repo" },
            ctx: {
                config: minimalConfig(),
                store,
                deps: happyDeps(),
            },
        })
        expect(out.content).toHaveLength(2)
        expect(out.structuredContent.status).toBe("GOOD_TO_GO")
        expect(out.content[0].text).toMatch(/Status: GOOD_TO_GO/)
    })

    test("uses mcp_tool trigger so blockCount budget is NOT consumed", async () => {
        const out = await reviewRequestHandler({
            args: { cwd: "/repo" },
            ctx: {
                config: minimalConfig(),
                store,
                deps: {
                    ...happyDeps(),
                    runAndParse: async () => ({
                        status: "ISSUES",
                        findings: [
                            {
                                file: "a.js",
                                line: 1,
                                severity: "blocker",
                                category: "bug",
                                message: "x",
                            },
                        ],
                        raw: {
                            durationMs: 1,
                            exitCode: 0,
                            timedOut: false,
                        },
                    }),
                },
            },
        })
        // ISSUES via mcp_tool: state codexRounds increments, blockCount does not.
        expect(out.structuredContent.state.codexRounds).toBe(1)
        expect(out.structuredContent.state.blockCount).toBe(0)
    })

    test("passes extra_instructions through to handleReview", async () => {
        let receivedPrompt = ""
        await reviewRequestHandler({
            args: {
                cwd: "/repo",
                extra_instructions: "Pay attention to auth.",
            },
            ctx: {
                config: minimalConfig(),
                store,
                deps: {
                    ...happyDeps(),
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
                },
            },
        })
        expect(receivedPrompt).toContain("Pay attention to auth.")
    })

    test("returns a CallToolResult (no exception) when cwd is missing", async () => {
        const out = await reviewRequestHandler({
            args: {},
            ctx: {
                config: minimalConfig(),
                store,
                deps: happyDeps(),
            },
        })
        expect(out.structuredContent.status).toBe("ESCALATE")
        expect(out.structuredContent.code).toBe("INVALID_REQUEST")
    })

    test("force=true bypasses the unchanged-baseline NO_CHANGES short-circuit (v0.1.18)", async () => {
        // Seed a cached GOOD_TO_GO baseline that matches the payload
        // progressHash; a non-forced call would short-circuit NO_CHANGES.
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
        })
        const runSpy = jest.fn(async () => ({
            status: "GOOD_TO_GO",
            findings: [],
            raw: { durationMs: 1, exitCode: 0, timedOut: false },
        }))
        const out = await reviewRequestHandler({
            args: { cwd: "/repo", force: true },
            ctx: {
                config: minimalConfig(),
                store,
                deps: { ...happyDeps(), runAndParse: runSpy },
            },
        })
        expect(out.structuredContent.status).toBe("GOOD_TO_GO")
        expect(runSpy).toHaveBeenCalledTimes(1)
    })

    test("provider override is threaded through to pickReviewer (v0.1.18)", async () => {
        const pickSpy = jest.fn(() => ({
            name: "gemini",
            runAndParse: async () => ({
                status: "GOOD_TO_GO",
                findings: [],
                raw: { durationMs: 1, exitCode: 0, timedOut: false },
            }),
            buildArgs: () => [],
            binary: "gemini",
        }))
        await reviewRequestHandler({
            args: { cwd: "/repo", provider: "gemini" },
            ctx: {
                config: minimalConfig(),
                store,
                deps: { ...happyDeps(), pickReviewer: pickSpy },
            },
        })
        expect(pickSpy).toHaveBeenCalledTimes(1)
        expect(pickSpy.mock.calls[0][1]).toBe("gemini")
    })
})

describe("REQUEST_REVIEW_TOOL", () => {
    test("names the tool and carries its input schema", () => {
        expect(REQUEST_REVIEW_TOOL).toMatchObject({
            name: "request_review",
            title: "Run a code review",
            inputSchema: REQUEST_REVIEW_INPUT_SHAPE,
        })
        expect(REQUEST_REVIEW_TOOL.description).toMatch(/GOOD_TO_GO/)
        expect(Object.isFrozen(REQUEST_REVIEW_TOOL)).toBe(true)
    })

    test("the core's output schema reaches the reviewer adapter", async () => {
        const store = makeStore()
        try {
            const schema = { marker: true }
            const runAndParse = jest.fn(happyDeps().runAndParse)
            await reviewRequestHandler({
                args: { cwd: "/repo" },
                ctx: {
                    config: minimalConfig(),
                    store,
                    deps: { ...happyDeps(), runAndParse },
                    schema,
                },
            })
            expect(runAndParse.mock.calls[0][0].schema).toBe(schema)
        } finally {
            cleanup(store)
        }
    })
})

describe("input schemas", () => {
    test("REQUEST_REVIEW_INPUT_SHAPE requires cwd as a non-empty string", () => {
        const schema = REQUEST_REVIEW_INPUT_SHAPE
        expect(schema.cwd.safeParse("/repo").success).toBe(true)
        expect(schema.cwd.safeParse("").success).toBe(false)
        expect(schema.cwd.safeParse(undefined).success).toBe(false)
    })

    test("REQUEST_REVIEW_INPUT_SHAPE accepts optional fields", () => {
        expect(
            REQUEST_REVIEW_INPUT_SHAPE.scope.safeParse(undefined).success
        ).toBe(true)
        expect(
            REQUEST_REVIEW_INPUT_SHAPE.scope.safeParse("uncommitted").success
        ).toBe(true)
        expect(
            REQUEST_REVIEW_INPUT_SHAPE.scope.safeParse("other").success
        ).toBe(false)
        expect(
            REQUEST_REVIEW_INPUT_SHAPE.extra_instructions.safeParse("hi")
                .success
        ).toBe(true)
    })
})

describe("repoInClientRoots — edge cases", () => {
    test("ignores roots with malformed file URIs", () => {
        // `file://` with no path, missing host info: fileURLToPath would
        // throw; we tolerate and treat as a non-match.
        const tmp = mkdtempSync(path.join(tmpdir(), "roots-"))
        try {
            expect(
                repoInClientRoots(realpathSync(tmp), [
                    { uri: "file://" },
                    { uri: "" },
                    { uri: null },
                ])
            ).toBe(false)
        } finally {
            rmSync(tmp, { recursive: true, force: true })
        }
    })

    test("accepts bare absolute path root URIs", () => {
        const tmp = mkdtempSync(path.join(tmpdir(), "roots-"))
        const tmpReal = realpathSync(tmp)
        try {
            expect(repoInClientRoots(tmpReal, [{ uri: tmpReal }])).toBe(true)
        } finally {
            rmSync(tmp, { recursive: true, force: true })
        }
    })

    test("ignores roots whose realpath fails (non-existent path)", () => {
        expect(
            repoInClientRoots("/repo", [
                { uri: "file:///definitely/does/not/exist" },
            ])
        ).toBe(false)
    })
})

describe("repoInClientRoots", () => {
    test("returns false when roots is null or non-array", () => {
        expect(repoInClientRoots("/repo", null)).toBe(false)
        expect(repoInClientRoots("/repo", undefined)).toBe(false)
        expect(repoInClientRoots("/repo", "nope")).toBe(false)
    })

    test("returns false when roots is empty (advertised but nothing allowed)", () => {
        expect(repoInClientRoots("/repo", [])).toBe(false)
    })

    test("accepts repo inside an advertised root (file:// URI)", () => {
        // We use the test's own tmpdir so realpath resolves. On macOS,
        // /var/folders is a symlink to /private/var/folders — repoInClientRoots
        // expects an already-realpath'd repoRoot per its contract (matches
        // how resolveContext produces its repoRoot value), so we realpath
        // here before passing in.
        const tmp = mkdtempSync(path.join(tmpdir(), "roots-"))
        const tmpReal = realpathSync(tmp)
        try {
            const sub = path.join(tmpReal, "sub")
            mkdirSync(sub)
            expect(repoInClientRoots(sub, [{ uri: `file://${tmp}` }])).toBe(
                true
            )
        } finally {
            rmSync(tmp, { recursive: true, force: true })
        }
    })

    test("rejects repo outside every advertised root", () => {
        const tmp = mkdtempSync(path.join(tmpdir(), "roots-"))
        try {
            // tmp is the only advertised root; /etc is clearly outside.
            expect(repoInClientRoots("/etc", [{ uri: `file://${tmp}` }])).toBe(
                false
            )
        } finally {
            rmSync(tmp, { recursive: true, force: true })
        }
    })

    test("ignores non-file:// URIs", () => {
        expect(
            repoInClientRoots("/repo", [{ uri: "https://example.com/repo" }])
        ).toBe(false)
    })
})

describe("maybeListClientRoots edge cases (via reviewRequestHandler)", () => {
    let store
    beforeEach(() => {
        store = makeStore()
    })
    afterEach(() => cleanup(store))

    test("mcpServer with no `server` low-level falls back to allowedRoots-only", async () => {
        const out = await reviewRequestHandler({
            args: { cwd: "/repo" },
            ctx: {
                config: minimalConfig(),
                store,
                deps: happyDeps(),
                mcpServer: {
                    /* no `.server` */
                },
            },
        })
        expect(out.structuredContent.status).toBe("GOOD_TO_GO")
    })

    test("when listRoots returns a non-array, treats it as empty → ESCALATE NOT_IN_CLIENT_ROOT", async () => {
        const mcpServer = {
            server: {
                getClientCapabilities: () => ({ roots: {} }),
                listRoots: async () => ({ roots: "garbage" }),
            },
        }
        const out = await reviewRequestHandler({
            args: { cwd: "/repo" },
            ctx: {
                config: minimalConfig(),
                store,
                deps: happyDeps(),
                mcpServer,
            },
        })
        expect(out.structuredContent.status).toBe("ESCALATE")
        expect(out.structuredContent.code).toBe("NOT_IN_CLIENT_ROOT")
    })
})

describe("reviewRequestHandler — MCP roots check", () => {
    let store
    beforeEach(() => {
        store = makeStore()
    })
    afterEach(() => cleanup(store))

    const mockMcpServerWithRoots = (rootsArray) => ({
        server: {
            getClientCapabilities: () => ({ roots: {} }),
            listRoots: async () => ({ roots: rootsArray }),
        },
    })

    test("when client advertises roots, repos outside them get ESCALATE NOT_IN_CLIENT_ROOT", async () => {
        const out = await reviewRequestHandler({
            args: { cwd: "/repo" },
            ctx: {
                config: minimalConfig(),
                store,
                deps: happyDeps(),
                mcpServer: mockMcpServerWithRoots([
                    // No roots that contain /repo.
                    { uri: "file:///somewhere/else" },
                ]),
            },
        })
        expect(out.structuredContent.status).toBe("ESCALATE")
        expect(out.structuredContent.code).toBe("NOT_IN_CLIENT_ROOT")
    })

    test("when listRoots throws, handler FAILS CLOSED with ESCALATE ROOTS_FETCH_FAILED", async () => {
        const mcpServer = {
            server: {
                getClientCapabilities: () => ({ roots: {} }),
                listRoots: async () => {
                    throw new Error("not supported")
                },
            },
        }
        const logger = { warn: jest.fn(), error: jest.fn() }
        const out = await reviewRequestHandler({
            args: { cwd: "/repo" },
            ctx: {
                config: minimalConfig(),
                store,
                deps: happyDeps(),
                logger,
                mcpServer,
            },
        })
        expect(out.structuredContent.status).toBe("ESCALATE")
        expect(out.structuredContent.code).toBe("ROOTS_FETCH_FAILED")
        expect(out.structuredContent.reason).toMatch(/not supported/)
        expect(logger.warn).toHaveBeenCalled()
    })

    test("the roots probe rides the tool call's own stream, with a bounded timeout", async () => {
        const listRoots = jest.fn(async () => ({ roots: [] }))
        const mcpServer = {
            server: { getClientCapabilities: () => ({ roots: {} }), listRoots },
        }
        await reviewRequestHandler({
            args: { cwd: "/repo" },
            ctx: {
                config: minimalConfig(),
                store,
                deps: happyDeps(),
                mcpServer,
            },
            requestId: 42,
        })
        expect(listRoots).toHaveBeenCalledTimes(1)
        expect(listRoots.mock.calls[0][1]).toEqual({
            relatedRequestId: 42,
            timeout: ROOTS_PROBE_TIMEOUT_MS,
        })
    })

    test("when client doesn't advertise roots capability, no listRoots call is made", async () => {
        const listRoots = jest.fn()
        const mcpServer = {
            server: {
                getClientCapabilities: () => ({}),
                listRoots,
            },
        }
        await reviewRequestHandler({
            args: { cwd: "/repo" },
            ctx: {
                config: minimalConfig(),
                store,
                deps: happyDeps(),
                mcpServer,
            },
        })
        expect(listRoots).not.toHaveBeenCalled()
    })
})
