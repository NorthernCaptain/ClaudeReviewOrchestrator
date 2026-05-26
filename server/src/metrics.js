/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

// In-process counters for the dashboard pie chart. Resets on server
// restart by design — these are operational stats, not durable data.
// The archive on disk is the source of truth for individual reviews.
//
// Three buckets:
//   - reviewed     : reviewer subprocess ran and returned a normal
//                    result (GOOD_TO_GO, GOOD_TO_GO_WITH_NOTES, ISSUES).
//   - shortCircuit : no spawn — cache hit, change-detection skip,
//                    safety cap, empty payload, or any pre-spawn
//                    validation rejection. None of these reach the
//                    archive.
//   - errors       : reviewer DID spawn and failed (status===ESCALATE
//                    with code===CODEX_ERROR). These are the entries
//                    that appear in the dashboard's Failed section.
//                    Anything else is bucketed as shortCircuit so the
//                    pie matches the archive view.

const REVIEWED_STATUSES = new Set([
    "GOOD_TO_GO",
    "GOOD_TO_GO_WITH_NOTES",
    "ISSUES",
])
const SHORT_CIRCUIT_STATUSES = new Set([
    "NO_CHANGES",
    "NO_PROGRESS_WITH_OPEN_ISSUES",
])

// classifyStatus accepts the full envelope (or just status as a string
// for callers from before the code-aware split). Returns a bucket name
// or null when the input is uncategorizable.
export const classifyStatus = (statusOrEnvelope, code = null) => {
    let status = statusOrEnvelope
    let resolvedCode = code
    if (statusOrEnvelope && typeof statusOrEnvelope === "object") {
        status = statusOrEnvelope.status
        resolvedCode = statusOrEnvelope.code ?? null
    }
    if (REVIEWED_STATUSES.has(status)) return "reviewed"
    if (SHORT_CIRCUIT_STATUSES.has(status)) return "shortCircuit"
    if (status === "ESCALATE") {
        // Only spawn-path failures (CODEX_ERROR) count as errors;
        // they're the ones that get archived and show up in the
        // dashboard's Failed section. All other ESCALATE codes
        // (cache, cap, validation) are bucketed as shortCircuit.
        return resolvedCode === "CODEX_ERROR" ? "errors" : "shortCircuit"
    }
    return null
}

export const createMetrics = () => {
    const counts = { reviewed: 0, shortCircuit: 0, errors: 0 }
    return {
        // Accepts either the full envelope ({status, code, ...}) so
        // the classifier can use the code, or just a status string
        // for backwards compatibility with older call sites.
        record(envelopeOrStatus) {
            const bucket = classifyStatus(envelopeOrStatus)
            if (bucket) counts[bucket] += 1
        },
        snapshot() {
            return { ...counts }
        },
        reset() {
            counts.reviewed = 0
            counts.shortCircuit = 0
            counts.errors = 0
        },
    }
}
