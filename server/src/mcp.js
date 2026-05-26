/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { randomUUID } from "node:crypto"
import { realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"
import { handleReview } from "./review.js"
import { handleReset } from "./reset.js"
import { VERSION } from "./version.js"
import {
    resolveContext as defaultResolveContext,
    isContainedIn,
    ContextError,
} from "./context.js"

// Best-effort parse of an MCP root URI. MCP roots are file:// URIs per the
// spec; we tolerate bare paths too.
const rootUriToPath = (uri) => {
    if (typeof uri !== "string" || uri.length === 0) return null
    if (uri.startsWith("file://")) {
        try {
            const p = fileURLToPath(uri)
            // Reject filesystem-root URIs (`file://`, `file:///`) so an
            // empty/malformed advertised root cannot grant access to /.
            if (!p || p === "/" || p === "") return null
            return p
        } catch {
            return null
        }
    }
    // Bare absolute path. Same guard: never accept just "/".
    if (uri.startsWith("/") && uri.length > 1) return uri
    return null
}

const realpathOrNull = (p) => {
    try {
        return realpathSync(p)
    } catch {
        return null
    }
}

// True iff `repoRoot` (already realpath'd) lies inside at least one of the
// client-advertised roots. The caller is expected to invoke this ONLY when
// the client advertised a roots capability — in which case an empty
// `roots` array means "no roots are allowed" and we must reject.
// (Compare with the old contract where empty was treated as "skip"; the
// failure-mode split lives in the caller now via maybeListClientRoots.)
export const repoInClientRoots = (repoRoot, roots) => {
    if (!Array.isArray(roots)) return false
    if (roots.length === 0) return false
    for (const r of roots) {
        const p = rootUriToPath(r?.uri)
        if (p === null) continue
        const real = realpathOrNull(p)
        if (real === null) continue
        if (isContainedIn(real, repoRoot)) return true
    }
    return false
}

// Wraps a resolveContext implementation with an extra membership check
// against client-advertised MCP roots. If the resolved repoRoot escapes
// all of them, raises ContextError("NOT_IN_CLIENT_ROOT") which the review
// handler maps to a 403 ESCALATE.
const wrapResolveWithClientRoots = (resolveImpl, clientRoots) => (args) => {
    const ctx = resolveImpl(args)
    if (!repoInClientRoots(ctx.repoRoot, clientRoots)) {
        throw new ContextError(
            "NOT_IN_CLIENT_ROOT",
            `cwd resolves to ${ctx.repoRoot}, which is outside the MCP client's advertised roots`
        )
    }
    return ctx
}

// Three-way result for the roots probe. Failure modes are distinct so the
// caller can fail closed when the client claims a roots capability but the
// list cannot be retrieved.
//
//   { advertised: false }
//     The client never advertised a roots capability. Skip the check.
//
//   { advertised: true, roots: Root[] }
//     Roots successfully fetched. The handler MUST apply the membership
//     check; an empty array means "no roots allowed" → repo is rejected.
//
//   { advertised: true, error: string }
//     listRoots() threw. Fail CLOSED: the handler returns ESCALATE
//     ROOTS_FETCH_FAILED instead of silently relaxing back to
//     allowedRoots-only enforcement.
export const maybeListClientRoots = async (mcpServer, logger) => {
    if (!mcpServer) return { advertised: false }
    const lowLevel = mcpServer.server
    if (!lowLevel || typeof lowLevel.getClientCapabilities !== "function") {
        return { advertised: false }
    }
    const caps = lowLevel.getClientCapabilities()
    if (!caps?.roots) return { advertised: false }
    try {
        const result = await lowLevel.listRoots()
        const roots = Array.isArray(result?.roots) ? result.roots : []
        return { advertised: true, roots }
    } catch (err) {
        const message = err?.message ?? String(err)
        logger?.warn?.(
            { err: message },
            "MCP: client advertised roots capability but listRoots failed; failing closed"
        )
        return { advertised: true, error: message }
    }
}

// Tool input schemas. The MCP SDK accepts plain ZodRawShape objects (i.e. an
// object whose values are zod schemas) and will turn them into JSON Schema
// for the tools/list response itself.
export const REQUEST_REVIEW_INPUT_SHAPE = {
    cwd: z
        .string()
        .min(1)
        .describe(
            "Absolute path to the current working directory of the calling session. The server resolves it to a git repo root and validates it is inside config.allowedRoots."
        ),
    scope: z
        .enum(["uncommitted"])
        .optional()
        .describe(
            "Diff scope. Only 'uncommitted' is supported in v1 (git diff HEAD + untracked, non-ignored files). Defaults to 'uncommitted'."
        ),
    extra_instructions: z
        .string()
        .optional()
        .describe(
            "Optional caller-supplied reviewer guidance. Layered on top of any project-level extraReviewerInstructions."
        ),
    force: z
        .boolean()
        .optional()
        .describe(
            "When true, bypass cache short-circuits (NO_CHANGES, NO_PROGRESS_WITH_OPEN_ISSUES, CODEX_ERROR_CACHED, dirty-flag fast path) and safety caps (MAX_BLOCKS, MAX_CODEX_ROUNDS). Spawns a fresh reviewer run unconditionally. Counters still increment."
        ),
    provider: z
        .enum(["codex", "claude", "gemini"])
        .optional()
        .describe(
            "Optional per-request reviewer override. One of: codex, claude, gemini. Falls back to the server's configured provider when omitted. If the named binary or auth is missing, the call returns ESCALATE."
        ),
}

export const RESET_REVIEW_CONTEXT_INPUT_SHAPE = {
    cwd: z
        .string()
        .min(1)
        .describe(
            "Absolute path to the current working directory of the calling session. The server resolves it to a (repoRoot, branch) context and clears its counters, baseline, and prior findings."
        ),
}

const summarizeReview = (envelope) => {
    const findings = envelope.findings ?? []
    const blocking = envelope.blockingFindings ?? []
    const dropped = envelope.droppedFindings ?? []
    const state = envelope.state ?? {}
    const lines = [`Status: ${envelope.status}`]
    if (envelope.reason) lines.push(`Reason: ${envelope.reason}`)
    if (envelope.code) lines.push(`Code: ${envelope.code}`)
    lines.push(
        `Findings: ${findings.length} (blocking: ${blocking.length}, dropped: ${dropped.length})`
    )
    if (state.codexRounds != null || state.blockCount != null) {
        lines.push(
            `Counters: codexRounds=${state.codexRounds ?? "-"}, blockCount=${state.blockCount ?? "-"}`
        )
    }
    return lines.join("\n")
}

const summarizeReset = (body) => {
    const lines = [
        body.ok ? "Reset OK" : `Reset failed: ${body.reason ?? "unknown"}`,
    ]
    if (body.context?.repo) {
        lines.push(`Context: ${body.context.repo}:${body.context.branch}`)
    }
    return lines.join("\n")
}

const asContent = (summary, structured) => ({
    content: [
        { type: "text", text: summary },
        {
            type: "text",
            text: `\`\`\`json\n${JSON.stringify(structured, null, 2)}\n\`\`\``,
        },
    ],
    structuredContent: structured,
})

/**
 * Tool handler for `request_review`. Pure function over { args, ctx } where
 * ctx contains all server-side dependencies. Returns an MCP CallToolResult.
 */
// Returns either { ok: true, deps } with deps possibly wrapped, or
// { ok: false, body } where body is a ready-to-return escalate envelope.
const applyRootsPolicy = async ({ mcpServer, logger, deps }) => {
    const probe = await maybeListClientRoots(mcpServer, logger)
    if (!probe.advertised) {
        return { ok: true, deps }
    }
    if (probe.error) {
        return {
            ok: false,
            body: {
                status: "ESCALATE",
                findings: [],
                blockingFindings: [],
                droppedFindings: [],
                reason: `MCP roots/list failed: ${probe.error}`,
                code: "ROOTS_FETCH_FAILED",
            },
        }
    }
    const baseResolve = deps.resolveContext ?? defaultResolveContext
    return {
        ok: true,
        deps: {
            ...deps,
            resolveContext: wrapResolveWithClientRoots(
                baseResolve,
                probe.roots
            ),
        },
    }
}

export const reviewRequestHandler = async ({
    args,
    ctx: {
        config,
        store,
        archive,
        logger,
        deps = {},
        now,
        mcpServer,
        metrics = null,
    },
}) => {
    const policy = await applyRootsPolicy({ mcpServer, logger, deps })
    if (!policy.ok) {
        if (metrics) metrics.record(policy.body)
        return asContent(summarizeReview(policy.body), policy.body)
    }
    const result = await handleReview({
        body: {
            cwd: args?.cwd,
            trigger: "mcp_tool",
            extra_instructions: args?.extra_instructions,
            force: args?.force === true,
            provider:
                typeof args?.provider === "string" ? args.provider : undefined,
        },
        config,
        store,
        archive,
        logger,
        deps: policy.deps,
        now,
    })
    if (metrics) metrics.record(result.body)
    return asContent(summarizeReview(result.body), result.body)
}

/**
 * Tool handler for `reset_review_context`.
 */
export const resetRequestHandler = async ({
    args,
    ctx: { config, store, logger, deps = {}, mcpServer },
}) => {
    const policy = await applyRootsPolicy({ mcpServer, logger, deps })
    if (!policy.ok) {
        return asContent(summarizeReset(policy.body), policy.body)
    }
    const result = handleReset({
        body: { cwd: args?.cwd },
        config,
        store,
        deps: policy.deps,
    })
    return asContent(summarizeReset(result.body), result.body)
}

const TOOL_TITLES = {
    request_review:
        "Run a code review of the current git changes in `cwd`. " +
        "Provider (codex / claude / gemini) is selected by " +
        "config.reviewer.provider on the server side, or per-call via " +
        "the optional `provider` input. Pass `force: true` to bypass the " +
        "server-side cache and safety caps and force a fresh reviewer " +
        "run. When the result contains blocking findings (severity " +
        "`blocker` or `major`), you MUST address every one of them in " +
        "code before responding to the user, then call request_review " +
        "again. Repeat until the tool returns GOOD_TO_GO or " +
        "GOOD_TO_GO_WITH_NOTES.",
    reset_review_context:
        "Clear the per-context review state (counters, baseline, prior findings) for the repo at `cwd`.",
}

/**
 * Build (but do not connect) an McpServer with the two tools registered.
 * Tests instantiate this directly to drive tools/call against a fresh
 * server without touching HTTP.
 */
export const buildMcpServer = (ctx) => {
    const server = new McpServer(
        { name: "review-orchestrator", version: VERSION },
        { capabilities: { tools: {} } }
    )
    // Each tool callback gets a per-server view of the shared ctx so handlers
    // can call listRoots() / getClientCapabilities() against THIS server's
    // underlying low-level handle. Closures avoid ctx mutation, which is
    // important when buildMcpServer is called once per request (stateless
    // mode — see mountMcpRoute) and we don't want one request's server to
    // bleed into another.
    const ctxWithServer = { ...ctx, mcpServer: server }

    server.registerTool(
        "request_review",
        {
            title: "Run a code review",
            description: TOOL_TITLES.request_review,
            inputSchema: REQUEST_REVIEW_INPUT_SHAPE,
        },
        async (args) => reviewRequestHandler({ args, ctx: ctxWithServer })
    )

    server.registerTool(
        "reset_review_context",
        {
            title: "Reset review context",
            description: TOOL_TITLES.reset_review_context,
            inputSchema: RESET_REVIEW_CONTEXT_INPUT_SHAPE,
        },
        async (args) => resetRequestHandler({ args, ctx: ctxWithServer })
    )

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

export const __test__ = {
    summarizeReview,
    summarizeReset,
    asContent,
}
