/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { ensureToken } from "./ensure-token.mjs"

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
        expect(cfg.codex.model).toBe("gpt-5-codex")
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
