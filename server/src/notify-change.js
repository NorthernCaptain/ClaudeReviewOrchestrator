/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

// POST /notify-change — receives a ping from the PostToolUse hook
// (`hooks/notify-change.mjs`) whenever Claude uses Write / Edit /
// MultiEdit. The endpoint resolves `cwd` to a `(repoRoot, branch)`
// context and marks that context as dirty so the next /review fast-
// path knows it cannot short-circuit.
//
// Keep this endpoint CHEAP — it fires on every tool call. One git
// rev-parse, one state write. No payload build, no reviewer spawn,
// no archive. Typical latency ~10ms.

import { resolveContext, ContextError } from "./context.js"

const noopLogger = { info() {}, warn() {}, error() {} }

export const handleNotifyChange = ({
    body,
    config,
    store,
    logger = noopLogger,
    deps = {},
    now = Date.now,
}) => {
    const log = logger.child
        ? logger.child({ component: "notify-change" })
        : logger

    const cwd = body?.cwd
    if (typeof cwd !== "string" || cwd.length === 0) {
        return {
            httpStatus: 400,
            body: { ok: false, error: "cwd is required" },
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
            err instanceof ContextError &&
            (err.code === "NOT_IN_ALLOWED_ROOT" ||
                err.code === "NOT_IN_CLIENT_ROOT")
                ? 403
                : 400
        log.warn(
            { err: err?.message, code: err?.code, cwd },
            "notify-change: context resolution failed"
        )
        return {
            httpStatus,
            body: { ok: false, error: err?.message ?? "context error" },
        }
    }

    // Merge with existing state so a write doesn't blank the cache
    // fields. store.save shallow-merges via Object.assign, so we only
    // need to send the changed fields.
    const t = now()
    const saved = store.save(context.key, {
        repoRoot: context.repoRoot,
        branch: context.branch,
        dirtySinceLastReview: true,
        lastChangeAt: t,
    })

    log.info(
        {
            repo: context.repo,
            branch: context.branch,
            cwd: context.repoRoot,
            tool: body?.tool ?? null,
            file: body?.file ?? null,
        },
        "change notification"
    )

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
            dirty: true,
            lastChangeAt: saved.lastChangeAt,
        },
    }
}

export const mountNotifyChangeRoute = (
    app,
    { config, store, logger = noopLogger, deps = {} } = {}
) => {
    app.post("/notify-change", (req, res) => {
        const result = handleNotifyChange({
            body: req.body,
            config,
            store,
            logger,
            deps,
        })
        res.status(result.httpStatus).json(result.body)
    })
}
