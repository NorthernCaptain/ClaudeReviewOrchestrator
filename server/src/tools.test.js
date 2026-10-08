/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { jest } from "@jest/globals"
import {
    chmodSync,
    mkdirSync,
    mkdtempSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs"
import { execFile as nodeExecFile } from "node:child_process"
import { tmpdir } from "node:os"
import path from "node:path"
import {
    createTools,
    DEFAULT_SEARCH_PATH,
    isGitTimeout,
    isNodeExecutable,
    KILL_GRACE_MS,
    locateExecutable,
    resolveRunnable,
    ToolError,
} from "./tools.js"

let dir
beforeEach(() => {
    dir = realpathSync(mkdtempSync(path.join(tmpdir(), "tools-")))
})
afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
})

const executable = (name) => {
    const p = path.join(dir, name)
    writeFileSync(p, "#!/bin/sh\necho hi\n")
    chmodSync(p, 0o755)
    return p
}

describe("locateExecutable", () => {
    test("searches PATH, resolves slash paths against cwd, null when absent", () => {
        const p = executable("mytool")
        expect(locateExecutable("mytool", { env: { PATH: dir } })).toBe(p)
        expect(locateExecutable("./mytool", { cwd: dir, env: {} })).toBe(p)
        expect(locateExecutable(p, { env: {} })).toBe(p)
        expect(locateExecutable("nope", { env: { PATH: dir } })).toBeNull()
        expect(locateExecutable("mytool", { env: {} })).toBeNull()
        expect(locateExecutable("./missing", { cwd: dir })).toBeNull()
    })

    test("relative PATH entries resolve against the child's cwd", () => {
        mkdirSync(path.join(dir, "bin"))
        const p = path.join(dir, "bin", "tool")
        writeFileSync(p, "#!/bin/sh\n")
        chmodSync(p, 0o755)
        expect(
            locateExecutable("tool", { cwd: dir, env: { PATH: ":bin" } })
        ).toBe(p)
    })

    test("an empty PATH entry searches the child's cwd", () => {
        const p = executable("tool")
        expect(
            locateExecutable("tool", {
                cwd: dir,
                env: { PATH: ":/does-not-exist" },
            })
        ).toBe(p)
    })

    test("no PATH at all searches the platform default", () => {
        const found = locateExecutable("sh", { env: {} })
        expect(DEFAULT_SEARCH_PATH.split(":")).toContain(path.dirname(found))
    })

    test("skips directories and non-executable files", () => {
        mkdirSync(path.join(dir, "a"))
        mkdirSync(path.join(dir, "a", "tool"))
        mkdirSync(path.join(dir, "b"))
        writeFileSync(path.join(dir, "b", "tool"), "x")
        mkdirSync(path.join(dir, "c"))
        const good = path.join(dir, "c", "tool")
        writeFileSync(good, "#!/bin/sh\n")
        chmodSync(good, 0o755)
        const PATH = ["a", "b", "c"].map((d) => path.join(dir, d)).join(":")
        expect(locateExecutable("tool", { env: { PATH } })).toBe(good)
    })
})

describe("isNodeExecutable", () => {
    test("detects node by basename and by being process.execPath", () => {
        expect(isNodeExecutable(process.execPath)).toBe(true)
        expect(isNodeExecutable(executable("nodejs"))).toBe(true)
        expect(isNodeExecutable(executable("node"))).toBe(true)
        const alias = path.join(dir, "not-node")
        symlinkSync(process.execPath, alias)
        expect(isNodeExecutable(alias)).toBe(true)
    })

    test("other binaries are not node", () => {
        expect(isNodeExecutable(executable("codex"))).toBe(false)
    })
})

describe("resolveRunnable", () => {
    test("a relative alias to node in the child's cwd is refused", () => {
        symlinkSync(process.execPath, path.join(dir, "reviewer"))
        expect(() =>
            resolveRunnable("./reviewer", { cwd: dir, env: {} })
        ).toThrow(expect.objectContaining({ code: "TOOL_IS_NODE" }))
    })

    test("node on the child's own PATH is refused", () => {
        symlinkSync(process.execPath, path.join(dir, "reviewer"))
        expect(() =>
            resolveRunnable("reviewer", { env: { PATH: dir } })
        ).toThrow(expect.objectContaining({ code: "TOOL_IS_NODE" }))
    })

    test("returns the absolute path it checked; a missing binary is ENOENT", () => {
        const p = executable("codex")
        expect(resolveRunnable("./codex", { cwd: dir, env: {} })).toBe(p)
        expect(() => resolveRunnable("nope", { env: { PATH: dir } })).toThrow(
            expect.objectContaining({ code: "ENOENT" })
        )
    })
})

