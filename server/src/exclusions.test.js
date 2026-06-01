/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createStateStore } from "./state.js"
import { handleExclusionMutation } from "./exclusions.js"

const makeStore = () => {
    const dir = mkdtempSync(path.join(tmpdir(), "excl-store-"))
    const store = createStateStore({
        filePath: path.join(dir, "state.json"),
        now: () => 0,
    })
    store.__dir = dir
    return store
}

const cleanup = (store) => rmSync(store.__dir, { recursive: true, force: true })

const seed = (store, opts = {}) => {
    store.save("/r|main", {
        repoRoot: "/r",
        branch: "main",
        exclusions: opts.exclusions ?? [],
        priorFindings: opts.priorFindings ?? [],
        ...opts.extra,
    })
}

describe("handleExclusionMutation — validation", () => {
    let store
    beforeEach(() => {
        store = makeStore()
    })
    afterEach(() => cleanup(store))

    test("400 when contextKey is missing", () => {
        const r = handleExclusionMutation({ body: {}, store })
        expect(r.httpStatus).toBe(400)
        expect(r.body.error).toMatch(/contextKey/)
    })

    test("400 when action is missing or invalid", () => {
        seed(store)
        const r = handleExclusionMutation({
            body: { contextKey: "/r|main", file: "a", message: "m" },
            store,
        })
        expect(r.httpStatus).toBe(400)
        const r2 = handleExclusionMutation({
            body: {
                contextKey: "/r|main",
                file: "a",
                message: "m",
                action: "wat",
            },
            store,
        })
        expect(r2.httpStatus).toBe(400)
    })

    test("400 when file or message is empty", () => {
        seed(store)
        const r = handleExclusionMutation({
            body: {
                contextKey: "/r|main",
                action: "add",
                file: "",
                message: "m",
            },
            store,
        })
        expect(r.httpStatus).toBe(400)
        const r2 = handleExclusionMutation({
            body: {
                contextKey: "/r|main",
                action: "add",
                file: "a",
                message: "",
            },
            store,
        })
        expect(r2.httpStatus).toBe(400)
    })

    test("404 when contextKey doesn't exist in the store", () => {
        const r = handleExclusionMutation({
            body: {
                contextKey: "/nope|x",
                action: "add",
                file: "a",
                message: "m",
            },
            store,
        })
        expect(r.httpStatus).toBe(404)
    })
})

describe("handleExclusionMutation — add", () => {
    let store
    beforeEach(() => {
        store = makeStore()
    })
    afterEach(() => cleanup(store))

    test("adds a new entry with excludedAt stamped from now()", () => {
        seed(store)
        const r = handleExclusionMutation({
            body: {
                contextKey: "/r|main",
                action: "add",
                file: "a.js",
                message: "noise",
            },
            store,
            now: () => 12345,
        })
        expect(r.httpStatus).toBe(200)
        expect(r.body.exclusions).toEqual([
            { file: "a.js", message: "noise", excludedAt: 12345 },
        ])
    })

    test("is idempotent — adding the same (file, message) twice is a no-op", () => {
        seed(store, {
            exclusions: [{ file: "a", message: "m", excludedAt: 1 }],
        })
        const r = handleExclusionMutation({
            body: {
                contextKey: "/r|main",
                action: "add",
                file: "a",
                message: "m",
            },
            store,
            now: () => 999,
        })
        expect(r.httpStatus).toBe(200)
        expect(r.body.exclusions).toHaveLength(1)
        // The original excludedAt is preserved, not overwritten.
        expect(r.body.exclusions[0].excludedAt).toBe(1)
    })

    test("adding strips matching entries from saved priorFindings", () => {
        seed(store, {
            priorFindings: [
                {
                    file: "a.js",
                    message: "noise",
                    severity: "blocker",
                    category: "bug",
                    line: 1,
                },
                {
                    file: "b.js",
                    message: "real",
                    severity: "blocker",
                    category: "bug",
                    line: 2,
                },
            ],
        })
        handleExclusionMutation({
            body: {
                contextKey: "/r|main",
                action: "add",
                file: "a.js",
                message: "noise",
            },
            store,
        })
        const after = store.get({
            key: "/r|main",
            repoRoot: "/r",
            branch: "main",
        })
        expect(after.priorFindings).toHaveLength(1)
        expect(after.priorFindings[0].file).toBe("b.js")
    })
})

