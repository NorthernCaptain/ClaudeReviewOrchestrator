/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { mergeMcp } from "./merge-mcp.mjs"

const makeTmp = () => mkdtempSync(path.join(tmpdir(), "merge-mcp-"))

describe("mergeMcp", () => {
    let dir
    beforeEach(() => {
        dir = makeTmp()
    })
    afterEach(() => rmSync(dir, { recursive: true, force: true }))

    const HELPER = "/Users/x/.config/review-orchestrator/mcp-headers.sh"

    test("creates ~/.claude.json with our review entry when file is missing", () => {
        const p = path.join(dir, ".claude.json")
        const r = mergeMcp({
            claudeJsonPath: p,
            headersHelperPath: HELPER,
        })
        expect(r.action).toBe("installed")
        const cfg = JSON.parse(readFileSync(p, "utf8"))
        expect(cfg.mcpServers.review).toEqual({
            type: "http",
            url: "http://127.0.0.1:7777/mcp",
            headersHelper: HELPER,
        })
    })

    test("adds review entry to an existing file without disturbing other servers", () => {
        const p = path.join(dir, ".claude.json")
        writeFileSync(
            p,
            JSON.stringify({
                otherKey: "preserved",
                mcpServers: {
                    other: { type: "stdio", command: "/bin/echo" },
                },
            })
        )
        const r = mergeMcp({
            claudeJsonPath: p,
            headersHelperPath: HELPER,
        })
        expect(r.action).toBe("updated")
        const cfg = JSON.parse(readFileSync(p, "utf8"))
        expect(cfg.otherKey).toBe("preserved")
        expect(cfg.mcpServers.other).toEqual({
            type: "stdio",
            command: "/bin/echo",
        })
        expect(cfg.mcpServers.review.url).toBe("http://127.0.0.1:7777/mcp")
    })

    test("replaces an existing review entry on rerun (drift correction)", () => {
        const p = path.join(dir, ".claude.json")
        writeFileSync(
            p,
            JSON.stringify({
                mcpServers: {
                    review: {
                        type: "http",
                        url: "http://127.0.0.1:9999/mcp",
                        headersHelper: "/old/path/script.sh",
                    },
                },
            })
        )
        const r = mergeMcp({
            claudeJsonPath: p,
            headersHelperPath: HELPER,
        })
        expect(r.action).toBe("updated")
        const cfg = JSON.parse(readFileSync(p, "utf8"))
        expect(cfg.mcpServers.review.headersHelper).toBe(HELPER)
        expect(cfg.mcpServers.review.url).toBe("http://127.0.0.1:7777/mcp")
    })

    test("returns unchanged when our entry already matches", () => {
        const p = path.join(dir, ".claude.json")
        const desired = {
            mcpServers: {
                review: {
                    type: "http",
                    url: "http://127.0.0.1:7777/mcp",
                    headersHelper: HELPER,
                },
            },
        }
        writeFileSync(p, JSON.stringify(desired, null, 2) + "\n")
        const r = mergeMcp({
            claudeJsonPath: p,
            headersHelperPath: HELPER,
        })
        expect(r.action).toBe("unchanged")
    })

    test("writes a .bak.<ts> backup only when bytes change", () => {
        const p = path.join(dir, ".claude.json")
        writeFileSync(p, JSON.stringify({ other: "v" }))
        const r1 = mergeMcp({
            claudeJsonPath: p,
            headersHelperPath: HELPER,
            now: () => "2026-05-21T14-30-45-000Z",
        })
        expect(r1.backup).toMatch(/\.bak\.2026-05-21T14-30-45-000Z$/)
        // Re-run with the SAME inputs → should be unchanged → no new backup.
        const r2 = mergeMcp({
            claudeJsonPath: p,
            headersHelperPath: HELPER,
            now: () => "2026-05-21T14-30-46-000Z",
        })
        expect(r2.action).toBe("unchanged")
        // Only the first backup exists; no second-timestamp backup.
        const fs = readFileSync
        expect(() => fs(`${p}.bak.2026-05-21T14-30-46-000Z`)).toThrow()
    })

    test("rejects non-object root JSON", () => {
        const p = path.join(dir, ".claude.json")
        writeFileSync(p, JSON.stringify([1, 2, 3]))
        expect(() =>
            mergeMcp({
                claudeJsonPath: p,
                headersHelperPath: HELPER,
            })
        ).toThrow(/not an object/)
    })

    test("rejects invalid JSON instead of clobbering", () => {
        const p = path.join(dir, ".claude.json")
        writeFileSync(p, "{ not json")
        expect(() =>
            mergeMcp({
                claudeJsonPath: p,
                headersHelperPath: HELPER,
            })
        ).toThrow(/failed to parse/)
    })

    test("treats an empty file as an empty object (writes from scratch)", () => {
        const p = path.join(dir, ".claude.json")
        writeFileSync(p, "")
        const r = mergeMcp({
            claudeJsonPath: p,
            headersHelperPath: HELPER,
        })
        expect(r.action).toBe("updated")
        const cfg = JSON.parse(readFileSync(p, "utf8"))
        expect(cfg.mcpServers.review.headersHelper).toBe(HELPER)
    })

    test("honors custom port and bind", () => {
        const p = path.join(dir, ".claude.json")
        mergeMcp({
            claudeJsonPath: p,
            headersHelperPath: HELPER,
            port: 17999,
            bind: "127.0.0.1",
        })
        const cfg = JSON.parse(readFileSync(p, "utf8"))
        expect(cfg.mcpServers.review.url).toBe("http://127.0.0.1:17999/mcp")
    })
})
