/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { removeMcp } from "./remove-mcp.mjs"
import { removeStopHook } from "./remove-stop-hook.mjs"
import { removePostToolUseHook } from "./remove-post-tool-use-hook.mjs"
import { removeClaudeMd } from "./remove-claude-md.mjs"

const makeTmp = () => mkdtempSync(path.join(tmpdir(), "remove-"))

const HOOK = "/Users/x/.claude/hooks/stop-review.mjs"

describe("removeMcp", () => {
    let dir
    beforeEach(() => {
        dir = makeTmp()
    })
    afterEach(() => rmSync(dir, { recursive: true, force: true }))

    test("returns absent when file is missing", () => {
        const r = removeMcp({ claudeJsonPath: path.join(dir, "absent.json") })
        expect(r.action).toBe("absent")
    })

    test("returns unchanged when review entry is not present", () => {
        const p = path.join(dir, ".claude.json")
        writeFileSync(p, JSON.stringify({ mcpServers: { other: {} } }))
        const r = removeMcp({ claudeJsonPath: p })
        expect(r.action).toBe("unchanged")
    })

    test("removes the review entry and keeps other servers", () => {
        const p = path.join(dir, ".claude.json")
        writeFileSync(
            p,
            JSON.stringify({
                theme: "dark",
                mcpServers: {
                    other: { type: "stdio" },
                    review: { type: "http" },
                },
            })
        )
        const r = removeMcp({ claudeJsonPath: p })
        expect(r.action).toBe("removed")
        const cfg = JSON.parse(readFileSync(p, "utf8"))
        expect(cfg.theme).toBe("dark")
        expect(cfg.mcpServers).toEqual({ other: { type: "stdio" } })
    })

    test("deletes mcpServers entirely when review was the only entry", () => {
        const p = path.join(dir, ".claude.json")
        writeFileSync(
            p,
            JSON.stringify({
                other: "v",
                mcpServers: { review: { type: "http" } },
            })
        )
        removeMcp({ claudeJsonPath: p })
        const cfg = JSON.parse(readFileSync(p, "utf8"))
        expect("mcpServers" in cfg).toBe(false)
        expect(cfg.other).toBe("v")
    })

    test("rerun is unchanged (idempotent)", () => {
        const p = path.join(dir, ".claude.json")
        writeFileSync(
            p,
            JSON.stringify({ mcpServers: { review: { type: "http" } } })
        )
        removeMcp({ claudeJsonPath: p })
        const r2 = removeMcp({ claudeJsonPath: p })
        expect(r2.action).toBe("unchanged")
    })
})

describe("removeStopHook", () => {
    let dir
    beforeEach(() => {
        dir = makeTmp()
    })
    afterEach(() => rmSync(dir, { recursive: true, force: true }))

    test("absent → absent action", () => {
        const r = removeStopHook({
            settingsPath: path.join(dir, "absent.json"),
            hookPath: HOOK,
        })
        expect(r.action).toBe("absent")
    })

    test("unchanged when no Stop list", () => {
        const p = path.join(dir, "settings.json")
        writeFileSync(p, JSON.stringify({ theme: "dark" }))
        expect(removeStopHook({ settingsPath: p, hookPath: HOOK }).action).toBe(
            "unchanged"
        )
    })

    test("removes only our matcher and keeps others", () => {
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
                                    command: "/other/hook",
                                },
                            ],
                        },
                        {
                            matcher: "",
                            hooks: [{ type: "command", command: HOOK }],
                        },
                    ],
                },
            })
        )
        const r = removeStopHook({ settingsPath: p, hookPath: HOOK })
        expect(r.action).toBe("removed")
        const s = JSON.parse(readFileSync(p, "utf8"))
        expect(s.hooks.Stop).toHaveLength(1)
        expect(s.hooks.Stop[0].hooks[0].command).toBe("/other/hook")
    })

    test("deletes hooks.Stop entirely when our entry was the only one", () => {
        const p = path.join(dir, "settings.json")
        writeFileSync(
            p,
            JSON.stringify({
                theme: "dark",
                hooks: {
                    Stop: [
                        {
                            matcher: "",
                            hooks: [{ type: "command", command: HOOK }],
                        },
                    ],
                },
            })
        )
        removeStopHook({ settingsPath: p, hookPath: HOOK })
        const s = JSON.parse(readFileSync(p, "utf8"))
        expect("hooks" in s).toBe(false)
        expect(s.theme).toBe("dark")
    })

    test("rerun is unchanged (idempotent)", () => {
        const p = path.join(dir, "settings.json")
        writeFileSync(
            p,
            JSON.stringify({
                hooks: {
                    Stop: [
                        {
                            matcher: "",
                            hooks: [{ type: "command", command: HOOK }],
                        },
                    ],
                },
            })
        )
        removeStopHook({ settingsPath: p, hookPath: HOOK })
        expect(removeStopHook({ settingsPath: p, hookPath: HOOK }).action).toBe(
            "unchanged"
        )
    })

    test("preserves co-located sibling hooks in the same matcher block", () => {
        // Filter at the hook-entry level — never drop a whole block
        // (and the user's other hooks with it).
        const p = path.join(dir, "settings.json")
        const sibling = { type: "command", command: "/users/x/their-hook" }
        writeFileSync(
            p,
            JSON.stringify({
                hooks: {
                    Stop: [
                        {
                            matcher: "",
                            hooks: [
                                sibling,
                                { type: "command", command: HOOK },
                            ],
                        },
                    ],
                },
            })
        )
        const r = removeStopHook({ settingsPath: p, hookPath: HOOK })
        expect(r.action).toBe("removed")
        const s = JSON.parse(readFileSync(p, "utf8"))
        expect(s.hooks.Stop).toHaveLength(1)
        expect(s.hooks.Stop[0].hooks).toEqual([sibling])
    })
})

