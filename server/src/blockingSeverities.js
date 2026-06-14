/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

// Runtime blocking-severities switch (v1.1.13). PUT
// /dashboard/blocking-severities { value: [...] } mutates the live
// in-memory config.blockingSeverities so the very next review honors
// the new policy (which severities count as blocking → drive ISSUES
// vs GOOD_TO_GO_WITH_NOTES), and best-effort persists it to the
// on-disk config file (top-level `blockingSeverities`) so it survives
// a restart. Loopback-only, same trust boundary as the other
// dashboard mutation routes.
//
// Like the max-rounds switch, we persist by editing the existing
// config JSON in place rather than re-serializing the normalized
// in-memory object — keeps any operator-authored keys we don't model
// intact.

import { readFileSync, writeFileSync } from "node:fs"
import { defaultConfigPath } from "./config.js"

// Canonical severity ordering, most → least severe. The dashboard
// only offers cumulative prefixes of this list (blocker; blocker+major;
// …) but the handler normalizes any valid subset into this order so a
// hand-edited config or out-of-order payload still round-trips cleanly.
export const SEVERITY_ORDER = ["blocker", "major", "minor", "nit"]

const normalize = (arr) => {
    const set = new Set(arr)
    return SEVERITY_ORDER.filter((s) => set.has(s))
}

const persistBlockingSeverities = ({ configPath, value, fs }) => {
    const read = fs?.readFileSync ?? readFileSync
    const write = fs?.writeFileSync ?? writeFileSync
    const raw = read(configPath, "utf8")
    const parsed = JSON.parse(raw)
    parsed.blockingSeverities = value
    write(configPath, JSON.stringify(parsed, null, 2) + "\n", "utf8")
}

export const handleSetBlockingSeverities = ({
    body,
    config,
    configPath = defaultConfigPath(),
    logger = null,
    deps = {},
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
    config.blockingSeverities = value

    let persisted = false
    let persistError = null
    try {
        persistBlockingSeverities({ configPath, value, fs: deps.fs })
        persisted = true
    } catch (err) {
        persistError = err?.message ?? String(err)
        logger?.warn?.(
            { err: persistError, configPath, value },
            "blockingSeverities switched in memory but failed to persist to config file"
        )
    }

    logger?.info?.(
        { previous, value, persisted },
        "blockingSeverities switched"
    )

    return {
        httpStatus: 200,
        body: {
            ok: true,
            value,
            previous,
            persisted,
            ...(persistError ? { persistError } : {}),
        },
    }
}
