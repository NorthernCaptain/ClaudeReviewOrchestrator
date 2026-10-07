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

export const VALID_PROVIDERS = ["codex", "claude", "gemini"]

// Curated, CLI-compatible reviewer choices for the dashboard, newest
// generation first. Gemini's explicit names are the current coding-capable
// choices, plus its router.
export const REVIEWER_PRESETS = {
    codex: [
        {
            id: "gpt-6.1-sol:xhigh",
            model: "gpt-6.1-sol",
            effortOrMode: "xhigh",
        },
        {
            id: "gpt-6.1-sol:high",
            model: "gpt-6.1-sol",
            effortOrMode: "high",
        },
        {
            id: "gpt-6.1-sol:medium",
            model: "gpt-6.1-sol",
            effortOrMode: "medium",
        },
        {
            id: "gpt-6-astra:xhigh",
            model: "gpt-6-astra",
            effortOrMode: "xhigh",
        },
        {
            id: "gpt-6-astra:high",
            model: "gpt-6-astra",
            effortOrMode: "high",
        },
        {
            id: "gpt-6-astra:medium",
            model: "gpt-6-astra",
            effortOrMode: "medium",
        },
        {
            id: "gpt-6-luna:xhigh",
            model: "gpt-6-luna",
            effortOrMode: "xhigh",
        },
        {
            id: "gpt-6-luna:high",
            model: "gpt-6-luna",
            effortOrMode: "high",
        },
        {
            id: "gpt-6-luna:medium",
            model: "gpt-6-luna",
            effortOrMode: "medium",
        },
    ],
    claude: [
        {
            id: "claude-opus-5-5:xhigh",
            model: "claude-opus-5-5",
            effortOrMode: "xhigh",
        },
        {
            id: "claude-opus-5-5:high",
            model: "claude-opus-5-5",
            effortOrMode: "high",
        },
        {
            id: "claude-opus-5-5:medium",
            model: "claude-opus-5-5",
            effortOrMode: "medium",
        },
        {
            id: "claude-fable-5-1:xhigh",
            model: "claude-fable-5-1",
            effortOrMode: "xhigh",
        },
        {
            id: "claude-fable-5-1:high",
            model: "claude-fable-5-1",
            effortOrMode: "high",
        },
        {
            id: "claude-fable-5-1:medium",
            model: "claude-fable-5-1",
            effortOrMode: "medium",
        },
        {
            id: "claude-sonnet-5-5:xhigh",
            model: "claude-sonnet-5-5",
            effortOrMode: "xhigh",
        },
        {
            id: "claude-sonnet-5-5:high",
            model: "claude-sonnet-5-5",
            effortOrMode: "high",
        },
        {
            id: "claude-sonnet-5-5:medium",
            model: "claude-sonnet-5-5",
            effortOrMode: "medium",
        },
        {
            id: "claude-opus-5:xhigh",
            model: "claude-opus-5",
            effortOrMode: "xhigh",
        },
        {
            id: "claude-opus-5:high",
            model: "claude-opus-5",
            effortOrMode: "high",
        },
        {
            id: "claude-opus-5:medium",
            model: "claude-opus-5",
            effortOrMode: "medium",
        },
        {
            id: "claude-fable-5:xhigh",
            model: "claude-fable-5",
            effortOrMode: "xhigh",
        },
        {
            id: "claude-fable-5:high",
            model: "claude-fable-5",
            effortOrMode: "high",
        },
        {
            id: "claude-fable-5:medium",
            model: "claude-fable-5",
            effortOrMode: "medium",
        },
        {
            id: "claude-sonnet-5:xhigh",
            model: "claude-sonnet-5",
            effortOrMode: "xhigh",
        },
        {
            id: "claude-sonnet-5:high",
            model: "claude-sonnet-5",
            effortOrMode: "high",
        },
        {
            id: "claude-sonnet-5:medium",
            model: "claude-sonnet-5",
            effortOrMode: "medium",
        },
    ],
    gemini: [
        { id: "auto:plan", model: "auto", effortOrMode: "plan" },
        {
            id: "gemini-3.5-flash:plan",
            model: "gemini-3.5-flash",
            effortOrMode: "plan",
        },
        {
            id: "gemini-3.1-pro-preview:plan",
            model: "gemini-3.1-pro-preview",
            effortOrMode: "plan",
        },
    ],
}

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

const persistPreset = ({ configPath, provider, preset, fs }) => {
    const read = fs?.readFileSync ?? readFileSync
    const write = fs?.writeFileSync ?? writeFileSync
    const parsed = JSON.parse(read(configPath, "utf8"))
    if (provider === "codex") {
        parsed.codex = {
            ...(parsed.codex ?? {}),
            model: preset.model,
            reasoningEffort: preset.effortOrMode,
        }
    } else {
        parsed.reviewer = { ...(parsed.reviewer ?? {}) }
        parsed.reviewer[provider] = {
            ...(parsed.reviewer[provider] ?? {}),
            model: preset.model,
            ...(provider === "claude"
                ? { effort: preset.effortOrMode }
                : { approvalMode: preset.effortOrMode }),
        }
    }
    write(configPath, JSON.stringify(parsed, null, 2) + "\n", "utf8")
}

export const handleSetReviewerPreset = ({
    body,
    config,
    configPath,
    logger = null,
    deps = {},
}) => {
    const provider = config?.reviewer?.provider ?? "codex"
    const preset = REVIEWER_PRESETS[provider]?.find(
        (p) => p.id === body?.preset
    )
    if (!preset) {
        return {
            httpStatus: 400,
            body: { ok: false, error: "unknown model preset", provider },
        }
    }
    if (provider === "codex") {
        config.codex = {
            ...(config.codex ?? {}),
            model: preset.model,
            reasoningEffort: preset.effortOrMode,
        }
    } else {
        config.reviewer = { ...(config.reviewer ?? {}) }
        config.reviewer[provider] = {
            ...(config.reviewer[provider] ?? {}),
            model: preset.model,
            ...(provider === "claude"
                ? { effort: preset.effortOrMode }
                : { approvalMode: preset.effortOrMode }),
        }
    }
    let persisted = false
    let persistError = null
    try {
        persistPreset({ configPath, provider, preset, fs: deps.fs })
        persisted = true
    } catch (err) {
        persistError = err?.message ?? String(err)
        logger?.warn?.(
            { err: persistError, provider, preset: preset.id },
            "reviewer model preset switched in memory but failed to persist"
        )
    }
    logger?.info?.(
        { provider, preset: preset.id, persisted },
        "reviewer model preset switched"
    )
    return {
        httpStatus: 200,
        body: {
            ok: true,
            provider,
            model: preset.model,
            effortOrMode: preset.effortOrMode,
            preset: preset.id,
            persisted,
            ...(persistError ? { persistError } : {}),
        },
    }
}

export const handleSetProvider = ({
    body,
    config,
    configPath,
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

// PUT /provider. `getOptions` is read per request
// ({ config, configPath, logger, deps }).
export const createProviderHandler = (getOptions) => (req, res) => {
    const { config, configPath, logger, deps } = getOptions()
    const result = handleSetProvider({
        body: req.body,
        config,
        configPath,
        logger,
        deps,
    })
    res.status(result.httpStatus).json(result.body)
}