describe("removePostToolUseHook", () => {
    const NOTIFY = "/Users/x/.claude/hooks/notify-change.mjs"
    let dir
    beforeEach(() => {
        dir = makeTmp()
    })
    afterEach(() => rmSync(dir, { recursive: true, force: true }))

    test("absent → absent action", () => {
        const r = removePostToolUseHook({
            settingsPath: path.join(dir, "absent.json"),
            hookPath: NOTIFY,
        })
        expect(r.action).toBe("absent")
    })

    test("unchanged when no PostToolUse list", () => {
        const p = path.join(dir, "settings.json")
        writeFileSync(p, JSON.stringify({ hooks: { Stop: [] } }))
        expect(
            removePostToolUseHook({ settingsPath: p, hookPath: NOTIFY }).action
        ).toBe("unchanged")
    })

    test("removes only our matcher and keeps others (Bash matcher untouched)", () => {
        const p = path.join(dir, "settings.json")
        writeFileSync(
            p,
            JSON.stringify({
                hooks: {
                    PostToolUse: [
                        {
                            matcher: "Bash",
                            hooks: [{ type: "command", command: "/other" }],
                        },
                        {
                            matcher: "Write|Edit|MultiEdit",
                            hooks: [{ type: "command", command: NOTIFY }],
                        },
                    ],
                },
            })
        )
        const r = removePostToolUseHook({ settingsPath: p, hookPath: NOTIFY })
        expect(r.action).toBe("removed")
        const s = JSON.parse(readFileSync(p, "utf8"))
        expect(s.hooks.PostToolUse).toHaveLength(1)
        expect(s.hooks.PostToolUse[0].matcher).toBe("Bash")
    })

    test("leaves the Stop hook block intact when removing PostToolUse", () => {
        const p = path.join(dir, "settings.json")
        writeFileSync(
            p,
            JSON.stringify({
                hooks: {
                    Stop: [
                        {
                            matcher: "",
                            hooks: [{ type: "command", command: "/stop" }],
                        },
                    ],
                    PostToolUse: [
                        {
                            matcher: "Write|Edit|MultiEdit",
                            hooks: [{ type: "command", command: NOTIFY }],
                        },
                    ],
                },
            })
        )
        removePostToolUseHook({ settingsPath: p, hookPath: NOTIFY })
        const s = JSON.parse(readFileSync(p, "utf8"))
        expect(s.hooks.Stop).toHaveLength(1)
        expect("PostToolUse" in s.hooks).toBe(false)
    })

    test("rerun is unchanged (idempotent)", () => {
        const p = path.join(dir, "settings.json")
        writeFileSync(
            p,
            JSON.stringify({
                hooks: {
                    PostToolUse: [
                        {
                            matcher: "Write|Edit|MultiEdit",
                            hooks: [{ type: "command", command: NOTIFY }],
                        },
                    ],
                },
            })
        )
        removePostToolUseHook({ settingsPath: p, hookPath: NOTIFY })
        expect(
            removePostToolUseHook({ settingsPath: p, hookPath: NOTIFY }).action
        ).toBe("unchanged")
    })

    test("preserves co-located sibling hooks in the same matcher block", () => {
        const p = path.join(dir, "settings.json")
        const sibling = {
            type: "command",
            command: "/users/x/their-tool",
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
                                { type: "command", command: NOTIFY },
                            ],
                        },
                    ],
                },
            })
        )
        const r = removePostToolUseHook({ settingsPath: p, hookPath: NOTIFY })
        expect(r.action).toBe("removed")
        const s = JSON.parse(readFileSync(p, "utf8"))
        expect(s.hooks.PostToolUse).toHaveLength(1)
        expect(s.hooks.PostToolUse[0].hooks).toEqual([sibling])
    })
})

describe("removeClaudeMd", () => {
    let dir
    beforeEach(() => {
        dir = makeTmp()
    })
    afterEach(() => rmSync(dir, { recursive: true, force: true }))

    test("absent → absent", () => {
        expect(
            removeClaudeMd({
                claudeMdPath: path.join(dir, "absent.md"),
            }).action
        ).toBe("absent")
    })

    test("unchanged when markers not present", () => {
        const p = path.join(dir, "CLAUDE.md")
        writeFileSync(p, "# notes\n")
        expect(removeClaudeMd({ claudeMdPath: p }).action).toBe("unchanged")
    })

    test("strips the block and preserves surrounding content", () => {
        const p = path.join(dir, "CLAUDE.md")
        writeFileSync(
            p,
            [
                "# Top",
                "",
                "<!-- review-orchestrator:begin -->",
                "remove me",
                "<!-- review-orchestrator:end -->",
                "",
                "## Bottom",
                "still here",
                "",
            ].join("\n")
        )
        const r = removeClaudeMd({ claudeMdPath: p })
        expect(r.action).toBe("removed")
        const c = readFileSync(p, "utf8")
        expect(c).not.toMatch(/remove me/)
        expect(c).not.toMatch(/review-orchestrator:/)
        expect(c).toMatch(/# Top/)
        expect(c).toMatch(/Bottom/)
        expect(c).toMatch(/still here/)
    })

    test("rerun is unchanged (idempotent)", () => {
        const p = path.join(dir, "CLAUDE.md")
        writeFileSync(
            p,
            [
                "<!-- review-orchestrator:begin -->",
                "block",
                "<!-- review-orchestrator:end -->",
            ].join("\n")
        )
        removeClaudeMd({ claudeMdPath: p })
        expect(removeClaudeMd({ claudeMdPath: p }).action).toBe("unchanged")
    })
})
