/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { jest } from "@jest/globals"
import {
    createResetHandler,
    handleDashboardReset,
    handleReset,
    RESET_REVIEW_CONTEXT_INPUT_SHAPE,
    RESET_REVIEW_CONTEXT_TOOL,
    resetRequestHandler,
    __test__,
} from "./reset.js"
import { ContextError } from "./review/context.js"
import { createStateStore } from "../state.js"
import { ROOTS_PROBE_TIMEOUT_MS } from "./review/mcp.js"

const { summarizeReset } = __test__

const minimalConfig = () => ({
    allowedRoots: ["/repo"],
})

const happyContext = {
    repo: "repo",
    repoRoot: "/repo",
    branch: "main",
    key: "/repo|main",
}

const makeStore = () => {
    const dir = mkdtempSync(path.join(tmpdir(), "reset-store-"))
    const store = createStateStore({
        filePath: path.join(dir, "state.json"),
        now: () => 0,
    })
    store.__dir = dir
    return store
}

const cleanup = (store) => rmSync(store.__dir, { recursive: true, force: true })

describe("handleReset", () => {
    let store
    beforeEach(() => {
        store = makeStore()
    })
    afterEach(() => cleanup(store))

    test("returns 400 when cwd missing", async () => {
        const r = await handleReset({
            body: {},
            config: minimalConfig(),
            store,
            deps: { resolveContext: () => happyContext },
        })
        expect(r.httpStatus).toBe(400)
        expect(r.body.code).toBe("INVALID_REQUEST")
    })

    test("returns 403 on NOT_IN_ALLOWED_ROOT", async () => {
        const r = await handleReset({
            body: { cwd: "/repo" },
            config: minimalConfig(),
            store,
            deps: {
                resolveContext: () => {
                    throw new ContextError("NOT_IN_ALLOWED_ROOT", "nope")
                },
            },
        })
        expect(r.httpStatus).toBe(403)
        expect(r.body.code).toBe("NOT_IN_ALLOWED_ROOT")
    })

    test("returns 400 on NOT_A_GIT_REPO", async () => {
        const r = await handleReset({
            body: { cwd: "/repo" },
            config: minimalConfig(),
            store,
            deps: {
                resolveContext: () => {
                    throw new ContextError("NOT_A_GIT_REPO", "not git")
                },
            },
        })
        expect(r.httpStatus).toBe(400)
        expect(r.body.code).toBe("NOT_A_GIT_REPO")
    })

    test("falls back to INTERNAL_ERROR when resolveContext throws a non-ContextError", async () => {
        const r = await handleReset({
            body: { cwd: "/repo" },
            config: minimalConfig(),
            store,
            deps: {
                resolveContext: () => {
                    throw new Error("disk read failure")
                },
            },
        })
        expect(r.httpStatus).toBe(400)
        expect(r.body.code).toBe("INTERNAL_ERROR")
        expect(r.body.reason).toMatch(/disk read failure/)
    })

    test("clears counters/baseline/priorFindings for the resolved context", async () => {
        // Seed.
        store.save(happyContext.key, {
            ...happyContext,
            codexRounds: 3,
            blockCount: 2,
            lastBaseline: { progressHash: "g" },
            priorFindings: [{ file: "a.js" }],
            lastReviewedAt: 1,
            lastResultStatus: "ISSUES",
        })
        const r = await handleReset({
            body: { cwd: "/repo" },
            config: minimalConfig(),
            store,
            deps: { resolveContext: () => happyContext },
        })
        expect(r.httpStatus).toBe(200)
        expect(r.body.ok).toBe(true)
        expect(r.body.state.codexRounds).toBe(0)
        expect(r.body.state.blockCount).toBe(0)
        expect(r.body.state.lastResultStatus).toBeNull()
        // And the store really is fresh.
        const fresh = store.get(happyContext)
        expect(fresh.codexRounds).toBe(0)
        expect(fresh.priorFindings).toEqual([])
    })
})

