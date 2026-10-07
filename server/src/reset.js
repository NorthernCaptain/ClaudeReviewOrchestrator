/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { contextErrorStatus, ContextError, resolveContext } from "./context.js"

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

export const mountResetRoute = (app, { config, store, deps } = {}) => {
    app.post("/reset", async (req, res) => {
        const result = await handleReset({
            body: req.body,
            config,
            store,
            deps,
        })
        res.status(result.httpStatus).json(result.body)
    })
}
