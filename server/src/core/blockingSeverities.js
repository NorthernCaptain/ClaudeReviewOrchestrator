/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

// Runtime blocking-severities switch (v1.1.13). PUT
// /dashboard/blocking-severities { value: [...] } sets
// blockingSeverities in the live config and in config.json together, so
// the next admitted review honors the new policy (which severities count
// as blocking → drive ISSUES vs GOOD_TO_GO_WITH_NOTES) and it survives a
// restart. Loopback-only, same trust boundary as the other
// dashboard mutation routes.
//
// The change goes through the shell's config transaction (a delta merged
// into a fresh read of config.json, checked, then written atomically), so
// keys the holder doesn't own and unapplied manual edits are kept.

import { commitConfigChange, configChangeBody } from "./config.js"

// Canonical severity ordering, most → least severe. The dashboard
// only offers cumulative prefixes of this list (blocker; blocker+major;
// …) but the handler normalizes any valid subset into this order so a
// hand-edited config or out-of-order payload still round-trips cleanly.
export const SEVERITY_ORDER = ["blocker", "major", "minor", "nit"]

const normalize = (arr) => {
    const set = new Set(arr)
    return SEVERITY_ORDER.filter((s) => set.has(s))
}

export const handleSetBlockingSeverities = async ({
    body,
    config,
    configTransaction,
    logger = null,
}) => {
    const raw = body?.value
    // An empty array is a legal policy ("nothing blocks" — every
    // finding is informational), so accept it; only a non-array is a
    // client error.
    if (!Array.isArray(raw)) {
        return {
            httpStatus: 400,
            body: {
                ok: false,
                error: "value is required (array of severities)",
            },
        }
    }
    const invalid = raw.filter((s) => !SEVERITY_ORDER.includes(s))
    if (invalid.length > 0) {
        return {
            httpStatus: 400,
            body: {
                ok: false,
                error: `invalid severities: ${invalid.join(", ")}`,
            },
        }
    }

    const value = normalize(raw)
    const previous = Array.isArray(config?.blockingSeverities)
        ? config.blockingSeverities
        : null
    const result = await commitConfigChange({
        configTransaction,
        delta: [[["blockingSeverities"], value]],
        logger,
        what: "blockingSeverities",
    })
    if (!result.ok) return result.response
    return {
        httpStatus: 200,
        body: configChangeBody(result, { value, previous }),
    }
}
