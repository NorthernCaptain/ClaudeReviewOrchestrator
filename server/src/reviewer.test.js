/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import {
    pickReviewer,
    providerCfg,
    DEFAULT_PROVIDER,
    wrapPrompt,
} from "./reviewer.js"
import { runAndParse as codexRunAndParse } from "./codex.js"
import { runAndParse as claudeRunAndParse } from "./claude.js"
import { runAndParse as geminiRunAndParse } from "./gemini.js"

const minimalConfig = (over = {}) => ({
    codex: {
        binary: "codex",
        model: "gpt-5.5",
        reasoningEffort: "high",
        ignoreProjectRules: true,
        extraArgs: [],
    },
    reviewer: {
        provider: "codex",
        claude: {
            binary: "claude",
            model: "claude-opus-4-7",
            effort: "high",
            permissionMode: "bypassPermissions",
            disallowedTools: ["Bash"],
            timeoutSeconds: 240,
            extraArgs: [],
        },
    },
    ...over,
})

describe("pickReviewer", () => {
    test("defaults to codex when reviewer is absent", () => {
        const r = pickReviewer({})
        expect(r.name).toBe("codex")
        expect(r.runAndParse).toBe(codexRunAndParse)
    })

    test("DEFAULT_PROVIDER is codex (backwards compat)", () => {
        expect(DEFAULT_PROVIDER).toBe("codex")
    })

    test("returns claude adapter when provider=claude", () => {
        const r = pickReviewer(minimalConfig({ reviewer: { provider: "claude" } }))
        expect(r.name).toBe("claude")
        expect(r.runAndParse).toBe(claudeRunAndParse)
    })

    test("returns gemini adapter when provider=gemini", () => {
        const r = pickReviewer(
            minimalConfig({ reviewer: { provider: "gemini" } })
        )
        expect(r.name).toBe("gemini")
        expect(r.runAndParse).toBe(geminiRunAndParse)
    })

    test("throws on unknown provider with a clear message", () => {
        expect(() =>
            pickReviewer({ reviewer: { provider: "bogus" } })
        ).toThrow(/unknown reviewer\.provider: bogus/)
    })

    test("binary tracks the provider", () => {
        const c = pickReviewer(minimalConfig())
        expect(c.binary).toBe("codex")
        const j = pickReviewer(
            minimalConfig({ reviewer: { provider: "claude" } })
        )
        expect(j.binary).toBe("claude")
        const g = pickReviewer(
            minimalConfig({ reviewer: { provider: "gemini" } })
        )
        expect(g.binary).toBe("gemini")
    })

    test("providerCfg resolves the right sub-object for each provider", () => {
        const cfg = {
            codex: { model: "gpt-5.5" },
            reviewer: {
                claude: { model: "claude-opus-4-7" },
                gemini: { model: "gemini-2.5-pro" },
            },
        }
        expect(providerCfg("codex", cfg).model).toBe("gpt-5.5")
        expect(providerCfg("claude", cfg).model).toBe("claude-opus-4-7")
        expect(providerCfg("gemini", cfg).model).toBe("gemini-2.5-pro")
    })

    test("codex buildArgs preview uses a schema placeholder", () => {
        const r = pickReviewer(minimalConfig())
        const args = r.buildArgs({ repoRoot: "/r", config: minimalConfig() })
        // The codex preview substitutes a placeholder for the schema path
        // so the log stays compact.
        expect(args).toContain("<output-schema>")
    })

    test("claude buildArgs preview redacts the inlined schema", () => {
        const cfg = minimalConfig({
            reviewer: {
                provider: "claude",
                claude: {
                    binary: "claude",
                    model: "claude-opus-4-7",
                    effort: "high",
                    permissionMode: "bypassPermissions",
                    disallowedTools: [],
                    timeoutSeconds: 240,
                    extraArgs: [],
                },
            },
        })
        const r = pickReviewer(cfg)
        const args = r.buildArgs({ repoRoot: "/r", config: cfg })
        const schemaIdx = args.indexOf("--json-schema")
        expect(schemaIdx).toBeGreaterThan(0)
        // The placeholder, not the inlined JSON.
        expect(args[schemaIdx + 1]).toBe("<reviewer-output-schema>")
    })
})

describe("wrapPrompt re-export", () => {
    test("module re-exports the same wrapPrompt used by codex", () => {
        const out = wrapPrompt({ payloadText: "diff" })
        expect(out).toContain("<<<REVIEW_SYSTEM>>>")
        expect(out).toContain("diff")
    })
})
