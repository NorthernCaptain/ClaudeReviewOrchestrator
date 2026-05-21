/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { resolveContext, ContextError } from "./context.js"

const escalate = (status, code, reason) => ({
    status: "ESCALATE",
    findings: [],
    blockingFindings: [],
    droppedFindings: [],
    reason,
    code,
})

export const handleReset = ({ body, config, store, deps = {} }) => {
    const cwd = body?.cwd
    if (!cwd) {
        return {
            httpStatus: 400,
            body: escalate(400, "INVALID_REQUEST", "cwd is required"),
        }
    }

    let context
    try {
        context = (deps.resolveContext ?? resolveContext)({
            cwd,
            allowedRoots: config.allowedRoots,
        })
    } catch (err) {
        const httpStatus =
            err instanceof ContextError && err.code === "NOT_IN_ALLOWED_ROOT"
                ? 403
                : 400
        return {
            httpStatus,
            body: escalate(
                httpStatus,
                err instanceof ContextError ? err.code : "INTERNAL_ERROR",
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

export const mountResetRoute = (app, { config, store, deps } = {}) => {
    app.post("/reset", (req, res) => {
        const result = handleReset({
            body: req.body,
            config,
            store,
            deps,
        })
        res.status(result.httpStatus).json(result.body)
    })
}
