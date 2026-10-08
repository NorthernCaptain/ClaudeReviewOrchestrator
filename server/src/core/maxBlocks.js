/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

// Runtime max-blocks switch (v1.1.19). PUT /dashboard/max-blocks
// { value } sets limits.maxBlocks in the live config and in config.json
// together, so the next admitted stop-hook block-cap check honors the
// new limit and it survives a restart. Loopback-only, same trust
// boundary as the other dashboard mutation routes. Mirrors maxRounds.js — maxBlocks is
// the *other* loop cap (how many times the Stop hook may re-block a
// turn), and in the normal stop-hook loop it advances in lockstep with
// maxCodexRounds, so the lower of the two binds first.
//
// The change goes through the shell's config transaction (a delta merged
// into a fresh read of config.json, checked, then written atomically), so
// keys the holder doesn't own and unapplied manual edits are kept.

import { commitConfigChange, configChangeBody } from "./config.js"

// Sanity cap. Below 1 is meaningless (the stop hook could never make
// progress) and above MAX is almost certainly a misclick — the
// dashboard caller goes one step at a time anyway.
export const MIN_MAX_BLOCKS = 1
export const MAX_MAX_BLOCKS = 50

export const handleSetMaxBlocks = async ({
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
    if (value < MIN_MAX_BLOCKS || value > MAX_MAX_BLOCKS) {
        return {
            httpStatus: 400,
            body: {
                ok: false,
                error: `value must be in [${MIN_MAX_BLOCKS}, ${MAX_MAX_BLOCKS}]`,
            },
        }
    }

    const previous = config?.limits?.maxBlocks ?? null
    const result = await commitConfigChange({
        configTransaction,
        delta: [[["limits", "maxBlocks"], value]],
        logger,
        what: "maxBlocks",
    })
    if (!result.ok) return result.response
    return {
        httpStatus: 200,
        body: configChangeBody(result, { value, previous }),
    }
}
