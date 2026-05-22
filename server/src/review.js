/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { createHash } from "node:crypto"
import { resolveContext, ContextError } from "./context.js"
import { buildPayload, sanitizeFindingPath } from "./diff.js"
import { pickReviewer, providerCfg, wrapPrompt } from "./reviewer.js"
import { loadProjectConfig, mergeWithGlobal } from "./project-config.js"

// Tail a string buffer for log lines — the reviewer's stderr is the
// gold for debugging auth/quota/network failures and we want it in
// the pipeline log without overflowing it. 800 bytes is enough for
// the "ERROR: ..." line + a bit of surrounding context.
const tailBytes = (s, n = 800) => {
    if (typeof s !== "string") return ""
    if (s.length <= n) return s
    return "…" + s.slice(-n)
}

const short = (s, n = 12) =>
    typeof s === "string" && s.length > n ? s.slice(0, n) : (s ?? null)

// Stable hash of the review-policy fields that change the meaning of a
// review result without necessarily changing the prompt bytes. The
// unchanged-baseline check requires this hash to match what was stored
// alongside lastBaseline; if any of these knobs flipped between rounds,
// the cache is invalidated and Codex re-runs.
//
// Notably included:
//   * blockingSeverities — flips between blocking and informational.
//   * extraReviewerInstructions — changes what the reviewer is told.
//   * ignorePaths — could affect which files Codex even sees.
//   * review-shaping limits — could cause different truncation behavior.
// Excluded: per-call body.extra_instructions (changes per request and is
// out of band with persistent state).
export const computeReviewConfigHash = (config) => {
    const blockingSeverities = [...(config.blockingSeverities ?? [])].sort()
    const ignorePaths = [...(config.ignorePaths ?? [])].sort()
    const policy = {
        blockingSeverities,
        ignorePaths,
        extraReviewerInstructions: config.extraReviewerInstructions ?? null,
        limits: {
            maxPayloadBytes: config.limits?.maxPayloadBytes ?? null,
            maxFileBytes: config.limits?.maxFileBytes ?? null,
            maxFiles: config.limits?.maxFiles ?? null,
        },
    }
    return createHash("sha256").update(JSON.stringify(policy)).digest("hex")
}

// Concatenate the project-config static directive and the per-call
// extra_instructions, in that order. Project guidance comes first so the
// caller's request layers on top of the project's review baseline.
const combineExtras = (projectExtras, callerExtras) => {
    const a =
        typeof projectExtras === "string" && projectExtras.length > 0
            ? projectExtras
            : null
    const b =
        typeof callerExtras === "string" && callerExtras.length > 0
            ? callerExtras
            : null
    if (a && b) return `${a}\n\n${b}`
    return a ?? b ?? null
}

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

const baselineSummary = (payload, reviewConfigHash = null) => ({
    headSha: payload.headSha,
    promptHash: payload.promptHash,
    progressHash: payload.progressHash,
    reviewConfigHash,
    files: payload.files,
    totalBytes: payload.totalBytes,
    truncated: payload.truncated,
})

