/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

// MCP tool behaviour for request_review: linking a reviewed folder to the
// session's repo (through the client's advertised roots) and the tool
// handler. Transport and sessions are the shell's (server/src/mcp.js); it
// registers REQUEST_REVIEW_TOOL per session and calls the core's handler
// for every tools/call.

import { fileURLToPath } from "node:url"
import { z } from "zod"
import { handleReview } from "./review.js"
import { recordLink } from "./linked.js"
import { resolveContext as defaultResolveContext } from "./context.js"

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

// The client's advertised roots name the session's own folder (MCP calls
// carry no session id). They're used only to link a reviewed folder to
// the session's repo, never to refuse one: any folder inside
// allowedRoots can be reviewed. The probe is sent on the calling
// tools/call's own response stream (relatedRequestId); without it the
// SDK routes a server→client request to the standalone GET stream,
// which a client may not have opened yet, and the probe hangs.
export const ROOTS_PROBE_TIMEOUT_MS = 10_000

export const maybeListClientRoots = async (
    mcpServer,
    logger,
    { relatedRequestId } = {}
) => {
    if (!mcpServer) return { advertised: false }
    const lowLevel = mcpServer.server
    if (!lowLevel || typeof lowLevel.getClientCapabilities !== "function") {
        return { advertised: false }
    }
    const caps = lowLevel.getClientCapabilities()
    if (!caps?.roots) return { advertised: false }
    try {
        const result = await lowLevel.listRoots(undefined, {
            relatedRequestId,
            timeout: ROOTS_PROBE_TIMEOUT_MS,
        })
        const roots = Array.isArray(result?.roots) ? result.roots : []
        return { advertised: true, roots }
    } catch (err) {
        const message = err?.message ?? String(err)
        logger?.warn?.(
            { err: message },
            "MCP: listRoots failed; the reviewed folder won't be linked"
        )
        return { advertised: true, error: message }
    }
}

// The session folders the client advertised, as local paths.
const sessionFolders = async (mcpServer, logger, requestId) => {
    const probe = await maybeListClientRoots(mcpServer, logger, {
        relatedRequestId: requestId,
    })
    if (!probe.advertised || probe.error) return []
    return probe.roots.map((r) => rootUriToPath(r?.uri)).filter(Boolean)
}

// Links the folder an agent asked to review to the session's repo (its
// advertised root), when they differ, so the session's Stop hook reviews
// it too. Best effort: a review never fails over a link.
export const linkToSession = async ({
    cwd,
    config,
    store,
    deps = {},
    mcpServer,
    logger,
    requestId,
    now,
}) => {
    const roots = await sessionFolders(mcpServer, logger, requestId)
    if (roots.length === 0) return []
    const resolve = (p) =>
        (deps.resolveContext ?? defaultResolveContext)({
            cwd: p,
            allowedRoots: config.allowedRoots,
            git: deps.git,
        })
    let target
    try {
        target = await resolve(cwd)
    } catch {
        return []
    }
    const linked = []
    for (const root of roots) {
        let session
        try {
            session = await resolve(root)
        } catch {
            // A root that isn't a repo inside allowedRoots.
            continue
        }
        const made = recordLink({
            store,
            primary: session,
            secondary: target,
            ...(now ? { now } : {}),
        })
        if (made) linked.push(session.key)
    }
    if (linked.length > 0) {
        logger?.info?.(
            { linked: target.key, to: linked },
            "MCP: reviewed folder linked to the session's repo"
        )
    }
    return linked
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

export const asContent = (summary, structured) => ({
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
    ctx: {
        config,
        store,
        archive,
        logger,
        deps = {},
        now,
        mcpServer,
        metrics = null,
        schema = null,
        versions = {},
    },
    requestId,
}) => {
    await linkToSession({
        cwd: args?.cwd,
        config,
        store,
        deps,
        mcpServer,
        logger,
        requestId,
        now,
    })
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
        deps,
        schema,
        ...versions,
        now,
    })
    if (metrics) metrics.record(result.body)
    return asContent(summarizeReview(result.body), result.body)
}

export const REQUEST_REVIEW_TOOL = Object.freeze({
    name: "request_review",
    title: "Run a code review",
    description:
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
    inputSchema: REQUEST_REVIEW_INPUT_SHAPE,
})

export const __test__ = { summarizeReview }
