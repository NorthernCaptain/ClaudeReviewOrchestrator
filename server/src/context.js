/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { realpathSync } from "node:fs"
import path from "node:path"
import { createTools, isGitTimeout } from "./tools.js"

export class ContextError extends Error {
    constructor(code, message) {
        super(message)
        this.name = "ContextError"
        this.code = code
    }
}

// Async, with a hard timeout (tools.js); the shell passes its own
// configured git through deps, and this is the fallback.
const defaultTools = createTools()
const defaultGit = (cwd, args) => defaultTools.git(cwd, args)

// A git that timed out says nothing about the repo, so it surfaces as
// its own error instead of being mistaken for "not a git repository".
// HTTP status for a resolveContext failure: a root violation is 403, a
// stalled git is a transient 503, anything else is the caller's 400.
export const contextErrorStatus = (err) => {
    if (isGitTimeout(err)) return 503
    if (
        err instanceof ContextError &&
        (err.code === "NOT_IN_ALLOWED_ROOT" ||
            err.code === "NOT_IN_CLIENT_ROOT")
    ) {
        return 403
    }
    return 400
}

const defaultRealpath = (p) => realpathSync(p)

export const isContainedIn = (parent, child) => {
    const rel = path.relative(parent, child)
    if (rel === "") return true
    if (rel.startsWith("..")) return false
    if (path.isAbsolute(rel)) return false
    return true
}

const resolveBranch = async (git, repoRoot) => {
    let head
    try {
        head = await git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"])
    } catch (err) {
        if (isGitTimeout(err)) throw err
        // An unborn branch (a new repo before its first commit) has no
        // HEAD commit to resolve, but HEAD still names the branch.
        try {
            return await git(repoRoot, ["symbolic-ref", "--short", "HEAD"])
        } catch (refErr) {
            throw isGitTimeout(refErr) ? refErr : err
        }
    }
    if (head !== "HEAD") return head
    const sha = await git(repoRoot, ["rev-parse", "--short", "HEAD"])
    return `detached:${sha}`
}

export const resolveContext = async ({
    cwd,
    allowedRoots,
    git: rawGit = defaultGit,
    realpath = defaultRealpath,
}) => {
    const git = async (cwd, args) => String(await rawGit(cwd, args)).trim()
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
        repoRoot = await git(cwdReal, ["rev-parse", "--show-toplevel"])
    } catch (err) {
        if (isGitTimeout(err)) throw err
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

    const branch = await resolveBranch(git, repoRootReal)
    const repo = path.basename(repoRootReal)
    const key = `${repoRootReal}|${branch}`

    return { key, repo, repoRoot: repoRootReal, branch }
}

export const __test__ = { isContainedIn }
