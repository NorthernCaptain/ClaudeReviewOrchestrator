/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { jest } from "@jest/globals"
import { handleNotifyChange } from "./notify-change.js"
import { ContextError } from "./context.js"

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
