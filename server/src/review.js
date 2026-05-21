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
        return envelope("ESCALATE", { reason: err.message, code: err.code })
    }
    return envelope("ESCALATE", {
        reason: err?.message ?? "unknown error",
        code: "INTERNAL_ERROR",
    })
}

const contextSummary = (context) => ({
    repo: context.repo,
    repoRoot: context.repoRoot,
    branch: context.branch,
    key: context.key,
})

const baselineSummary = (payload) => ({
    headSha: payload.headSha,
    promptHash: payload.promptHash,
    progressHash: payload.progressHash,
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

const stateSummary = (state) => ({
    codexRounds: state.codexRounds,
    blockCount: state.blockCount,
    lastResultStatus: state.lastResultStatus,
})

// Returns true iff the caller wants Stop-hook-style accounting (cap check,
// blockCount consumption, decision:"block" on ISSUES).
const isStopHook = (trigger) => trigger === "stop_hook"

export const handleReview = async ({
    body,
    config,
    store,
    deps = {},
    now = Date.now,
}) => {
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
        const httpStatus =
            err instanceof ContextError && err.code === "NOT_IN_ALLOWED_ROOT"
                ? 403
                : 400
        return { httpStatus, body: errorToEscalate(err) }
    }

    const trigger = body?.trigger ?? "manual"
    const state = store.get(context)

    // Stop-hook-only pre-cap: if we've already issued maxBlocks worth of
    // decision:"block" instructions this loop, escalate before doing any
    // more work. Manual MCP calls bypass this cap because they don't
    // consume block budget by definition.
    if (isStopHook(trigger) && state.blockCount >= config.limits.maxBlocks) {
        return {
            httpStatus: 200,
            body: envelope("ESCALATE", {
                reason: `block cap (${config.limits.maxBlocks}) reached for this context`,
                code: "MAX_BLOCKS",
                context: contextSummary(context),
                state: stateSummary(state),
            }),
        }
    }

    let payload
    try {
        payload = (deps.buildPayload ?? buildPayload)({
            repoRoot: context.repoRoot,
            config,
            priorFindings: state.priorFindings,
        })
    } catch (err) {
        return { httpStatus: 500, body: errorToEscalate(err) }
    }

    if (payload.empty || payload.nonBinaryFileCount === 0) {
        return {
            httpStatus: 200,
            body: envelope("ESCALATE", {
                reason: "payload empty or fully binary",
                code: "EMPTY_PAYLOAD",
                context: contextSummary(context),
                baseline: baselineSummary(payload),
                state: stateSummary(state),
            }),
        }
    }

    // Change detection: NO_CHANGES or NO_PROGRESS_WITH_OPEN_ISSUES short
    // circuits before we spawn codex.
    const unchanged =
        state.lastBaseline &&
        state.lastBaseline.progressHash === payload.progressHash

    if (unchanged) {
        if (
            state.lastResultStatus === "GOOD_TO_GO" ||
            state.lastResultStatus === "GOOD_TO_GO_WITH_NOTES"
        ) {
            return {
                httpStatus: 200,
                body: envelope("NO_CHANGES", {
                    context: contextSummary(context),
                    baseline: baselineSummary(payload),
                    state: stateSummary(state),
                }),
            }
        }
        if (state.lastResultStatus === "ISSUES") {
            // Same on-disk state as last review, blocking findings still open.
            // Block-cap accounting: only stop-hook calls consume budget.
            let nextState = state
            if (isStopHook(trigger)) {
                nextState = store.save(context.key, {
                    ...state,
                    blockCount: state.blockCount + 1,
                    lastReviewedAt: now(),
                })
            }
            return {
                httpStatus: 200,
                body: {
                    status: "NO_PROGRESS_WITH_OPEN_ISSUES",
                    findings: state.priorFindings,
                    blockingFindings: [],
                    droppedFindings: [],
                    reason: "No on-disk progress on flagged files since the last review.",
                    context: contextSummary(context),
                    baseline: baselineSummary(payload),
                    state: stateSummary(nextState),
                },
            }
        }
    }

    // Cap check on Codex rounds before spawning. The counter increments
    // before the spawn so a misbehaving codex can't burn extra rounds via
    // retries.
    if (state.codexRounds >= config.limits.maxCodexRounds) {
        return {
            httpStatus: 200,
            body: envelope("ESCALATE", {
                reason: `codex round cap (${config.limits.maxCodexRounds}) reached for this context`,
                code: "MAX_CODEX_ROUNDS",
                context: contextSummary(context),
                state: stateSummary(state),
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
        return { httpStatus: 502, body: errorToEscalate(err) }
    }

    if (codexResult.status === "ESCALATE") {
        // Persist the baseline so a follow-up call without any edits still
        // returns NO_CHANGES instead of re-spinning Codex.
        const nextState = store.save(context.key, {
            ...state,
            codexRounds: state.codexRounds + 1,
            lastBaseline: baselineSummary(payload),
            lastReviewedAt: now(),
            lastResultStatus: "ESCALATE",
        })
        return {
            httpStatus: 200,
            body: envelope("ESCALATE", {
                reason: codexResult.reason,
                code: "CODEX_ERROR",
                context: contextSummary(context),
                baseline: baselineSummary(payload),
                codex: codexSummary(codexResult),
                state: stateSummary(nextState),
            }),
        }
    }

    // Codex returned a structured result. In Phase 2 we still pass through
    // findings as-is (blockingFindings / droppedFindings are wired in
    // Phase 3). The result-status mapping is also simpler than Phase 3 —
    // GOOD_TO_GO_WITH_NOTES is not yet derived here.
    const status = codexResult.status === "ISSUES" ? "ISSUES" : "GOOD_TO_GO"

    const nextState = {
        ...state,
        codexRounds: state.codexRounds + 1,
        lastBaseline: baselineSummary(payload),
        lastReviewedAt: now(),
        lastResultStatus: status,
        priorFindings: status === "ISSUES" ? codexResult.findings : [],
        // Only stop-hook ISSUES results consume block budget.
        blockCount:
            isStopHook(trigger) && status === "ISSUES"
                ? state.blockCount + 1
                : status === "GOOD_TO_GO"
                  ? 0
                  : state.blockCount,
    }

    // GOOD_TO_GO also resets codexRounds — the loop is over.
    if (status === "GOOD_TO_GO") {
        nextState.codexRounds = 0
        nextState.blockCount = 0
        nextState.priorFindings = []
    }

    const saved = store.save(context.key, nextState)

    return {
        httpStatus: 200,
        body: {
            status,
            findings: codexResult.findings,
            blockingFindings: [],
            droppedFindings: [],
            context: contextSummary(context),
            baseline: baselineSummary(payload),
            codex: codexSummary(codexResult),
            state: stateSummary(saved),
        },
    }
}

export const mountReviewRoute = (app, { config, store, deps } = {}) => {
    app.post("/review", async (req, res) => {
        const result = await handleReview({
            body: req.body,
            config,
            store,
            deps,
        })
        res.status(result.httpStatus).json(result.body)
    })
}
