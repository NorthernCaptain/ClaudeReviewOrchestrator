/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { describe, expect, test } from "@jest/globals"
import {
    handleSetProvider,
    handleSetReviewerPreset,
    createProviderHandler,
    REVIEWER_PRESETS,
    VALID_PROVIDERS,
} from "./provider.js"

// Records each delta and answers like the shell's config transaction.
const fakeTransaction = (result = { revision: 3, replaced: [] }) => {
    const tx = async (delta) => {
        tx.calls.push(delta)
        return result
    }
    tx.calls = []
    return tx
}

const baseConfig = () => ({ reviewer: { provider: "gemini" } })

describe("handleSetProvider", () => {
    test.each([
        [{}, /provider is required/],
        [{ provider: 123 }, /provider is required/],
        [{ provider: "bogus" }, /unknown provider: bogus/],
    ])("400 for %j, without a transaction", async (body, error) => {
        const tx = fakeTransaction()
        const r = await handleSetProvider({
            body,
            config: baseConfig(),
            configTransaction: tx,
        })
        expect(r.httpStatus).toBe(400)
        expect(r.body.error).toMatch(error)
        expect(r.body.validProviders).toEqual(VALID_PROVIDERS)
        expect(tx.calls).toEqual([])
    })

    test.each(VALID_PROVIDERS)(
        "commits reviewer.provider=%s and reports the previous one",
        async (provider) => {
            const tx = fakeTransaction()
            const r = await handleSetProvider({
                body: { provider },
                config: baseConfig(),
                configTransaction: tx,
            })
            expect(tx.calls).toEqual([[[["reviewer", "provider"], provider]]])
            expect(r).toEqual({
                httpStatus: 200,
                body: {
                    ok: true,
                    provider,
                    previous: "gemini",
                    persisted: true,
                    revision: 3,
                },
            })
        }
    )

    test("previous is null without a reviewer block", async () => {
        const r = await handleSetProvider({
            body: { provider: "codex" },
            config: {},
            configTransaction: fakeTransaction(),
        })
        expect(r.body.previous).toBeNull()
    })

    test("a rejected transaction is the response", async () => {
        const r = await handleSetProvider({
            body: { provider: "codex" },
            config: baseConfig(),
            configTransaction: async () => {
                throw Object.assign(new Error("disk gone"), {
                    code: "CONFIG_FILE_UNREADABLE",
                    httpStatus: 500,
                })
            },
        })
        expect(r.httpStatus).toBe(500)
        expect(r.body).toMatchObject({ ok: false, error: "disk gone" })
    })
})

