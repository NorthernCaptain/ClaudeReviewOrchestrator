/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

// Shell half of MCP: the HTTP transport and the session map. Tool
// behaviour is the core's (core/review/mcp.js, core/reset.js); each
// session registers the current core's tool definitions and every call
// runs on the core current at that moment.

import { randomUUID } from "node:crypto"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js"
import { MCP_TOOL_METHODS } from "./core-loader.js"
import { VERSION } from "./version.js"

/**
 * Build (but do not connect) an McpServer with the core's tools
 * registered. A tool's name, description and input schema are fixed for
 * the session's life (changing them needs a client reconnect); its
 * behaviour follows the current core. `cores` is the reload controller:
 * request_review is admitted (counted and pinned to a core and a frozen
 * config) before anything else; reset_review_context pins its core.
 */
export const buildMcpServer = ({ cores }) => {
    const server = new McpServer(
        { name: "review-orchestrator", version: VERSION },
        { capabilities: { tools: {} } }
    )
    for (const def of cores.currentCore().mcp.toolDefs) {
        const method = MCP_TOOL_METHODS[def.name]
        const admit =
            def.name === "request_review"
                ? () => cores.admitReview()
                : () => cores.pin()
        server.registerTool(
            def.name,
            {
                title: def.title,
                description: def.description,
                inputSchema: def.inputSchema,
            },
            // The handler gets THIS session's server, so the roots check
            // asks this client (and on this call's own stream).
            async (args, extra) => {
                const ticket = await admit()
                try {
                    return await ticket.core.mcp[method]({
                        args,
                        requestId: extra?.requestId,
                        mcpServer: server,
                        request: { config: ticket.config },
                    })
                } finally {
                    ticket.release()
                }
            }
        )
    }
    return server
}

/**
 * Mount the MCP route on the given Express app — STATEFUL mode.
 *
 * Stateful is required (not just nicer) because the SDK's MCP `Server`
 * object only knows about the client's advertised capabilities (e.g.
 * `roots`) AFTER it has processed an `initialize` request from that
 * client. A fresh per-request server has empty capabilities on every
 * tools/call, which silently disables our roots-membership check. To
 * enforce it, the same server has to handle initialize through the
 * subsequent tool calls in the same logical session.
 *
 * The protocol carries this binding via the `Mcp-Session-Id` header.
 * On initialize, a new sessionId is minted and returned in the
 * response headers; the client echoes it on every subsequent request.
 * We keep an in-memory map of sessionId → { server, transport }.
 * Transport.onclose evicts the entry.
 *
 * GET /mcp and DELETE /mcp also route through the same map — clients
 * use GET to subscribe to server-initiated notifications and DELETE
 * to terminate the session explicitly.
 */
export const mountMcpRoute = (app, ctx) => {
    // sessionId → { server: McpServer, transport: StreamableHTTPServerTransport }
    const sessions = new Map()

    const replyBadRequest = (res, message) => {
        if (res.headersSent) return
        res.status(400).json({
            jsonrpc: "2.0",
            error: { code: -32000, message },
            id: null,
        })
    }

    const handle = async (req, res) => {
        const sessionId = req.headers["mcp-session-id"]
        let session = sessionId ? sessions.get(sessionId) : null

        if (!session) {
            // New session: only an initialize POST is allowed here.
            if (req.method !== "POST" || !isInitializeRequest(req.body)) {
                replyBadRequest(
                    res,
                    sessionId
                        ? "Unknown Mcp-Session-Id"
                        : "Mcp-Session-Id missing and request is not an initialize"
                )
                return
            }
            const server = buildMcpServer(ctx)
            const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                onsessioninitialized: (sid) => {
                    sessions.set(sid, { server, transport })
                },
            })
            transport.onclose = () => {
                const sid = transport.sessionId
                if (sid && sessions.has(sid)) sessions.delete(sid)
            }
            try {
                await server.connect(transport)
                await transport.handleRequest(req, res, req.body)
            } catch (err) {
                ctx.logger?.error?.(
                    {
                        err: err?.message ?? String(err),
                        stack: err?.stack,
                        method: req.method,
                    },
                    "MCP: transport handleRequest threw on initialize"
                )
                if (!res.headersSent) {
                    res.status(500).json({
                        jsonrpc: "2.0",
                        error: {
                            code: -32603,
                            message:
                                "internal MCP error: " +
                                (err?.message ?? "unknown"),
                        },
                        id: null,
                    })
                }
            }
            return
        }

        // Existing session — hand the request to its transport.
        try {
            await session.transport.handleRequest(req, res, req.body)
        } catch (err) {
            ctx.logger?.error?.(
                {
                    err: err?.message ?? String(err),
                    stack: err?.stack,
                    method: req.method,
                    sessionId,
                },
                "MCP: transport handleRequest threw"
            )
            if (!res.headersSent) {
                res.status(500).json({
                    jsonrpc: "2.0",
                    error: {
                        code: -32603,
                        message:
                            "internal MCP error: " +
                            (err?.message ?? "unknown"),
                    },
                    id: null,
                })
            }
        }
    }

    app.post("/mcp", handle)
    app.get("/mcp", handle)
    app.delete("/mcp", handle)

    // Closer for graceful shutdown. Walks every live session, calls
    // transport.close() (which the SDK uses to end SSE long-polls and
    // notify the client), and clears the map. Without this, GET /mcp
    // long-poll connections keep the HTTP server alive forever and
    // `server.close()` never resolves on SIGINT/SIGTERM.
    const closeAllSessions = async () => {
        const entries = Array.from(sessions.values())
        sessions.clear()
        await Promise.all(
            entries.map(async ({ transport, server }) => {
                try {
                    await transport?.close?.()
                } catch {
                    // ignore — best-effort
                }
                try {
                    await server?.close?.()
                } catch {
                    // ignore
                }
            })
        )
    }

    return { sessions, closeAllSessions }
}
