/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { jest } from "@jest/globals"
import { editedFolder, handleNotifyChange } from "./notify-change.js"
import { ContextError } from "./review/context.js"

const minimalConfig = () => ({
    allowedRoots: ["/repo"],
})

const happyContext = {
    repo: "repo",
    repoRoot: "/repo",
    branch: "main",
    key: "/repo|main",
}

const makeStore = () => {
    const state = {}
    return {
        state,
        save: (key, next) => {
            state[key] = { ...(state[key] ?? {}), ...next, key }
            return { ...state[key] }
        },
        peek: (key) => state[key] ?? null,
    }
}

describe("handleNotifyChange", () => {
    test("400 when cwd is missing or empty", async () => {
        const store = makeStore()
        const r1 = await handleNotifyChange({
            body: {},
            config: minimalConfig(),
            store,
        })
        expect(r1.httpStatus).toBe(400)
        expect(r1.body.ok).toBe(false)
        const r2 = await handleNotifyChange({
            body: { cwd: "" },
            config: minimalConfig(),
            store,
        })
        expect(r2.httpStatus).toBe(400)
    })

    test("403 when context resolution rejects (cwd outside allowedRoots)", async () => {
        const store = makeStore()
        const result = await handleNotifyChange({
            body: { cwd: "/elsewhere" },
            config: minimalConfig(),
            store,
            deps: {
                resolveContext: () => {
                    const err = new ContextError("nope")
                    err.code = "NOT_IN_ALLOWED_ROOT"
                    throw err
                },
            },
        })
        expect(result.httpStatus).toBe(403)
    })

    test("400 when context resolution fails for an unknown reason", async () => {
        const store = makeStore()
        const result = await handleNotifyChange({
            body: { cwd: "/repo" },
            config: minimalConfig(),
            store,
            deps: {
                resolveContext: () => {
                    throw new Error("not a git repo")
                },
            },
        })
        expect(result.httpStatus).toBe(400)
    })

    test("happy path: marks the context dirty and stamps lastChangeAt", async () => {
        const store = makeStore()
        const result = await handleNotifyChange({
            body: {
                cwd: "/repo",
                tool: "Write",
                file: "src/a.js",
            },
            config: minimalConfig(),
            store,
            now: () => 1_700_000_000_000,
            deps: { resolveContext: () => happyContext },
        })
        expect(result.httpStatus).toBe(200)
        expect(result.body.ok).toBe(true)
        expect(result.body.dirty).toBe(true)
        expect(result.body.lastChangeAt).toBe(1_700_000_000_000)
        // The store now holds dirty + lastChangeAt for the context.
        expect(store.state["/repo|main"].dirtySinceLastReview).toBe(true)
        expect(store.state["/repo|main"].lastChangeAt).toBe(1_700_000_000_000)
        // repoRoot/branch propagated so save() can create the slot.
        expect(store.state["/repo|main"].repoRoot).toBe("/repo")
        expect(store.state["/repo|main"].branch).toBe("main")
    })

    test("preserves existing cache fields (shallow merge via store.save)", async () => {
        const store = makeStore()
        // Pre-seed an existing context with a baseline + result status.
        store.save("/repo|main", {
            repoRoot: "/repo",
            branch: "main",
            lastResultStatus: "GOOD_TO_GO",
            lastBaseline: { progressHash: "abc" },
            dirtySinceLastReview: false,
        })
        await handleNotifyChange({
            body: { cwd: "/repo", tool: "Edit", file: "a.js" },
            config: minimalConfig(),
            store,
            now: () => 12345,
            deps: { resolveContext: () => happyContext },
        })
        // dirty flips to true; baseline + lastResultStatus untouched.
        expect(store.state["/repo|main"].dirtySinceLastReview).toBe(true)
        expect(store.state["/repo|main"].lastResultStatus).toBe("GOOD_TO_GO")
        expect(store.state["/repo|main"].lastBaseline).toEqual({
            progressHash: "abc",
        })
    })

    test("logs at info level with tool + file fields", async () => {
        const store = makeStore()
        const info = jest.fn()
        await handleNotifyChange({
            body: { cwd: "/repo", tool: "MultiEdit", file: "src/b.ts" },
            config: minimalConfig(),
            store,
            logger: { info, warn: () => {}, error: () => {} },
            deps: { resolveContext: () => happyContext },
        })
        expect(info).toHaveBeenCalled()
        const [fields, msg] = info.mock.calls[0]
        expect(msg).toBe("change notification")
        expect(fields.tool).toBe("MultiEdit")
        expect(fields.file).toBe("src/b.ts")
        expect(fields.repo).toBe("repo")
        expect(fields.branch).toBe("main")
    })
})

describe("handleNotifyChange — git capability", () => {
    test("a git timeout is a transient 503", async () => {
        const result = await handleNotifyChange({
            body: { cwd: "/repo" },
            config: minimalConfig(),
            store: makeStore(),
            deps: {
                resolveContext: async () => {
                    throw Object.assign(new Error("git timed out"), {
                        code: "GIT_TIMEOUT",
                    })
                },
            },
        })
        expect(result.httpStatus).toBe(503)
        expect(result.body.ok).toBe(false)
    })

    test("passes the shell's git through to resolveContext", async () => {
        const git = async () => ""
        let seen
        await handleNotifyChange({
            body: { cwd: "/repo" },
            config: minimalConfig(),
            store: makeStore(),
            deps: {
                git,
                resolveContext: async (args) => {
                    seen = args.git
                    return happyContext
                },
            },
        })
        expect(seen).toBe(git)
    })
})

