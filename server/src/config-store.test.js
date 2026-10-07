/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { jest } from "@jest/globals"
import {
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
    applyDelta,
    ConfigChangeError,
    createConfigStore,
    deepFreeze,
    KEEP_BACKUPS,
} from "./config-store.js"

let dir
let configPath
beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "config-store-"))
    configPath = path.join(dir, "config.json")
})
afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
})

const writeConfig = (obj) =>
    writeFileSync(configPath, JSON.stringify(obj, null, 2) + "\n")
const readConfig = () => JSON.parse(readFileSync(configPath, "utf8"))

// A stand-in core: the "schema" accepts any object whose limits are
// numbers; the self-check refuses maxCodexRounds 13.
const coreChecks = () => ({
    validate: jest.fn((raw) => {
        if (typeof raw?.limits?.maxCodexRounds !== "number") {
            throw Object.assign(new Error("limits.maxCodexRounds: required"), {
                code: "CONFIG_INVALID",
            })
        }
        return { ...raw }
    }),
    selfCheck: jest.fn((config) => {
        if (config.limits.maxCodexRounds === 13) throw new Error("unlucky")
    }),
})

const makeStore = (initial, over = {}) => {
    const checks = coreChecks()
    let t = Date.parse("2026-10-07T12:00:00.000Z")
    const store = createConfigStore({
        configPath,
        initial,
        checks: () => checks,
        now: () => (t += 1000),
        ...over,
    })
    return { store, checks }
}

const base = () => ({
    authToken: "tok",
    reviewer: { provider: "codex" },
    limits: { maxCodexRounds: 5, maxBlocks: 6 },
})

describe("applyDelta + deepFreeze", () => {
    test("sets nested keys on a copy, creating parents", () => {
        const src = { a: { b: 1 } }
        const out = applyDelta(src, [
            [["a", "b"], 2],
            [["x", "y", "z"], [1]],
        ])
        expect(out).toEqual({ a: { b: 2 }, x: { y: { z: [1] } } })
        expect(src).toEqual({ a: { b: 1 } })
    })

    test("deepFreeze freezes every level", () => {
        const v = deepFreeze({ a: { b: [1] } })
        expect(Object.isFrozen(v.a.b)).toBe(true)
    })
})

describe("createConfigStore — holder", () => {
    test("holds a frozen copy and starts at revision 0", () => {
        const initial = base()
        const { store } = makeStore(initial)
        expect(store.current()).toEqual(initial)
        expect(store.current()).not.toBe(initial)
        expect(Object.isFrozen(store.current().limits)).toBe(true)
        expect(store.revision()).toBe(0)
    })
})

