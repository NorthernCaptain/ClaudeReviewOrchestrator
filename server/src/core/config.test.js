/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
    commitConfigChange,
    configChangeBody,
    validateConfig,
    __test__,
} from "./config.js"

const { expandHome, ConfigSchema } = __test__

describe("expandHome", () => {
    test("returns home for bare ~", () => {
        expect(expandHome("~", "/Users/leo")).toBe("/Users/leo")
    })
    test("expands ~/...", () => {
        expect(expandHome("~/foo/bar", "/Users/leo")).toBe("/Users/leo/foo/bar")
    })
    test("leaves absolute paths alone", () => {
        expect(expandHome("/etc/foo", "/Users/leo")).toBe("/etc/foo")
    })
    test("leaves relative paths alone (no ~)", () => {
        expect(expandHome("./reviews", "/Users/leo")).toBe("./reviews")
    })
})

describe("ConfigSchema", () => {
    test("applies defaults when minimal config supplied", () => {
        const result = ConfigSchema.parse({ authToken: "abc" })
        expect(result.port).toBe(7777)
        expect(result.bind).toBe("127.0.0.1")
        expect(result.codex.model).toBe("gpt-6.1-sol")
        expect(result.codex.reasoningEffort).toBe("high")
        expect(result.limits.maxCodexRounds).toBe(5)
        expect(result.blockingSeverities).toEqual(["blocker", "major"])
    })
    test("limits.gitTimeoutSeconds defaults to 30 and is bounded", () => {
        expect(
            ConfigSchema.parse({ authToken: "x" }).limits.gitTimeoutSeconds
        ).toBe(30)
        expect(
            ConfigSchema.parse({
                authToken: "x",
                limits: { gitTimeoutSeconds: 5 },
            }).limits.gitTimeoutSeconds
        ).toBe(5)
        for (const bad of [0, 601, 1.5]) {
            expect(() =>
                ConfigSchema.parse({
                    authToken: "x",
                    limits: { gitTimeoutSeconds: bad },
                })
            ).toThrow()
        }
    })
    test("rejects an unknown reasoningEffort value", () => {
        expect(() =>
            ConfigSchema.parse({
                authToken: "x",
                codex: { reasoningEffort: "ultra" },
            })
        ).toThrow()
    })
    test("accepts Codex xhigh reasoning effort", () => {
        expect(
            ConfigSchema.parse({
                authToken: "x",
                codex: { reasoningEffort: "xhigh" },
            }).codex.reasoningEffort
        ).toBe("xhigh")
    })
    test("reviewer block defaults to provider=codex with claude sub-defaults", () => {
        const r = ConfigSchema.parse({ authToken: "abc" })
        expect(r.reviewer.provider).toBe("codex")
        expect(r.reviewer.claude.model).toBe("claude-opus-5")
        expect(r.reviewer.claude.effort).toBe("high")
        expect(r.reviewer.claude.permissionMode).toBe("bypassPermissions")
        expect(r.reviewer.claude.disallowedTools).toEqual(
            expect.arrayContaining(["Bash", "Edit", "Write"])
        )
    })
    test("reviewer.provider accepts 'claude' explicitly", () => {
        const r = ConfigSchema.parse({
            authToken: "x",
            reviewer: { provider: "claude" },
        })
        expect(r.reviewer.provider).toBe("claude")
    })
    test("accepts reviewer.provider=klaude with the claude knobs and its own binary", () => {
        const r = ConfigSchema.parse({
            authToken: "x",
            reviewer: { provider: "klaude", klaude: { effort: "max" } },
        })
        expect(r.reviewer.provider).toBe("klaude")
        expect(r.reviewer.klaude.binary).toBe("klaude")
        expect(r.reviewer.klaude.effort).toBe("max")
        expect(r.reviewer.klaude.disallowedTools).toEqual(
            r.reviewer.claude.disallowedTools
        )
        expect(r.reviewer.claude.binary).toBe("claude")
    })

    test("accepts reviewer.provider=gemini with defaults", () => {
        const r = ConfigSchema.parse({
            authToken: "x",
            reviewer: { provider: "gemini" },
        })
        expect(r.reviewer.provider).toBe("gemini")
        expect(r.reviewer.gemini.model).toBe("auto")
        expect(r.reviewer.gemini.effort).toBeNull()
        expect(r.reviewer.gemini.approvalMode).toBe("plan")
    })
    test("accepts a gemini effort the model offers", () => {
        const r = ConfigSchema.parse({
            authToken: "x",
            reviewer: {
                gemini: { model: "gemini-4-hydrogen", effort: "xhigh" },
            },
        })
        expect(r.reviewer.gemini.effort).toBe("xhigh")
    })
    test("rejects a gemini effort the model doesn't offer", () => {
        expect(() =>
            ConfigSchema.parse({
                authToken: "x",
                reviewer: {
                    gemini: { model: "gemini-4-carbon", effort: "xhigh" },
                },
            })
        ).toThrow("gemini-4-carbon takes effort high, medium, low or null")
    })
    test("an inherited property name is not a model with efforts", () => {
        for (const model of ["constructor", "toString", "__proto__"]) {
            expect(() =>
                ConfigSchema.parse({
                    authToken: "x",
                    reviewer: { gemini: { model, effort: "high" } },
                })
            ).toThrow(`${model} has no review efforts`)
        }
    })
    test("rejects a gemini effort for a model without efforts", () => {
        expect(() =>
            ConfigSchema.parse({
                authToken: "x",
                reviewer: { gemini: { model: "auto", effort: "high" } },
            })
        ).toThrow(
            "auto has no review efforts; use null or one of: gemini-4-hydrogen, gemini-4-carbon"
        )
    })
    test("rejects an unknown reviewer.provider", () => {
        expect(() =>
            ConfigSchema.parse({
                authToken: "x",
                reviewer: { provider: "bogus" },
            })
        ).toThrow()
    })
    test("rejects an unknown reviewer.gemini.approvalMode", () => {
        expect(() =>
            ConfigSchema.parse({
                authToken: "x",
                reviewer: { gemini: { approvalMode: "ludicrous" } },
            })
        ).toThrow()
    })
    test("rejects an unknown reviewer.claude.effort", () => {
        expect(() =>
            ConfigSchema.parse({
                authToken: "x",
                reviewer: { claude: { effort: "ludicrous" } },
            })
        ).toThrow()
    })
    test("hook block defaults fetchTimeoutSeconds to null (auto-derive)", () => {
        const r = ConfigSchema.parse({ authToken: "abc" })
        expect(r.hook.fetchTimeoutSeconds).toBeNull()
    })
    test("hook.fetchTimeoutSeconds accepts a positive integer", () => {
        const r = ConfigSchema.parse({
            authToken: "x",
            hook: { fetchTimeoutSeconds: 660 },
        })
        expect(r.hook.fetchTimeoutSeconds).toBe(660)
    })
    test("rejects a non-integer / non-null hook.fetchTimeoutSeconds", () => {
        expect(() =>
            ConfigSchema.parse({
                authToken: "x",
                hook: { fetchTimeoutSeconds: "60" },
            })
        ).toThrow()
    })
    test("payload.fallbackToHead defaults to false", () => {
        const r = ConfigSchema.parse({ authToken: "abc" })
        expect(r.payload.fallbackToHead).toBe(false)
    })
    test("caps reviewer timeouts at MAX_REVIEWER_TIMEOUT_SECONDS (1680)", () => {
        // The Stop hook waits reviewer+60s and is clamped to a fixed
        // ceiling the installed harness timeout sits above; a reviewer
        // timeout beyond the cap would let codex outlive the hook's
        // wait, so the schema rejects it.
        expect(() =>
            ConfigSchema.parse({
                authToken: "x",
                limits: { codexTimeoutSeconds: 1681 },
            })
        ).toThrow()
        expect(() =>
            ConfigSchema.parse({
                authToken: "x",
                reviewer: { claude: { timeoutSeconds: 5000 } },
            })
        ).toThrow()
        // The cap itself is accepted.
        const r = ConfigSchema.parse({
            authToken: "x",
            limits: { codexTimeoutSeconds: 1680 },
        })
        expect(r.limits.codexTimeoutSeconds).toBe(1680)
    })
    test("payload.verifyCleanTree defaults to false", () => {
        const r = ConfigSchema.parse({ authToken: "abc" })
        expect(r.payload.verifyCleanTree).toBe(false)
    })
    test("payload.verifyCleanTree accepts true explicitly", () => {
        const r = ConfigSchema.parse({
            authToken: "x",
            payload: { verifyCleanTree: true },
        })
        expect(r.payload.verifyCleanTree).toBe(true)
    })
    test("rejects a non-boolean payload.verifyCleanTree", () => {
        expect(() =>
            ConfigSchema.parse({
                authToken: "x",
                payload: { verifyCleanTree: "yes" },
            })
        ).toThrow()
    })
    test("payload.fallbackToHead accepts true explicitly", () => {
        const r = ConfigSchema.parse({
            authToken: "x",
            payload: { fallbackToHead: true },
        })
        expect(r.payload.fallbackToHead).toBe(true)
    })
    test("rejects a non-boolean payload.fallbackToHead", () => {
        expect(() =>
            ConfigSchema.parse({
                authToken: "x",
                payload: { fallbackToHead: "yes" },
            })
        ).toThrow()
    })
    test("rejects missing authToken", () => {
        expect(() => ConfigSchema.parse({})).toThrow()
    })
    test("rejects unknown top-level keys (strict)", () => {
        expect(() =>
            ConfigSchema.parse({ authToken: "x", bogus: true })
        ).toThrow()
    })
    test("rejects invalid severity in blockingSeverities", () => {
        expect(() =>
            ConfigSchema.parse({
                authToken: "x",
                blockingSeverities: ["whoops"],
            })
        ).toThrow()
    })
})

