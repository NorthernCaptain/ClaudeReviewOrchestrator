/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { describe, expect, jest, test } from "@jest/globals"
import {
    handleSetProvider,
    handleSetReviewerPreset,
    mountProviderRoute,
    REVIEWER_PRESETS,
    VALID_PROVIDERS,
} from "./provider.js"

// In-memory fs double so tests never touch the real config file.
const makeFs = (initial = "{}") => {
    const store = { content: initial, writes: [] }
    return {
        readFileSync: jest.fn(() => store.content),
        writeFileSync: jest.fn((_path, data) => {
            store.content = data
            store.writes.push(data)
        }),
        __store: store,
    }
}

const baseConfig = () => ({ reviewer: { provider: "gemini" } })

describe("handleSetProvider — validation", () => {
    test("400 when provider is missing", () => {
        const r = handleSetProvider({ body: {}, config: baseConfig() })
        expect(r.httpStatus).toBe(400)
        expect(r.body.ok).toBe(false)
        expect(r.body.validProviders).toEqual(VALID_PROVIDERS)
    })

    test("400 when provider is not a string", () => {
        const r = handleSetProvider({
            body: { provider: 123 },
            config: baseConfig(),
        })
        expect(r.httpStatus).toBe(400)
    })

    test("400 on an unknown provider name", () => {
        const r = handleSetProvider({
            body: { provider: "bogus" },
            config: baseConfig(),
        })
        expect(r.httpStatus).toBe(400)
        expect(r.body.error).toMatch(/unknown provider: bogus/)
    })

    test.each(VALID_PROVIDERS)("accepts %s", (provider) => {
        const fs = makeFs(JSON.stringify(baseConfig()))
        const r = handleSetProvider({
            body: { provider },
            config: baseConfig(),
            configPath: "/cfg.json",
            deps: { fs },
        })
        expect(r.httpStatus).toBe(200)
        expect(r.body.provider).toBe(provider)
    })
})

describe("handleSetProvider — live mutation", () => {
    test("mutates config.reviewer.provider in place (live effect)", () => {
        const config = baseConfig()
        const fs = makeFs(JSON.stringify(config))
        handleSetProvider({
            body: { provider: "codex" },
            config,
            configPath: "/cfg.json",
            deps: { fs },
        })
        expect(config.reviewer.provider).toBe("codex")
    })

    test("reports the previous provider", () => {
        const config = baseConfig()
        const fs = makeFs(JSON.stringify(config))
        const r = handleSetProvider({
            body: { provider: "claude" },
            config,
            configPath: "/cfg.json",
            deps: { fs },
        })
        expect(r.body.previous).toBe("gemini")
        expect(r.body.provider).toBe("claude")
    })

    test("creates config.reviewer when absent", () => {
        const config = {}
        const fs = makeFs("{}")
        handleSetProvider({
            body: { provider: "codex" },
            config,
            configPath: "/cfg.json",
            deps: { fs },
        })
        expect(config.reviewer.provider).toBe("codex")
    })
})

describe("handleSetProvider — persistence", () => {
    test("writes only reviewer.provider back, preserving other keys", () => {
        const onDisk = {
            port: 7777,
            reviewer: { provider: "gemini", gemini: { model: "auto" } },
            limits: { maxBlocks: 6 },
        }
        const fs = makeFs(JSON.stringify(onDisk))
        const r = handleSetProvider({
            body: { provider: "codex" },
            config: baseConfig(),
            configPath: "/cfg.json",
            deps: { fs },
        })
        expect(r.body.persisted).toBe(true)
        const written = JSON.parse(fs.__store.content)
        expect(written.reviewer.provider).toBe("codex")
        // Untouched keys survive.
        expect(written.port).toBe(7777)
        expect(written.reviewer.gemini.model).toBe("auto")
        expect(written.limits.maxBlocks).toBe(6)
        // Trailing newline for a clean diff.
        expect(fs.__store.content.endsWith("\n")).toBe(true)
    })

    test("creates reviewer block in the file when missing on disk", () => {
        const fs = makeFs(JSON.stringify({ port: 7777 }))
        handleSetProvider({
            body: { provider: "claude" },
            config: baseConfig(),
            configPath: "/cfg.json",
            deps: { fs },
        })
        const written = JSON.parse(fs.__store.content)
        expect(written.reviewer.provider).toBe("claude")
    })

    test("still succeeds (in-memory) when persistence fails; reports persisted:false", () => {
        const config = baseConfig()
        const fs = {
            readFileSync: () => {
                throw new Error("disk gone")
            },
            writeFileSync: jest.fn(),
        }
        const warn = jest.fn()
        const r = handleSetProvider({
            body: { provider: "codex" },
            config,
            configPath: "/cfg.json",
            logger: { warn, info: jest.fn() },
            deps: { fs },
        })
        // Live switch still happened.
        expect(config.reviewer.provider).toBe("codex")
        expect(r.httpStatus).toBe(200)
        expect(r.body.ok).toBe(true)
        expect(r.body.persisted).toBe(false)
        expect(r.body.persistError).toMatch(/disk gone/)
        expect(warn).toHaveBeenCalled()
    })
})

