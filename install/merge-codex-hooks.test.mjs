/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
    mergeCodexHooks,
    POST_MATCHER,
    POST_TIMEOUT_SECONDS,
} from "./merge-codex-hooks.mjs"
import { HARNESS_TIMEOUT_SECONDS } from "./merge-stop-hook.mjs"

const makeTmp = () => mkdtempSync(path.join(tmpdir(), "merge-codex-hooks-"))

const STOP = "/h/stop-review.mjs"
const NOTIFY = "/h/notify-change.mjs"

describe("mergeCodexHooks", () => {
    let dir
    beforeEach(() => {
        dir = makeTmp()
    })
    afterEach(() => rmSync(dir, { recursive: true, force: true }))

    const run = (over = {}) =>
        mergeCodexHooks({
            hooksJsonPath: path.join(dir, "hooks.json"),
            stopHookPath: STOP,
            notifyHookPath: NOTIFY,
            ...over,
        })
    const read = () =>
        JSON.parse(readFileSync(path.join(dir, "hooks.json"), "utf8"))

    test("creates hooks.json with Stop + PostToolUse at the top level", () => {
        const r = run()
        expect(r.action).toBe("installed")
        const s = read()
        expect(Array.isArray(s.Stop)).toBe(true)
        expect(Array.isArray(s.PostToolUse)).toBe(true)
        // Codex shape: events at top level, NOT under a `hooks` wrapper.
        expect(s.hooks).toBeUndefined()
        expect(s.Stop[0].hooks[0]).toEqual({
            type: "command",
            command: STOP,
            timeout: HARNESS_TIMEOUT_SECONDS,
        })
        const post = s.PostToolUse[0]
        expect(post.matcher).toBe(POST_MATCHER)
        expect(post.hooks[0]).toEqual({
            type: "command",
            command: NOTIFY,
            timeout: POST_TIMEOUT_SECONDS,
        })
    })

    test("Stop block carries no matcher key", () => {
        run()
        expect("matcher" in read().Stop[0]).toBe(false)
    })

    test("PostToolUse matcher covers file edits AND shell commands", () => {
        // Command-side edits (formatters, codegen, sed -i) must also mark
        // the context dirty, or a Stop can fast-path to NO_CHANGES and
        // skip review of the new diff.
        const re = new RegExp(POST_MATCHER)
        expect(re.test("apply_patch")).toBe(true)
        // codex's real shell tool names (codex-cli 0.142.2).
        expect(re.test("exec_command")).toBe(true)
        expect(re.test("write_stdin")).toBe(true)
        expect(re.test("Bash")).toBe(true)
        // Anchored: doesn't match unrelated / namespaced tools.
        expect(re.test("Read")).toBe(false)
        expect(re.test("mcp__x__apply_patch")).toBe(false)
    })

    test("is idempotent on re-run", () => {
        run()
        expect(run().action).toBe("unchanged")
    })

    test("refreshes a stale Stop entry (different timeout) in place", () => {
        const p = path.join(dir, "hooks.json")
        writeFileSync(
            p,
            JSON.stringify({
                Stop: [
                    {
                        hooks: [
                            { type: "command", command: STOP, timeout: 60 },
                        ],
                    },
                ],
            })
        )
        const r = run()
        expect(r.action).toBe("updated")
        const s = read()
        expect(s.Stop[0].hooks[0].timeout).toBe(HARNESS_TIMEOUT_SECONDS)
        expect(s.Stop[0].hooks.filter((h) => h.command === STOP)).toHaveLength(
            1
        )
    })

    test("preserves sibling hooks in the same event", () => {
        const p = path.join(dir, "hooks.json")
        const sibling = { type: "command", command: "/x/other.sh", timeout: 5 }
        writeFileSync(p, JSON.stringify({ Stop: [{ hooks: [sibling] }] }))
        run()
        const s = read()
        // Our entry joins the existing canonical (no-matcher) block.
        const cmds = s.Stop.flatMap((b) => b.hooks).map((h) => h.command)
        expect(cmds).toContain("/x/other.sh")
        expect(cmds).toContain(STOP)
    })

    test("preserves unrelated events (e.g. a user SessionStart hook)", () => {
        const p = path.join(dir, "hooks.json")
        writeFileSync(
            p,
            JSON.stringify({
                SessionStart: [
                    { hooks: [{ type: "command", command: "/x/s.sh" }] },
                ],
            })
        )
        run()
        const s = read()
        expect(s.SessionStart[0].hooks[0].command).toBe("/x/s.sh")
        expect(s.Stop[0].hooks[0].command).toBe(STOP)
    })

    test("dedupes our hook listed twice in one block to a single entry", () => {
        const p = path.join(dir, "hooks.json")
        writeFileSync(
            p,
            JSON.stringify({
                Stop: [
                    {
                        hooks: [
                            { type: "command", command: STOP, timeout: 1 },
                            { type: "command", command: STOP, timeout: 2 },
                        ],
                    },
                ],
            })
        )
        run()
        const ours = read().Stop[0].hooks.filter((h) => h.command === STOP)
        expect(ours).toHaveLength(1)
        expect(ours[0].timeout).toBe(HARNESS_TIMEOUT_SECONDS)
    })

    test("rejects invalid JSON instead of clobbering", () => {
        const p = path.join(dir, "hooks.json")
        writeFileSync(p, "{ not json")
        expect(() => run()).toThrow(/failed to parse/)
    })

    test("writes a backup only when bytes change", () => {
        const p = path.join(dir, "hooks.json")
        const r1 = run({ now: () => "ts1" })
        expect(r1.backup).toBeNull() // created file, nothing to back up
        run({ stopTimeout: 999, now: () => "ts2" })
        expect(() => readFileSync(`${p}.bak.ts2`)).not.toThrow()
    })
})
