/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

// Runtime max-rounds switch (v1.1.8). PUT /dashboard/max-rounds
// { value } mutates the live in-memory config so the very next review
// honors the new cap, and best-effort persists the change to the
// on-disk config file (limits.maxCodexRounds) so it survives a
// restart. Loopback-only, same trust boundary as the other dashboard
// mutation routes.
//
// We persist by editing the existing config JSON in place rather than
// re-serializing the home-expanded, schema-normalized in-memory
// object — keeps any operator-authored keys we don't model intact.

import { readFileSync, writeFileSync } from "node:fs"
import { defaultConfigPath } from "./config.js"

// Sanity cap. Below 1 is meaningless (the review loop can't make
// progress) and above MAX is almost certainly a misclick — the
// dashboard caller goes one step at a time anyway, so a real ramp
// past this would need a config-file edit, not a button mash.
export const MIN_MAX_ROUNDS = 1
export const MAX_MAX_ROUNDS = 50

const persistMaxRounds = ({ configPath, value, fs }) => {
    const read = fs?.readFileSync ?? readFileSync
    const write = fs?.writeFileSync ?? writeFileSync
    const raw = read(configPath, "utf8")
    const parsed = JSON.parse(raw)
    if (!parsed.limits || typeof parsed.limits !== "object") {
        parsed.limits = {}
    }
    parsed.limits.maxCodexRounds = value
    write(configPath, JSON.stringify(parsed, null, 2) + "\n", "utf8")
}

export const handleSetMaxRounds = ({
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
    if (!config.limits || typeof config.limits !== "object") {
        config.limits = {}
    }
    config.limits.maxCodexRounds = value

    let persisted = false
    let persistError = null
    try {
        persistMaxRounds({ configPath, value, fs: deps.fs })
        persisted = true
    } catch (err) {
        persistError = err?.message ?? String(err)
        logger?.warn?.(
            { err: persistError, configPath, value },
            "maxCodexRounds switched in memory but failed to persist to config file"
        )
    }

    logger?.info?.({ previous, value, persisted }, "maxCodexRounds switched")

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
