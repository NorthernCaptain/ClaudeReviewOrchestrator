/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { resolveContext, ContextError } from "./context.js"
import { buildPayload, sanitizeFindingPath } from "./diff.js"
import { runAndParse, wrapPrompt } from "./codex.js"

// The set of repo-relative paths that the current payload exposes to Codex.
// Codex findings referencing anything outside this set are dropped.
const collectPayloadPaths = (payload) => {
    const set = new Set()
    for (const f of payload.files?.modified ?? []) {
        if (f?.path) set.add(f.path)
    }
    for (const f of payload.files?.untracked ?? []) {
        if (f?.path) set.add(f.path)
    }
    for (const p of payload.files?.deleted ?? []) {
        if (p) set.add(p)
    }
    for (const r of payload.files?.renamed ?? []) {
        if (r?.from) set.add(r.from)
        if (r?.to) set.add(r.to)
    }
    for (const f of payload.files?.priorFindingContext ?? []) {
        if (f?.path) set.add(f.path)
    }
    return set
}

// Sanitize a finding path (path-traversal guard already done at storage
// time, but Codex's fresh output also passes through here) AND check the
// payload-set membership rule. Returns the safe finding (with normalized
// `file`) or null.
const acceptFinding = (finding, payloadPaths, repoRoot) => {
    if (!finding || typeof finding.file !== "string") return null
    const safe = sanitizeFindingPath(finding.file, repoRoot)
    if (safe === null) return null
    if (!payloadPaths.has(safe)) return null
    return { ...finding, file: safe }
}

const partitionFindings = (findings, payloadPaths, repoRoot) => {
    const kept = []
    const dropped = []
    for (const f of findings ?? []) {
        const accepted = acceptFinding(f, payloadPaths, repoRoot)
        if (accepted) kept.push(accepted)
        else dropped.push(f)
    }
    return { kept, dropped }
}

// Re-validate cached state findings before they leave the server. Legacy
// or corrupt state could carry unsafe paths; this is the defensive read
// counterpart to the storage-side sanitization. No payload-membership
// check here — cached findings already passed it when they entered state
// and the same files are force-included in this round's payload.
const resanitizeCached = (findings, repoRoot) => {
    const out = []
    for (const f of findings ?? []) {
        if (!f || typeof f.file !== "string") continue
        const safe = sanitizeFindingPath(f.file, repoRoot)
        if (safe === null) continue
        out.push({ ...f, file: safe })
    }
    return out
}

const computeBlocking = (findings, blockingSeverities) => {
    const set = new Set(blockingSeverities)
    return findings.filter((f) => set.has(f.severity))
}

