/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { execFileSync } from "node:child_process"
import {
    mkdtempSync,
    rmSync,
    writeFileSync,
    mkdirSync,
    symlinkSync,
    realpathSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { resolveContext, ContextError, __test__ } from "./context.js"

const { isContainedIn } = __test__

const makeTmpDir = (prefix = "ctx-") => mkdtempSync(path.join(tmpdir(), prefix))

const initRepo = (dir, branch = "main") => {
    execFileSync("git", ["init", "-q", "-b", branch, dir])
    execFileSync("git", ["-C", dir, "config", "user.email", "t@t"])
    execFileSync("git", ["-C", dir, "config", "user.name", "t"])
    writeFileSync(path.join(dir, "README.md"), "hi\n")
    execFileSync("git", ["-C", dir, "add", "."])
    execFileSync("git", ["-C", dir, "commit", "-qm", "init"])
}

describe("isContainedIn", () => {
    test("exact match → true", async () => {
        expect(isContainedIn("/Users/leo", "/Users/leo")).toBe(true)
    })
    test("child path → true", async () => {
        expect(isContainedIn("/Users/leo", "/Users/leo/foo/bar")).toBe(true)
    })
    test("sibling with prefix collision → false", async () => {
        expect(isContainedIn("/Users/leo", "/Users/leo2")).toBe(false)
    })
    test("parent path → false", async () => {
        expect(isContainedIn("/Users/leo/foo", "/Users/leo")).toBe(false)
    })
    test("unrelated path → false", async () => {
        expect(isContainedIn("/etc", "/Users/leo")).toBe(false)
    })
})

describe("resolveContext", () => {
    let tmp
    beforeEach(() => {
        tmp = makeTmpDir()
    })
    afterEach(() => {
        rmSync(tmp, { recursive: true, force: true })
    })

    test("rejects relative cwd", async () => {
        await expect(
            resolveContext({ cwd: "relative", allowedRoots: ["/"] })
        ).rejects.toThrow(ContextError)
    })

    test("rejects non-existent cwd", async () => {
        try {
            await resolveContext({
                cwd: path.join(tmp, "does-not-exist"),
                allowedRoots: [tmp],
            })
            throw new Error("expected throw")
        } catch (err) {
            expect(err).toBeInstanceOf(ContextError)
            expect(err.code).toBe("INVALID_CWD")
        }
    })

    test("rejects non-git directory with NOT_A_GIT_REPO", async () => {
        try {
            await resolveContext({ cwd: tmp, allowedRoots: [tmp] })
            throw new Error("expected throw")
        } catch (err) {
            expect(err.code).toBe("NOT_A_GIT_REPO")
        }
    })

    test("rejects when repo root is outside allowedRoots", async () => {
        initRepo(tmp)
        try {
            await resolveContext({
                cwd: tmp,
                allowedRoots: ["/etc"],
            })
            throw new Error("expected throw")
        } catch (err) {
            expect(err.code).toBe("NOT_IN_ALLOWED_ROOT")
        }
    })

    test("does not false-match /tmp/foo vs /tmp/foo2", async () => {
        const foo = makeTmpDir("ctx-foo-")
        const foo2 = `${foo}2`
        mkdirSync(foo2)
        initRepo(foo2)
        try {
            await resolveContext({ cwd: foo2, allowedRoots: [foo] })
            throw new Error("expected throw")
        } catch (err) {
            expect(err.code).toBe("NOT_IN_ALLOWED_ROOT")
        } finally {
            rmSync(foo, { recursive: true, force: true })
            rmSync(foo2, { recursive: true, force: true })
        }
    })

    test("resolves valid repo, returns key/repo/repoRoot/branch", async () => {
        initRepo(tmp, "main")
        const ctx = await resolveContext({
            cwd: tmp,
            allowedRoots: [tmp],
        })
        expect(ctx.branch).toBe("main")
        expect(ctx.repo).toBe(path.basename(ctx.repoRoot))
        expect(ctx.key).toBe(`${ctx.repoRoot}|main`)
    })

    test("collapses subdirectory cwd to repo root", async () => {
        initRepo(tmp)
        const sub = path.join(tmp, "src", "deep")
        mkdirSync(sub, { recursive: true })
        const ctx = await resolveContext({ cwd: sub, allowedRoots: [tmp] })
        expect(ctx.repoRoot).toBe(realpathSync(tmp))
    })

    test("an unborn branch (no commits yet) still resolves its name", async () => {
        execFileSync("git", ["init", "-q", "-b", "feature", tmp])
        writeFileSync(path.join(tmp, "a.js"), "x\n")
        execFileSync("git", ["-C", tmp, "add", "."])
        const ctx = await resolveContext({ cwd: tmp, allowedRoots: [tmp] })
        expect(ctx.branch).toBe("feature")
        expect(ctx.key).toBe(`${ctx.repoRoot}|feature`)
    })

    test("rethrows the HEAD error when HEAD is neither a commit nor a branch", async () => {
        const headError = new Error("bad HEAD")
        const fakeGit = (cwd, args) => {
            if (args[1] === "--show-toplevel") return tmp
            if (args[1] === "--abbrev-ref") throw headError
            throw new Error("not a symbolic ref")
        }
        await expect(
            resolveContext({
                cwd: tmp,
                allowedRoots: [tmp],
                git: fakeGit,
                realpath: (p) => p,
            })
        ).rejects.toThrow(headError)
    })

    test.each([["--show-toplevel"], ["--abbrev-ref"]])(
        "a git timeout on %s surfaces as GIT_TIMEOUT, not as a repo verdict",
        async (stalled) => {
            const timeout = Object.assign(new Error("timed out"), {
                code: "GIT_TIMEOUT",
            })
            const fakeGit = async (cwd, args) => {
                if (args[1] === stalled) throw timeout
                if (args[1] === "--show-toplevel") return `${tmp}\n`
                return "main\n"
            }
            await expect(
                resolveContext({
                    cwd: tmp,
                    allowedRoots: [tmp],
                    git: fakeGit,
                    realpath: (p) => p,
                })
            ).rejects.toBe(timeout)
        }
    )

    test("an unborn branch's symbolic-ref timeout surfaces as GIT_TIMEOUT", async () => {
        const timeout = Object.assign(new Error("timed out"), {
            code: "GIT_TIMEOUT",
        })
        const fakeGit = async (cwd, args) => {
            if (args[1] === "--show-toplevel") return tmp
            if (args[0] === "symbolic-ref") throw timeout
            throw new Error("unknown revision HEAD")
        }
        await expect(
            resolveContext({
                cwd: tmp,
                allowedRoots: [tmp],
                git: fakeGit,
                realpath: (p) => p,
            })
        ).rejects.toBe(timeout)
    })

    test("an async git's output is trimmed", async () => {
        const fakeGit = async (cwd, args) =>
            args[1] === "--show-toplevel" ? `${tmp}\n` : "dev\n"
        const ctx = await resolveContext({
            cwd: tmp,
            allowedRoots: [tmp],
            git: fakeGit,
            realpath: (p) => p,
        })
        expect(ctx).toMatchObject({ repoRoot: tmp, branch: "dev" })
    })

    test("detached HEAD produces detached:<sha> branch", async () => {
        initRepo(tmp)
        // Detach by checking out the commit SHA.
        const sha = execFileSync("git", ["-C", tmp, "rev-parse", "HEAD"])
            .toString()
            .trim()
        execFileSync("git", ["-C", tmp, "checkout", "-q", sha])
        const ctx = await resolveContext({ cwd: tmp, allowedRoots: [tmp] })
        expect(ctx.branch).toMatch(/^detached:[0-9a-f]+$/)
    })

    test("rejects when git reports a repo root outside allowedRoots", async () => {
        // Inject fake git so the pre-check passes (cwd inside tmp) but the
        // resolved repo root lies elsewhere.
        const fakeGit = (cwd, args) => {
            if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
                return "/somewhere/else"
            }
            return "main"
        }
        const fakeRealpath = (p) => p
        try {
            await resolveContext({
                cwd: tmp,
                allowedRoots: [tmp],
                git: fakeGit,
                realpath: fakeRealpath,
            })
            throw new Error("expected throw")
        } catch (err) {
            expect(err.code).toBe("NOT_IN_ALLOWED_ROOT")
        }
    })

    test("rejects when realpath fails for the resolved repo root", async () => {
        // git claims a repo root that realpath cannot resolve.
        const fakeGit = (cwd, args) => {
            if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
                return "/gone"
            }
            return "main"
        }
        let calls = 0
        const fakeRealpath = (p) => {
            calls++
            if (p === "/gone") throw new Error("ENOENT")
            return p
        }
        try {
            await resolveContext({
                cwd: tmp,
                allowedRoots: [tmp],
                git: fakeGit,
                realpath: fakeRealpath,
            })
            throw new Error("expected throw")
        } catch (err) {
            expect(err.code).toBe("NOT_A_GIT_REPO")
        }
        expect(calls).toBeGreaterThan(0)
    })

    test("tolerates a non-existent path in allowedRoots when another root matches", async () => {
        initRepo(tmp)
        const ctx = await resolveContext({
            cwd: tmp,
            allowedRoots: ["/does-not-exist", tmp],
        })
        expect(ctx.repoRoot).toBe(realpathSync(tmp))
    })

    test("resolves through symlinks", async () => {
        initRepo(tmp)
        const linkParent = makeTmpDir("ctx-link-")
        const link = path.join(linkParent, "link")
        symlinkSync(tmp, link)
        try {
            const ctx = await resolveContext({
                cwd: link,
                allowedRoots: [tmp],
            })
            expect(ctx.repoRoot).toBe(realpathSync(tmp))
        } finally {
            rmSync(linkParent, { recursive: true, force: true })
        }
    })
})
