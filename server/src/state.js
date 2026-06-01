/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import {
    readFileSync,
    writeFileSync,
    renameSync,
    mkdirSync,
    existsSync,
} from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

export const defaultStatePath = () =>
    path.join(homedir(), ".cache", "review-orchestrator", "state.json")

const blankContext = ({ key, repoRoot, branch }) => ({
    key,
    repoRoot,
    branch,
    codexRounds: 0,
    blockCount: 0,
    lastBaseline: null,
    priorFindings: [],
    // User-curated exclusion list (v1.1). Each entry is
    // { file, message, excludedAt }. Findings whose (file, message)
    // pair matches an entry are silently dropped from saved
    // priorFindings (so NO_PROGRESS doesn't fire on them) and listed
    // as a trusted directive in the next reviewer prompt.
    exclusions: [],
    lastReviewedAt: 0,
    lastResultStatus: null,
    lastEscalateReason: null,
    // Change-notification fast path (v0.1.11). The PostToolUse hook
    // pings POST /notify-change every time Claude edits a file; the
    // server flips this to true and the next /review can short-circuit
    // when dirty is false AND the working tree is shallow-clean.
    // Default true so the FIRST review for a fresh context always
    // runs (no notification has had a chance to land yet).
    dirtySinceLastReview: true,
    lastChangeAt: 0,
    // ESCALATE notification gate (v0.1.14). Flips true the first time
    // the server returns an ESCALATE-class result for this context;
    // flips back false when a non-ESCALATE terminal review completes.
    // The Stop hook uses the paired `notifyUser` field on the
    // response to decide whether to emit a decision:"block" reason
    // telling Claude to surface the failure to the user. At-most-once
    // notification per failure run.
    escalateNotified: false,
})

// Idle reset: clear LOOP counters but keep the content-keyed CACHE
// (lastBaseline + lastResultStatus + lastEscalateReason +
// priorFindings). The cache only short-circuits when progressHash +
// reviewConfigHash match, so retaining it across an arbitrarily long
// idle period is safe — it will simply miss when something has
// actually changed on disk. The counters are loop state (the verify-
// finding cycle, the block cap) and shouldn't persist past quiet
// periods, so those still reset.
//
// priorFindings was previously zeroed here, which silently broke the
// NO_PROGRESS_WITH_OPEN_ISSUES short-circuit: after a 10-minute idle,
// lastResultStatus stayed "ISSUES" but priorFindings became [], so the
// Stop hook saw "issues remain" with no findings to show, Claude had
// nothing to fix, and blockCount climbed to MAX_BLOCKS without
// progress. priorFindings is part of the cached ISSUES result, not a
// loop counter, so it must persist alongside lastResultStatus.
//
// lastReviewedAt is set to 0 so a follow-up get() doesn't trigger a
// second idle reset until a real review writes a new value.
const idleResetContext = ({ key, repoRoot, branch }, existing) => ({
    key,
    repoRoot,
    branch,
    codexRounds: 0,
    blockCount: 0,
    priorFindings: existing?.priorFindings ?? [],
    // User exclusions persist across idle reset (they reflect ongoing
    // policy, not transient loop state).
    exclusions: existing?.exclusions ?? [],
    lastReviewedAt: 0,
    lastBaseline: existing?.lastBaseline ?? null,
    lastResultStatus: existing?.lastResultStatus ?? null,
    lastEscalateReason: existing?.lastEscalateReason ?? null,
    // Preserve the dirty + lastChangeAt fields across idle reset for
    // the same reason we preserve lastBaseline: they're content-keyed
    // observational state, not loop counters.
    dirtySinceLastReview: existing?.dirtySinceLastReview ?? true,
    lastChangeAt: existing?.lastChangeAt ?? 0,
    escalateNotified: existing?.escalateNotified ?? false,
})

const cloneState = (state) => JSON.parse(JSON.stringify(state))

const loadFromDisk = (filePath) => {
    if (!filePath) return {}
    if (!existsSync(filePath)) return {}
    try {
        const raw = readFileSync(filePath, "utf8")
        const parsed = JSON.parse(raw)
        if (parsed && typeof parsed === "object" && parsed.contexts) {
            return parsed.contexts
        }
        return {}
    } catch {
        return {}
    }
}

const persistAtomically = (filePath, contexts) => {
    if (!filePath) return
    const dir = path.dirname(filePath)
    mkdirSync(dir, { recursive: true })
    const tmp = `${filePath}.tmp`
    const payload = JSON.stringify({ version: 1, contexts }, null, 2)
    writeFileSync(tmp, payload, { mode: 0o600 })
    renameSync(tmp, filePath)
}

export const createStateStore = ({
    filePath = defaultStatePath(),
    now = Date.now,
    idleResetMs = 10 * 60 * 1000,
} = {}) => {
    const contexts = loadFromDisk(filePath)

    const ensure = ({ key, repoRoot, branch }) => {
        if (!contexts[key]) {
            contexts[key] = blankContext({ key, repoRoot, branch })
        }
        return contexts[key]
    }

    const get = ({ key, repoRoot, branch }) => {
        const state = ensure({ key, repoRoot, branch })
        // Idle reset: clear loop counters but KEEP the content-keyed
        // cache (lastBaseline + lastResultStatus + lastEscalateReason).
        // See idleResetContext() for the rationale.
        if (
            state.lastReviewedAt > 0 &&
            now() - state.lastReviewedAt > idleResetMs
        ) {
            contexts[key] = idleResetContext({ key, repoRoot, branch }, state)
            persistAtomically(filePath, contexts)
        }
        return cloneState(contexts[key])
    }

    const save = (key, next) => {
        if (!contexts[key]) {
            contexts[key] = blankContext({
                key,
                repoRoot: next.repoRoot,
                branch: next.branch,
            })
        }
        Object.assign(contexts[key], next, { key })
        persistAtomically(filePath, contexts)
        return cloneState(contexts[key])
    }

    const reset = ({ key, repoRoot, branch }) => {
        // Preserve user-set exclusions across an explicit /reset —
        // they encode ongoing policy ('don't flag X here'), not loop
        // state that the user wanted cleared.
        const existing = contexts[key]
        const fresh = blankContext({ key, repoRoot, branch })
        fresh.exclusions = existing?.exclusions ?? []
        contexts[key] = fresh
        persistAtomically(filePath, contexts)
        return cloneState(contexts[key])
    }

    const list = () => Object.values(contexts).map(cloneState)

    // Read the current persisted state for a context WITHOUT triggering
    // idle reset, save, or cloning. Used by review.js right before
    // saving review results so a concurrent dashboard mutation
    // (e.g. POST /dashboard/exclusions during a long review) isn't
    // clobbered by the stale snapshot the review captured at its start.
    const peek = (key) => contexts[key] ?? null

    return { get, save, reset, list, peek }
}

export const __test__ = { blankContext, cloneState }
