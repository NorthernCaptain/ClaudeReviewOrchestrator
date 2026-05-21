/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { jest } from "@jest/globals"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { startServer } from "./index.js"
import { createStateStore } from "./state.js"

const minimalConfig = () => ({
    port: 0,
    bind: "127.0.0.1",
    authToken: "wire-secret",
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
        maxCodexOutputBytes: 1024 * 1024,
        maxPayloadBytes: 262144,
        maxFileBytes: 65536,
        maxFiles: 40,
    },
    ignorePaths: [],
    blockingSeverities: ["blocker", "major"],
    extraReviewerInstructions: null,
})

const happyDeps = () => ({
    resolveContext: () => ({
        repo: "repo",
        repoRoot: "/repo",
        branch: "main",
        key: "/repo|main",
    }),
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
        raw: { durationMs: 12, exitCode: 0, timedOut: false },
    }),
})

const makeStore = () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mcp-wire-"))
    const store = createStateStore({
        filePath: path.join(dir, "state.json"),
        now: () => 0,
    })
    store.__dir = dir
    return store
}

const silentLog = { info() {}, warn() {}, error() {} }

const startApp = async (opts = {}) => {
    const store = opts.store ?? makeStore()
    const config = opts.config ?? minimalConfig()
    const deps = opts.deps ?? happyDeps()
    const r = await startServer({
        config,
        store,
        deps,
        log: silentLog,
    })
    if (!r.ok) throw r.error
    return {
        url: `http://127.0.0.1:${r.address.port}/mcp`,
        close: () =>
            new Promise((res) => {
                r.server.close(() => {
                    if (!opts.store)
                        rmSync(store.__dir, {
                            recursive: true,
                            force: true,
                        })
                    res()
                })
            }),
        store,
    }
}

const connectClient = async (
    url,
    {
        authToken = "wire-secret",
        clientCapabilities = {},
        rootsHandler = null,
    } = {}
) => {
    const transport = new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { "x-review-token": authToken } },
    })
    const client = new Client(
        { name: "wire-test", version: "0.0.0" },
        { capabilities: clientCapabilities }
    )
    if (rootsHandler) {
        client.setRequestHandler(ListRootsRequestSchema, rootsHandler)
    }
    await client.connect(transport)
    return client
}

describe("/mcp HTTP wire — basic protocol", () => {
    test("initialize → tools/list returns both v1 tools", async () => {
        const { url, close } = await startApp()
        try {
            const client = await connectClient(url)
            const tools = await client.listTools()
            expect(tools.tools.map((t) => t.name).sort()).toEqual([
                "request_review",
                "reset_review_context",
            ])
            await client.close()
        } finally {
            await close()
        }
    })

    test("tools/call request_review wires through to handleReview and returns the envelope", async () => {
        const { url, close } = await startApp()
        try {
            const client = await connectClient(url)
            const r = await client.callTool({
                name: "request_review",
                arguments: { cwd: "/repo" },
            })
            expect(r.isError).toBeFalsy()
            expect(r.structuredContent.status).toBe("GOOD_TO_GO")
            await client.close()
        } finally {
            await close()
        }
    })

    test("missing X-Review-Token blocks connect (401)", async () => {
        const { url, close } = await startApp()
        try {
            // Connect with empty token; SDK surfaces this as an error.
            await expect(
                connectClient(url, { authToken: "wrong" })
            ).rejects.toThrow()
        } finally {
            await close()
        }
    })

    test("second tools/call on the same session works (proves session is persisted)", async () => {
        const { url, close } = await startApp()
        try {
            const client = await connectClient(url)
            const r1 = await client.callTool({
                name: "request_review",
                arguments: { cwd: "/repo" },
            })
            expect(r1.structuredContent.status).toBe("GOOD_TO_GO")
            const r2 = await client.callTool({
                name: "reset_review_context",
                arguments: { cwd: "/repo" },
            })
            expect(r2.structuredContent.ok).toBe(true)
            await client.close()
        } finally {
            await close()
        }
    })
})

describe("/mcp HTTP wire — MCP roots enforcement", () => {
    // With per-session stateful transports, capabilities advertised at
    // initialize survive across subsequent tools/call requests. These tests
    // exercise that wiring end-to-end.

    test("client advertising roots NOT containing cwd → ESCALATE NOT_IN_CLIENT_ROOT", async () => {
        const { url, close } = await startApp()
        try {
            const client = await connectClient(url, {
                clientCapabilities: { roots: {} },
                rootsHandler: async () => ({
                    roots: [{ uri: "file:///somewhere/else" }],
                }),
            })
            const r = await client.callTool({
                name: "request_review",
                arguments: { cwd: "/repo" },
            })
            expect(r.structuredContent.status).toBe("ESCALATE")
            expect(r.structuredContent.code).toBe("NOT_IN_CLIENT_ROOT")
            await client.close()
        } finally {
            await close()
        }
    })

    test("client advertising roots throwing on listRoots → ESCALATE ROOTS_FETCH_FAILED (fail closed)", async () => {
        const { url, close } = await startApp()
        try {
            const client = await connectClient(url, {
                clientCapabilities: { roots: {} },
                rootsHandler: async () => {
                    throw new Error("client refused to enumerate roots")
                },
            })
            const r = await client.callTool({
                name: "request_review",
                arguments: { cwd: "/repo" },
            })
            expect(r.structuredContent.status).toBe("ESCALATE")
            expect(r.structuredContent.code).toBe("ROOTS_FETCH_FAILED")
            expect(r.structuredContent.reason).toMatch(
                /client refused to enumerate roots/
            )
            await client.close()
        } finally {
            await close()
        }
    })

    test("client advertising roots returning an EMPTY list → ESCALATE NOT_IN_CLIENT_ROOT", async () => {
        const { url, close } = await startApp()
        try {
            const client = await connectClient(url, {
                clientCapabilities: { roots: {} },
                rootsHandler: async () => ({ roots: [] }),
            })
            const r = await client.callTool({
                name: "request_review",
                arguments: { cwd: "/repo" },
            })
            expect(r.structuredContent.status).toBe("ESCALATE")
            expect(r.structuredContent.code).toBe("NOT_IN_CLIENT_ROOT")
            await client.close()
        } finally {
            await close()
        }
    })

    test("client NOT advertising roots → request succeeds (no extra check)", async () => {
        const { url, close } = await startApp()
        try {
            // No `capabilities.roots`, no rootsHandler.
            const client = await connectClient(url)
            const r = await client.callTool({
                name: "request_review",
                arguments: { cwd: "/repo" },
            })
            expect(r.structuredContent.status).toBe("GOOD_TO_GO")
            await client.close()
        } finally {
            await close()
        }
    })
})

// Guard against the silent fallback regression: if mcp.js ever drops the
// roots probe inside the same session, this test will catch it because the
// configured rootsHandler IS called.
describe("/mcp HTTP wire — roots probe actually runs", () => {
    test("the server-side listRoots probe reaches the client at least once", async () => {
        const { url, close } = await startApp()
        try {
            const calls = jest.fn(async () => ({
                roots: [{ uri: "file:///nowhere" }],
            }))
            const client = await connectClient(url, {
                clientCapabilities: { roots: {} },
                rootsHandler: calls,
            })
            await client.callTool({
                name: "request_review",
                arguments: { cwd: "/repo" },
            })
            expect(calls).toHaveBeenCalled()
            await client.close()
        } finally {
            await close()
        }
    })
})