// Compact reviewer summary embedded in the /review response body.
// Field stays named "codex" in the envelope for back-compat with
// existing hook + MCP clients; the `provider` sub-field is the new
// way for callers to render provider-aware messages (e.g. the Stop
// hook's block-reason header).
const codexSummary = (codexResult, providerName = null) => {
    const raw = codexResult.raw ?? {}
    return {
        provider: providerName,
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

const noopLogger = { info() {}, warn() {}, error() {} }

// In-flight review tracker. Maps context.key → Promise<{httpStatus,body}>.
// When a second /review arrives for the same context while the first is
// still spawning the reviewer / waiting for it to finish, the second
// caller attaches to the first promise instead of starting a parallel
// reviewer. Cleared in `finally` so a failed review doesn't poison the
// slot — the next caller is free to retry.
//
// Module-scope by design: this is per-server-process. Tests inject their
// own Map via `deps.inflight` for isolation.
export const defaultInflight = new Map()

export const handleReview = async ({
    body,
    config,
    store,
    archive = null,
    logger = noopLogger,
    deps = {},
    now = Date.now,
    requestId = null,
}) => {
    // Bind requestId so every log line through this request is correlatable
    // with the access-log entry the http-log middleware emits. The
    // child binding is extended once the context resolves so every
    // subsequent line carries repo / branch / cwd without restating them
    // at each call site.
    let log = logger.child
        ? logger.child({ requestId, component: "review" })
        : logger

    log.info(
        {
            cwd: body?.cwd,
            trigger: body?.trigger ?? "manual",
            sessionId: body?.session_id ?? null,
            hasExtraInstructions:
                typeof body?.extra_instructions === "string" &&
                body.extra_instructions.length > 0,
        },
        "review request received"
    )

    const cwd = body?.cwd
    if (!cwd) {
        log.warn({}, "review: missing cwd")
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
            err instanceof ContextError &&
            (err.code === "NOT_IN_ALLOWED_ROOT" ||
                err.code === "NOT_IN_CLIENT_ROOT")
                ? 403
                : 400
        log.warn(
            { err: err?.message, code: err?.code, httpStatus, cwd },
            "context resolution failed"
        )
        return { httpStatus, body: errorToEscalate(err) }
    }
    log.info(
        {
            repo: context.repo,
            branch: context.branch,
            repoRoot: context.repoRoot,
            contextKey: context.key,
        },
        "context resolved"
    )

    // Rebind log so every subsequent line carries the context fields —
    // looking at a single "spawning reviewer" or "review result" line is
    // enough to know which repo and branch were being reviewed without
    // cross-referencing requestId back to the "context resolved" entry.
    if (log.child) {
        log = log.child({
            repo: context.repo,
            branch: context.branch,
            cwd: context.repoRoot,
        })
    }

    // In-flight dedup. Claude Code re-fires the Stop hook on subsequent
    // stop events even while the previous hook invocation is still
    // waiting on /review — without dedup we'd spawn a parallel reviewer
    // for the same repo+branch, doubling cost and confusing state. The
    // second (and Nth) caller attaches to the first promise and gets
    // the same {httpStatus, body} back. Map entries are removed in
    // finally so the next request is free to spin up a fresh review.
    const inflight = deps.inflight ?? defaultInflight
    const existing = inflight.get(context.key)
    if (existing) {
        log.info(
            { contextKey: context.key, attached: true },
            "attached to in-flight review"
        )
        return existing
    }

    const pipelinePromise = (async () => {
        // Per-repo overrides via .review-orchestrator.json at the repo root.
        // The file is optional; loadProjectConfig returns null when missing or
        // invalid (after logging) so the loop keeps running on the global
        // config. Project keys win on a per-key basis for limits and replace
        // wholesale for ignorePaths / blockingSeverities / extraReviewerInstructions.
        const projectConfig = (deps.loadProjectConfig ?? loadProjectConfig)({
            repoRoot: context.repoRoot,
            logger: log,
        })
        config = mergeWithGlobal(config, projectConfig)
        const reviewConfigHash = computeReviewConfigHash(config)
        log.info(
            {
                hasProjectConfig: Boolean(projectConfig),
                reviewConfigHash: short(reviewConfigHash, 16),
                blockingSeverities: config.blockingSeverities,
                ignorePathsCount: config.ignorePaths?.length ?? 0,
                extraReviewerInstructionsSet: Boolean(
                    config.extraReviewerInstructions
                ),
            },
            "config resolved"
        )

        const trigger = body?.trigger ?? "manual"
        const state = store.get(context)
        log.info(
            {
                codexRounds: state.codexRounds,
                blockCount: state.blockCount,
                lastResultStatus: state.lastResultStatus,
                priorFindingsCount: Array.isArray(state.priorFindings)
                    ? state.priorFindings.length
                    : 0,
                hasLastBaseline: Boolean(state.lastBaseline),
            },
            "state loaded"
        )

        // Stop-hook-only pre-cap: if we've already issued maxBlocks worth of
        // decision:"block" instructions this loop, escalate before doing any
        // more work. Manual MCP calls bypass this cap because they don't
        // consume block budget by definition.
        if (
            isStopHook(trigger) &&
            state.blockCount >= config.limits.maxBlocks
        ) {
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
            log.error(
                { err: err?.message, stack: err?.stack },
                "payload build failed"
            )
            return { httpStatus: 500, body: errorToEscalate(err) }
        }
        log.info(
            {
                totalBytes: payload.totalBytes,
                nonBinaryFileCount: payload.nonBinaryFileCount,
                truncated: payload.truncated,
                modifiedCount: payload.files?.modified?.length ?? 0,
                untrackedCount: payload.files?.untracked?.length ?? 0,
                deletedCount: payload.files?.deleted?.length ?? 0,
                renamedCount: payload.files?.renamed?.length ?? 0,
                priorFindingContextCount:
                    payload.files?.priorFindingContext?.length ?? 0,
                headSha: short(payload.headSha, 12),
                promptHash: short(payload.promptHash, 16),
                progressHash: short(payload.progressHash, 16),
            },
            "payload built"
        )

        if (payload.empty || payload.nonBinaryFileCount === 0) {
            log.warn(
                {
                    empty: payload.empty,
                    nonBinaryFileCount: payload.nonBinaryFileCount,
                },
                "EMPTY_PAYLOAD — skipping reviewer"
            )
            return {
                httpStatus: 200,
                body: envelope("ESCALATE", {
                    reason: "payload empty or fully binary",
                    code: "EMPTY_PAYLOAD",
                    context: contextSummary(context),
                    baseline: baselineSummary(payload, reviewConfigHash),
                    state: stateSummary(state),
                }),
            }
        }

        // Change detection: NO_CHANGES or NO_PROGRESS_WITH_OPEN_ISSUES short
        // circuits before we spawn codex. The check requires BOTH the disk-
        // state hash AND the review-policy hash to match — a project edit to
        // blockingSeverities or extraReviewerInstructions invalidates the
        // cache even when the file bytes have not changed.
        const unchanged =
            state.lastBaseline &&
            state.lastBaseline.progressHash === payload.progressHash &&
            state.lastBaseline.reviewConfigHash === reviewConfigHash

        log.info(
            {
                unchanged: Boolean(unchanged),
                lastResultStatus: state.lastResultStatus,
            },
            "cache decision"
        )

        if (unchanged) {
            if (
                state.lastResultStatus === "GOOD_TO_GO" ||
                state.lastResultStatus === "GOOD_TO_GO_WITH_NOTES"
            ) {
                log.info({}, "short-circuit: NO_CHANGES")
                return {
                    httpStatus: 200,
                    body: envelope("NO_CHANGES", {
                        context: contextSummary(context),
                        baseline: baselineSummary(payload, reviewConfigHash),
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
                log.info(
                    { cachedBlockingCount: cachedBlocking.length },
                    "short-circuit: NO_PROGRESS_WITH_OPEN_ISSUES"
                )
                return {
                    httpStatus: 200,
                    body: {
                        status: "NO_PROGRESS_WITH_OPEN_ISSUES",
                        findings: cachedBlocking,
                        blockingFindings: cachedBlocking,
                        droppedFindings: [],
                        reason: "No on-disk progress on flagged files since the last review.",
                        context: contextSummary(context),
                        baseline: baselineSummary(payload, reviewConfigHash),
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
                log.warn(
                    { lastEscalateReason: state.lastEscalateReason },
                    "short-circuit: CODEX_ERROR_CACHED"
                )
                return {
                    httpStatus: 200,
                    body: envelope("ESCALATE", {
                        reason:
                            state.lastEscalateReason ??
                            "previous reviewer run failed and the on-disk state has not changed",
                        // code stays CODEX_ERROR_CACHED for back-compat
                        // with hook + MCP clients that key on this symbol.
                        code: "CODEX_ERROR_CACHED",
                        context: contextSummary(context),
                        baseline: baselineSummary(payload, reviewConfigHash),
                        state: stateSummary(nextState),
                    }),
                }
            }
        }

        // Cap check on reviewer rounds before spawning. The counter
        // increments before the spawn so a misbehaving reviewer can't
        // burn extra rounds via retries. (Internal state/config field
        // names keep the historic "codex" prefix for back-compat.)
        if (state.codexRounds >= config.limits.maxCodexRounds) {
            log.warn(
                {
                    rounds: state.codexRounds,
                    cap: config.limits.maxCodexRounds,
                },
                "reviewer round cap reached — refusing to spawn"
            )
            return {
                httpStatus: 200,
                body: envelope("ESCALATE", {
                    reason: `reviewer round cap (${config.limits.maxCodexRounds}) reached for this context`,
                    // code stays MAX_CODEX_ROUNDS for back-compat with
                    // hook + MCP clients that key on this symbol.
                    code: "MAX_CODEX_ROUNDS",
                    context: contextSummary(context),
                    state: stateSummary(state),
                }),
            }
        }

        // Build the wrapped prompt (system preamble + delimiters + payload +
        // optional prior findings + optional extras). All of Codex's view of
        // the world goes through this single function.
        //
        // The EXTRA_INSTRUCTIONS section gets the project-config directive
        // (config.extraReviewerInstructions) AND the caller-supplied
        // body.extra_instructions, in that order, separated by a blank line.
        // Both are optional; combineExtras returns null when neither is set.
        const callerExtras =
            typeof body?.extra_instructions === "string"
                ? body.extra_instructions
                : null
        const extraInstructions = combineExtras(
            config.extraReviewerInstructions,
            callerExtras
        )
        const wrappedPrompt = wrapPrompt({
            payloadText: payload.promptText,
            priorFindings: state.priorFindings,
            extraInstructions,
        })

        // Pick the reviewer adapter (codex or claude). The picker maps
        // config.reviewer.provider → the runAndParse/buildArgs pair so the
        // rest of this function is provider-agnostic.
        let reviewerAdapter
        try {
            reviewerAdapter = (deps.pickReviewer ?? pickReviewer)(config)
        } catch (err) {
            log.error(
                { err: err?.message, configReviewer: config.reviewer ?? null },
                "reviewer provider misconfigured"
            )
            return { httpStatus: 500, body: errorToEscalate(err) }
        }
        const providerName = reviewerAdapter.name

        // Log the exact argv we're about to spawn. The argv is reproducible
        // by hand from this single log line — gold for debugging auth /
        // quota / model issues with whichever reviewer is in use.
        try {
            const previewArgs = reviewerAdapter.buildArgs({
                repoRoot: context.repoRoot,
                config,
            })
            const pcfg = providerCfg(providerName, config)
            log.info(
                {
                    provider: providerName,
                    binary: reviewerAdapter.binary,
                    model: pcfg?.model,
                    effort: pcfg?.effort ?? pcfg?.reasoningEffort ?? null,
                    argv: [reviewerAdapter.binary, ...previewArgs],
                    promptBytes: Buffer.byteLength(wrappedPrompt, "utf8"),
                    hasPriorFindings:
                        Array.isArray(state.priorFindings) &&
                        state.priorFindings.length > 0,
                    hasExtraInstructions: Boolean(extraInstructions),
                },
                "spawning reviewer"
            )
        } catch (err) {
            log.warn(
                { err: err?.message, provider: providerName },
                "failed to log reviewer argv (continuing)"
            )
        }

        let codexResult
        try {
            // deps.runAndParse is a test-only override. When set, it BYPASSES
            // the picker — the configured provider is ignored. Tests rely on
            // this to stub the subprocess without spinning up a real adapter.
            // Production never sets it; deps.pickReviewer is the supported
            // injection point for swapping the adapter itself.
            codexResult = await (
                deps.runAndParse ?? reviewerAdapter.runAndParse
            )({
                repoRoot: context.repoRoot,
                prompt: wrappedPrompt,
                config,
            })
        } catch (err) {
            log.error(
                {
                    err: err?.message,
                    stack: err?.stack,
                    provider: providerName,
                },
                "reviewer spawn threw"
            )
            return { httpStatus: 502, body: errorToEscalate(err) }
        }

        {
            const raw = codexResult.raw ?? {}
            log.info(
                {
                    provider: providerName,
                    exitCode: raw.exitCode,
                    signal: raw.signal ?? null,
                    durationMs: raw.durationMs,
                    timedOut: Boolean(raw.timedOut),
                    oversize: Boolean(raw.oversize),
                    stdoutBytes: Buffer.byteLength(raw.rawStdout ?? "", "utf8"),
                    stderrBytes: Buffer.byteLength(raw.rawStderr ?? "", "utf8"),
                    resultStatus: codexResult.status,
                    reason: codexResult.reason ?? null,
                    // True when parseClaudeOutput had to extract the JSON
                    // from a prose-wrapped reply. Audit signal — if we see
                    // this often, tighten the directive or switch to a
                    // full --system-prompt replace.
                    salvaged: Boolean(codexResult.salvaged),
                },
                "reviewer finished"
            )
            // Soft-fail audit signal: Claude's `-p` mode commonly exits
            // non-zero even when it returned a valid envelope; the adapter
            // tolerates that and reports the parsed review. Surface a
            // warn-level line so a non-zero exit + non-ESCALATE result is
            // visible in the log instead of being silently swallowed.
            if (
                codexResult.status !== "ESCALATE" &&
                typeof raw.exitCode === "number" &&
                raw.exitCode !== 0
            ) {
                log.warn(
                    {
                        provider: providerName,
                        exitCode: raw.exitCode,
                        resultStatus: codexResult.status,
                    },
                    "reviewer exited non-zero but envelope was valid; trusting envelope"
                )
            }
            // When the reviewer failed, surface the stderr tail so the
            // actual cause (auth error, quota, network) lands in the
            // pipeline log without requiring a dive into the archive.
            if (
                codexResult.status === "ESCALATE" ||
                (typeof raw.exitCode === "number" && raw.exitCode !== 0)
            ) {
                log.warn(
                    {
                        provider: providerName,
                        stderrTail: tailBytes(raw.rawStderr ?? ""),
                        stdoutTail: tailBytes(raw.rawStdout ?? "", 400),
                        schemaError: codexResult.schemaError ?? null,
                    },
                    "reviewer stderr/stdout tail"
                )
            }
        }

        if (codexResult.status === "ESCALATE") {
            // Persist the baseline + the reason so a follow-up call without any
            // edits short-circuits to the cached ESCALATE instead of re-spinning
            // Codex (see the unchanged+ESCALATE branch above).
            const nextState = store.save(context.key, {
                ...state,
                codexRounds: state.codexRounds + 1,
                lastBaseline: baselineSummary(payload, reviewConfigHash),
                lastReviewedAt: now(),
                lastResultStatus: "ESCALATE",
                lastEscalateReason: codexResult.reason,
            })
            safeArchive(archive, {
                context,
                payload,
                codexRaw: {
                    ...codexResult.raw,
                    provider: providerName,
                    model: providerCfg(providerName, config)?.model ?? null,
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
                    // code stays CODEX_ERROR for back-compat with hook
                    // + MCP clients that key on this symbol.
                    code: "CODEX_ERROR",
                    context: contextSummary(context),
                    baseline: baselineSummary(payload, reviewConfigHash),
                    codex: codexSummary(codexResult, providerName),
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
        const blockingFindings = computeBlocking(
            kept,
            config.blockingSeverities
        )
        const status = derivePublicStatus({ kept, blocking: blockingFindings })

        const isTerminal =
            status === "GOOD_TO_GO" || status === "GOOD_TO_GO_WITH_NOTES"

        const nextState = {
            ...state,
            codexRounds: state.codexRounds + 1,
            lastBaseline: baselineSummary(payload, reviewConfigHash),
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

        log.info(
            {
                status,
                findingsCount: kept.length,
                blockingCount: blockingFindings.length,
                droppedCount: dropped.length,
                round: archivedRound,
                blockCount: archivedBlockCount,
                isTerminal,
            },
            "review result"
        )

        safeArchive(archive, {
            context,
            payload,
            codexRaw: {
                ...codexResult.raw,
                provider: providerName,
                model: providerCfg(providerName, config)?.model ?? null,
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
                baseline: baselineSummary(payload, reviewConfigHash),
                codex: codexSummary(codexResult, providerName),
                state: stateSummary(saved),
            },
        }
    })() // end of pipelinePromise IIFE

    inflight.set(context.key, pipelinePromise)
    try {
        return await pipelinePromise
    } finally {
        // Clear the slot whether the pipeline resolved or threw. A
        // future request for the same context starts a fresh pipeline.
        inflight.delete(context.key)
    }
}

export const mountReviewRoute = (
    app,
    { config, store, archive = null, logger = noopLogger, deps } = {}
) => {
    app.post("/review", async (req, res) => {
        const result = await handleReview({
            body: req.body,
            config,
            store,
            archive,
            logger,
            deps,
            requestId: req.requestId ?? null,
        })
        res.status(result.httpStatus).json(result.body)
    })
}
