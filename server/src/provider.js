/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

// Runtime reviewer-provider switch. PUT /provider { provider } mutates
// the live in-memory config so the very next review uses the new
// provider, and best-effort persists the change to the on-disk config
// file so it survives a restart. Behind the X-Review-Token middleware
// like every other mutating route.
//
// We persist by reading the existing config JSON, setting only
// reviewer.provider, and writing it back — never serializing the
// home-expanded, schema-normalized in-memory object (that would
// rewrite paths and drop comments-by-omission semantics the operator
// hand-authored).

import { readFileSync, writeFileSync } from "node:fs"
import { defaultConfigPath } from "./config.js"

export const VALID_PROVIDERS = ["codex", "claude", "gemini"]

const persistProvider = ({ configPath, provider, fs }) => {
    const read = fs?.readFileSync ?? readFileSync
    const write = fs?.writeFileSync ?? writeFileSync
    const raw = read(configPath, "utf8")
    const parsed = JSON.parse(raw)
    if (!parsed.reviewer || typeof parsed.reviewer !== "object") {
        parsed.reviewer = {}
    }
    parsed.reviewer.provider = provider
    write(configPath, JSON.stringify(parsed, null, 2) + "\n", "utf8")
}

export const handleSetProvider = ({
    body,
    config,
    configPath = defaultConfigPath(),
    logger = null,
    deps = {},
}) => {
    const provider = body?.provider
    if (!provider || typeof provider !== "string") {
        return {
            httpStatus: 400,
            body: {
                ok: false,
                error: "provider is required",
                validProviders: VALID_PROVIDERS,
            },
        }
    }
    if (!VALID_PROVIDERS.includes(provider)) {
        return {
            httpStatus: 400,
            body: {
                ok: false,
                error: `unknown provider: ${provider}`,
                validProviders: VALID_PROVIDERS,
            },
        }
    }

    const previous = config.reviewer?.provider ?? null
    // Mutate the live config object in place. Every route was handed
    // this same reference at mount time, so the next request through
    // handleReview picks up the new provider immediately.
    if (!config.reviewer || typeof config.reviewer !== "object") {
        config.reviewer = {}
    }
    config.reviewer.provider = provider

    let persisted = false
    let persistError = null
    try {
        persistProvider({ configPath, provider, fs: deps.fs })
        persisted = true
    } catch (err) {
        persistError = err?.message ?? String(err)
        logger?.warn?.(
            { err: persistError, configPath, provider },
            "provider switched in memory but failed to persist to config file"
        )
    }

    logger?.info?.(
        { previous, provider, persisted },
        "reviewer provider switched"
    )

    return {
        httpStatus: 200,
        body: {
            ok: true,
            provider,
            previous,
            persisted,
            ...(persistError ? { persistError } : {}),
        },
    }
}

export const mountProviderRoute = (
    app,
    { config, configPath, logger, deps } = {}
) => {
    app.put("/provider", (req, res) => {
        const result = handleSetProvider({
            body: req.body,
            config,
            configPath,
            logger,
            deps,
        })
        res.status(result.httpStatus).json(result.body)
    })
}