describe("validateConfig", () => {
    test("validates a parsed config and expands ~ in paths", () => {
        const home = mkdtempSync(path.join(tmpdir(), "review-cfg-"))
        try {
            const cfg = validateConfig(
                {
                    authToken: "tok",
                    allowedRoots: ["~/projects"],
                    reviewsDir: "~/reviews",
                    logging: { dir: "~/logs", level: "info" },
                },
                { home }
            )
            expect(cfg.authToken).toBe("tok")
            expect(cfg.allowedRoots).toHaveLength(1)
            expect(cfg.allowedRoots[0]).toContain("projects")
            expect(cfg.reviewsDir).toBe(path.join(home, "reviews"))
            expect(cfg.logging.dir).toBe(path.join(home, "logs"))
        } finally {
            rmSync(home, { recursive: true, force: true })
        }
    })

    test("throws CONFIG_INVALID naming the offending path", () => {
        try {
            validateConfig({ authToken: "x", port: -1 })
            throw new Error("expected throw")
        } catch (err) {
            expect(err.code).toBe("CONFIG_INVALID")
            expect(err.message).toMatch(/port/)
            expect(err.issues.length).toBeGreaterThan(0)
        }
    })
})

describe("reviewer.rulesFile", () => {
    test("defaults to null: the bundled rules", () => {
        expect(validateConfig({ authToken: "t" }).reviewer.rulesFile).toBe(null)
    })

    test("expands ~/ and keeps absolute paths", () => {
        const home = "/home/u"
        const at = (rulesFile) =>
            validateConfig(
                { authToken: "t", reviewer: { rulesFile } },
                { home }
            ).reviewer
        expect(at("~/rules/review.md").rulesFile).toBe(
            path.join(home, "rules/review.md")
        )
        expect(at("/etc/review.md").rulesFile).toBe("/etc/review.md")
        // The rest of the reviewer block keeps its defaults.
        expect(at("/etc/review.md").provider).toBe("codex")
    })

    test("rejects a relative path", () => {
        expect(() =>
            validateConfig({
                authToken: "t",
                reviewer: { rulesFile: "rules.md" },
            })
        ).toThrow(/reviewer\.rulesFile: must be an absolute path/)
    })
})

