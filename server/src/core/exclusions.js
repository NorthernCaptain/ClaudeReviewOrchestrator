/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

// Per-context exclusion list management (v1.1).
//
// Add or remove a finding-suppression entry on a stored context. The
// matching key is (file, message) — line number is deliberately
// excluded so an exclusion survives normal line shifts as the user
// edits the code. Returns the updated context (with full exclusions
// array and a sanitized priorFindings).
//
// Add is idempotent: a duplicate (same file + message) is a no-op.
// Remove is also idempotent: removing an entry that isn't there
// returns the current state unchanged.
//
// Adding an exclusion ALSO trims the matching entries out of the
// context's persisted priorFindings, so the NO_PROGRESS short-circuit
// stops surfacing items the user has chosen to ignore.

const isValidStr = (s) => typeof s === "string" && s.length > 0

const sameEntry = (a, b) => a?.file === b?.file && a?.message === b?.message

export const handleExclusionMutation = ({ body, store, now = Date.now }) => {
    const contextKey = body?.contextKey
    const file = body?.file
    const message = body?.message
    const action = body?.action

    if (!isValidStr(contextKey)) {
        return {
            httpStatus: 400,
            body: { ok: false, error: "contextKey is required" },
        }
    }
    if (action !== "add" && action !== "remove") {
        return {
            httpStatus: 400,
            body: { ok: false, error: "action must be 'add' or 'remove'" },
        }
    }
    if (!isValidStr(file) || !isValidStr(message)) {
        return {
            httpStatus: 400,
            body: {
                ok: false,
                error: "file and message are required (non-empty strings)",
            },
        }
    }

    const known = (store?.list?.() ?? []).find((c) => c.key === contextKey)
    if (!known) {
        return {
            httpStatus: 404,
            body: { ok: false, error: `unknown context: ${contextKey}` },
        }
    }

    const exclusions = Array.isArray(known.exclusions) ? known.exclusions : []
    const target = { file, message }
    const existingIdx = exclusions.findIndex((e) => sameEntry(e, target))

    let nextExclusions = exclusions
    let nextPriorFindings = Array.isArray(known.priorFindings)
        ? known.priorFindings
        : []

    if (action === "add") {
        if (existingIdx === -1) {
            nextExclusions = [
                ...exclusions,
                { file, message, excludedAt: now() },
            ]
        }
        // Strip matching findings from priorFindings so NO_PROGRESS
        // doesn't keep surfacing this one. (No-op if none match.)
        nextPriorFindings = nextPriorFindings.filter(
            (f) => !sameEntry(f, target)
        )
    } else {
        if (existingIdx !== -1) {
            nextExclusions = exclusions.filter((_, i) => i !== existingIdx)
        }
    }

    const writes = { ...known, exclusions: nextExclusions }
    const priorChanged =
        nextPriorFindings.length !==
            (Array.isArray(known.priorFindings)
                ? known.priorFindings.length
                : 0) ||
        nextPriorFindings.some((f, i) => f !== (known.priorFindings ?? [])[i])
    if (priorChanged) writes.priorFindings = nextPriorFindings

    // Cache invalidation (v1.1.5). When the exclusion list ACTUALLY
    // changes, the meaning of the cached review result changes too
    // (a previously-excluded finding may now block, or vice versa).
    // The fast-path and the post-payload `unchanged` check both gate
    // on `dirtySinceLastReview` / `lastBaseline`, so if we leave them
    // pointing at a stale verdict, an exclusion toggle followed by a
    // Stop event would short-circuit NO_CHANGES (or NO_PROGRESS) and
    // the reviewer never re-runs with the new exclusion list. Flip
    // the dirty flag and drop lastBaseline so the next review
    // actually spawns.
    const exclusionsChanged = nextExclusions !== exclusions
    if (exclusionsChanged) {
        writes.dirtySinceLastReview = true
        writes.lastBaseline = null
    }

    const saved = store.save(known.key, writes)

    return {
        httpStatus: 200,
        body: {
            ok: true,
            context: {
                key: saved.key,
                repoRoot: saved.repoRoot,
                branch: saved.branch,
            },
            action,
            exclusions: saved.exclusions ?? [],
        },
    }
}