// Derive the public status from kept findings and the blocking subset.
// Codex never returns GOOD_TO_GO_WITH_NOTES itself — that's a server-side
// notion based on severity classification.
const derivePublicStatus = ({ kept, blocking }) => {
    if (kept.length === 0) return "GOOD_TO_GO"
    if (blocking.length === 0) return "GOOD_TO_GO_WITH_NOTES"
    return "ISSUES"
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

// archive.write logs its own errors and returns {ok: boolean, error?}.
// We still wrap defensively: if an injected mock or a future bug throws
// in a way archive.write doesn't catch, we don't want the review path
// itself to crash. Any caught error is logged via the archive's own
// logger when it has one, otherwise dropped (which is the legacy
// behavior).
const safeArchive = (archive, args) => {
    if (!archive) return
    try {
        archive.write(args)
    } catch {
        // archive.write should not throw; this is a backstop.
    }
}

export const handleReview = async ({
    body,
    config,
    store,
    archive = null,
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
            // Re-sanitize the cached priors so legacy/corrupt state can't
            // leak unsafe paths back to callers. priorFindings is the
            // blocker subset by construction (Phase 3), so the same array
            // serves as both `findings` and `blockingFindings`.
            const cachedBlocking = resanitizeCached(
                state.priorFindings,
                context.repoRoot
            )
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
                    findings: cachedBlocking,
                    blockingFindings: cachedBlocking,
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

    // Build the wrapped prompt (system preamble + delimiters + payload +
    // optional prior findings + optional extras). All of Codex's view of
    // the world goes through this single function.
    const extraInstructions =
        typeof body?.extra_instructions === "string"
            ? body.extra_instructions
            : null
    const wrappedPrompt = wrapPrompt({
        payloadText: payload.promptText,
        priorFindings: state.priorFindings,
        extraInstructions,
    })

    let codexResult
    try {
        codexResult = await (deps.runAndParse ?? runAndParse)({
            repoRoot: context.repoRoot,
            prompt: wrappedPrompt,
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
        safeArchive(archive, {
            context,
            payload,
            codexRaw: {
                ...codexResult.raw,
                model: config.codex?.model ?? null,
            },
            result: {
                status: "ESCALATE",
                findings: [],
                blockingFindings: [],
                droppedFindings: [],
                reason: codexResult.reason,
                schemaError: codexResult.schemaError ?? null,
            },
            state: nextState,
            round: nextState.codexRounds,
            blockCount: nextState.blockCount,
            trigger,
            priorFindingsFedIn: state.priorFindings,
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

    // Codex returned a schema-valid result. Two post-processing passes:
    //   1) Drop findings that reference files outside the payload. Codex's
    //      sandbox lets it read additional files for context, but it may
    //      not raise issues against unchanged code. Out-of-payload findings
    //      are recorded as droppedFindings for visibility and discarded.
    //   2) Compute blockingFindings from the remaining set using
    //      config.blockingSeverities (the project-config-merged value when
    //      Phase 5 lands).
    const payloadPaths = collectPayloadPaths(payload)
    const { kept, dropped } = partitionFindings(
        codexResult.findings,
        payloadPaths,
        context.repoRoot
    )
    const blockingFindings = computeBlocking(kept, config.blockingSeverities)
    const status = derivePublicStatus({ kept, blocking: blockingFindings })

    const isTerminal =
        status === "GOOD_TO_GO" || status === "GOOD_TO_GO_WITH_NOTES"

    const nextState = {
        ...state,
        codexRounds: state.codexRounds + 1,
        lastBaseline: baselineSummary(payload),
        lastReviewedAt: now(),
        lastEscalateReason: null,
        lastResultStatus: status,
        // priorFindings tracks ONLY blockers across rounds — Codex's next
        // job is to verify each one is resolved, not to chase nits.
        priorFindings: status === "ISSUES" ? blockingFindings : [],
        // blockCount is consumed only by Stop-hook ISSUES results.
        blockCount:
            isStopHook(trigger) && status === "ISSUES"
                ? state.blockCount + 1
                : isTerminal
                  ? 0
                  : state.blockCount,
    }

    // Capture this round's counters BEFORE the terminal reset zeroes them,
    // so the archive records "round N / blockCount M" of the actual work
    // even when the loop just ended.
    const archivedRound = nextState.codexRounds
    const archivedBlockCount = nextState.blockCount

    if (isTerminal) {
        // Both terminal statuses end the loop — counters go to zero, the
        // prior-findings cache is dropped.
        nextState.codexRounds = 0
        nextState.blockCount = 0
        nextState.priorFindings = []
    }

    const saved = store.save(context.key, nextState)

    safeArchive(archive, {
        context,
        payload,
        codexRaw: {
            ...codexResult.raw,
            model: config.codex?.model ?? null,
        },
        result: {
            status,
            findings: kept,
            blockingFindings,
            droppedFindings: dropped,
        },
        state: saved,
        round: archivedRound,
        blockCount: archivedBlockCount,
        trigger,
        priorFindingsFedIn: state.priorFindings,
    })

    return {
        httpStatus: 200,
        body: {
            status,
            findings: kept,
            blockingFindings,
            droppedFindings: dropped,
            context: contextSummary(context),
            baseline: baselineSummary(payload),
            codex: codexSummary(codexResult),
            state: stateSummary(saved),
        },
    }
}

export const mountReviewRoute = (
    app,
    { config, store, archive = null, deps } = {}
) => {
    app.post("/review", async (req, res) => {
        const result = await handleReview({
            body: req.body,
            config,
            store,
            archive,
            deps,
        })
        res.status(result.httpStatus).json(result.body)
    })
}
