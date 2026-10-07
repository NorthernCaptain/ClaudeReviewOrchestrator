/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

// MCP tool behaviour for request_review: the client-roots check and the
// tool handler. Transport and sessions are the shell's (server/src/mcp.js);
// it registers REQUEST_REVIEW_TOOL per session and calls the core's
// handler for every tools/call.

import { realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { z } from "zod"
import { handleReview } from "./review.js"
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
const wrapResolveWithClientRoots =
    (resolveImpl, clientRoots) => async (args) => {
        const ctx = await resolveImpl(args)
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
// The probe is sent on the calling tools/call's own response stream
// (relatedRequestId). Without it the SDK routes a server→client request
// to the standalone GET stream, which a client may not have opened yet;
// the request is then dropped and the probe hangs.
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
// Returns either { ok: true, deps } with deps possibly wrapped, or
// { ok: false, body } where body is a ready-to-return escalate envelope.
export const applyRootsPolicy = async ({
    mcpServer,
    logger,
    deps,
    requestId,
}) => {
    const probe = await maybeListClientRoots(mcpServer, logger, {
        relatedRequestId: requestId,
    })
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
        schema = null,
    },
    requestId,
}) => {
    const policy = await applyRootsPolicy({
        mcpServer,
        logger,
        deps,
        requestId,
    })
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
        schema,
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