describe("createTools — resolveBinary", () => {
    const tools = createTools({ nodeCheck: () => false, locate: (b) => b })

    test("git needs no config", () => {
        expect(tools.resolveBinary("git")).toBe("git")
    })

    test("reviewer tools resolve from the caller's config", () => {
        const config = {
            codex: { binary: "/opt/codex" },
            reviewer: {
                claude: { binary: "/opt/claude" },
                gemini: { binary: "/opt/gemini" },
            },
        }
        expect(tools.resolveBinary("codex", config)).toBe("/opt/codex")
        expect(tools.resolveBinary("claude", config)).toBe("/opt/claude")
        expect(tools.resolveBinary("gemini", config)).toBe("/opt/gemini")
        expect(tools.resolveBinary("codex", {})).toBe("codex")
    })

    test("locates the binary with the child's cwd and env", () => {
        const locate = jest.fn(() => "/abs/codex")
        const t = createTools({ nodeCheck: () => false, locate })
        const env = { PATH: "/x" }
        expect(t.resolveBinary("codex", {}, { cwd: "/repo", env })).toBe(
            "/abs/codex"
        )
        expect(locate).toHaveBeenCalledWith("codex", { cwd: "/repo", env })
    })

    test("reviewer tools without a config are refused", () => {
        expect(() => tools.resolveBinary("codex")).toThrow(
            expect.objectContaining({ code: "TOOL_CONFIG_REQUIRED" })
        )
    })

    test("unknown tools are refused", () => {
        expect(() => tools.resolveBinary("bash")).toThrow(
            expect.objectContaining({ code: "TOOL_NOT_ALLOWED" })
        )
        expect(() => tools.resolveBinary("constructor")).toThrow(
            expect.objectContaining({ code: "TOOL_NOT_ALLOWED" })
        )
    })

    test("with an issued-config check, only configs the shell pinned run a reviewer", () => {
        const issued = new WeakSet()
        const pinned = { codex: { binary: "/opt/codex" } }
        issued.add(pinned)
        const t = createTools({
            nodeCheck: () => false,
            locate: (b) => b,
            isIssuedConfig: (c) => issued.has(c),
        })
        expect(t.resolveBinary("codex", pinned)).toBe("/opt/codex")
        expect(() =>
            t.resolveBinary("codex", { codex: { binary: "/opt/codex" } })
        ).toThrow(expect.objectContaining({ code: "TOOL_CONFIG_NOT_ISSUED" }))
        expect(t.resolveBinary("git")).toBe("git")
    })

    test("a reviewer binary that is node is refused", () => {
        const real = createTools()
        expect(() =>
            real.resolveBinary("codex", {
                codex: { binary: process.execPath },
            })
        ).toThrow(expect.objectContaining({ code: "TOOL_IS_NODE" }))
    })
})