describe("handleNotifyChange — the edited file's own repo", () => {
    const contexts = {
        "/work/repo1": {
            ...happyContext,
            repoRoot: "/work/repo1",
            key: "/work/repo1|main",
        },
        "/work/tmp/repo2-wt/lib": {
            repo: "repo2",
            repoRoot: "/work/tmp/repo2-wt",
            branch: "feat",
            key: "/work/tmp/repo2-wt|feat",
        },
    }
    const resolveContext = jest.fn(async ({ cwd }) => {
        const c = contexts[cwd]
        if (!c) throw new ContextError("NOT_A_REPO", `no repo at ${cwd}`)
        return c
    })
    let store
    const run = (body, exists = () => true) => {
        store = makeStore()
        return handleNotifyChange({
            body,
            config: minimalConfig(),
            store,
            deps: { resolveContext, exists },
            now: () => 5000,
        })
    }

    test("an edit in another repo's worktree marks that repo, not the session's", async () => {
        const r = await run({
            cwd: "/work/repo1",
            tool: "Edit",
            file: "/work/tmp/repo2-wt/lib/a.php",
        })
        expect(r.httpStatus).toBe(200)
        expect(r.body.context.key).toBe("/work/tmp/repo2-wt|feat")
        // ...and links it to the session's repo, for its Stop hook.
        expect(r.body.linkedTo).toBe("/work/repo1|main")
        expect(store.state["/work/repo1|main"].linkedContexts).toEqual({
            "/work/tmp/repo2-wt|feat": {
                repo: "repo2",
                repoRoot: "/work/tmp/repo2-wt",
                branch: "feat",
                linkedAt: 5000,
                lastChangeAt: 5000,
            },
        })
    })

    test("a session in a repo nested inside the edited one still links it", async () => {
        contexts["/work/tmp/repo2-wt/vendor/sub"] = {
            repo: "sub",
            repoRoot: "/work/tmp/repo2-wt/vendor/sub",
            branch: "main",
            key: "/work/tmp/repo2-wt/vendor/sub|main",
        }
        const r = await run({
            cwd: "/work/tmp/repo2-wt/vendor/sub",
            file: "/work/tmp/repo2-wt/lib/a.php",
        })
        expect(r.body.context.key).toBe("/work/tmp/repo2-wt|feat")
        expect(r.body.linkedTo).toBe("/work/tmp/repo2-wt/vendor/sub|main")
    })

    test("an edit inside the session's own repo links nothing", async () => {
        const r = await run({
            cwd: "/work/tmp/repo2-wt",
            file: "/work/tmp/repo2-wt/lib/a.php",
        })
        expect(r.body.linkedTo).toBeUndefined()
        expect(
            store.state["/work/tmp/repo2-wt|feat"].linkedContexts
        ).toBeUndefined()
    })

    test("a session folder that isn't a repo still gets the edit marked, just not linked", async () => {
        const warn = jest.fn()
        const r = await handleNotifyChange({
            body: { cwd: "/work/notes", file: "/work/tmp/repo2-wt/lib/a.php" },
            config: minimalConfig(),
            store: makeStore(),
            logger: { info() {}, warn, error() {} },
            deps: { resolveContext, exists: () => true },
        })
        expect(r.httpStatus).toBe(200)
        expect(r.body.context.key).toBe("/work/tmp/repo2-wt|feat")
        expect(r.body.linkedTo).toBeUndefined()
        expect(warn).toHaveBeenCalledWith(
            expect.objectContaining({ cwd: "/work/notes" }),
            "notify-change: session repo unresolved, edit not linked"
        )
    })

    test("no absolute path (a shell edit, a relative path) falls back to the session's cwd", async () => {
        for (const file of [null, undefined, "lib/a.php"]) {
            const r = await run({ cwd: "/work/repo1", file })
            expect(r.body.context.key).toBe("/work/repo1|main")
        }
    })

    test("a file outside any reviewable repo marks the session's repo, as before", async () => {
        const r = await run({ cwd: "/work/repo1", file: "/tmp/notes.md" })
        expect(r.httpStatus).toBe(200)
        expect(r.body.context.key).toBe("/work/repo1|main")
    })

    test("a git timeout on the file's repo fails the request instead of falling back", async () => {
        const r = await handleNotifyChange({
            body: { cwd: "/work/repo1", file: "/work/tmp/repo2-wt/lib/a.php" },
            config: minimalConfig(),
            store: makeStore(),
            deps: {
                exists: () => true,
                resolveContext: async ({ cwd }) => {
                    if (cwd === "/work/repo1") return contexts[cwd]
                    throw Object.assign(new Error("git timed out"), {
                        code: "GIT_TIMEOUT",
                    })
                },
            },
        })
        expect(r.httpStatus).toBe(503)
    })

    test("editedFolder walks up past folders that don't exist yet", () => {
        const existing = new Set([
            "/work/tmp/repo2-wt",
            "/work/tmp",
            "/work",
            "/",
        ])
        const exists = (d) => existing.has(d)
        expect(editedFolder("/work/tmp/repo2-wt/new/deep/a.js", exists)).toBe(
            "/work/tmp/repo2-wt"
        )
        expect(editedFolder("/nowhere/a.js", () => false)).toBeNull()
        expect(editedFolder("rel/a.js")).toBeNull()
        expect(editedFolder(42)).toBeNull()
    })
})