describe("handleSetReviewerPreset", () => {
    test("codex: commits model and reasoning effort", async () => {
        const tx = fakeTransaction()
        const r = await handleSetReviewerPreset({
            body: { preset: "gpt-6-astra:medium" },
            config: { reviewer: { provider: "codex" } },
            configTransaction: tx,
        })
        expect(r.httpStatus).toBe(200)
        expect(tx.calls).toEqual([
            [
                [["codex", "model"], "gpt-6-astra"],
                [["codex", "reasoningEffort"], "medium"],
            ],
        ])
        expect(r.body).toMatchObject({
            provider: "codex",
            model: "gpt-6-astra",
            effortOrMode: "medium",
            preset: "gpt-6-astra:medium",
            persisted: true,
        })
    })

    test("claude: commits model and effort without altering the provider", async () => {
        const tx = fakeTransaction()
        await handleSetReviewerPreset({
            body: { preset: "claude-fable-5-1:xhigh" },
            config: { reviewer: { provider: "claude" } },
            configTransaction: tx,
        })
        expect(tx.calls).toEqual([
            [
                [["reviewer", "claude", "model"], "claude-fable-5-1"],
                [["reviewer", "claude", "effort"], "xhigh"],
            ],
        ])
    })

    test("gemini: commits model and approval mode", async () => {
        const tx = fakeTransaction()
        await handleSetReviewerPreset({
            body: { preset: "gemini-3.5-flash:plan" },
            config: baseConfig(),
            configTransaction: tx,
        })
        expect(tx.calls).toEqual([
            [
                [["reviewer", "gemini", "model"], "gemini-3.5-flash"],
                [["reviewer", "gemini", "approvalMode"], "plan"],
            ],
        ])
    })

    test("rejects a preset that is not valid for the active provider", async () => {
        const tx = fakeTransaction()
        const r = await handleSetReviewerPreset({
            body: { preset: "claude-sonnet-5:high" },
            config: { reviewer: { provider: "codex" } },
            configTransaction: tx,
        })
        expect(r.httpStatus).toBe(400)
        expect(r.body.error).toMatch(/unknown model preset/)
        expect(tx.calls).toEqual([])
    })

    test("a rejected transaction is the response", async () => {
        const r = await handleSetReviewerPreset({
            body: { preset: "gpt-6-astra:medium" },
            config: {},
            configTransaction: async () => {
                throw new Error("config changed, reload the page")
            },
        })
        expect(r.httpStatus).toBe(409)
        expect(r.body.error).toMatch(/reload the page/)
    })

    test("catalog exposes model and effort choices for every provider", () => {
        expect(REVIEWER_PRESETS.codex).toContainEqual(
            expect.objectContaining({ id: "gpt-6.1-sol:high" })
        )
        expect(REVIEWER_PRESETS.codex).toContainEqual(
            expect.objectContaining({ id: "gpt-6.1-sol:xhigh" })
        )
        expect(REVIEWER_PRESETS.claude).toContainEqual(
            expect.objectContaining({ id: "claude-sonnet-5:high" })
        )
        expect(REVIEWER_PRESETS.claude).toContainEqual(
            expect.objectContaining({ id: "claude-sonnet-5:xhigh" })
        )
        expect(REVIEWER_PRESETS.gemini).toContainEqual(
            expect.objectContaining({ id: "gemini-3.5-flash:plan" })
        )
    })

    test("catalog lists the newest generation first with every effort", () => {
        const models = (provider) => [
            ...new Set(REVIEWER_PRESETS[provider].map((p) => p.model)),
        ]
        // Codex offers only the GPT-6 generation: 6.1 Sol plus 6 Astra / Luna.
        expect(models("codex")).toEqual([
            "gpt-6.1-sol",
            "gpt-6-astra",
            "gpt-6-luna",
        ])
        expect(models("claude").slice(0, 3)).toEqual([
            "claude-opus-5-5",
            "claude-fable-5-1",
            "claude-sonnet-5-5",
        ])
        for (const model of [
            "gpt-6.1-sol",
            "gpt-6-astra",
            "gpt-6-luna",
            "claude-opus-5-5",
            "claude-fable-5-1",
            "claude-sonnet-5-5",
        ]) {
            const provider = model.startsWith("gpt") ? "codex" : "claude"
            expect(
                REVIEWER_PRESETS[provider]
                    .filter((p) => p.model === model)
                    .map((p) => p.id)
            ).toEqual([`${model}:xhigh`, `${model}:high`, `${model}:medium`])
        }
    })

    test("orders effort variants from xhigh through medium for each model", () => {
        expect(
            REVIEWER_PRESETS.codex
                .filter((p) => p.model === "gpt-6.1-sol")
                .map((p) => p.effortOrMode)
        ).toEqual(["xhigh", "high", "medium"])
        expect(
            REVIEWER_PRESETS.claude
                .filter((p) => p.model === "claude-sonnet-5")
                .map((p) => p.effortOrMode)
        ).toEqual(["xhigh", "high", "medium"])
    })
})

describe("createProviderHandler", () => {
    const mkRes = () => {
        const res = { statusCode: 0, body: null }
        res.status = (c) => {
            res.statusCode = c
            return res
        }
        res.json = (b) => {
            res.body = b
            return res
        }
        return res
    }

    test("reads its options per request and replies with the result", async () => {
        const tx = fakeTransaction()
        const handler = createProviderHandler(() => ({
            config: baseConfig(),
            configTransaction: tx,
        }))
        const res = mkRes()
        await handler({ body: { provider: "codex" } }, res)
        expect(res.statusCode).toBe(200)
        expect(res.body.provider).toBe("codex")
        const bad = mkRes()
        await handler({ body: { provider: "nope" } }, bad)
        expect(bad.statusCode).toBe(400)
    })
})
