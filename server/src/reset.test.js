/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { handleReset } from "./reset.js"
import { ContextError } from "./context.js"
import { createStateStore } from "./state.js"

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
    const dir = mkdtempSync(path.join(tmpdir(), "reset-store-"))
    const store = createStateStore({
        filePath: path.join(dir, "state.json"),
        now: () => 0,
    })
    store.__dir = dir
    return store
}

const cleanup = (store) => rmSync(store.__dir, { recursive: true, force: true })

describe("handleReset", () => {
    let store
    beforeEach(() => {
        store = makeStore()
    })
    afterEach(() => cleanup(store))

    test("returns 400 when cwd missing", () => {
        const r = handleReset({
            body: {},
            config: minimalConfig(),
            store,
            deps: { resolveContext: () => happyContext },
        })
        expect(r.httpStatus).toBe(400)
        expect(r.body.code).toBe("INVALID_REQUEST")
    })

    test("returns 403 on NOT_IN_ALLOWED_ROOT", () => {
        const r = handleReset({
            body: { cwd: "/repo" },
            config: minimalConfig(),
            store,
            deps: {
                resolveContext: () => {
                    throw new ContextError("NOT_IN_ALLOWED_ROOT", "nope")
                },
            },
        })
        expect(r.httpStatus).toBe(403)
        expect(r.body.code).toBe("NOT_IN_ALLOWED_ROOT")
    })

    test("returns 400 on NOT_A_GIT_REPO", () => {
        const r = handleReset({
            body: { cwd: "/repo" },
            config: minimalConfig(),
            store,
            deps: {
                resolveContext: () => {
                    throw new ContextError("NOT_A_GIT_REPO", "not git")
                },
            },
        })
        expect(r.httpStatus).toBe(400)
        expect(r.body.code).toBe("NOT_A_GIT_REPO")
    })

    test("falls back to INTERNAL_ERROR when resolveContext throws a non-ContextError", () => {
        const r = handleReset({
            body: { cwd: "/repo" },
            config: minimalConfig(),
            store,
            deps: {
                resolveContext: () => {
                    throw new Error("disk read failure")
                },
            },
        })
        expect(r.httpStatus).toBe(400)
        expect(r.body.code).toBe("INTERNAL_ERROR")
        expect(r.body.reason).toMatch(/disk read failure/)
    })

    test("clears counters/baseline/priorFindings for the resolved context", () => {
        // Seed.
        store.save(happyContext.key, {
            ...happyContext,
            codexRounds: 3,
            blockCount: 2,
            lastBaseline: { progressHash: "g" },
            priorFindings: [{ file: "a.js" }],
            lastReviewedAt: 1,
            lastResultStatus: "ISSUES",
        })
        const r = handleReset({
            body: { cwd: "/repo" },
            config: minimalConfig(),
            store,
            deps: { resolveContext: () => happyContext },
        })
        expect(r.httpStatus).toBe(200)
        expect(r.body.ok).toBe(true)
        expect(r.body.state.codexRounds).toBe(0)
        expect(r.body.state.blockCount).toBe(0)
        expect(r.body.state.lastResultStatus).toBeNull()
        // And the store really is fresh.
        const fresh = store.get(happyContext)
        expect(fresh.codexRounds).toBe(0)
        expect(fresh.priorFindings).toEqual([])
    })
})
