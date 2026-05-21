/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createStateStore } from "./state.js"

const makeTmpFile = () => {
    const dir = mkdtempSync(path.join(tmpdir(), "state-"))
    return { dir, filePath: path.join(dir, "state.json") }
}

const ctxKey = {
    key: "/repo|main",
    repoRoot: "/repo",
    branch: "main",
}

describe("createStateStore — basics", () => {
    let dir, filePath
    beforeEach(() => {
        ;({ dir, filePath } = makeTmpFile())
    })
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true })
    })

    test("get returns a blank ContextState for a new key", () => {
        const store = createStateStore({ filePath, now: () => 1000 })
        const s = store.get(ctxKey)
        expect(s.codexRounds).toBe(0)
        expect(s.blockCount).toBe(0)
        expect(s.priorFindings).toEqual([])
        expect(s.lastBaseline).toBeNull()
        expect(s.lastResultStatus).toBeNull()
    })

    test("save persists to disk and round-trips through a new store", () => {
        const t = () => 5000
        const a = createStateStore({ filePath, now: t })
        a.save(ctxKey.key, {
            repoRoot: ctxKey.repoRoot,
            branch: ctxKey.branch,
            codexRounds: 2,
            blockCount: 1,
            lastBaseline: { promptHash: "p", progressHash: "g" },
            priorFindings: [{ file: "a.js" }],
            lastReviewedAt: 5000,
            lastResultStatus: "ISSUES",
        })
        const raw = JSON.parse(readFileSync(filePath, "utf8"))
        expect(raw.contexts[ctxKey.key].codexRounds).toBe(2)

        const b = createStateStore({ filePath, now: t })
        const s = b.get(ctxKey)
        expect(s.codexRounds).toBe(2)
        expect(s.blockCount).toBe(1)
        expect(s.priorFindings).toEqual([{ file: "a.js" }])
        expect(s.lastBaseline.promptHash).toBe("p")
        expect(s.lastResultStatus).toBe("ISSUES")
    })

    test("reset clears counters but keeps the context entry", () => {
        const store = createStateStore({ filePath, now: () => 0 })
        store.save(ctxKey.key, {
            repoRoot: ctxKey.repoRoot,
            branch: ctxKey.branch,
            codexRounds: 4,
            blockCount: 3,
            lastReviewedAt: 1,
            lastResultStatus: "ISSUES",
            priorFindings: [{ file: "x" }],
            lastBaseline: { progressHash: "p" },
        })
        const fresh = store.reset(ctxKey)
        expect(fresh.codexRounds).toBe(0)
        expect(fresh.blockCount).toBe(0)
        expect(fresh.priorFindings).toEqual([])
        expect(fresh.lastBaseline).toBeNull()
        expect(fresh.lastResultStatus).toBeNull()
    })

    test("get returns an isolated clone (mutating it does not change store state)", () => {
        const store = createStateStore({ filePath, now: () => 0 })
        store.save(ctxKey.key, {
            repoRoot: ctxKey.repoRoot,
            branch: ctxKey.branch,
            codexRounds: 1,
            lastReviewedAt: 0,
        })
        const a = store.get(ctxKey)
        a.codexRounds = 99
        const b = store.get(ctxKey)
        expect(b.codexRounds).toBe(1)
    })
})

describe("createStateStore — idle reset", () => {
    let dir, filePath
    beforeEach(() => {
        ;({ dir, filePath } = makeTmpFile())
    })
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true })
    })

    test("idle reset clears counters when idleResetMs has elapsed", () => {
        let t = 1000
        const store = createStateStore({
            filePath,
            now: () => t,
            idleResetMs: 500,
        })
        store.save(ctxKey.key, {
            repoRoot: ctxKey.repoRoot,
            branch: ctxKey.branch,
            codexRounds: 3,
            blockCount: 2,
            lastReviewedAt: 1000,
            lastResultStatus: "ISSUES",
            priorFindings: [{ file: "f" }],
            lastBaseline: { progressHash: "p" },
        })

        t = 2000 // 1000ms idle, > 500ms threshold
        const s = store.get(ctxKey)
        expect(s.codexRounds).toBe(0)
        expect(s.blockCount).toBe(0)
        expect(s.priorFindings).toEqual([])
        expect(s.lastBaseline).toBeNull()
    })

    test("idle reset does NOT fire while still within the window", () => {
        let t = 1000
        const store = createStateStore({
            filePath,
            now: () => t,
            idleResetMs: 5000,
        })
        store.save(ctxKey.key, {
            repoRoot: ctxKey.repoRoot,
            branch: ctxKey.branch,
            codexRounds: 3,
            lastReviewedAt: 1000,
        })
        t = 1200
        expect(store.get(ctxKey).codexRounds).toBe(3)
    })

    test("idle reset does NOT fire when lastReviewedAt is 0 (untouched)", () => {
        const t = () => 1_000_000_000
        const store = createStateStore({
            filePath,
            now: t,
            idleResetMs: 1,
        })
        const s = store.get(ctxKey)
        expect(s.codexRounds).toBe(0)
        expect(s.lastReviewedAt).toBe(0)
    })
})

describe("createStateStore — disk robustness", () => {
    let dir, filePath
    beforeEach(() => {
        ;({ dir, filePath } = makeTmpFile())
    })
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true })
    })

    test("treats a missing file as empty contexts", () => {
        const store = createStateStore({
            filePath: path.join(dir, "absent.json"),
            now: () => 0,
        })
        expect(store.list()).toEqual([])
    })

    test("treats corrupt JSON on disk as empty contexts (does not throw)", () => {
        writeFileSync(filePath, "{ not json")
        const store = createStateStore({ filePath, now: () => 0 })
        expect(store.list()).toEqual([])
    })

    test("treats a JSON without a contexts object as empty", () => {
        writeFileSync(filePath, JSON.stringify({ version: 1 }))
        const store = createStateStore({ filePath, now: () => 0 })
        expect(store.list()).toEqual([])
    })

    test("writes are atomic (no .tmp left behind)", () => {
        const store = createStateStore({ filePath, now: () => 0 })
        store.save(ctxKey.key, {
            repoRoot: ctxKey.repoRoot,
            branch: ctxKey.branch,
            codexRounds: 1,
            lastReviewedAt: 0,
        })
        expect(() =>
            readFileSync(`${filePath}.tmp`, "utf8")
        ).toThrow()
    })

    test("list returns all current contexts", () => {
        const store = createStateStore({ filePath, now: () => 0 })
        store.save("/a|main", { repoRoot: "/a", branch: "main" })
        store.save("/b|main", { repoRoot: "/b", branch: "main" })
        const ctxs = store.list()
        expect(ctxs.map((c) => c.key).sort()).toEqual(["/a|main", "/b|main"])
    })
})
