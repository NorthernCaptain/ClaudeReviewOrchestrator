/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { mergePostToolUseHook } from "./merge-post-tool-use-hook.mjs"

const makeTmp = () => mkdtempSync(path.join(tmpdir(), "merge-ptu-hook-"))

const HOOK = "/Users/x/.claude/hooks/notify-change.mjs"

describe("mergePostToolUseHook", () => {
    let dir
    beforeEach(() => {
        dir = makeTmp()
    })
    afterEach(() => rmSync(dir, { recursive: true, force: true }))

    test("creates settings.json with the Write|Edit|MultiEdit matcher when file is missing", () => {
        const p = path.join(dir, "settings.json")
        const r = mergePostToolUseHook({ settingsPath: p, hookPath: HOOK })
        expect(r.action).toBe("installed")
        const s = JSON.parse(readFileSync(p, "utf8"))
        expect(s.hooks.PostToolUse).toHaveLength(1)
        expect(s.hooks.PostToolUse[0].matcher).toBe("Write|Edit|MultiEdit")
        expect(s.hooks.PostToolUse[0].hooks[0].command).toBe(HOOK)
        expect(s.hooks.PostToolUse[0].hooks[0].timeout).toBe(3000)
    })

    test("appends to an existing PostToolUse list without touching other matchers", () => {
        const p = path.join(dir, "settings.json")
        writeFileSync(
            p,
            JSON.stringify({
                hooks: {
                    PostToolUse: [
                        {
                            matcher: "Bash",
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
        const r = mergePostToolUseHook({ settingsPath: p, hookPath: HOOK })
        expect(r.action).toBe("updated")
        const s = JSON.parse(readFileSync(p, "utf8"))
        expect(s.hooks.PostToolUse).toHaveLength(2)
        expect(s.hooks.PostToolUse[0].hooks[0].command).toBe("/some/other/hook")
        expect(s.hooks.PostToolUse[1].hooks[0].command).toBe(HOOK)
    })

    test("preserves the Stop hook block untouched", () => {
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
                                    command: "/stop/hook",
                                    timeout: 720000,
                                },
                            ],
                        },
                    ],
                },
            })
        )
        mergePostToolUseHook({ settingsPath: p, hookPath: HOOK })
        const s = JSON.parse(readFileSync(p, "utf8"))
        expect(s.hooks.Stop).toHaveLength(1)
        expect(s.hooks.Stop[0].hooks[0].command).toBe("/stop/hook")
        expect(s.hooks.PostToolUse).toHaveLength(1)
    })

    test("is idempotent when our entry already matches", () => {
        const p = path.join(dir, "settings.json")
        const ours = {
            matcher: "Write|Edit|MultiEdit",
            hooks: [{ type: "command", command: HOOK, timeout: 3000 }],
        }
        writeFileSync(
            p,
            JSON.stringify({ hooks: { PostToolUse: [ours] } }, null, 2) + "\n"
        )
        const r = mergePostToolUseHook({ settingsPath: p, hookPath: HOOK })
        expect(r.action).toBe("unchanged")
    })

    test("refreshes our hook entry's shape but leaves the user's matcher pattern intact", () => {
        // If a user widened or narrowed the matcher pattern, the
        // installer treats that as deliberate and only updates OUR
        // hook entry (type / command / timeout) inside the block.
        // The codex sibling-preservation contract demands we never
        // overwrite a whole block we didn't author.
        const p = path.join(dir, "settings.json")
        writeFileSync(
            p,
            JSON.stringify({
                hooks: {
                    PostToolUse: [
                        {
                            matcher: "Write|Edit", // user-customized pattern
                            hooks: [
                                {
                                    type: "command",
                                    command: HOOK,
                                    timeout: 999, // stale
                                },
                            ],
                        },
                    ],
                },
            })
        )
        const r = mergePostToolUseHook({ settingsPath: p, hookPath: HOOK })
        expect(r.action).toBe("updated")
        const s = JSON.parse(readFileSync(p, "utf8"))
        expect(s.hooks.PostToolUse[0].matcher).toBe("Write|Edit")
        expect(s.hooks.PostToolUse[0].hooks[0].timeout).toBe(3000)
    })

    test("preserves co-located sibling hooks inside the same matcher block", () => {
        // Codex bug: replacing the whole block clobbered sibling hooks
        // the user put alongside ours. The merger must operate at the
        // hook-entry level, not the matcher-block level.
        const p = path.join(dir, "settings.json")
        const sibling = {
            type: "command",
            command: "/users/x/hooks/their-tool.sh",
            timeout: 5000,
        }
        writeFileSync(
            p,
            JSON.stringify({
                hooks: {
                    PostToolUse: [
                        {
                            matcher: "Write|Edit|MultiEdit",
                            hooks: [
                                sibling,
                                { type: "command", command: HOOK, timeout: 1 },
                            ],
                        },
                    ],
                },
            })
        )
        mergePostToolUseHook({ settingsPath: p, hookPath: HOOK })
        const s = JSON.parse(readFileSync(p, "utf8"))
        expect(s.hooks.PostToolUse).toHaveLength(1)
        expect(s.hooks.PostToolUse[0].hooks).toHaveLength(2)
        expect(s.hooks.PostToolUse[0].hooks[0]).toEqual(sibling)
        expect(s.hooks.PostToolUse[0].hooks[1].command).toBe(HOOK)
        expect(s.hooks.PostToolUse[0].hooks[1].timeout).toBe(3000)
    })

    test("rejects invalid JSON instead of clobbering", () => {
        const p = path.join(dir, "settings.json")
        writeFileSync(p, "{ not json")
        expect(() =>
            mergePostToolUseHook({ settingsPath: p, hookPath: HOOK })
        ).toThrow(/failed to parse/)
    })

    test("rejects non-object root", () => {
        const p = path.join(dir, "settings.json")
        writeFileSync(p, "[]")
        expect(() =>
            mergePostToolUseHook({ settingsPath: p, hookPath: HOOK })
        ).toThrow(/not an object/)
    })

    test("writes a backup only when bytes change", () => {
        const p = path.join(dir, "settings.json")
        writeFileSync(p, JSON.stringify({ hooks: { PostToolUse: [] } }))
        const r1 = mergePostToolUseHook({
            settingsPath: p,
            hookPath: HOOK,
            now: () => "ts1",
        })
        expect(r1.backup).toMatch(/\.bak\.ts1$/)
        const r2 = mergePostToolUseHook({
            settingsPath: p,
            hookPath: HOOK,
            now: () => "ts2",
        })
        expect(r2.action).toBe("unchanged")
        expect(() => readFileSync(`${p}.bak.ts2`)).toThrow()
    })
})