describe("createConfigStore — mutate", () => {
    test("merges the delta into a fresh read and commits holder + delta", async () => {
        writeConfig(base())
        const { store, checks } = makeStore(base())
        const r = await store.mutate([[["limits", "maxCodexRounds"], 7]])
        expect(r.revision).toBe(1)
        expect(r.replaced).toEqual([])
        expect(store.current().limits.maxCodexRounds).toBe(7)
        expect(readConfig().limits.maxCodexRounds).toBe(7)
        // Once to compare the file with the holder, twice for the results.
        expect(checks.validate).toHaveBeenCalledTimes(3)
        expect(checks.selfCheck).toHaveBeenCalledTimes(2)
        expect(statSync(configPath).mode & 0o777).toBe(0o600)
    })

    test("a token rotated on disk survives a dashboard save", async () => {
        writeConfig({ ...base(), authToken: "rotated" })
        const { store } = makeStore(base())
        await store.mutate([[["limits", "maxBlocks"], 3]])
        expect(readConfig().authToken).toBe("rotated")
        expect(store.current().authToken).toBe("tok")
    })

    test("an unapplied manual edit to another key survives, and stays out of the holder", async () => {
        writeConfig({ ...base(), reviewer: { provider: "gemini" } })
        const { store } = makeStore(base())
        await store.mutate([[["limits", "maxBlocks"], 3]])
        expect(readConfig().reviewer.provider).toBe("gemini")
        expect(store.current().reviewer.provider).toBe("codex")
    })

    test("a manual edit to the same key is replaced and reported", async () => {
        writeConfig({ ...base(), limits: { maxCodexRounds: 9, maxBlocks: 6 } })
        const { store } = makeStore(base())
        const r = await store.mutate([[["limits", "maxCodexRounds"], 7]])
        expect(r.replaced).toEqual([
            { key: "limits.maxCodexRounds", manualValue: 9 },
        ])
        expect(readConfig().limits.maxCodexRounds).toBe(7)
    })

    test("omitted defaults and normalized values aren't reported as manual edits", async () => {
        // A file holding only what differs from the defaults, and a schema
        // that fills them in (the holder is always in that form).
        writeConfig({ authToken: "tok" })
        const filling = (raw) => ({
            ...structuredClone(raw),
            limits: { maxCodexRounds: 5, maxBlocks: 6, ...(raw.limits ?? {}) },
        })
        const store = createConfigStore({
            configPath,
            initial: filling({ authToken: "tok" }),
            checks: () => ({ validate: filling, selfCheck: () => {} }),
        })
        const r = await store.mutate([[["limits", "maxBlocks"], 3]])
        expect(r.replaced).toEqual([])
        expect(readConfig()).toEqual({
            authToken: "tok",
            limits: { maxBlocks: 3 },
        })
    })

    test("an unparseable config.json fails the change and writes nothing", async () => {
        writeFileSync(configPath, "{ half")
        const { store } = makeStore(base())
        await expect(
            store.mutate([[["limits", "maxBlocks"], 3]])
        ).rejects.toMatchObject({ code: "CONFIG_FILE_INVALID" })
        expect(readFileSync(configPath, "utf8")).toBe("{ half")
        expect(store.revision()).toBe(0)
    })

    test("a missing file is an error, not a fresh config", async () => {
        const { store } = makeStore(base())
        await expect(
            store.mutate([[["limits", "maxBlocks"], 3]])
        ).rejects.toMatchObject({
            code: "CONFIG_FILE_UNREADABLE",
            httpStatus: 500,
        })
    })

    test.each([
        ["the self-check", [[["limits", "maxCodexRounds"], 13]]],
        ["the schema", [[["limits", "maxCodexRounds"], "x"]]],
    ])(
        "a change rejected by %s writes nothing and leaves the holder",
        async (_label, delta) => {
            writeConfig(base())
            const { store } = makeStore(base())
            await expect(store.mutate(delta)).rejects.toBeInstanceOf(
                ConfigChangeError
            )
            expect(readConfig()).toEqual(base())
            expect(store.current()).toEqual(base())
            expect(readdirSync(dir)).toEqual(["config.json"])
        }
    )

    test("the file passing but holder + delta failing (or the reverse) is rejected", async () => {
        // File has an unapplied edit making the merged FILE fail the
        // self-check while the holder + delta passes.
        writeConfig({ ...base(), limits: { maxCodexRounds: 13 } })
        const { store } = makeStore(base())
        await expect(
            store.mutate([[["limits", "maxBlocks"], 2]])
        ).rejects.toThrow(/unlucky/)
        expect(store.revision()).toBe(0)
    })

    test("an edit landing before the re-check is merged on the next attempt", async () => {
        writeConfig(base())
        let edits = 1
        const realRead = (p, enc) => readFileSync(p, enc)
        const readFile = jest.fn((p, enc) => {
            const text = realRead(p, enc)
            // The second read of the first attempt is the re-check.
            if (readFile.mock.calls.length === 2 && edits-- > 0) {
                writeConfig({ ...base(), reviewer: { provider: "claude" } })
                return realRead(p, enc)
            }
            return text
        })
        const { store } = makeStore(base(), { fs: { readFileSync: readFile } })
        await store.mutate([[["limits", "maxBlocks"], 3]])
        expect(readConfig()).toMatchObject({
            reviewer: { provider: "claude" },
            limits: { maxBlocks: 3 },
        })
    })

    test("an edit landing while the temp file is written is seen right before the rename", async () => {
        writeConfig(base())
        let edited = false
        const writeFile = jest.fn((p, data, opts) => {
            writeFileSync(p, data, opts)
            if (!edited && p.includes(".tmp-")) {
                edited = true
                writeConfig({ ...base(), authToken: "rotated" })
            }
        })
        const { store } = makeStore(base(), {
            fs: { writeFileSync: writeFile },
        })
        const r = await store.mutate([[["limits", "maxBlocks"], 3]])
        expect(readConfig()).toMatchObject({
            authToken: "rotated",
            limits: { maxBlocks: 3 },
        })
        const files = readdirSync(dir)
        expect(files.filter((n) => n.includes(".tmp-"))).toEqual([])
        const backups = files.filter((n) => n.startsWith("config.json.bak-"))
        expect(backups).toHaveLength(1)
        expect(
            JSON.parse(readFileSync(path.join(dir, backups[0]), "utf8"))
                .authToken
        ).toBe("rotated")
        expect(r.backup).toBe(path.join(dir, backups[0]))
    })

    test("three conflicting attempts give up without writing", async () => {
        writeConfig(base())
        let n = 0
        const readFile = (p, enc) => {
            const text = readFileSync(p, enc)
            n++
            // Every re-check sees a different file.
            return n % 2 === 0 ? text + " ".repeat(n) : text
        }
        const { store } = makeStore(base(), { fs: { readFileSync: readFile } })
        await expect(
            store.mutate([[["limits", "maxBlocks"], 3]])
        ).rejects.toMatchObject({ code: "CONFIG_CHANGED_WHILE_SAVING" })
        expect(n).toBe(6)
        expect(readConfig()).toEqual(base())
    })

    test("every write keeps a backup of the file as read, only the last 10", async () => {
        writeConfig(base())
        const { store } = makeStore(base())
        for (let i = 1; i <= KEEP_BACKUPS + 2; i++) {
            await store.mutate([[["limits", "maxBlocks"], i]])
        }
        const backups = readdirSync(dir)
            .filter((n) => n.startsWith("config.json.bak-"))
            .sort()
        expect(backups).toHaveLength(KEEP_BACKUPS)
        const newest = path.join(dir, backups.at(-1))
        expect(JSON.parse(readFileSync(newest, "utf8")).limits.maxBlocks).toBe(
            KEEP_BACKUPS + 1
        )
        expect(statSync(newest).mode & 0o777).toBe(0o600)
        expect(store.revision()).toBe(KEEP_BACKUPS + 2)
    })

    test("a backup-cleanup failure after the write still commits the change", async () => {
        writeConfig(base())
        const { store } = makeStore(base(), {
            fs: {
                readdirSync: () => {
                    throw new Error("EIO")
                },
            },
        })
        const r = await store.mutate([[["limits", "maxBlocks"], 3]])
        expect(r.revision).toBe(1)
        expect(store.current().limits.maxBlocks).toBe(3)
        expect(readConfig().limits.maxBlocks).toBe(3)
    })

    test("saves within the same millisecond keep separate backups", async () => {
        writeConfig(base())
        const store = createConfigStore({
            configPath,
            initial: base(),
            checks: coreChecks,
            now: () => 0,
        })
        await store.mutate([[["limits", "maxBlocks"], 1]])
        await store.mutate([[["limits", "maxBlocks"], 2]])
        const backups = readdirSync(dir)
            .filter((n) => n.startsWith("config.json.bak-"))
            .sort()
        expect(backups).toHaveLength(2)
        expect(
            backups.map(
                (b) =>
                    JSON.parse(readFileSync(path.join(dir, b), "utf8")).limits
                        .maxBlocks
            )
        ).toEqual([6, 1])
    })

    test("a backup name already taken (another writer) is skipped, never overwritten", async () => {
        writeConfig(base())
        const taken = path.join(
            dir,
            "config.json.bak-19700101T000000000Z-000001"
        )
        writeFileSync(taken, "theirs")
        const store = createConfigStore({
            configPath,
            initial: base(),
            checks: coreChecks,
            now: () => 0,
        })
        await store.mutate([[["limits", "maxBlocks"], 1]])
        expect(readFileSync(taken, "utf8")).toBe("theirs")
        expect(
            readdirSync(dir).filter((n) => n.startsWith("config.json.bak-"))
        ).toHaveLength(2)
    })

    test("transactions run one at a time, in order", async () => {
        writeConfig(base())
        const { store } = makeStore(base())
        const order = []
        const slow = store.exclusive(async () => {
            order.push("swap:start")
            await new Promise((r) => setTimeout(r, 20))
            order.push("swap:end")
        })
        const edit = store
            .mutate([[["limits", "maxBlocks"], 2]])
            .then(() => order.push("edit"))
        await Promise.all([slow, edit])
        expect(order).toEqual(["swap:start", "swap:end", "edit"])
    })

    test("a failed transaction doesn't block the next", async () => {
        writeConfig(base())
        const { store } = makeStore(base())
        await expect(
            store.exclusive(async () => {
                throw new Error("x")
            })
        ).rejects.toThrow("x")
        await store.mutate([[["limits", "maxBlocks"], 2]])
        expect(store.revision()).toBe(1)
    })

    test("checks come from the core current when the transaction runs", async () => {
        writeConfig(base())
        let current = coreChecks()
        const store = createConfigStore({
            configPath,
            initial: base(),
            checks: () => current,
        })
        const gate = store.exclusive(async () => {
            current = {
                validate: () => {
                    throw new Error("config changed, reload the page")
                },
                selfCheck: () => {},
            }
        })
        const edit = store.mutate([[["limits", "maxBlocks"], 2]])
        await gate
        await expect(edit).rejects.toThrow(/config changed, reload the page/)
    })
})

describe("createConfigStore — writeFile + commit", () => {
    test("writeFile refuses when the file no longer has the expected hash", () => {
        writeConfig(base())
        const { store } = makeStore(base())
        const file = store.readFile()
        writeConfig({ ...base(), x: 1 })
        expect(
            store.writeFile(
                { y: 1 },
                {
                    expectHash: file.hash,
                    backupText: file.text,
                }
            )
        ).toBeNull()
        expect(readConfig().x).toBe(1)
    })

    test("commit replaces the holder and bumps the revision", () => {
        const { store } = makeStore(base())
        store.commit({ ...base(), reviewer: { provider: "claude" } })
        expect(store.current().reviewer.provider).toBe("claude")
        expect(store.revision()).toBe(1)
    })
})