describe("handleReset — git capability", () => {
    let store
    beforeEach(() => {
        store = makeStore()
    })
    afterEach(() => cleanup(store))

    test("a git timeout is a transient 503 GIT_TIMEOUT", async () => {
        const r = await handleReset({
            body: { cwd: "/repo" },
            config: minimalConfig(),
            store,
            deps: {
                resolveContext: async () => {
                    throw Object.assign(new Error("git timed out"), {
                        code: "GIT_TIMEOUT",
                    })
                },
            },
        })
        expect(r.httpStatus).toBe(503)
        expect(r.body.code).toBe("GIT_TIMEOUT")
    })

    test("passes the shell's git through to resolveContext", async () => {
        const git = async () => ""
        let seen
        await handleReset({
            body: { cwd: "/repo" },
            config: minimalConfig(),
            store,
            deps: {
                git,
                resolveContext: async (args) => {
                    seen = args.git
                    return happyContext
                },
            },
        })
        expect(seen).toBe(git)
    })
})

const mkRes = () => {
    const res = { statusCode: 0, body: null }
    res.status = (c) => {
        res.statusCode = c
        return res
    }
    res.json = (b) => {
        res.body = b
        return res
    }
    return res
}

describe("createResetHandler", () => {
    let store
    beforeEach(() => {
        store = makeStore()
    })
    afterEach(() => cleanup(store))

    test("reads its options per request and replies with the result", async () => {
        const handler = createResetHandler(() => ({
            config: minimalConfig(),
            store,
            deps: { resolveContext: () => happyContext },
        }))
        const res = mkRes()
        await handler({ body: { cwd: "/repo" } }, res)
        expect(res.statusCode).toBe(200)
        expect(res.body.ok).toBe(true)
    })
})

describe("handleDashboardReset", () => {
    let store
    beforeEach(() => {
        store = makeStore()
    })
    afterEach(() => cleanup(store))

    test("400 without a contextKey, 404 for an unknown one", () => {
        expect(handleDashboardReset({ body: {}, store }).httpStatus).toBe(400)
        expect(
            handleDashboardReset({ body: { contextKey: "nope" }, store })
                .httpStatus
        ).toBe(404)
    })

    test("resets a known context by its store key", () => {
        store.save(happyContext.key, { ...happyContext, codexRounds: 4 })
        const r = handleDashboardReset({
            body: { contextKey: happyContext.key },
            store,
        })
        expect(r.httpStatus).toBe(200)
        expect(r.body.context).toMatchObject({
            repoRoot: "/repo",
            branch: "main",
        })
        expect(r.body.state.codexRounds).toBe(0)
        expect(store.get(happyContext).codexRounds).toBe(0)
    })
})

describe("reset_review_context MCP tool", () => {
    let store
    beforeEach(() => {
        store = makeStore()
    })
    afterEach(() => cleanup(store))

    test("the tool definition names the tool and its input schema", () => {
        expect(RESET_REVIEW_CONTEXT_TOOL).toMatchObject({
            name: "reset_review_context",
            inputSchema: RESET_REVIEW_CONTEXT_INPUT_SHAPE,
        })
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

    test("RESET_REVIEW_CONTEXT_INPUT_SHAPE requires cwd", () => {
        expect(
            RESET_REVIEW_CONTEXT_INPUT_SHAPE.cwd.safeParse("/repo").success
        ).toBe(true)
        expect(RESET_REVIEW_CONTEXT_INPUT_SHAPE.cwd.safeParse("").success).toBe(
            false
        )
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

    test("the roots probe rides the tool call's own stream", async () => {
        const listRoots = jest.fn(async () => ({ roots: [] }))
        await resetRequestHandler({
            args: { cwd: "/repo" },
            ctx: {
                config: minimalConfig(),
                store,
                deps: { resolveContext: () => happyContext },
                mcpServer: {
                    server: {
                        getClientCapabilities: () => ({ roots: {} }),
                        listRoots,
                    },
                },
            },
            requestId: 7,
        })
        expect(listRoots.mock.calls[0][1]).toEqual({
            relatedRequestId: 7,
            timeout: ROOTS_PROBE_TIMEOUT_MS,
        })
    })
})
