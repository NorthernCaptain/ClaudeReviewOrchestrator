/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

// Runtime reviewer-provider switch. PUT /provider { provider } sets
// reviewer.provider in the live config and in config.json together, so
// the next admitted review uses the new provider and it survives a
// restart. Behind the X-Review-Token middleware like every other
// mutating route.
//
// The change goes through the shell's config transaction (a delta merged
// into a fresh read of config.json, checked, then written atomically) —
// never a dump of the home-expanded, schema-normalized holder, which
// would rewrite paths and drop what the operator hand-authored.

import { commitConfigChange, configChangeBody } from "./config.js"

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

export const handleSetReviewerPreset = async ({
    body,
    config,
    configTransaction,
    logger = null,
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
    const delta =
        provider === "codex"
            ? [
                  [["codex", "model"], preset.model],
                  [["codex", "reasoningEffort"], preset.effortOrMode],
              ]
            : [
                  [["reviewer", provider, "model"], preset.model],
                  [
                      [
                          "reviewer",
                          provider,
                          provider === "claude" ? "effort" : "approvalMode",
                      ],
                      preset.effortOrMode,
                  ],
              ]
    const result = await commitConfigChange({
        configTransaction,
        delta,
        logger,
        what: "reviewer preset",
    })
    if (!result.ok) return result.response
    return {
        httpStatus: 200,
        body: configChangeBody(result, {
            provider,
            model: preset.model,
            effortOrMode: preset.effortOrMode,
            preset: preset.id,
        }),
    }
}

export const handleSetProvider = async ({
    body,
    config,
    configTransaction,
    logger = null,
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

    const previous = config?.reviewer?.provider ?? null
    const result = await commitConfigChange({
        configTransaction,
        delta: [[["reviewer", "provider"], provider]],
        logger,
        what: "reviewer provider",
    })
    if (!result.ok) return result.response
    return {
        httpStatus: 200,
        body: configChangeBody(result, { provider, previous }),
    }
}

// PUT /provider. `getOptions` is read per request
// ({ config, configTransaction, logger }).
export const createProviderHandler = (getOptions) => async (req, res) => {
    const { config, configTransaction, logger } = getOptions()
    const result = await handleSetProvider({
        body: req.body,
        config,
        configTransaction,
        logger,
    })
    res.status(result.httpStatus).json(result.body)
}
