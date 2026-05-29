/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { mergeStopHook } from "./merge-stop-hook.mjs"

const makeTmp = () => mkdtempSync(path.join(tmpdir(), "merge-stop-hook-"))

const HOOK = "/Users/x/.claude/hooks/stop-review.mjs"

describe("mergeStopHook", () => {
    let dir
    beforeEach(() => {
        dir = makeTmp()
    })
    afterEach(() => rmSync(dir, { recursive: true, force: true }))

    test("creates settings.json with our Stop matcher when file is missing", () => {
        const p = path.join(dir, "settings.json")
        const r = mergeStopHook({ settingsPath: p, hookPath: HOOK })
        expect(r.action).toBe("installed")
        const s = JSON.parse(readFileSync(p, "utf8"))
        expect(s.hooks.Stop).toHaveLength(1)
        expect(s.hooks.Stop[0].hooks[0].command).toBe(HOOK)
    })

    test("appends to an existing Stop list without touching other matchers", () => {
        const p = path.join(dir, "settings.json")
        writeFileSync(
            p,
            JSON.stringify({
                hooks: {
                    Stop: [
                        {
                            matcher: "other",
                            hooks: [
                                {
                                    type: "command",
                                    command: "/some/other/hook",
                                    timeout: 1000,
                                },
                            ],
                        },
                    ],
                },
            })
        )
        const r = mergeStopHook({ settingsPath: p, hookPath: HOOK })
        expect(r.action).toBe("updated")
        const s = JSON.parse(readFileSync(p, "utf8"))
        expect(s.hooks.Stop).toHaveLength(2)
        expect(s.hooks.Stop[0].hooks[0].command).toBe("/some/other/hook")
        expect(s.hooks.Stop[1].hooks[0].command).toBe(HOOK)
    })

    test("is idempotent when our entry already matches", () => {
        const p = path.join(dir, "settings.json")
        const ourMatcher = {
            matcher: "",
            hooks: [
                {
                    type: "command",
                    command: HOOK,
                    timeout: 720000,
                },
            ],
        }
        writeFileSync(
            p,
            JSON.stringify({ hooks: { Stop: [ourMatcher] } }, null, 2) + "\n"
        )
        const r = mergeStopHook({ settingsPath: p, hookPath: HOOK })
        expect(r.action).toBe("unchanged")
    })

    test("refreshes an entry pointing at our hook with a different shape", () => {
        const p = path.join(dir, "settings.json")
        writeFileSync(
            p,
            JSON.stringify({
                hooks: {
                    Stop: [
                        {
                            matcher: "",
                            hooks: [
                                {
                                    type: "command",
                                    command: HOOK,
                                    timeout: 60000, // old short timeout
                                },
                            ],
                        },
                    ],
                },
            })
        )
        const r = mergeStopHook({ settingsPath: p, hookPath: HOOK })
        expect(r.action).toBe("updated")
        const s = JSON.parse(readFileSync(p, "utf8"))
        expect(s.hooks.Stop[0].hooks[0].timeout).toBe(720000)
    })

    test("preserves unrelated top-level keys", () => {
        const p = path.join(dir, "settings.json")
        writeFileSync(p, JSON.stringify({ theme: "dark", hooks: {} }))
        mergeStopHook({ settingsPath: p, hookPath: HOOK })
        const s = JSON.parse(readFileSync(p, "utf8"))
        expect(s.theme).toBe("dark")
    })

    test("rejects invalid JSON instead of clobbering", () => {
        const p = path.join(dir, "settings.json")
        writeFileSync(p, "{ not json")
        expect(() =>
            mergeStopHook({ settingsPath: p, hookPath: HOOK })
        ).toThrow(/failed to parse/)
    })

    test("rejects non-object root", () => {
        const p = path.join(dir, "settings.json")
        writeFileSync(p, "[]")
        expect(() =>
            mergeStopHook({ settingsPath: p, hookPath: HOOK })
        ).toThrow(/not an object/)
    })

    test("preserves co-located sibling hooks inside the same matcher block", () => {
        // Operate at the hook-entry level, not the matcher-block level
        // — never blow away a sibling command the user put alongside
        // ours.
        const p = path.join(dir, "settings.json")
        const sibling = {
            type: "command",
            command: "/users/x/hooks/their-stop.sh",
            timeout: 5000,
        }
        writeFileSync(
            p,
            JSON.stringify({
                hooks: {
                    Stop: [
                        {
                            matcher: "",
                            hooks: [
                                sibling,
                                {
                                    type: "command",
                                    command: HOOK,
                                    timeout: 60000, // stale
                                },
                            ],
                        },
                    ],
                },
            })
        )
        mergeStopHook({ settingsPath: p, hookPath: HOOK })
        const s = JSON.parse(readFileSync(p, "utf8"))
        expect(s.hooks.Stop).toHaveLength(1)
        expect(s.hooks.Stop[0].hooks).toHaveLength(2)
        expect(s.hooks.Stop[0].hooks[0]).toEqual(sibling)
        expect(s.hooks.Stop[0].hooks[1].command).toBe(HOOK)
        expect(s.hooks.Stop[0].hooks[1].timeout).toBe(720000)
    })

    test("writes a backup only when bytes change", () => {
        const p = path.join(dir, "settings.json")
        writeFileSync(p, JSON.stringify({ hooks: { Stop: [] } }))
        const r1 = mergeStopHook({
            settingsPath: p,
            hookPath: HOOK,
            now: () => "ts1",
        })
        expect(r1.backup).toMatch(/\.bak\.ts1$/)
        const r2 = mergeStopHook({
            settingsPath: p,
            hookPath: HOOK,
            now: () => "ts2",
        })
        expect(r2.action).toBe("unchanged")
        expect(() => readFileSync(`${p}.bak.ts2`)).toThrow()
    })
})
