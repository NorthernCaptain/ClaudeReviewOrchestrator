/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { execFileSync } from "node:child_process"
import { realpathSync } from "node:fs"
import path from "node:path"

export class ContextError extends Error {
    constructor(code, message) {
        super(message)
        this.name = "ContextError"
        this.code = code
    }
}

const defaultGit = (cwd, args) =>
    execFileSync("git", ["-C", cwd, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
    }).trim()

const defaultRealpath = (p) => realpathSync(p)

const isContainedIn = (parent, child) => {
    const rel = path.relative(parent, child)
    if (rel === "") return true
    if (rel.startsWith("..")) return false
    if (path.isAbsolute(rel)) return false
    return true
}

const resolveBranch = (git, repoRoot) => {
    const head = git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"])
    if (head !== "HEAD") return head
    const sha = git(repoRoot, ["rev-parse", "--short", "HEAD"])
    return `detached:${sha}`
}

export const resolveContext = ({
    cwd,
    allowedRoots,
    git = defaultGit,
    realpath = defaultRealpath,
}) => {
    if (!cwd || typeof cwd !== "string" || !path.isAbsolute(cwd)) {
        throw new ContextError(
            "INVALID_CWD",
            `cwd must be an absolute path, got: ${cwd}`
        )
    }

    let cwdReal
    try {
        cwdReal = realpath(cwd)
    } catch {
        throw new ContextError("INVALID_CWD", `cwd does not exist: ${cwd}`)
    }

    // Cheap pre-check: cwd must already be inside an allowed root before we
    // probe for a git repo. Without this, callers could enumerate which
    // arbitrary paths are git repos on the host.
    const cwdAllowed = allowedRoots.some((root) => {
        let rootReal
        try {
            rootReal = realpath(root)
        } catch {
            return false
        }
        return isContainedIn(rootReal, cwdReal)
    })
    if (!cwdAllowed) {
        throw new ContextError(
            "NOT_IN_ALLOWED_ROOT",
            `cwd not in allowed roots: ${cwd}`
        )
    }

    let repoRoot
    try {
        repoRoot = git(cwdReal, ["rev-parse", "--show-toplevel"])
    } catch {
        throw new ContextError("NOT_A_GIT_REPO", `not a git repository: ${cwd}`)
    }

    let repoRootReal
    try {
        repoRootReal = realpath(repoRoot)
    } catch {
        throw new ContextError(
            "NOT_A_GIT_REPO",
            `repo root does not exist: ${repoRoot}`
        )
    }

    const allowed = allowedRoots.some((root) => {
        let rootReal
        try {
            rootReal = realpath(root)
        } catch {
            return false
        }
        return isContainedIn(rootReal, repoRootReal)
    })

    if (!allowed) {
        throw new ContextError(
            "NOT_IN_ALLOWED_ROOT",
            `cwd not in allowed roots: ${cwd}`
        )
    }

    const branch = resolveBranch(git, repoRootReal)
    const repo = path.basename(repoRootReal)
    const key = `${repoRootReal}|${branch}`

    return { key, repo, repoRoot: repoRootReal, branch }
}

export const __test__ = { isContainedIn }
