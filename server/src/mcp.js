/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { z } from "zod"
import { handleReview } from "./review.js"
import { handleReset } from "./reset.js"
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
// client-advertised roots. Returns true when `roots` is null/empty so the
// caller can skip the check when no roots capability is in play.
export const repoInClientRoots = (repoRoot, roots) => {
    if (!Array.isArray(roots) || roots.length === 0) return true
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

// Returns the client-advertised roots if the client supports the roots
// capability, or null when no roots check should be applied. Failures
// (transport errors, missing capability) collapse to null so the review
// path falls back to allowedRoots-only enforcement.
const maybeListClientRoots = async (mcpServer, logger) => {
    if (!mcpServer) return null
    const lowLevel = mcpServer.server
    if (!lowLevel || typeof lowLevel.getClientCapabilities !== "function") {
        return null
    }
    const caps = lowLevel.getClientCapabilities()
    if (!caps?.roots) return null
    try {
        const result = await lowLevel.listRoots()
        return Array.isArray(result?.roots) ? result.roots : null
    } catch (err) {
        logger?.warn?.(
            { err: err?.message ?? String(err) },
            "MCP: client advertised roots capability but listRoots failed"
        )
        return null
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
export const reviewRequestHandler = async ({
    args,
    ctx: { config, store, archive, logger, deps = {}, now, mcpServer },
}) => {
    const clientRoots = await maybeListClientRoots(mcpServer, logger)
    const baseResolve = deps.resolveContext ?? defaultResolveContext
    const wrappedDeps = clientRoots
        ? {
              ...deps,
              resolveContext: wrapResolveWithClientRoots(
                  baseResolve,
                  clientRoots
              ),
          }
        : deps
    const result = await handleReview({
        body: {
            cwd: args?.cwd,
            trigger: "mcp_tool",
            extra_instructions: args?.extra_instructions,
        },
        config,
        store,
        archive,
        logger,
        deps: wrappedDeps,
        now,
    })
    return asContent(summarizeReview(result.body), result.body)
}

/**
 * Tool handler for `reset_review_context`.
 */
export const resetRequestHandler = async ({
    args,
    ctx: { config, store, logger, deps = {}, mcpServer },
}) => {
    const clientRoots = await maybeListClientRoots(mcpServer, logger)
    const baseResolve = deps.resolveContext ?? defaultResolveContext
    const wrappedDeps = clientRoots
        ? {
              ...deps,
              resolveContext: wrapResolveWithClientRoots(
                  baseResolve,
                  clientRoots
              ),
          }
        : deps
    const result = handleReset({
        body: { cwd: args?.cwd },
        config,
        store,
        deps: wrappedDeps,
    })
    return asContent(summarizeReset(result.body), result.body)
}

const TOOL_TITLES = {
    request_review: "Run a Codex review of the current git changes in `cwd`.",
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
        { name: "review-orchestrator", version: "0.0.0" },
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
            title: "Run a Codex review",
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
 * Mount the MCP route on the given Express app.
 *
 * Per the SDK's stateless-streamable-http reference example, every POST
 * /mcp invocation gets its own McpServer + StreamableHTTPServerTransport
 * pair. The transport's internal state machine (`_initialized` flag,
 * stream registry, etc.) is per-request in stateless mode; reusing a
 * single instance across requests leaves stale state that breaks the
 * second and subsequent calls (initialize → 200, then notifications/
 * initialized → 500 from the same transport).
 *
 * GET and DELETE return 405 — there's no long-lived session to stream
 * notifications down or to terminate.
 */
export const mountMcpRoute = (app, ctx) => {
    const handle = async (req, res) => {
        const server = buildMcpServer(ctx)
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined, // stateless mode
        })
        try {
            await server.connect(transport)
            await transport.handleRequest(req, res, req.body)
            res.on("close", () => {
                transport.close().catch(() => {})
                server.close().catch(() => {})
            })
        } catch (err) {
            ctx.logger?.error?.(
                {
                    err: err?.message ?? String(err),
                    stack: err?.stack,
                    method: req.method,
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

    const notAllowed = (_req, res) => {
        res.status(405).json({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Method not allowed." },
            id: null,
        })
    }

    app.post("/mcp", handle)
    app.get("/mcp", notAllowed)
    app.delete("/mcp", notAllowed)
}

export const __test__ = {
    summarizeReview,
    summarizeReset,
    asContent,
}
