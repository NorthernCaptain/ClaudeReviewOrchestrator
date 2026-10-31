/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

// POST /notify-change — receives a ping from the PostToolUse hook
// (`hooks/notify-change.mjs`) whenever Claude uses Write / Edit /
// MultiEdit. The endpoint resolves the edited file's folder (or `cwd`
// when the hook names no absolute path) to a `(repoRoot, branch)`
// context and marks that context as dirty so the next /review fast-
// path knows it cannot short-circuit. An agent can edit another repo
// (a worktree in another folder) from its session; the file's own
// repo is the one that changed.
//
// Keep this endpoint CHEAP — it fires on every tool call. One git
// rev-parse, one state write. No payload build, no reviewer spawn,
// no archive. Typical latency ~10ms.

import { existsSync } from "node:fs"
import path from "node:path"
import {
    ContextError,
    contextErrorStatus,
    resolveContext,
} from "./review/context.js"
import { recordLink } from "./review/linked.js"

const noopLogger = { info() {}, warn() {}, error() {} }

// The folder of an absolute `file`, walking up past folders that don't
// exist (a file just created in a new folder); null when there's none.
export const editedFolder = (file, exists = existsSync) => {
    if (typeof file !== "string" || !path.isAbsolute(file)) return null
    let dir = path.dirname(file)
    while (!exists(dir)) {
        const up = path.dirname(dir)
        if (up === dir) return null
        dir = up
    }
    return dir
}

export const handleNotifyChange = async ({
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

    const resolve = (dir) =>
        (deps.resolveContext ?? resolveContext)({
            cwd: dir,
            allowedRoots: config.allowedRoots,
            git: deps.git,
        })
    const fileDir = editedFolder(body?.file, deps.exists)
    let context
    let fromFile = false
    try {
        try {
            context = await resolve(fileDir ?? cwd)
            fromFile = fileDir !== null
        } catch (err) {
            // The file isn't in a reviewable repo (a scratch file, a path
            // outside allowedRoots): the session's repo is marked, as
            // before. A git timeout fails the request instead.
            if (!fileDir || !(err instanceof ContextError)) throw err
            context = await resolve(cwd)
        }
    } catch (err) {
        const httpStatus = contextErrorStatus(err)
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

    // An edit in another repo links it to the session's own, so the Stop
    // hook reviews both. Best effort: the notification itself succeeded.
    let linkedTo = null
    // Compared by repo identity, not folder: a session in a repo nested
    // inside the edited one is still a different repo.
    if (fromFile) {
        try {
            const session = await resolve(cwd)
            if (
                recordLink({ store, primary: session, secondary: context, now })
            ) {
                linkedTo = session.key
            }
        } catch (err) {
            log.warn(
                { err: err?.message, code: err?.code, cwd },
                "notify-change: session repo unresolved, edit not linked"
            )
        }
    }

    log.info(
        {
            linkedTo,
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
            ...(linkedTo ? { linkedTo } : {}),
        },
    }
}

// POST /notify-change. `getOptions` is read per request
// ({ config, store, logger, deps }).
export const createNotifyChangeHandler = (getOptions) => async (req, res) => {
    const { config, store, logger = noopLogger, deps = {} } = getOptions()
    const result = await handleNotifyChange({
        body: req.body,
        config,
        store,
        logger,
        deps,
    })
    res.status(result.httpStatus).json(result.body)
}
