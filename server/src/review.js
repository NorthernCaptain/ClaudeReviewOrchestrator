/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { createHash } from "node:crypto"
import { resolveContext, ContextError } from "./context.js"
import {
    buildPayload,
    currentHeadSha,
    isWorkingTreeClean,
    sanitizeFindingPath,
} from "./diff.js"
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
export const computeReviewConfigHash = (config, providerOverride = null) => {
    const blockingSeverities = [...(config.blockingSeverities ?? [])].sort()
    const ignorePaths = [...(config.ignorePaths ?? [])].sort()
    // The effective reviewer for THIS request: a per-call MCP override
    // wins, else the server's configured provider. The provider (and
    // its model) is part of the review policy — a different reviewer can
    // legitimately reach a different verdict on the same diff. Omitting
    // it let a cache hit (NO_CHANGES / NO_PROGRESS / CODEX_ERROR_CACHED)
    // return the PREVIOUS provider's result after `setprovider.sh` or a
    // per-call `provider` override, silently defeating the switch.
    const provider = providerOverride ?? config.reviewer?.provider ?? "codex"
    const providerModel = providerCfg(provider, config)?.model ?? null
    const policy = {
        blockingSeverities,
        ignorePaths,
        extraReviewerInstructions: config.extraReviewerInstructions ?? null,
        limits: {
            maxPayloadBytes: config.limits?.maxPayloadBytes ?? null,
            maxFileBytes: config.limits?.maxFileBytes ?? null,
            maxFiles: config.limits?.maxFiles ?? null,
        },
        // Toggling head-fallback changes WHICH diff the reviewer sees,
        // so a cached baseline from before the flip is no longer
        // comparable. Including it here invalidates the cache on
        // flip, forcing a fresh review.
        fallbackToHead: config.payload?.fallbackToHead === true,
        // Toggling verifyCleanTree changes whether the fast path is
        // willing to short-circuit on the dirty flag alone. Bust the
        // cache on flip so the operator sees the new behavior take
        // effect on the very next review.
        verifyCleanTree: config.payload?.verifyCleanTree === true,
        // Effective reviewer + model. A provider switch (server-wide or
        // per-call) invalidates the cached baseline so the newly
        // selected reviewer actually runs.
        provider,
        providerModel,
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

// ESCALATE notification gate (v0.1.14).
//
// Returns true only when ALL of:
//   1. The trigger is a Stop hook — only that path can act on
//      notifyUser=true (by emitting a decision:"block" reason).
//      Manual MCP request_review calls hand the response straight
//      back to Claude; gating them would silently consume the
//      single notification per failure run before the Stop hook
//      ever gets to use it.
//   2. The context's gate hasn't already been set by a prior Stop
//      hook in this failure run.
//
// At-most-once-per-failure-run notification, scoped to Stop hooks.
const computeNotifyUser = (state, trigger) =>
    isStopHook(trigger) && state.escalateNotified !== true

// Auth-class transient failure detection. When CODEX_ERROR's reason
// matches one of these patterns, the failure is almost certainly
// going to vanish once the user fixes the credential — so we
// deliberately DON'T save the cached-ESCALATE baseline. That way the
// next Stop after the user re-authenticates re-spawns the reviewer
// instead of returning the stale cached failure.
const AUTH_ERROR_PATTERNS = [
    /usage limit/i,
    /api[_-]?key/i,
    /not logged in/i,
    /unauthor/i,
    /rate limit/i,
    /\bquota\b/i,
]
const isTransientAuthError = (reason, stderr = "") => {
    const text = `${reason ?? ""}\n${stderr ?? ""}`
    return AUTH_ERROR_PATTERNS.some((re) => re.test(text))
}

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
    // "working-tree" | "head-fallback" — only set when the payload
    // came from a commit range (working tree was clean and the
    // fallback flag was on). null on older payloads.
    source: payload.source ?? null,
    baseSha: payload.baseSha ?? null,
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

// In-flight review tracker. Maps the full result-sharing key
// (context|force|provider) → Promise<{httpStatus,body}>. When a second
// IDENTICAL /review arrives while the first is still running, the
// second caller attaches to the first promise instead of starting a
// parallel reviewer. Cleared in `finally` so a failed review doesn't
// poison the slot.
//
// Module-scope by design: this is per-server-process. Tests inject their
// own Map via `deps.inflight` for isolation.
export const defaultInflight = new Map()

// Per-context serialization chain. Maps context.key → Promise of the
// last-queued pipeline for that context. A review's read-modify-write of
// stored state (store.get → store.save full-replacement) is NOT safe to
// run concurrently with another review for the same context: the last
// finisher would clobber counters / priorFindings / lastBaseline. The
// result-sharing key (above) intentionally differs by force/provider, so
// a force or provider-switched request does NOT attach — it would
// otherwise run a second state-mutating pipeline in parallel. To keep
// state mutations serialized while still allowing distinct results, each
// non-attaching pipeline chains AFTER the current context tail and only
// touches state once its predecessor has finished. Distinct contexts
// keep independent tails and still run in parallel.
//
// Tests inject their own Map via `deps.contextChains` for isolation.
export const defaultContextChains = new Map()

// Observability registry for in-flight reviews (v0.1.28). Parallel to
// `inflight` (which holds promises for dedup), this maps the same
// result-sharing key → { contextKey, repo, branch, provider, force,
// startedAt } so the dashboard can show what's running right now without
// unwrapping promises. Entry added when a pipeline registers, removed in
// the same `finally` as the inflight slot.
//
// Tests inject their own Map via `deps.inflightMeta`.
export const defaultInflightMeta = new Map()

// Snapshot the in-flight registry for the dashboard / GET /inflight.
// Returns one row per running review with elapsedMs computed against
// `now`, oldest first.
export const snapshotInFlight = (now = Date.now, meta = defaultInflightMeta) =>
    [...meta.values()]
        .map((m) => ({
            contextKey: m.contextKey,
            repo: m.repo,
            branch: m.branch,
            provider: m.provider,
            force: m.force === true,
            startedAt: m.startedAt,
            elapsedMs: Math.max(0, now() - m.startedAt),
        }))
        .sort((a, b) => a.startedAt - b.startedAt)

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

    const force = body?.force === true
    const providerOverride =
        typeof body?.provider === "string" && body.provider.length > 0
            ? body.provider
            : null

    log.info(
        {
            cwd: body?.cwd,
            trigger: body?.trigger ?? "manual",
            sessionId: body?.session_id ?? null,
            hasExtraInstructions:
                typeof body?.extra_instructions === "string" &&
                body.extra_instructions.length > 0,
            force,
            providerOverride,
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
    // Dedup key includes force + the EFFECTIVE provider (per-call
    // override, else the live server default). A `force:true` or
    // `provider`-override request promises a fresh / provider-specific
    // run, so it must NOT attach to (or be served by) an ordinary
    // in-flight review for the same context. Using the effective
    // provider (not just the per-call override) also means a live
    // `PUT /provider` switch made while a review is in flight takes
    // effect on the next plain request instead of attaching to the
    // old provider's running promise. Two identical plain requests
    // under the same provider still share one pipeline.
    const inflight = deps.inflight ?? defaultInflight
    const contextChains = deps.contextChains ?? defaultContextChains
    const inflightMeta = deps.inflightMeta ?? defaultInflightMeta
    const effectiveProvider =
        providerOverride ?? config.reviewer?.provider ?? "codex"
    const inflightKey = `${context.key}|force=${force}|provider=${effectiveProvider}`
    const existing = inflight.get(inflightKey)
    if (existing) {
        log.info(
            { contextKey: context.key, inflightKey, attached: true },
            "attached to in-flight review"
        )
        return existing
    }

    // Serialize against any pipeline already queued for this context.
    // We capture the current tail BEFORE installing ourselves as the new
    // tail, then await it (ignoring its outcome) before touching state.
    const prevTail = contextChains.get(context.key) ?? Promise.resolve()
    const serialized = prevTail !== undefined && contextChains.has(context.key)

    const pipelinePromise = (async () => {
        // Wait for any in-progress same-context review to finish so our
        // store.get → store.save sequence never races with theirs. We
        // swallow the predecessor's result/errors — we only care that it
        // has released the context.
        await prevTail.catch(() => {})
        if (serialized) {
            log.info(
                { contextKey: context.key, inflightKey },
                "serialized behind in-flight same-context review"
            )
        }
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
        const reviewConfigHash = computeReviewConfigHash(
            config,
            providerOverride
        )
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
                dirtySinceLastReview: state.dirtySinceLastReview,
            },
            "state loaded"
        )

        // Change-notification fast path (v0.1.11). When the PostToolUse
        // hook hasn't pinged /notify-change since the last terminal
        // success AND a shallow git probe confirms the working tree is
        // actually clean (catches IDE / out-of-Claude edits), return
        // NO_CHANGES immediately — no payload build, no hashing.
        //
        // We only fast-path off of terminal-success states. ISSUES /
        // ESCALATE / NO_PROGRESS land in the existing post-buildPayload
        // cache logic so their semantics (cached-blocking, cached-
        // escalate, blockCount accounting) stay intact.
        // force=true (v0.1.18): caller demanded a fresh reviewer run.
        // Skip every short-circuit (fast-path, NO_CHANGES, NO_PROGRESS,
        // CODEX_ERROR_CACHED) and every safety cap (MAX_BLOCKS,
        // MAX_CODEX_ROUNDS). Counters still increment so /status
        // reflects reality.
        const fastPathEligible =
            !force &&
            state.dirtySinceLastReview === false &&
            state.lastBaseline &&
            // The cached baseline must have been produced under the same
            // review policy (provider, model, blockingSeverities, …).
            // Without this, switching provider on an otherwise-unchanged
            // tree would still short-circuit NO_CHANGES from the old
            // provider instead of running the newly selected reviewer.
            state.lastBaseline.reviewConfigHash === reviewConfigHash &&
            (state.lastResultStatus === "GOOD_TO_GO" ||
                state.lastResultStatus === "GOOD_TO_GO_WITH_NOTES")
        if (fastPathEligible) {
            // Shallow probe #1 (correctness-critical, always on):
            // HEAD hasn't moved since the cached baseline was captured.
            // Catches commit/pull/rebase done outside Claude (or via
            // Claude's Bash tool, which doesn't fire PostToolUse:
            // Write|Edit|MultiEdit) — those leave the working tree
            // clean but invalidate the cached review.
            const headSha = (deps.currentHeadSha ?? currentHeadSha)(
                context.repoRoot,
                deps.git
            )
            const cachedHead = state.lastBaseline?.headSha ?? null
            const headMatches =
                typeof headSha === "string" &&
                typeof cachedHead === "string" &&
                headSha === cachedHead

            // Shallow probe #2 (optional, off by default):
            // `git status --porcelain -z` confirms the working tree
            // really has no uncommitted edits. Belt-and-braces against
            // edits that bypass the PostToolUse hook (IDE auto-save,
            // file-watcher tools, terminal edits). Toggle on via
            // `payload.verifyCleanTree` when you also edit outside
            // Claude. Default off — trust the dirty flag.
            const verifyTree = config.payload?.verifyCleanTree === true
            const treeClean =
                headMatches && verifyTree
                    ? (deps.isWorkingTreeClean ?? isWorkingTreeClean)(
                          context.repoRoot,
                          deps.git
                      )
                    : true
            if (headMatches && treeClean) {
                log.info(
                    {
                        lastResultStatus: state.lastResultStatus,
                        lastChangeAt: state.lastChangeAt ?? 0,
                        headSha: short(headSha, 12),
                        verifyCleanTree: verifyTree,
                    },
                    "fast-path: no changes since last terminal success"
                )
                return {
                    httpStatus: 200,
                    body: envelope("NO_CHANGES", {
                        context: contextSummary(context),
                        // Re-use the cached baseline so the response
                        // still carries the headSha / hashes the
                        // caller may rely on.
                        baseline: {
                            ...(state.lastBaseline ?? {}),
                            // Keep these in lockstep with the new
                            // payload-built baselineSummary shape so
                            // /status + dashboard rendering don't
                            // choke on missing fields.
                            source:
                                state.lastBaseline?.source ?? "working-tree",
                            baseSha: state.lastBaseline?.baseSha ?? null,
                        },
                        state: stateSummary(state),
                    }),
                }
            }
            log.info(
                {
                    lastResultStatus: state.lastResultStatus,
                    headMatches,
                    treeClean,
                    headSha: short(headSha, 12),
                    cachedHead: short(cachedHead, 12),
                    verifyCleanTree: verifyTree,
                },
                "fast-path: deferred — HEAD moved or tree dirty"
            )
        }

        // Stop-hook-only pre-cap: if we've already issued maxBlocks worth of
        // decision:"block" instructions this loop, escalate before doing any
        // more work. Manual MCP calls bypass this cap because they don't
        // consume block budget by definition.
        if (
            !force &&
            isStopHook(trigger) &&
            state.blockCount >= config.limits.maxBlocks
        ) {
            const notifyUser = computeNotifyUser(state, trigger)
            if (notifyUser) {
                store.save(context.key, {
                    ...state,
                    escalateNotified: true,
                })
            }
            return {
                httpStatus: 200,
                body: envelope("ESCALATE", {
                    reason: `block cap (${config.limits.maxBlocks}) reached for this context`,
                    code: "MAX_BLOCKS",
                    notifyUser,
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
                source: payload.source ?? "working-tree",
                // baseSha is null for the working-tree path; keep that
                // null in the log instead of routing through short() so
                // the intent is explicit at the call site and the field
                // value is unambiguous to anyone grepping the log.
                baseSha: payload.baseSha ? short(payload.baseSha, 12) : null,
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
                    // Not a reviewer failure — nothing to tell the user
                    // about. Hook stays silent and the turn ends.
                    notifyUser: false,
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
            !force &&
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
                // Defensive: if the cache says ISSUES but has nothing to
                // show (legacy idle-reset wiped priorFindings, state-file
                // downgrade, sanitize dropped every path), returning an
                // empty NO_PROGRESS_WITH_OPEN_ISSUES would tell Claude
                // "issues remain" with no findings to fix — blockCount
                // would climb to MAX_BLOCKS without progress. Fall
                // through to a real review instead, and DO NOT consume
                // the block budget.
                if (cachedBlocking.length === 0) {
                    log.warn(
                        {
                            priorFindingsLen: Array.isArray(state.priorFindings)
                                ? state.priorFindings.length
                                : 0,
                        },
                        "cache says ISSUES but priorFindings is empty after sanitize; falling through to a real review"
                    )
                } else {
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
                            baseline: baselineSummary(
                                payload,
                                reviewConfigHash
                            ),
                            state: stateSummary(nextState),
                        },
                    }
                }
            }
            if (state.lastResultStatus === "ESCALATE") {
                // The last Codex run failed (schema error, timeout, etc.). The
                // user hasn't edited anything; spawning Codex again with the same
                // prompt isn't going to help and would burn codexRounds for free.
                // Return the cached ESCALATE; stop_hook still consumes blockCount
                // so the loop eventually exits hard.
                const notifyUser = computeNotifyUser(state, trigger)
                let nextState = state
                if (isStopHook(trigger) || notifyUser) {
                    nextState = store.save(context.key, {
                        ...state,
                        blockCount: isStopHook(trigger)
                            ? state.blockCount + 1
                            : state.blockCount,
                        lastReviewedAt: now(),
                        escalateNotified:
                            notifyUser || state.escalateNotified === true,
                    })
                }
                log.warn(
                    {
                        lastEscalateReason: state.lastEscalateReason,
                        notifyUser,
                    },
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
                        notifyUser,
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
        if (!force && state.codexRounds >= config.limits.maxCodexRounds) {
            const notifyUser = computeNotifyUser(state, trigger)
            if (notifyUser) {
                store.save(context.key, {
                    ...state,
                    escalateNotified: true,
                })
            }
            log.warn(
                {
                    rounds: state.codexRounds,
                    cap: config.limits.maxCodexRounds,
                    notifyUser,
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
                    notifyUser,
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
            reviewerAdapter = (deps.pickReviewer ?? pickReviewer)(
                config,
                providerOverride
            )
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
            // Auth-class transient detection. When the reason matches a
            // known credential-style failure (usage limit, missing API
            // key, login expired, rate limit, quota), we DELIBERATELY
            // skip saving the cached-ESCALATE baseline — the failure
            // is almost certainly going to vanish once the user fixes
            // the credential, and we don't want a stale CODEX_ERROR_CACHED
            // to mask the recovered reviewer on the next Stop. We still
            // set escalateNotified so the loop doesn't pester Claude
            // again until a non-ESCALATE review clears it.
            const transientAuth = isTransientAuthError(
                codexResult.reason,
                codexResult.raw?.rawStderr ?? ""
            )
            const notifyUser = computeNotifyUser(state, trigger)
            const saveFields = transientAuth
                ? {
                      ...state,
                      codexRounds: state.codexRounds + 1,
                      lastReviewedAt: now(),
                      escalateNotified:
                          notifyUser || state.escalateNotified === true,
                      // Leave lastBaseline / lastResultStatus / lastEscalateReason
                      // UNCHANGED so the cache short-circuit does not fire on the
                      // next Stop — let the reviewer re-spawn after the user
                      // refreshes credentials.
                  }
                : {
                      ...state,
                      codexRounds: state.codexRounds + 1,
                      lastBaseline: baselineSummary(payload, reviewConfigHash),
                      lastReviewedAt: now(),
                      lastResultStatus: "ESCALATE",
                      lastEscalateReason: codexResult.reason,
                      escalateNotified:
                          notifyUser || state.escalateNotified === true,
                  }
            const nextState = store.save(context.key, saveFields)
            if (transientAuth) {
                log.warn(
                    {
                        reason: codexResult.reason,
                        notifyUser,
                    },
                    "reviewer failed with transient-auth reason — cache bypassed; next Stop will re-spawn"
                )
            }
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
                    notifyUser,
                    transientAuth,
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
            // Clear the change-notification flag only on terminal SUCCESS
            // (GOOD_TO_GO / GOOD_TO_GO_WITH_NOTES). ISSUES keeps it true —
            // there's work to do, and the next /review must run when
            // edits land. ESCALATE handled in its own branch above.
            dirtySinceLastReview: isTerminal
                ? false
                : (state.dirtySinceLastReview ?? true),
            // Any non-ESCALATE result means the reviewer ran end-to-end
            // successfully — even ISSUES is a successful run that just
            // happened to find blockers. Reset the notification gate
            // so a fresh ESCALATE down the line will tell the user
            // again.
            escalateNotified: false,
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

    inflight.set(inflightKey, pipelinePromise)
    // Become the new tail of this context's serialization chain so the
    // next non-attaching request queues behind us.
    contextChains.set(context.key, pipelinePromise)
    // Register observability metadata for the dashboard / GET /inflight.
    inflightMeta.set(inflightKey, {
        contextKey: context.key,
        repo: context.repo,
        branch: context.branch,
        provider: effectiveProvider,
        force,
        startedAt: now(),
    })
    try {
        return await pipelinePromise
    } finally {
        // Clear the result-sharing slot whether the pipeline resolved or
        // threw. A future identical request starts a fresh pipeline.
        inflight.delete(inflightKey)
        inflightMeta.delete(inflightKey)
        // Only clear the chain tail if we're still it — a later request
        // may have already chained behind us and become the new tail.
        if (contextChains.get(context.key) === pipelinePromise) {
            contextChains.delete(context.key)
        }
    }
}

export const mountReviewRoute = (
    app,
    {
        config,
        store,
        archive = null,
        logger = noopLogger,
        deps,
        metrics = null,
    } = {}
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
        if (metrics) metrics.record(result.body)
        res.status(result.httpStatus).json(result.body)
    })
}
