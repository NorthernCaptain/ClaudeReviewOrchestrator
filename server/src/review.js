/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { resolveContext, ContextError } from "./context.js"
import { buildPayload } from "./diff.js"
import { runAndParse } from "./codex.js"

const envelope = (status, extra = {}) => ({
    status,
    findings: [],
    blockingFindings: [],
    droppedFindings: [],
    ...extra,
})

const errorToEscalate = (err) => {
    if (err instanceof ContextError) {
        return envelope("ESCALATE", {
            reason: err.message,
            code: err.code,
        })
    }
    return envelope("ESCALATE", {
        reason: err?.message ?? "unknown error",
        code: "INTERNAL_ERROR",
    })
}

export const handleReview = async ({ body, config, deps = {} }) => {
    const cwd = body?.cwd
    if (!cwd) {
        return {
            httpStatus: 400,
            body: envelope("ESCALATE", {
                reason: "cwd is required in the request body",
                code: "INVALID_REQUEST",
            }),
        }
    }

    let context
    try {
        context = (deps.resolveContext ?? resolveContext)({
            cwd,
            allowedRoots: config.allowedRoots,
        })
    } catch (err) {
        const body = errorToEscalate(err)
        const httpStatus =
            err instanceof ContextError && err.code === "NOT_IN_ALLOWED_ROOT"
                ? 403
                : 400
        return { httpStatus, body }
    }

    let payload
    try {
        payload = (deps.buildPayload ?? buildPayload)({
            repoRoot: context.repoRoot,
            config,
        })
    } catch (err) {
        return {
            httpStatus: 500,
            body: errorToEscalate(err),
        }
    }

    if (payload.empty || payload.nonBinaryFileCount === 0) {
        return {
            httpStatus: 200,
            body: envelope("ESCALATE", {
                reason: "payload empty or fully binary",
                code: "EMPTY_PAYLOAD",
                context: contextSummary(context),
                baseline: baselineSummary(payload),
            }),
        }
    }

    let codexResult
    try {
        codexResult = await (deps.runAndParse ?? runAndParse)({
            repoRoot: context.repoRoot,
            prompt: payload.promptText,
            config,
        })
    } catch (err) {
        return {
            httpStatus: 502,
            body: errorToEscalate(err),
        }
    }

    if (codexResult.status === "ESCALATE") {
        return {
            httpStatus: 200,
            body: envelope("ESCALATE", {
                reason: codexResult.reason,
                code: "CODEX_ERROR",
                context: contextSummary(context),
                baseline: baselineSummary(payload),
                codex: codexSummary(codexResult),
            }),
        }
    }

    return {
        httpStatus: 200,
        body: {
            status: codexResult.status,
            findings: codexResult.findings,
            blockingFindings: [],
            droppedFindings: [],
            context: contextSummary(context),
            baseline: baselineSummary(payload),
            codex: codexSummary(codexResult),
        },
    }
}

const contextSummary = (context) => ({
    repo: context.repo,
    repoRoot: context.repoRoot,
    branch: context.branch,
    key: context.key,
})

const baselineSummary = (payload) => ({
    headSha: payload.headSha,
    files: payload.files,
    totalBytes: payload.totalBytes,
    truncated: payload.truncated,
})

const codexSummary = (codexResult) => {
    const raw = codexResult.raw ?? {}
    return {
        durationMs: raw.durationMs,
        exitCode: raw.exitCode,
        timedOut: raw.timedOut,
    }
}

export const mountReviewRoute = (app, { config, deps } = {}) => {
    app.post("/review", async (req, res) => {
        const result = await handleReview({
            body: req.body,
            config,
            deps,
        })
        res.status(result.httpStatus).json(result.body)
    })
}