describe("handleSetReviewerPreset", () => {
    test("changes codex model and reasoning effort live and on disk", () => {
        const config = {
            codex: { model: "gpt-5.5", reasoningEffort: "high" },
            reviewer: { provider: "codex" },
        }
        const fs = makeFs(JSON.stringify(config))
        const r = handleSetReviewerPreset({
            body: { preset: "gpt-5.6-terra:medium" },
            config,
            configPath: "/cfg.json",
            deps: { fs },
        })
        expect(r.httpStatus).toBe(200)
        expect(config.codex).toMatchObject({
            model: "gpt-5.6-terra",
            reasoningEffort: "medium",
        })
        expect(JSON.parse(fs.__store.content).codex.reasoningEffort).toBe(
            "medium"
        )
    })

    test("changes the active Claude preset without altering its provider", () => {
        const config = { reviewer: { provider: "claude", claude: {} } }
        const fs = makeFs(JSON.stringify(config))
        const r = handleSetReviewerPreset({
            body: { preset: "claude-sonnet-5:high" },
            config,
            configPath: "/cfg.json",
            deps: { fs },
        })
        expect(r.body).toMatchObject({
            provider: "claude",
            model: "claude-sonnet-5",
            effortOrMode: "high",
        })
        expect(config.reviewer.claude).toMatchObject({
            model: "claude-sonnet-5",
            effort: "high",
        })
    })

    test("rejects a preset that is not valid for the active provider", () => {
        const r = handleSetReviewerPreset({
            body: { preset: "claude-sonnet-5:high" },
            config: { reviewer: { provider: "codex" } },
        })
        expect(r.httpStatus).toBe(400)
        expect(r.body.error).toMatch(/unknown model preset/)
    })

    test("catalog exposes model and effort choices for every provider", () => {
        expect(REVIEWER_PRESETS.codex).toContainEqual(
            expect.objectContaining({ id: "gpt-5.6-sol:high" })
        )
        expect(REVIEWER_PRESETS.codex).toContainEqual(
            expect.objectContaining({ id: "gpt-5.6-sol:xhigh" })
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
})

describe("mountProviderRoute", () => {
    const mkRouteRecorder = () => {
        const routes = {}
        const app = {
            put: (path, handler) => {
                routes[`PUT ${path}`] = handler
            },
        }
        return { app, routes }
    }
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

    test("registers PUT /provider and switches via the handler", () => {
        const { app, routes } = mkRouteRecorder()
        const config = baseConfig()
        const fs = makeFs(JSON.stringify(config))
        mountProviderRoute(app, {
            config,
            configPath: "/cfg.json",
            deps: { fs },
        })
        const res = mkRes()
        routes["PUT /provider"]({ body: { provider: "codex" } }, res)
        expect(res.statusCode).toBe(200)
        expect(res.body.provider).toBe("codex")
        expect(config.reviewer.provider).toBe("codex")
    })

    test("PUT /provider returns 400 for a bad provider", () => {
        const { app, routes } = mkRouteRecorder()
        mountProviderRoute(app, {
            config: baseConfig(),
            configPath: "/cfg.json",
        })
        const res = mkRes()
        routes["PUT /provider"]({ body: { provider: "nope" } }, res)
        expect(res.statusCode).toBe(400)
    })
})
