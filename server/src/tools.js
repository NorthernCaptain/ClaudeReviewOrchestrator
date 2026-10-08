/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

// Shell-owned process capability (hot-reload plan §5.3 step 3a). Every
// external process the server runs goes through here:
//   * execTool  — buffered, async, with a hard timeout (git).
//   * spawnTool — streaming child process (the reviewer CLIs).
// Only allowlisted tool names run, and a binary that resolves to a Node
// executable is refused, so no caller can start `node <script>` and run
// JavaScript from outside the code it was loaded from. The binary is
// located the way the child's exec would find it (its cwd and PATH), and
// that same absolute path is what runs, so the file checked is the file
// executed. There is no
// synchronous variant: a stalled subprocess must never block the event
// loop that serves deadlines, admissions and reloads.

import {
    execFile as nodeExecFile,
    spawn as nodeSpawn,
} from "node:child_process"
import { accessSync, constants, realpathSync, statSync } from "node:fs"
import path from "node:path"

export const DEFAULT_GIT_TIMEOUT_MS = 30_000
// Grace between SIGTERM and SIGKILL for a timed-out child.
export const KILL_GRACE_MS = 2_000
const MAX_BUFFER_BYTES = 64 * 1024 * 1024

export const REVIEWER_TOOLS = Object.freeze({
    codex: (config) => config?.codex?.binary ?? "codex",
    claude: (config) => config?.reviewer?.claude?.binary ?? "claude",
    gemini: (config) => config?.reviewer?.gemini?.binary ?? "gemini",
})

export const isGitTimeout = (err) => err?.code === "GIT_TIMEOUT"

export class ToolError extends Error {
    constructor(code, message) {
        super(message)
        this.name = "ToolError"
        this.code = code
    }
}

const realpathOr = (p, realpath) => {
    try {
        return realpath(p)
    } catch {
        return p
    }
}

// What the launcher searches when the child has no PATH at all.
export const DEFAULT_SEARCH_PATH = "/usr/bin:/bin"

// Where the child's exec would find `binary`: a name with a slash is
// relative to the child's cwd; a bare name is the first executable file
// on the child's PATH, whose relative entries (and empty ones, meaning
// the cwd itself) are relative to that cwd too. Returns an absolute path,
// or null when nothing matches.
export const locateExecutable = (
    binary,
    {
        cwd = process.cwd(),
        env = process.env,
        stat = statSync,
        access = accessSync,
    } = {}
) => {
    const runnable = (p) => {
        try {
            if (!stat(p).isFile()) return false
            access(p, constants.X_OK)
            return true
        } catch {
            return false
        }
    }
    if (binary.includes("/")) {
        const abs = path.resolve(cwd, binary)
        return runnable(abs) ? abs : null
    }
    const searchPath = env.PATH ?? DEFAULT_SEARCH_PATH
    for (const dir of searchPath.split(path.delimiter)) {
        const candidate = path.resolve(cwd, dir, binary)
        if (runnable(candidate)) return candidate
    }
    return null
}

// True when the located file is a Node executable: basename node /
// nodejs once symlinks are resolved, or the running process's own binary.
export const isNodeExecutable = (
    located,
    { execPath = process.execPath, realpath = realpathSync } = {}
) => {
    const real = realpathOr(located, realpath)
    const base = path.basename(real)
    if (base === "node" || base === "nodejs") return true
    return real === realpathOr(execPath, realpath)
}

// The absolute path to exec for `binary` in a child with this cwd and
// env, refused when it is Node. Missing binaries fail like spawn does.
export const resolveRunnable = (
    binary,
    {
        cwd,
        env,
        label = binary,
        locate = locateExecutable,
        nodeCheck = isNodeExecutable,
    } = {}
) => {
    const located = locate(binary, {
        cwd: cwd ?? process.cwd(),
        env: env ?? process.env,
    })
    if (!located) {
        throw Object.assign(new Error(`spawn ${binary} ENOENT`), {
            code: "ENOENT",
            syscall: `spawn ${binary}`,
            path: binary,
        })
    }
    if (nodeCheck(located)) {
        throw new ToolError(
            "TOOL_IS_NODE",
            `refusing to run a Node executable as ${label}: ${binary}`
        )
    }
    return located
}