describe("createTools — execTool", () => {
    test("runs git and resolves its stdout", async () => {
        const tools = createTools()
        const out = await tools.execTool("git", ["--version"])
        expect(out).toMatch(/^git version/)
    })

    test("git(cwd, args) prefixes -C cwd", async () => {
        const execFile = jest.fn((bin, args, opts, cb) => {
            cb(null, "ok", "")
            return { kill: jest.fn() }
        })
        const tools = createTools({
            execFile,
            nodeCheck: () => false,
            locate: (b) => b,
        })
        await expect(tools.git("/repo", ["status"])).resolves.toBe("ok")
        expect(execFile.mock.calls[0][0]).toBe("git")
        expect(execFile.mock.calls[0][1]).toEqual(["-C", "/repo", "status"])
    })

    test("git runs from the absolute path located on PATH", async () => {
        const execFile = jest.fn((bin, args, opts, cb) => {
            cb(null, "", "")
            return { kill: jest.fn() }
        })
        await createTools({ execFile }).git("/repo", ["status"])
        const bin = execFile.mock.calls[0][0]
        expect(path.isAbsolute(bin)).toBe(true)
        expect(path.basename(bin)).toBe("git")
    })

    test("a non-zero exit rejects with the exit code on status", async () => {
        const tools = createTools()
        await expect(
            tools.execTool("git", ["-C", dir, "rev-parse", "HEAD"])
        ).rejects.toMatchObject({ status: expect.any(Number) })
    })

    test("a synchronous callback settles without arming a timer", async () => {
        const setTimer = jest.fn()
        const tools = createTools({
            execFile: (b, a, o, cb) => {
                cb(null, "done", "")
                return { kill: jest.fn() }
            },
            setTimer,
            nodeCheck: () => false,
            locate: (b) => b,
        })
        await expect(tools.execTool("git", ["x"])).resolves.toBe("done")
        expect(setTimer).not.toHaveBeenCalled()
    })

    test("a timeout kills with SIGTERM, then SIGKILL, and rejects GIT_TIMEOUT", async () => {
        const timers = []
        const setTimer = jest.fn((fn, ms) => {
            timers.push({ fn, ms })
            return timers.length
        })
        const clearTimer = jest.fn()
        const kill = jest.fn()
        let callback
        const tools = createTools({
            execFile: (b, a, o, cb) => {
                callback = cb
                return { kill }
            },
            setTimer,
            clearTimer,
            getGitTimeoutMs: () => 1234,
            nodeCheck: () => false,
            locate: (b) => b,
        })
        const p = tools.execTool("git", ["fetch"])
        expect(timers[0].ms).toBe(1234)
        timers[0].fn()
        expect(kill).toHaveBeenCalledWith("SIGTERM")
        expect(timers[1].ms).toBe(KILL_GRACE_MS)
        callback(new Error("terminated"), "", "partial")
        await expect(p).rejects.toMatchObject({
            code: "GIT_TIMEOUT",
            stderr: "partial",
        })
        expect(clearTimer).toHaveBeenCalledTimes(2)
        expect(kill).not.toHaveBeenCalledWith("SIGKILL")
    })

    test("a child that ignores SIGTERM is killed and the call settles without its callback", async () => {
        const timers = []
        const kill = jest.fn()
        const stdout = { destroy: jest.fn() }
        let callback
        const tools = createTools({
            execFile: (b, a, o, cb) => {
                callback = cb
                return { kill, stdout }
            },
            setTimer: (fn, ms) => timers.push({ fn, ms }),
            clearTimer: () => {},
            nodeCheck: () => false,
            locate: (b) => b,
        })
        const p = tools.execTool("git", ["fetch"])
        timers[0].fn()
        timers[1].fn()
        expect(kill).toHaveBeenCalledWith("SIGKILL")
        expect(stdout.destroy).toHaveBeenCalled()
        await expect(p).rejects.toMatchObject({ code: "GIT_TIMEOUT" })
        // A late callback after settling is ignored.
        callback(null, "late", "")
    })

    test("a descendant holding the pipes open can't stall a timed-out call", async () => {
        const tools = createTools({
            execFile: (b, a, o, cb) =>
                nodeExecFile("/bin/sh", ["-c", "sleep 3 & sleep 3"], o, cb),
            getGitTimeoutMs: () => 50,
            killGraceMs: 50,
            nodeCheck: () => false,
            locate: (b) => b,
        })
        const started = Date.now()
        await expect(tools.git(dir, ["status"])).rejects.toMatchObject({
            code: "GIT_TIMEOUT",
        })
        expect(Date.now() - started).toBeLessThan(1500)
    })

    test("a non-git tool times out as TOOL_TIMEOUT with an explicit timeout", async () => {
        const timers = []
        let callback
        const tools = createTools({
            execFile: (b, a, o, cb) => {
                callback = cb
                return { kill: jest.fn() }
            },
            setTimer: (fn, ms) => timers.push({ fn, ms }),
            clearTimer: () => {},
            nodeCheck: () => false,
            locate: (b) => b,
        })
        const p = tools.execTool("codex", ["x"], {
            config: {},
            timeoutMs: 50,
        })
        expect(timers[0].ms).toBe(50)
        timers[0].fn()
        callback(new Error("killed"), "", "")
        await expect(p).rejects.toMatchObject({ code: "TOOL_TIMEOUT" })
    })

    test("a refused tool rejects without running anything", async () => {
        const execFile = jest.fn()
        const tools = createTools({ execFile })
        await expect(
            tools.execTool("bash", ["-c", "x"])
        ).rejects.toBeInstanceOf(ToolError)
        expect(execFile).not.toHaveBeenCalled()
    })
})

describe("createTools — spawnTool", () => {
    test("spawns the resolved binary and strips config from options", () => {
        const spawn = jest.fn(() => "child")
        const tools = createTools({
            spawn,
            nodeCheck: () => false,
            locate: (b) => b,
        })
        const config = { codex: { binary: "/opt/codex" } }
        expect(tools.spawnTool("codex", ["exec"], { config, cwd: "/r" })).toBe(
            "child"
        )
        expect(spawn).toHaveBeenCalledWith("/opt/codex", ["exec"], {
            cwd: "/r",
        })
    })

    test("refuses a node binary before spawning", () => {
        const spawn = jest.fn()
        const tools = createTools({ spawn })
        expect(() =>
            tools.spawnTool("claude", [], {
                config: { reviewer: { claude: { binary: process.execPath } } },
            })
        ).toThrow(expect.objectContaining({ code: "TOOL_IS_NODE" }))
        expect(spawn).not.toHaveBeenCalled()
    })
})

describe("isGitTimeout", () => {
    test("matches only the GIT_TIMEOUT code", () => {
        expect(isGitTimeout({ code: "GIT_TIMEOUT" })).toBe(true)
        expect(isGitTimeout({ code: "TOOL_TIMEOUT" })).toBe(false)
        expect(isGitTimeout(null)).toBe(false)
    })
})
