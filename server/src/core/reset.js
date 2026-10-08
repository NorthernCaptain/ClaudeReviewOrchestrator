/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { z } from "zod"
import {
    contextErrorStatus,
    ContextError,
    resolveContext,
} from "./review/context.js"
import { applyRootsPolicy, asContent } from "./review/mcp.js"

const escalate = (status, code, reason) => ({
    status: "ESCALATE",
    findings: [],
    blockingFindings: [],
    droppedFindings: [],
    reason,
    code,
})

export const handleReset = async ({ body, config, store, deps = {} }) => {
    const cwd = body?.cwd
    if (!cwd) {
        return {
            httpStatus: 400,
            body: escalate(400, "INVALID_REQUEST", "cwd is required"),
        }
    }

    let context
    try {
        context = await (deps.resolveContext ?? resolveContext)({
            cwd,
            allowedRoots: config.allowedRoots,
            git: deps.git,
        })
    } catch (err) {
        const httpStatus = contextErrorStatus(err)
        return {
            httpStatus,
            body: escalate(
                httpStatus,
                err instanceof ContextError || err?.code === "GIT_TIMEOUT"
                    ? err.code
                    : "INTERNAL_ERROR",
                err.message ?? "unknown error"
            ),
        }
    }

    const fresh = store.reset(context)
    return {
        httpStatus: 200,
        body: {
            ok: true,
            context: {
                repo: context.repo,
                repoRoot: context.repoRoot,
                branch: context.branch,
                key: context.key,
            },
            state: {
                codexRounds: fresh.codexRounds,
                blockCount: fresh.blockCount,
                lastResultStatus: fresh.lastResultStatus,
            },
        },
    }
}

// Dashboard reset: takes `{ contextKey }` — the store key already
// encodes (repoRoot, branch), so unlike `cwd` it can't be ambiguous when
// a repo has multiple branches in the store. Validated against
// store.list() before touching state.
export const handleDashboardReset = ({ body, store }) => {
    const contextKey = body?.contextKey
    if (typeof contextKey !== "string" || contextKey.length === 0) {
        return {
            httpStatus: 400,
            body: { ok: false, error: "contextKey is required" },
        }
    }
    const known = (store?.list?.() ?? []).find((c) => c.key === contextKey)
    if (!known) {
        return {
            httpStatus: 404,
            body: { ok: false, error: `unknown context: ${contextKey}` },
        }
    }
    const fresh = store.reset({
        key: known.key,
        repoRoot: known.repoRoot,
        branch: known.branch,
    })
    return {
        httpStatus: 200,
        body: {
            ok: true,
            context: {
                repo: known.repo ?? known.repoRoot?.split("/").pop() ?? null,
                repoRoot: known.repoRoot,
                branch: known.branch,
                key: known.key,
            },
            state: {
                codexRounds: fresh.codexRounds,
                blockCount: fresh.blockCount,
                lastResultStatus: fresh.lastResultStatus,
            },
        },
    }
}

// POST /reset. `getOptions` is read per request ({ config, store, deps }).
export const createResetHandler = (getOptions) => async (req, res) => {
    const { config, store, deps } = getOptions()
    const result = await handleReset({ body: req.body, config, store, deps })
    res.status(result.httpStatus).json(result.body)
}

export const RESET_REVIEW_CONTEXT_INPUT_SHAPE = {
    cwd: z
        .string()
        .min(1)
        .describe(
            "Absolute path to the current working directory of the calling session. The server resolves it to a (repoRoot, branch) context and clears its counters, baseline, and prior findings."
        ),
}

export const RESET_REVIEW_CONTEXT_TOOL = Object.freeze({
    name: "reset_review_context",
    title: "Reset review context",
    description:
        "Clear the per-context review state (counters, baseline, prior findings) for the repo at `cwd`.",
    inputSchema: RESET_REVIEW_CONTEXT_INPUT_SHAPE,
})

const summarizeReset = (body) => {
    const lines = [
        body.ok ? "Reset OK" : `Reset failed: ${body.reason ?? "unknown"}`,
    ]
    if (body.context?.repo) {
        lines.push(`Context: ${body.context.repo}:${body.context.branch}`)
    }
    return lines.join("\n")
}

// MCP tool handler for `reset_review_context`. Honors the client's
// advertised roots the same way request_review does.
export const resetRequestHandler = async ({
    args,
    ctx: { config, store, logger, deps = {}, mcpServer },
    requestId,
}) => {
    const policy = await applyRootsPolicy({
        mcpServer,
        logger,
        deps,
        requestId,
    })
    if (!policy.ok) {
        return asContent(summarizeReset(policy.body), policy.body)
    }
    const result = await handleReset({
        body: { cwd: args?.cwd },
        config,
        store,
        deps: policy.deps,
    })
    return asContent(summarizeReset(result.body), result.body)
}

export const __test__ = { summarizeReset }
