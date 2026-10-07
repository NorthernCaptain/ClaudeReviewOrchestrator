/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { jest } from "@jest/globals"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { z } from "zod"
import { buildMcpServer, mountMcpRoute } from "./mcp.js"

const reply = (tag) => ({
    content: [{ type: "text", text: tag }],
    structuredContent: { tag },
})

const fakeCore = (tag) => ({
    mcp: {
        toolDefs: [
            {
                name: "request_review",
                title: "Run",
                description: `review via ${tag}`,
                inputSchema: { cwd: z.string() },
            },
            {
                name: "reset_review_context",
                title: "Reset",
                description: `reset via ${tag}`,
                inputSchema: { cwd: z.string() },
            },
        ],
        requestReview: jest.fn(async () => reply(`review-${tag}`)),
        resetReviewContext: jest.fn(async () => reply(`reset-${tag}`)),
    },
})

const connect = async (server) => {
    const [clientT, serverT] = InMemoryTransport.createLinkedPair()
    await server.connect(serverT)
    const client = new Client(
        { name: "test", version: "0.0.0" },
        { capabilities: {} }
    )
    await client.connect(clientT)
    return client
}

describe("buildMcpServer", () => {
    test("registers the current core's tool definitions", async () => {
        const core = fakeCore("v1")
        const server = buildMcpServer({ currentCore: () => core })
        const client = await connect(server)
        const { tools } = await client.listTools()
        expect(tools.map((t) => [t.name, t.description]).sort()).toEqual([
            ["request_review", "review via v1"],
            ["reset_review_context", "reset via v1"],
        ])
        await client.close()
        await server.close()
    })

    test("every call runs on the core current at that moment, with this session's server", async () => {
        let current = fakeCore("v1")
        const first = current
        const server = buildMcpServer({ currentCore: () => current })
        const client = await connect(server)

        const a = await client.callTool({
            name: "request_review",
            arguments: { cwd: "/repo" },
        })
        current = fakeCore("v2")
        const b = await client.callTool({
            name: "request_review",
            arguments: { cwd: "/repo" },
        })
        const c = await client.callTool({
            name: "reset_review_context",
            arguments: { cwd: "/repo" },
        })

        expect(a.structuredContent.tag).toBe("review-v1")
        expect(b.structuredContent.tag).toBe("review-v2")
        expect(c.structuredContent.tag).toBe("reset-v2")
        const call = first.mcp.requestReview.mock.calls[0][0]
        expect(call.args).toEqual({ cwd: "/repo" })
        expect(call.mcpServer).toBe(server)
        expect(call.requestId).toBeDefined()
        // Names and descriptions were fixed when the session started.
        const { tools } = await client.listTools()
        expect(tools.find((t) => t.name === "request_review").description).toBe(
            "review via v1"
        )
        await client.close()
        await server.close()
    })
})

describe("mountMcpRoute", () => {
    const mount = () => {
        const routes = {}
        const app = {}
        for (const m of ["post", "get", "delete"]) {
            app[m] = (p, h) => {
                routes[`${m.toUpperCase()} ${p}`] = h
            }
        }
        const logger = { error: jest.fn() }
        const mcp = mountMcpRoute(app, {
            currentCore: () => fakeCore("v1"),
            logger,
        })
        return { routes, mcp, logger }
    }
    const mkRes = (headersSent = false) => {
        const res = { headersSent, statusCode: 0, body: null }
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

    test("mounts POST, GET and DELETE /mcp", () => {
        expect(Object.keys(mount().routes).sort()).toEqual([
            "DELETE /mcp",
            "GET /mcp",
            "POST /mcp",
        ])
    })

    test.each([
        [
            "POST",
            {},
            { jsonrpc: "2.0", method: "tools/list", id: 1 },
            /missing/,
        ],
        ["GET", {}, undefined, /missing/],
        ["POST", { "mcp-session-id": "nope" }, {}, /Unknown Mcp-Session-Id/],
    ])(
        "%s without a known session and no initialize is a 400",
        async (method, headers, body, message) => {
            const { routes } = mount()
            const res = mkRes()
            await routes[`${method} /mcp`]({ method, headers, body }, res)
            expect(res.statusCode).toBe(400)
            expect(res.body.error.message).toMatch(message)
        }
    )

    test("a transport that throws on an open session is a logged 500", async () => {
        const { routes, mcp, logger } = mount()
        mcp.sessions.set("s1", {
            transport: {
                handleRequest: async () => {
                    throw new Error("boom")
                },
            },
        })
        const res = mkRes()
        await routes["POST /mcp"](
            { method: "POST", headers: { "mcp-session-id": "s1" }, body: {} },
            res
        )
        expect(res.statusCode).toBe(500)
        expect(res.body.error.message).toMatch(/boom/)
        expect(logger.error).toHaveBeenCalled()
        const sent = mkRes(true)
        await routes["POST /mcp"](
            { method: "POST", headers: { "mcp-session-id": "s1" }, body: {} },
            sent
        )
        expect(sent.statusCode).toBe(0)
    })

    test("closeAllSessions closes every session, best effort, and empties the map", async () => {
        const { mcp } = mount()
        const ok = { close: jest.fn(async () => {}) }
        const bad = {
            close: jest.fn(async () => {
                throw new Error("x")
            }),
        }
        mcp.sessions.set("a", { transport: ok, server: bad })
        mcp.sessions.set("b", { transport: bad, server: ok })
        await mcp.closeAllSessions()
        expect(ok.close).toHaveBeenCalledTimes(2)
        expect(bad.close).toHaveBeenCalledTimes(2)
        expect(mcp.sessions.size).toBe(0)
    })
})
