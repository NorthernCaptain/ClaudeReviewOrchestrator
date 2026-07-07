/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import {
    chmodSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { mergeCodexMcp } from "./merge-codex-mcp.mjs"

const makeTmp = () => mkdtempSync(path.join(tmpdir(), "merge-codex-mcp-"))

describe("mergeCodexMcp", () => {
    let dir
    beforeEach(() => {
        dir = makeTmp()
    })
    afterEach(() => rmSync(dir, { recursive: true, force: true }))

    const cfg = (over = {}) => ({
        configTomlPath: path.join(dir, "config.toml"),
        token: "tok-abc",
        ...over,
    })

    test("creates config.toml with the managed review block when missing", () => {
        const p = path.join(dir, "config.toml")
        const r = mergeCodexMcp(cfg())
        expect(r.action).toBe("installed")
        const s = readFileSync(p, "utf8")
        expect(s).toContain("[mcp_servers.review]")
        expect(s).toContain('url = "http://127.0.0.1:7777/mcp"')
        expect(s).toContain('http_headers = { "X-Review-Token" = "tok-abc" }')
        expect(s).toContain("review-orchestrator:begin")
        expect(s).toContain("review-orchestrator:end")
    })

    test("is idempotent on re-run with the same token", () => {
        mergeCodexMcp(cfg())
        const r = mergeCodexMcp(cfg())
        expect(r.action).toBe("unchanged")
    })

    test("replaces the managed block when the token changes (single block)", () => {
        const p = path.join(dir, "config.toml")
        mergeCodexMcp(cfg({ token: "old" }))
        const r = mergeCodexMcp(cfg({ token: "new" }))
        expect(r.action).toBe("updated")
        const s = readFileSync(p, "utf8")
        expect(s).toContain('"X-Review-Token" = "new"')
        expect(s).not.toContain('"X-Review-Token" = "old"')
        // Exactly one managed block.
        expect(s.match(/review-orchestrator:begin/g)).toHaveLength(1)
        expect(s.match(/\[mcp_servers\.review\]/g)).toHaveLength(1)
    })

    test("preserves unrelated tables and appends with a separator", () => {
        const p = path.join(dir, "config.toml")
        writeFileSync(
            p,
            'model = "gpt-5.5"\n\n[mcp_servers.other]\nurl = "http://x/mcp"\n'
        )
        const r = mergeCodexMcp(cfg())
        expect(r.action).toBe("updated")
        const s = readFileSync(p, "utf8")
        expect(s).toContain('model = "gpt-5.5"')
        expect(s).toContain("[mcp_servers.other]")
        expect(s).toContain("[mcp_servers.review]")
        // Our table header is on its own line (not glued to prior content).
        expect(s).toMatch(/\n\[mcp_servers\.review\]/)
    })

    test("reads the token from config.json when not passed directly", () => {
        const p = path.join(dir, "config.toml")
        const tokenCfg = path.join(dir, "config.json")
        writeFileSync(tokenCfg, JSON.stringify({ authToken: "from-json" }))
        mergeCodexMcp({ configTomlPath: p, tokenConfigPath: tokenCfg })
        expect(readFileSync(p, "utf8")).toContain(
            '"X-Review-Token" = "from-json"'
        )
    })

    test("throws when config.json lacks an authToken", () => {
        const tokenCfg = path.join(dir, "config.json")
        writeFileSync(tokenCfg, JSON.stringify({ other: 1 }))
        expect(() =>
            mergeCodexMcp({
                configTomlPath: path.join(dir, "config.toml"),
                tokenConfigPath: tokenCfg,
            })
        ).toThrow(/no authToken/)
    })

    test("throws on malformed config.json", () => {
        const tokenCfg = path.join(dir, "config.json")
        writeFileSync(tokenCfg, "{ not json")
        expect(() =>
            mergeCodexMcp({
                configTomlPath: path.join(dir, "config.toml"),
                tokenConfigPath: tokenCfg,
            })
        ).toThrow(/failed to parse/)
    })

    test("escapes quotes/backslashes in the token", () => {
        const p = path.join(dir, "config.toml")
        mergeCodexMcp(cfg({ token: 'a"b\\c' }))
        const s = readFileSync(p, "utf8")
        expect(s).toContain('"X-Review-Token" = "a\\"b\\\\c"')
    })

    test("honors custom port and bind", () => {
        const p = path.join(dir, "config.toml")
        mergeCodexMcp(cfg({ port: 8888, bind: "127.0.0.1" }))
        expect(readFileSync(p, "utf8")).toContain(
            'url = "http://127.0.0.1:8888/mcp"'
        )
    })

    test("writes a backup only when bytes change", () => {
        const p = path.join(dir, "config.toml")
        const r1 = mergeCodexMcp(cfg({ now: () => "ts1" }))
        // First write created the file → no prior bytes to back up.
        expect(r1.backup).toBeNull()
        mergeCodexMcp(cfg({ token: "changed", now: () => "ts2" }))
        expect(() => readFileSync(`${p}.bak.ts2`)).not.toThrow()
    })

    test("config.toml and its token-bearing backup are owner-only (0600)", () => {
        const p = path.join(dir, "config.toml")
        mergeCodexMcp(cfg({ now: () => "ts1" }))
        expect(statSync(p).mode & 0o777).toBe(0o600)
        // A re-merge that changes the token backs up the old (token-
        // bearing) bytes; that backup must also be owner-only.
        mergeCodexMcp(cfg({ token: "changed", now: () => "ts2" }))
        expect(statSync(`${p}.bak.ts2`).mode & 0o777).toBe(0o600)
        expect(statSync(p).mode & 0o777).toBe(0o600)
    })

    test("repairs world-readable perms on the unchanged path", () => {
        const p = path.join(dir, "config.toml")
        mergeCodexMcp(cfg())
        // Simulate a file left 0644 by an earlier installer version.
        chmodSync(p, 0o644)
        const r = mergeCodexMcp(cfg()) // same token → unchanged bytes
        expect(r.action).toBe("unchanged")
        expect(statSync(p).mode & 0o777).toBe(0o600)
    })

    test("refuses to append when an unmanaged review table already exists", () => {
        const p = path.join(dir, "config.toml")
        writeFileSync(p, '[mcp_servers.review]\nurl = "http://hand/authored"\n')
        expect(() => mergeCodexMcp(cfg())).toThrow(/unmanaged/)
        // The file is left untouched (no duplicate table written).
        expect(readFileSync(p, "utf8")).not.toContain("review-orchestrator:")
    })

    test("detects an unmanaged review table even alongside our managed block", () => {
        const p = path.join(dir, "config.toml")
        mergeCodexMcp(cfg()) // writes our managed block
        // User then hand-adds a conflicting unmarked table.
        writeFileSync(
            p,
            readFileSync(p, "utf8") + '\n[mcp_servers.review]\nurl = "x"\n'
        )
        expect(() => mergeCodexMcp(cfg({ token: "new" }))).toThrow(/unmanaged/)
    })
})