describe("port", () => {
    test("accepts 0 (an OS-assigned port) and rejects out-of-range values", () => {
        expect(validateConfig({ authToken: "t", port: 0 }).port).toBe(0)
        expect(() => validateConfig({ authToken: "t", port: -1 })).toThrow()
        expect(() => validateConfig({ authToken: "t", port: 65536 })).toThrow()
    })
})

describe("commitConfigChange + configChangeBody", () => {
    test("passes the delta to the transaction and shapes a success body", async () => {
        const calls = []
        const info = []
        const result = await commitConfigChange({
            configTransaction: async (delta) => {
                calls.push(delta)
                return { revision: 5, replaced: [{ key: "a", manualValue: 1 }] }
            },
            delta: [[["a"], 2]],
            logger: { info: (...a) => info.push(a) },
            what: "a",
        })
        expect(calls).toEqual([[[["a"], 2]]])
        expect(info).toHaveLength(1)
        expect(configChangeBody(result, { value: 2 })).toEqual({
            ok: true,
            value: 2,
            persisted: true,
            revision: 5,
            replacedManualEdits: [{ key: "a", manualValue: 1 }],
        })
    })

    test("a rejection becomes a ready response with its status and code", async () => {
        const result = await commitConfigChange({
            configTransaction: async () => {
                throw Object.assign(new Error("nope"), {
                    code: "X",
                    httpStatus: 500,
                })
            },
            delta: [],
            what: "x",
        })
        expect(result).toEqual({
            ok: false,
            response: {
                httpStatus: 500,
                body: { ok: false, error: "nope", code: "X" },
            },
        })
        const plain = await commitConfigChange({
            configTransaction: async () => {
                throw "boom"
            },
            delta: [],
            what: "x",
        })
        expect(plain.response).toEqual({
            httpStatus: 409,
            body: { ok: false, error: "boom", code: "CONFIG_CHANGE_FAILED" },
        })
    })

    test("no replaced edits means no replacedManualEdits field", () => {
        expect(
            configChangeBody({ revision: 1, replaced: [] }, { v: 1 })
        ).toEqual({ ok: true, v: 1, persisted: true, revision: 1 })
    })
})

describe("logging.level", () => {
    test("is one of the logger's levels", () => {
        expect(
            validateConfig({ authToken: "t", logging: { level: "debug" } })
                .logging.level
        ).toBe("debug")
        expect(() =>
            validateConfig({ authToken: "t", logging: { level: "bogus" } })
        ).toThrow(/logging\.level/)
    })
})
