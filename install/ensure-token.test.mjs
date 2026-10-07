/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import {
    chmodSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { ensureToken, runEnsureToken } from "./ensure-token.mjs"

const makeTmp = () => mkdtempSync(path.join(tmpdir(), "ensure-token-"))

describe("ensureToken", () => {
    let dir
    let home
    beforeEach(() => {
        dir = makeTmp()
        home = makeTmp()
    })
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true })
        rmSync(home, { recursive: true, force: true })
    })

    test("creates the file with a fresh token when missing", () => {
        const p = path.join(dir, "config.json")
        const r = ensureToken({
            configPath: p,
            home,
            generate: () => "GENERATED-TOKEN-AAA",
        })
        expect(r.action).toBe("installed")
        expect(r.token).toBe("GENERATED-TOKEN-AAA")
        const cfg = JSON.parse(readFileSync(p, "utf8"))
        expect(cfg.authToken).toBe("GENERATED-TOKEN-AAA")
        // Defaults landed.
        expect(cfg.port).toBe(7777)
        expect(cfg.codex.model).toBe("gpt-6.1-sol")
        expect(cfg.codex.reasoningEffort).toBe("high")
        // Reviewer block ships with provider=codex (existing behavior) and
        // Claude sub-config preloaded so flipping the provider needs no
        // hand-edits beyond the one key.
        expect(cfg.reviewer.provider).toBe("codex")
        expect(cfg.reviewer.claude.model).toBe("claude-opus-5")
        expect(cfg.reviewer.claude.effort).toBe("high")
        expect(cfg.reviewer.claude.permissionMode).toBe("bypassPermissions")
    })

    test("seeds allowedRoots with HOME when defaults.allowedRoots is empty", () => {
        const p = path.join(dir, "config.json")
        ensureToken({
            configPath: p,
            home,
            generate: () => "T",
        })
        const cfg = JSON.parse(readFileSync(p, "utf8"))
        expect(cfg.allowedRoots).toEqual([home])
    })

    test("preserves existing valid token (unchanged)", () => {
        const p = path.join(dir, "config.json")
        writeFileSync(
            p,
            JSON.stringify({ authToken: "EXISTING", port: 9999 }) + "\n"
        )
        const r = ensureToken({
            configPath: p,
            home,
            generate: () => "WOULD-NOT-USE",
        })
        expect(r.action).toBe("unchanged")
        expect(r.token).toBe("EXISTING")
        const cfg = JSON.parse(readFileSync(p, "utf8"))
        expect(cfg.authToken).toBe("EXISTING")
        expect(cfg.port).toBe(9999) // also preserved
    })

    test("adds a token to an existing tokenless config (updated)", () => {
        const p = path.join(dir, "config.json")
        writeFileSync(
            p,
            JSON.stringify({ port: 12345, allowedRoots: ["/x"] }) + "\n"
        )
        const r = ensureToken({
            configPath: p,
            home,
            generate: () => "FRESH",
        })
        expect(r.action).toBe("updated")
        expect(r.token).toBe("FRESH")
        const cfg = JSON.parse(readFileSync(p, "utf8"))
        expect(cfg.authToken).toBe("FRESH")
        expect(cfg.port).toBe(12345)
        expect(cfg.allowedRoots).toEqual(["/x"])
        // A locked update: the file as read is kept as a backup.
        const backups = readdirSync(dir).filter((n) =>
            n.startsWith("config.json.bak-")
        )
        expect(backups).toHaveLength(1)
        expect(
            JSON.parse(readFileSync(path.join(dir, backups[0]), "utf8"))
        ).toEqual({ port: 12345, allowedRoots: ["/x"] })
    })

    test("treats empty-string authToken as missing (regenerates)", () => {
        const p = path.join(dir, "config.json")
        writeFileSync(p, JSON.stringify({ authToken: "" }))
        const r = ensureToken({
            configPath: p,
            home,
            generate: () => "REPLACED",
        })
        expect(r.action).toBe("updated")
        expect(r.token).toBe("REPLACED")
    })

    test("throws on existing invalid JSON instead of clobbering", () => {
        const p = path.join(dir, "config.json")
        writeFileSync(p, "{ not json")
        expect(() =>
            ensureToken({
                configPath: p,
                home,
                generate: () => "T",
            })
        ).toThrow(/not valid JSON/)
    })

    test("repairs config permissions to 0600 even on unchanged-token path", () => {
        const p = path.join(dir, "config.json")
        writeFileSync(
            p,
            JSON.stringify({ authToken: "EXISTING-AND-VALID" }) + "\n"
        )
        chmodSync(p, 0o644) // simulate hand-edit / older install
        const r = ensureToken({
            configPath: p,
            home,
            generate: () => "would-not-use",
        })
        expect(r.action).toBe("unchanged")
        const mode = statSync(p).mode & 0o777
        expect(mode).toBe(0o600)
    })

    test("fresh install also enforces 0600", () => {
        const p = path.join(dir, "config.json")
        ensureToken({
            configPath: p,
            home,
            generate: () => "T",
        })
        const mode = statSync(p).mode & 0o777
        expect(mode).toBe(0o600)
    })

    test("creates parent directory on demand", () => {
        const p = path.join(dir, "deep", "nested", "config.json")
        ensureToken({
            configPath: p,
            home,
            generate: () => "T",
        })
        expect(readFileSync(p, "utf8")).toMatch(/"authToken":/)
    })
})

describe("runEnsureToken", () => {
    let home
    beforeEach(() => {
        home = mkdtempSync(path.join(tmpdir(), "ensure-token-home-"))
    })
    afterEach(() => {
        rmSync(home, { recursive: true, force: true })
    })

    test("writes config.json and the credentials cache only beneath the given home, under the lock", async () => {
        const configPath = path.join(
            home,
            ".config",
            "review-orchestrator",
            "config.json"
        )
        const locked = []
        const r = await runEnsureToken({
            configPath,
            home,
            generate: () => "TOK",
            lock: async (p, fn) => {
                locked.push(p)
                return fn()
            },
        })
        expect(r.action).toBe("installed")
        expect(locked).toEqual([configPath])
        const cache = path.join(
            home,
            ".cache",
            "review-orchestrator",
            "hook-credentials.json"
        )
        expect(JSON.parse(readFileSync(cache, "utf8")).token).toBe("TOK")
    })

    test("takes the real config lock by default", async () => {
        const configPath = path.join(home, "cfg", "config.json")
        await runEnsureToken({ configPath, home, generate: () => "T" })
        expect(readdirSync(path.dirname(configPath)).sort()).toEqual([
            "config.json",
            "config.json.lock",
        ])
    })
})
