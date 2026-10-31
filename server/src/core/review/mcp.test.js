/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { jest } from "@jest/globals"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
    asContent,
    reviewRequestHandler,
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

describe("reviewRequestHandler — linking the reviewed folder to the session's repo", () => {
    let store
    beforeEach(() => {
        store = makeStore()
    })
    afterEach(() => cleanup(store))

    const session = {
        repo: "app",
        repoRoot: "/work/app",
        branch: "main",
        key: "/work/app|main",
    }
    const other = {
        repo: "infra",
        repoRoot: "/work/tmp/infra-wt",
        branch: "feat",
        key: "/work/tmp/infra-wt|feat",
    }
    const contexts = { "/work/app": session, "/work/tmp/infra-wt": other }
    const deps = () => ({
        ...happyDeps(),
        currentHeadSha: async () => "abc1234",
        isWorkingTreeClean: async () => false,
        resolveContext: ({ cwd }) => {
            const c = contexts[cwd]
            if (!c) {
                throw Object.assign(new Error(`not a repo: ${cwd}`), {
                    code: "NOT_A_GIT_REPO",
                })
            }
            return c
        },
    })
    const withRoots = (roots) => ({
        server: {
            getClientCapabilities: () => ({ roots: {} }),
            listRoots: jest.fn(async () => ({ roots })),
        },
    })
    const review = (cwd, mcpServer, extra = {}) =>
        reviewRequestHandler({
            args: { cwd },
            ctx: {
                config: minimalConfig(),
                store,
                deps: deps(),
                mcpServer,
                ...extra,
            },
            requestId: 42,
        })
    const linksOfSession = () =>
        Object.keys(store.peek(session.key)?.linkedContexts ?? {})

    test("a folder outside the client's roots is reviewed, and linked to the session's repo", async () => {
        const out = await review(
            "/work/tmp/infra-wt",
            withRoots([{ uri: "file:///work/app" }])
        )
        expect(out.structuredContent.status).toBe("GOOD_TO_GO")
        expect(linksOfSession()).toEqual([other.key])
    })

    test("the session's own repo links nothing", async () => {
        await review("/work/app", withRoots([{ uri: "file:///work/app" }]))
        expect(linksOfSession()).toEqual([])
    })

    test("roots that can't name the session (empty, malformed, not a repo, probe failure) link nothing and never block", async () => {
        for (const roots of [
            [],
            "not-an-array",
            [{ uri: "file:///" }, { uri: "https://x" }, { uri: "" }],
            [{ uri: "file:///nowhere" }],
        ]) {
            const out = await review("/work/tmp/infra-wt", withRoots(roots))
            expect(["GOOD_TO_GO", "NO_CHANGES"]).toContain(
                out.structuredContent.status
            )
        }
        const warn = jest.fn()
        const failing = {
            server: {
                getClientCapabilities: () => ({ roots: {} }),
                listRoots: async () => {
                    throw new Error("not supported")
                },
            },
        }
        const out = await review("/work/tmp/infra-wt", failing, {
            logger: { warn, info() {}, error() {} },
        })
        expect(["GOOD_TO_GO", "NO_CHANGES"]).toContain(
            out.structuredContent.status
        )
        expect(warn).toHaveBeenCalled()
        expect(linksOfSession()).toEqual([])
    })

    test("a bare absolute path root works like a file:// one", async () => {
        await review("/work/tmp/infra-wt", withRoots([{ uri: "/work/app" }]))
        expect(linksOfSession()).toEqual([other.key])
    })

    test("a folder that isn't a repo links nothing; the review reports it", async () => {
        const out = await review(
            "/work/tmp/nope",
            withRoots([{ uri: "file:///work/app" }])
        )
        expect(out.structuredContent.status).toBe("ESCALATE")
        expect(linksOfSession()).toEqual([])
    })

    test("the roots probe rides the tool call's own stream, with a bounded timeout", async () => {
        const mcpServer = withRoots([])
        await review("/work/app", mcpServer)
        expect(mcpServer.server.listRoots).toHaveBeenCalledTimes(1)
        expect(mcpServer.server.listRoots.mock.calls[0][1]).toEqual({
            relatedRequestId: 42,
            timeout: ROOTS_PROBE_TIMEOUT_MS,
        })
    })

    test("a client without the roots capability isn't asked, and its reviews run", async () => {
        const listRoots = jest.fn()
        const out = await review("/work/tmp/infra-wt", {
            server: { getClientCapabilities: () => ({}), listRoots },
        })
        expect(listRoots).not.toHaveBeenCalled()
        expect(["GOOD_TO_GO", "NO_CHANGES"]).toContain(
            out.structuredContent.status
        )
        const noServer = await review("/work/tmp/infra-wt", null)
        expect(["GOOD_TO_GO", "NO_CHANGES"]).toContain(
            noServer.structuredContent.status
        )
        const noLowLevel = await review("/work/tmp/infra-wt", {})
        expect(["GOOD_TO_GO", "NO_CHANGES"]).toContain(
            noLowLevel.structuredContent.status
        )
    })
})
