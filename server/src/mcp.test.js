/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { jest } from "@jest/globals"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
    reviewRequestHandler,
    resetRequestHandler,
    buildMcpServer,
    repoInClientRoots,
    REQUEST_REVIEW_INPUT_SHAPE,
    RESET_REVIEW_CONTEXT_INPUT_SHAPE,
    __test__,
} from "./mcp.js"
import { createStateStore } from "./state.js"

const { summarizeReview, summarizeReset, asContent } = __test__

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

    test("summarizeReset reports success / context", () => {
        expect(
            summarizeReset({
                ok: true,
                context: { repo: "foo", branch: "main" },
            })
        ).toMatch(/Reset OK[\s\S]+foo:main/)
    })

    test("summarizeReset reports failure with reason", () => {
        expect(summarizeReset({ ok: false, reason: "nope" })).toMatch(
            /Reset failed: nope/
        )
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
})

describe("resetRequestHandler", () => {
    let store
    beforeEach(() => {
        store = makeStore()
    })
    afterEach(() => cleanup(store))

    test("clears state and returns a CallToolResult", async () => {
        store.save(happyContext.key, {
            ...happyContext,
            codexRounds: 3,
            blockCount: 2,
            lastReviewedAt: 1,
        })
        const out = await resetRequestHandler({
            args: { cwd: "/repo" },
            ctx: {
                config: minimalConfig(),
                store,
                deps: { resolveContext: () => happyContext },
            },
        })
        expect(out.structuredContent.ok).toBe(true)
        const fresh = store.get(happyContext)
        expect(fresh.codexRounds).toBe(0)
    })

    test("surfaces ESCALATE when cwd missing", async () => {
        const out = await resetRequestHandler({
            args: {},
            ctx: {
                config: minimalConfig(),
                store,
                deps: { resolveContext: () => happyContext },
            },
        })
        expect(out.structuredContent.status).toBe("ESCALATE")
        expect(out.structuredContent.code).toBe("INVALID_REQUEST")
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

    test("RESET_REVIEW_CONTEXT_INPUT_SHAPE requires cwd", () => {
        expect(
            RESET_REVIEW_CONTEXT_INPUT_SHAPE.cwd.safeParse("/repo").success
        ).toBe(true)
        expect(RESET_REVIEW_CONTEXT_INPUT_SHAPE.cwd.safeParse("").success).toBe(
            false
        )
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
            expect(
                repoInClientRoots(tmpReal, [{ uri: tmpReal }])
            ).toBe(true)
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
    test("returns true when roots is null/empty (no check)", () => {
        expect(repoInClientRoots("/repo", null)).toBe(true)
        expect(repoInClientRoots("/repo", [])).toBe(true)
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
                mcpServer: { /* no `.server` */ },
            },
        })
        expect(out.structuredContent.status).toBe("GOOD_TO_GO")
    })

    test("when listRoots returns a non-array, fall back to allowedRoots-only", async () => {
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
        expect(out.structuredContent.status).toBe("GOOD_TO_GO")
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

    test("when listRoots throws, handler falls back to allowedRoots-only and the call succeeds", async () => {
        const mcpServer = {
            server: {
                getClientCapabilities: () => ({ roots: {} }),
                listRoots: async () => {
                    throw new Error("not supported")
                },
            },
        }
        const out = await reviewRequestHandler({
            args: { cwd: "/repo" },
            ctx: {
                config: minimalConfig(),
                store,
                deps: happyDeps(),
                logger: { warn: jest.fn() },
                mcpServer,
            },
        })
        expect(out.structuredContent.status).toBe("GOOD_TO_GO")
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

    test("resetRequestHandler also honors client roots", async () => {
        const out = await resetRequestHandler({
            args: { cwd: "/repo" },
            ctx: {
                config: minimalConfig(),
                store,
                deps: { resolveContext: () => happyContext },
                mcpServer: {
                    server: {
                        getClientCapabilities: () => ({ roots: {} }),
                        listRoots: async () => ({
                            roots: [{ uri: "file:///somewhere/else" }],
                        }),
                    },
                },
            },
        })
        expect(out.structuredContent.status).toBe("ESCALATE")
        expect(out.structuredContent.code).toBe("NOT_IN_CLIENT_ROOT")
    })
})

describe("buildMcpServer", () => {
    let store
    beforeEach(() => {
        store = makeStore()
    })
    afterEach(() => cleanup(store))

    test("registers exactly the two v1 tools and they round-trip via the server's tools/list", async () => {
        const server = buildMcpServer({
            config: minimalConfig(),
            store,
            deps: happyDeps(),
        })
        // McpServer keeps tools in an internal map; we sanity-check that
        // `server.server` exposes the low-level API and that connecting a
        // pair of in-memory transports yields the two tools via tools/list.
        const { InMemoryTransport } =
            await import("@modelcontextprotocol/sdk/inMemory.js")
        const { Client } =
            await import("@modelcontextprotocol/sdk/client/index.js")
        const [clientT, serverT] = InMemoryTransport.createLinkedPair()
        await server.connect(serverT)
        const client = new Client(
            { name: "test", version: "0.0.0" },
            { capabilities: {} }
        )
        await client.connect(clientT)
        const list = await client.listTools()
        const names = list.tools.map((t) => t.name).sort()
        expect(names).toEqual(["request_review", "reset_review_context"])
        await client.close()
        await server.close()
    })

    test("tools/call → request_review wires through to handleReview", async () => {
        const server = buildMcpServer({
            config: minimalConfig(),
            store,
            deps: happyDeps(),
        })
        const { InMemoryTransport } =
            await import("@modelcontextprotocol/sdk/inMemory.js")
        const { Client } =
            await import("@modelcontextprotocol/sdk/client/index.js")
        const [clientT, serverT] = InMemoryTransport.createLinkedPair()
        await server.connect(serverT)
        const client = new Client(
            { name: "test", version: "0.0.0" },
            { capabilities: {} }
        )
        await client.connect(clientT)
        const r = await client.callTool({
            name: "request_review",
            arguments: { cwd: "/repo" },
        })
        expect(r.isError).toBeFalsy()
        expect(r.structuredContent.status).toBe("GOOD_TO_GO")
        await client.close()
        await server.close()
    })
})
