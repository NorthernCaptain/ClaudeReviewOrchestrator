/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { resolveContext, ContextError } from "./context.js"
import { buildPayload, sanitizeFindingPath } from "./diff.js"
import { runAndParse } from "./codex.js"

// Drop findings whose file path is unsafe (absolute, escapes repoRoot via
// "..", backslashes, null bytes). The dropped paths are visible to the
// caller via the dropped count; Phase 3 will surface them as
// result.droppedFindings.
const safeFindingsOnly = (findings, repoRoot) => {
    const safe = []
    let droppedForPath = 0
    for (const f of findings ?? []) {
        if (!f || typeof f.file !== "string") {
            droppedForPath++
            continue
        }
        const sanitized = sanitizeFindingPath(f.file, repoRoot)
        if (sanitized === null) {
            droppedForPath++
            continue
        }
        safe.push({ ...f, file: sanitized })
    }
    return { safe, droppedForPath }
}

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
        if (state.lastResultStatus === "ESCALATE") {
            // The last Codex run failed (schema error, timeout, etc.). The
            // user hasn't edited anything; spawning Codex again with the same
            // prompt isn't going to help and would burn codexRounds for free.
            // Return the cached ESCALATE; stop_hook still consumes blockCount
            // so the loop eventually exits hard.
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
                body: envelope("ESCALATE", {
                    reason:
                        state.lastEscalateReason ??
                        "previous codex run failed and the on-disk state has not changed",
                    code: "CODEX_ERROR_CACHED",
                    context: contextSummary(context),
                    baseline: baselineSummary(payload),
                    state: stateSummary(nextState),
                }),
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
        // Persist the baseline + the reason so a follow-up call without any
        // edits short-circuits to the cached ESCALATE instead of re-spinning
        // Codex (see the unchanged+ESCALATE branch above).
        const nextState = store.save(context.key, {
            ...state,
            codexRounds: state.codexRounds + 1,
            lastBaseline: baselineSummary(payload),
            lastReviewedAt: now(),
            lastResultStatus: "ESCALATE",
            lastEscalateReason: codexResult.reason,
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

    // Codex returned a structured result. Sanitize finding paths before
    // they enter state — Codex output is untrusted and a path like
    // "../../secret.txt" would otherwise be hashed and read on the next
    // round. In Phase 2 we still surface the sanitized list as `findings`
    // (blockingFindings / droppedFindings get wired in Phase 3).
    const status = codexResult.status === "ISSUES" ? "ISSUES" : "GOOD_TO_GO"
    const { safe: safeFindings } = safeFindingsOnly(
        codexResult.findings,
        context.repoRoot
    )

    const nextState = {
        ...state,
        codexRounds: state.codexRounds + 1,
        lastBaseline: baselineSummary(payload),
        lastReviewedAt: now(),
        lastEscalateReason: null,
        lastResultStatus: status,
        priorFindings: status === "ISSUES" ? safeFindings : [],
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
            findings: safeFindings,
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
