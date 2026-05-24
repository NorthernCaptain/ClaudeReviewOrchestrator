/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { loadConfig, __test__ } from "./config.js"

const { expandHome, ConfigSchema } = __test__

const makeTmpDir = () => mkdtempSync(path.join(tmpdir(), "review-cfg-"))

const writeConfig = (dir, obj) => {
    const p = path.join(dir, "config.json")
    writeFileSync(p, JSON.stringify(obj))
    return p
}

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
        expect(result.codex.model).toBe("gpt-5.5")
        expect(result.codex.reasoningEffort).toBe("high")
        expect(result.limits.maxCodexRounds).toBe(5)
        expect(result.blockingSeverities).toEqual(["blocker", "major"])
    })
    test("rejects an unknown reasoningEffort value", () => {
        expect(() =>
            ConfigSchema.parse({
                authToken: "x",
                codex: { reasoningEffort: "ultra" },
            })
        ).toThrow()
    })
    test("reviewer block defaults to provider=codex with claude sub-defaults", () => {
        const r = ConfigSchema.parse({ authToken: "abc" })
        expect(r.reviewer.provider).toBe("codex")
        expect(r.reviewer.claude.model).toBe("claude-opus-4-7")
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
    test("accepts reviewer.provider=gemini with defaults", () => {
        const r = ConfigSchema.parse({
            authToken: "x",
            reviewer: { provider: "gemini" },
        })
        expect(r.reviewer.provider).toBe("gemini")
        expect(r.reviewer.gemini.model).toBe("auto")
        expect(r.reviewer.gemini.approvalMode).toBe("plan")
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

describe("loadConfig", () => {
    let dir
    beforeEach(() => {
        dir = makeTmpDir()
    })
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true })
    })

    test("loads a minimal valid config and expands ~ in allowedRoots", () => {
        const home = makeTmpDir()
        const cfgPath = writeConfig(dir, {
            authToken: "tok",
            allowedRoots: ["~/projects"],
            reviewsDir: "~/reviews",
            logging: { dir: "~/logs", level: "info" },
        })
        try {
            const cfg = loadConfig({ configPath: cfgPath, home })
            expect(cfg.authToken).toBe("tok")
            expect(cfg.allowedRoots).toHaveLength(1)
            expect(cfg.allowedRoots[0]).toContain("projects")
            expect(cfg.reviewsDir).toBe(path.join(home, "reviews"))
            expect(cfg.logging.dir).toBe(path.join(home, "logs"))
        } finally {
            rmSync(home, { recursive: true, force: true })
        }
    })

    test("throws CONFIG_NOT_FOUND when file is missing", () => {
        const cfgPath = path.join(dir, "missing.json")
        expect(() => loadConfig({ configPath: cfgPath })).toThrow(
            /config file not found/
        )
        try {
            loadConfig({ configPath: cfgPath })
        } catch (err) {
            expect(err.code).toBe("CONFIG_NOT_FOUND")
        }
    })

    test("throws CONFIG_INVALID_JSON on malformed JSON", () => {
        const cfgPath = path.join(dir, "bad.json")
        writeFileSync(cfgPath, "{ not json")
        try {
            loadConfig({ configPath: cfgPath })
            throw new Error("expected throw")
        } catch (err) {
            expect(err.code).toBe("CONFIG_INVALID_JSON")
        }
    })

    test("rethrows non-ENOENT fs errors verbatim", () => {
        const err = Object.assign(new Error("permission denied"), {
            code: "EACCES",
        })
        const read = () => {
            throw err
        }
        expect(() => loadConfig({ configPath: "/nope", read })).toThrow(
            "permission denied"
        )
    })

    test("throws CONFIG_INVALID and includes path in message", () => {
        const cfgPath = writeConfig(dir, {
            authToken: "x",
            port: -1,
        })
        try {
            loadConfig({ configPath: cfgPath })
            throw new Error("expected throw")
        } catch (err) {
            expect(err.code).toBe("CONFIG_INVALID")
            expect(err.message).toMatch(/port/)
        }
    })
})
