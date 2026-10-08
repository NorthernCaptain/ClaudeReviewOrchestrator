/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

// Runtime max-rounds switch (v1.1.8). PUT /dashboard/max-rounds
// { value } sets limits.maxCodexRounds in the live config and in
// config.json together, so the next admitted review honors the new cap
// and it survives a restart. Loopback-only, same trust boundary as the
// other dashboard mutation routes.
//
// The change goes through the shell's config transaction (a delta merged
// into a fresh read of config.json, checked, then written atomically), so
// keys the holder doesn't own and unapplied manual edits are kept.

import { commitConfigChange, configChangeBody } from "./config.js"

// Sanity cap. Below 1 is meaningless (the review loop can't make
// progress) and above MAX is almost certainly a misclick — the
// dashboard caller goes one step at a time anyway, so a real ramp
// past this would need a config-file edit, not a button mash.
export const MIN_MAX_ROUNDS = 1
export const MAX_MAX_ROUNDS = 50

export const handleSetMaxRounds = async ({
    body,
    config,
    configTransaction,
    logger = null,
}) => {
    const raw = body?.value
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
        return {
            httpStatus: 400,
            body: {
                ok: false,
                error: "value is required (integer)",
            },
        }
    }
    const value = Math.trunc(raw)
    if (value < MIN_MAX_ROUNDS || value > MAX_MAX_ROUNDS) {
        return {
            httpStatus: 400,
            body: {
                ok: false,
                error: `value must be in [${MIN_MAX_ROUNDS}, ${MAX_MAX_ROUNDS}]`,
            },
        }
    }

    const previous = config?.limits?.maxCodexRounds ?? null
    const result = await commitConfigChange({
        configTransaction,
        delta: [[["limits", "maxCodexRounds"], value]],
        logger,
        what: "maxCodexRounds",
    })
    if (!result.ok) return result.response
    return {
        httpStatus: 200,
        body: configChangeBody(result, { value, previous }),
    }
}
