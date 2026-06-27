/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { mergeStopHook, HARNESS_TIMEOUT_SECONDS } from "./merge-stop-hook.mjs"

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
                    timeout: HARNESS_TIMEOUT_SECONDS,
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
        expect(s.hooks.Stop[0].hooks[0].timeout).toBe(HARNESS_TIMEOUT_SECONDS)
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
        expect(s.hooks.Stop[0].hooks[1].timeout).toBe(HARNESS_TIMEOUT_SECONDS)
    })

    test("multiple canonical blocks: keeps our hook in ONE block, strips dupes from the rest", () => {
        // The duplicate-install regression: a user-owned empty-matcher
        // Stop block existed before our installer ran (so the
        // installer appended a second empty-matcher block with our
        // hook). Reinstalling on this layout used to leave both,
        // causing the Stop event to run our hook twice.
        const p = path.join(dir, "settings.json")
        const userSibling = {
            type: "command",
            command: "/users/x/user-stop.sh",
            timeout: 1000,
        }
        writeFileSync(
            p,
            JSON.stringify({
                hooks: {
                    Stop: [
                        // User's own empty-matcher block (no overlap
                        // with ours).
                        { matcher: "", hooks: [userSibling] },
                        // Installer-owned empty-matcher block with
                        // our hook — should remain THE home.
                        {
                            matcher: "",
                            hooks: [
                                {
                                    type: "command",
                                    command: HOOK,
                                    timeout: 60000,
                                },
                            ],
                        },
                    ],
                },
            })
        )
        mergeStopHook({ settingsPath: p, hookPath: HOOK })
        const s = JSON.parse(readFileSync(p, "utf8"))
        // Both blocks remain (user's separate group untouched), but
        // our hook lives in exactly ONE of them now.
        const occurrences = s.hooks.Stop.flatMap((b) => b.hooks).filter(
            (h) => h.command === HOOK
        )
        expect(occurrences).toHaveLength(1)
        expect(occurrences[0].timeout).toBe(HARNESS_TIMEOUT_SECONDS)
        // The user's sibling block still has only the sibling.
        const userBlock = s.hooks.Stop.find((b) =>
            b.hooks.some((h) => h.command === userSibling.command)
        )
        expect(userBlock.hooks).toEqual([userSibling])
    })

    test("within-block dedupe: a single canonical block with our hook listed TWICE collapses to one (v1.0.7)", () => {
        // The same matcher block has our command twice — Claude
        // Code would fire both. Merge must collapse to a single
        // refreshed entry, preserving any sibling hooks.
        const p = path.join(dir, "settings.json")
        const sibling = {
            type: "command",
            command: "/users/x/their-stop.sh",
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
                                { type: "command", command: HOOK, timeout: 1 },
                                sibling,
                                { type: "command", command: HOOK, timeout: 2 },
                            ],
                        },
                    ],
                },
            })
        )
        mergeStopHook({ settingsPath: p, hookPath: HOOK })
        const s = JSON.parse(readFileSync(p, "utf8"))
        // One block; one occurrence of our hook; sibling preserved.
        expect(s.hooks.Stop).toHaveLength(1)
        const ours = s.hooks.Stop[0].hooks.filter((h) => h.command === HOOK)
        expect(ours).toHaveLength(1)
        expect(ours[0].timeout).toBe(HARNESS_TIMEOUT_SECONDS)
        expect(s.hooks.Stop[0].hooks).toContainEqual(sibling)
    })

    test("two canonical blocks both containing our hook: deduplicate to one, drop the emptied dupe", () => {
        const p = path.join(dir, "settings.json")
        writeFileSync(
            p,
            JSON.stringify({
                hooks: {
                    Stop: [
                        {
                            matcher: "",
                            hooks: [
                                { type: "command", command: HOOK, timeout: 1 },
                            ],
                        },
                        {
                            matcher: "",
                            hooks: [
                                { type: "command", command: HOOK, timeout: 2 },
                            ],
                        },
                    ],
                },
            })
        )
        mergeStopHook({ settingsPath: p, hookPath: HOOK })
        const s = JSON.parse(readFileSync(p, "utf8"))
        expect(s.hooks.Stop).toHaveLength(1)
        expect(s.hooks.Stop[0].hooks).toHaveLength(1)
        expect(s.hooks.Stop[0].hooks[0].timeout).toBe(HARNESS_TIMEOUT_SECONDS)
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

    test("installs a fixed harness timeout, independent of any config", () => {
        // The harness timeout is a static value (HARNESS_TIMEOUT_SECONDS)
        // set above the hook's hard wait ceiling — NOT derived from the
        // install-time config — so it can't desync when the operator
        // later raises the reviewer timeout without reinstalling.
        const p = path.join(dir, "settings.json")
        mergeStopHook({ settingsPath: p, hookPath: HOOK })
        const s = JSON.parse(readFileSync(p, "utf8"))
        expect(s.hooks.Stop[0].hooks[0].timeout).toBe(HARNESS_TIMEOUT_SECONDS)
        expect(HARNESS_TIMEOUT_SECONDS).toBe(1800)
    })
})