describe("handleExclusionMutation — remove", () => {
    let store
    beforeEach(() => {
        store = makeStore()
    })
    afterEach(() => cleanup(store))

    test("removes a matching entry", () => {
        seed(store, {
            exclusions: [
                { file: "a", message: "m", excludedAt: 1 },
                { file: "b", message: "n", excludedAt: 2 },
            ],
        })
        const r = handleExclusionMutation({
            body: {
                contextKey: "/r|main",
                action: "remove",
                file: "a",
                message: "m",
            },
            store,
        })
        expect(r.httpStatus).toBe(200)
        expect(r.body.exclusions).toEqual([
            { file: "b", message: "n", excludedAt: 2 },
        ])
    })

    test("is idempotent — removing a non-existent entry returns the current list unchanged", () => {
        seed(store, {
            exclusions: [{ file: "a", message: "m", excludedAt: 1 }],
        })
        const r = handleExclusionMutation({
            body: {
                contextKey: "/r|main",
                action: "remove",
                file: "different",
                message: "x",
            },
            store,
        })
        expect(r.httpStatus).toBe(200)
        expect(r.body.exclusions).toHaveLength(1)
    })

    test("remove does NOT touch priorFindings (it's only an add-time cleanup)", () => {
        // priorFindings is curated server-side; removing an exclusion
        // shouldn't re-introduce the finding into the cache.
        seed(store, {
            priorFindings: [{ file: "b.js", message: "real", line: 1 }],
            exclusions: [{ file: "a", message: "m", excludedAt: 1 }],
        })
        handleExclusionMutation({
            body: {
                contextKey: "/r|main",
                action: "remove",
                file: "a",
                message: "m",
            },
            store,
        })
        const after = store.get({
            key: "/r|main",
            repoRoot: "/r",
            branch: "main",
        })
        expect(after.priorFindings).toEqual([
            { file: "b.js", message: "real", line: 1 },
        ])
    })
})

describe("handleExclusionMutation — review cache invalidation (v1.1.5)", () => {
    let store
    beforeEach(() => {
        store = makeStore()
    })
    afterEach(() => cleanup(store))

    test("adding an exclusion clears lastBaseline and flips dirtySinceLastReview", () => {
        // Pre-mutation: a clean cached GOOD_TO_GO baseline that the
        // next review would short-circuit on.
        store.save("/r|main", {
            repoRoot: "/r",
            branch: "main",
            lastResultStatus: "GOOD_TO_GO",
            lastBaseline: { progressHash: "p", reviewConfigHash: "c" },
            dirtySinceLastReview: false,
            exclusions: [],
        })
        handleExclusionMutation({
            body: {
                contextKey: "/r|main",
                action: "add",
                file: "a.js",
                message: "noise",
            },
            store,
        })
        const after = store.get({
            key: "/r|main",
            repoRoot: "/r",
            branch: "main",
        })
        // Cache invalidated — both gates flipped so the next review
        // can't fast-path NO_CHANGES on the now-stale verdict.
        expect(after.dirtySinceLastReview).toBe(true)
        expect(after.lastBaseline).toBeNull()
    })

    test("removing an exclusion also clears the cached baseline", () => {
        // Codex's scenario: a context reached GOOD_TO_GO because a
        // finding was excluded. The user clicks Include without
        // editing files. Without this fix, the next review would
        // short-circuit NO_CHANGES and the finding would never
        // resurface.
        store.save("/r|main", {
            repoRoot: "/r",
            branch: "main",
            lastResultStatus: "GOOD_TO_GO",
            lastBaseline: { progressHash: "p", reviewConfigHash: "c" },
            dirtySinceLastReview: false,
            exclusions: [{ file: "a.js", message: "noise", excludedAt: 1 }],
        })
        handleExclusionMutation({
            body: {
                contextKey: "/r|main",
                action: "remove",
                file: "a.js",
                message: "noise",
            },
            store,
        })
        const after = store.get({
            key: "/r|main",
            repoRoot: "/r",
            branch: "main",
        })
        expect(after.dirtySinceLastReview).toBe(true)
        expect(after.lastBaseline).toBeNull()
    })

    test("a NO-OP mutation (idempotent re-add) does NOT invalidate the cache", () => {
        // Adding the same exclusion twice is documented as a no-op.
        // It would be wasteful to bust the cache when nothing
        // semantically changed — the next review can still
        // short-circuit if the disk content hasn't moved.
        store.save("/r|main", {
            repoRoot: "/r",
            branch: "main",
            lastResultStatus: "GOOD_TO_GO",
            lastBaseline: { progressHash: "p", reviewConfigHash: "c" },
            dirtySinceLastReview: false,
            exclusions: [{ file: "a", message: "m", excludedAt: 1 }],
        })
        handleExclusionMutation({
            body: { contextKey: "/r|main", action: "add", file: "a", message: "m" },
            store,
        })
        const after = store.get({
            key: "/r|main",
            repoRoot: "/r",
            branch: "main",
        })
        // Idempotent — cache untouched.
        expect(after.dirtySinceLastReview).toBe(false)
        expect(after.lastBaseline).toEqual({
            progressHash: "p",
            reviewConfigHash: "c",
        })
    })

    test("a NO-OP remove (entry not present) also leaves the cache intact", () => {
        store.save("/r|main", {
            repoRoot: "/r",
            branch: "main",
            lastResultStatus: "GOOD_TO_GO",
            lastBaseline: { progressHash: "p", reviewConfigHash: "c" },
            dirtySinceLastReview: false,
            exclusions: [],
        })
        handleExclusionMutation({
            body: {
                contextKey: "/r|main",
                action: "remove",
                file: "not-there",
                message: "x",
            },
            store,
        })
        const after = store.get({
            key: "/r|main",
            repoRoot: "/r",
            branch: "main",
        })
        expect(after.dirtySinceLastReview).toBe(false)
        expect(after.lastBaseline).toEqual({
            progressHash: "p",
            reviewConfigHash: "c",
        })
    })
})