export const createTools = ({
    execFile = nodeExecFile,
    spawn = nodeSpawn,
    getGitTimeoutMs = () => DEFAULT_GIT_TIMEOUT_MS,
    nodeCheck = isNodeExecutable,
    locate = locateExecutable,
    // (config) → true for a config the shell pinned to an admitted review.
    // When given, the reviewer tools run only with one of those, so a core
    // can't pick a binary from a config it assembled itself.
    isIssuedConfig = null,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    killGraceMs = KILL_GRACE_MS,
} = {}) => {
    // Allowlist + config lookup, then the absolute runnable path for a
    // child started with `where` ({ cwd, env }).
    const resolveBinary = (name, config, where = {}) => {
        let binary
        if (name === "git") {
            binary = "git"
        } else if (Object.hasOwn(REVIEWER_TOOLS, name)) {
            if (!config || typeof config !== "object") {
                throw new ToolError(
                    "TOOL_CONFIG_REQUIRED",
                    `${name} needs the caller's pinned config`
                )
            }
            if (isIssuedConfig && !isIssuedConfig(config)) {
                throw new ToolError(
                    "TOOL_CONFIG_NOT_ISSUED",
                    `${name} needs the config the shell pinned to this review`
                )
            }
            binary = REVIEWER_TOOLS[name](config)
        } else {
            throw new ToolError("TOOL_NOT_ALLOWED", `tool not allowed: ${name}`)
        }
        return resolveRunnable(binary, {
            cwd: where.cwd,
            env: where.env,
            label: name,
            locate,
            nodeCheck,
        })
    }

    // Buffered run with a hard timeout. Resolves with stdout (utf8).
    // Rejects like execFileSync used to throw, with the exit code on
    // `status`, so callers that inspect it keep working. A timed-out
    // call settles by the end of the kill grace even if the callback
    // never comes: a helper git spawned can inherit and hold the pipes
    // open after git itself is gone, so our ends are destroyed too.
    const execTool = (name, args, opts = {}) =>
        new Promise((resolve, reject) => {
            let binary
            try {
                binary = resolveBinary(name, opts.config, opts)
            } catch (err) {
                reject(err)
                return
            }
            const timeoutMs =
                opts.timeoutMs ??
                (name === "git" ? getGitTimeoutMs() : DEFAULT_GIT_TIMEOUT_MS)
            let timedOut = false
            let settled = false
            let timer = null
            let killTimer = null
            const timeoutError = (stderr) => {
                const e = new ToolError(
                    name === "git" ? "GIT_TIMEOUT" : "TOOL_TIMEOUT",
                    `${name} ${args.join(" ")} timed out after ${timeoutMs}ms`
                )
                e.stderr = stderr
                return e
            }
            const child = execFile(
                binary,
                args,
                {
                    cwd: opts.cwd,
                    encoding: "utf8",
                    maxBuffer: MAX_BUFFER_BYTES,
                    env: opts.env,
                },
                (err, stdout, stderr) => {
                    if (settled) return
                    settled = true
                    if (timer) clearTimer(timer)
                    if (killTimer) clearTimer(killTimer)
                    if (timedOut) {
                        reject(timeoutError(stderr))
                        return
                    }
                    if (err) {
                        if (typeof err.code === "number") err.status = err.code
                        err.stdout = stdout
                        err.stderr = stderr
                        reject(err)
                        return
                    }
                    resolve(stdout)
                }
            )
            if (settled) return
            timer = setTimer(() => {
                timedOut = true
                child.kill("SIGTERM")
                killTimer = setTimer(() => {
                    child.kill("SIGKILL")
                    if (settled) return
                    settled = true
                    for (const stream of [
                        child.stdin,
                        child.stdout,
                        child.stderr,
                    ]) {
                        stream?.destroy()
                    }
                    reject(timeoutError(""))
                }, killGraceMs)
            }, timeoutMs)
        })

    // Streaming child for the reviewer CLIs; same allowlist and Node check.
    const spawnTool = (name, args, opts = {}) => {
        const { config, ...spawnOpts } = opts
        return spawn(resolveBinary(name, config, spawnOpts), args, spawnOpts)
    }

    // git(cwd, args) → Promise<stdout>, the shape diff.js / context.js take.
    const git = (cwd, args) => execTool("git", ["-C", cwd, ...args])

    return { execTool, spawnTool, git, resolveBinary }
}
