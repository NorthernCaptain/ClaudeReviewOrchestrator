/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

// Runtime max-blocks switch (v1.1.19). PUT /dashboard/max-blocks
// { value } mutates the live in-memory config so the very next
// stop-hook block-cap check honors the new limit, and best-effort
// persists the change to the on-disk config file (limits.maxBlocks)
// so it survives a restart. Loopback-only, same trust boundary as the
// other dashboard mutation routes. Mirrors maxRounds.js — maxBlocks is
// the *other* loop cap (how many times the Stop hook may re-block a
// turn), and in the normal stop-hook loop it advances in lockstep with
// maxCodexRounds, so the lower of the two binds first.
//
// We persist by editing the existing config JSON in place rather than
// re-serializing the home-expanded, schema-normalized in-memory
// object — keeps any operator-authored keys we don't model intact.

import { readFileSync, writeFileSync } from "node:fs"
import { defaultConfigPath } from "./config.js"

// Sanity cap. Below 1 is meaningless (the stop hook could never make
// progress) and above MAX is almost certainly a misclick — the
// dashboard caller goes one step at a time anyway.
export const MIN_MAX_BLOCKS = 1
export const MAX_MAX_BLOCKS = 50

const persistMaxBlocks = ({ configPath, value, fs }) => {
    const read = fs?.readFileSync ?? readFileSync
    const write = fs?.writeFileSync ?? writeFileSync
    const raw = read(configPath, "utf8")
    const parsed = JSON.parse(raw)
    if (!parsed.limits || typeof parsed.limits !== "object") {
        parsed.limits = {}
    }
    parsed.limits.maxBlocks = value
    write(configPath, JSON.stringify(parsed, null, 2) + "\n", "utf8")
}

export const handleSetMaxBlocks = ({
    body,
    config,
    configPath = defaultConfigPath(),
    logger = null,
    deps = {},
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
    if (!config.limits || typeof config.limits !== "object") {
        config.limits = {}
    }
    config.limits.maxBlocks = value

    let persisted = false
    let persistError = null
    try {
        persistMaxBlocks({ configPath, value, fs: deps.fs })
        persisted = true
    } catch (err) {
        persistError = err?.message ?? String(err)
        logger?.warn?.(
            { err: persistError, configPath, value },
            "maxBlocks switched in memory but failed to persist to config file"
        )
    }

    logger?.info?.({ previous, value, persisted }, "maxBlocks switched")

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
