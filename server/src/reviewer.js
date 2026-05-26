/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

// Reviewer provider picker. Maps config.reviewer.provider ("codex" |
// "claude" | "gemini") to the matching adapter module exports. All
// modules implement the same runAndParse / buildArgs / wrapPrompt
// contract so review.js can dispatch without provider-specific
// branches.

import {
    runAndParse as codexRunAndParse,
    buildCodexArgs,
    wrapPrompt,
} from "./codex.js"
import { runAndParse as claudeRunAndParse, buildClaudeArgs } from "./claude.js"
import { runAndParse as geminiRunAndParse, buildGeminiArgs } from "./gemini.js"

// Default provider when config.reviewer is absent. Backwards-compatible
// with installs predating the reviewer block — they keep using codex.
export const DEFAULT_PROVIDER = "codex"

const PROVIDERS = {
    codex: {
        name: "codex",
        runAndParse: codexRunAndParse,
        // Adapters wrap a canonical buildArgs signature so the review
        // pipeline can render a faithful argv preview into the log
        // regardless of provider.
        buildArgs: ({ repoRoot, config }) =>
            buildCodexArgs({
                repoRoot,
                config,
                schemaPath: "<output-schema>",
            }),
    },
    claude: {
        name: "claude",
        runAndParse: claudeRunAndParse,
        buildArgs: ({ repoRoot, config }) => {
            // The real --json-schema arg is the entire schema document
            // inlined. We don't want that ballooning every log line, so
            // replace it with a placeholder for the preview only.
            const args = buildClaudeArgs({
                repoRoot,
                config,
                sessionId: "<session>",
            })
            const idx = args.indexOf("--json-schema")
            if (idx >= 0 && idx + 1 < args.length) {
                args[idx + 1] = "<reviewer-output-schema>"
            }
            return args
        },
    },
    gemini: {
        name: "gemini",
        runAndParse: geminiRunAndParse,
        buildArgs: ({ config }) =>
            buildGeminiArgs({ config, sessionId: "<session>" }),
    },
}

// One-stop lookup that resolves the configured binary for each
// provider. Centralized so adding a new provider doesn't sprout
// ternaries through the picker.
const BINARY_RESOLVERS = {
    codex: (config) => config?.codex?.binary ?? "codex",
    claude: (config) => config?.reviewer?.claude?.binary ?? "claude",
    gemini: (config) => config?.reviewer?.gemini?.binary ?? "gemini",
}

export const pickReviewer = (config, override = null) => {
    const requested = override ?? config?.reviewer?.provider ?? DEFAULT_PROVIDER
    const entry = PROVIDERS[requested]
    if (!entry) {
        throw new Error(
            `unknown reviewer.provider: ${requested}. Valid: ${Object.keys(PROVIDERS).join(", ")}`
        )
    }
    return {
        ...entry,
        binary: BINARY_RESOLVERS[requested](config),
    }
}

// Returns the provider-specific config sub-object so callers (review.js
// log + archive metadata) don't have to branch on provider name.
export const providerCfg = (providerName, config) => {
    if (providerName === "claude") return config?.reviewer?.claude
    if (providerName === "gemini") return config?.reviewer?.gemini
    return config?.codex
}

// Re-export wrapPrompt verbatim — the prompt format (markers, system
// preamble, prior-findings, extras) is provider-agnostic.
export { wrapPrompt }

export const __test__ = { PROVIDERS }
