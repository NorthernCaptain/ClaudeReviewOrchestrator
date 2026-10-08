/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { jest } from "@jest/globals"
import { spawn } from "node:child_process"
import {
    existsSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
    acquireConfigLock,
    ConfigLockError,
    credentialsFrom,
    KEEP_BACKUPS,
    pruneConfigBackups,
    refreshHookCredentials,
    updateConfigFile,
    withConfigLock,
    writeConfigBackup,
    writeFileAtomic,
} from "./config-lock.mjs"

const MODULE = fileURLToPath(new URL("./config-lock.mjs", import.meta.url))

let dir
let configPath
beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "config-lock-"))
    configPath = path.join(dir, "config.json")
})
afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
})

// A child that takes the lock, prints "locked", then runs `body`.
const child = (body) => {
    const script = `
        import { acquireConfigLock } from ${JSON.stringify(MODULE)}
        const lock = await acquireConfigLock({ configPath: ${JSON.stringify(configPath)}, timeoutMs: 5000 })
        process.stdout.write("locked\\n")
        ${body}
    `
    const proc = spawn(
        process.execPath,
        ["--input-type=module", "-e", script],
        {
            stdio: ["ignore", "pipe", "inherit"],
        }
    )
    const locked = new Promise((resolve, reject) => {
        proc.stdout.on("data", (d) => {
            if (String(d).includes("locked")) resolve()
        })
        proc.once("exit", (code) => reject(new Error(`exited ${code}`)))
    })
    const exited = new Promise((resolve) => proc.once("exit", resolve))
    return { proc, locked, exited }
}

describe("acquireConfigLock (child processes)", () => {
    test("a second writer can't get it while the first holds it", async () => {
        const holder = child("await new Promise((r) => setTimeout(r, 60000))")
        try {
            await holder.locked
            await expect(
                acquireConfigLock({ configPath, timeoutMs: 150, retryMs: 20 })
            ).rejects.toBeInstanceOf(ConfigLockError)
        } finally {
            holder.proc.kill("SIGKILL")
            await holder.exited
        }
    })

    test("after kill -9 of the holder the next writer gets it at once, with no stale-file handling", async () => {
        const holder = child("await new Promise((r) => setTimeout(r, 60000))")
        await holder.locked
        holder.proc.kill("SIGKILL")
        await holder.exited
        const started = Date.now()
        const lock = await acquireConfigLock({ configPath, timeoutMs: 1000 })
        expect(Date.now() - started).toBeLessThan(500)
        lock.release()
        expect(existsSync(`${configPath}.lock`)).toBe(true)
    })

    test("three racing writers never overlap", async () => {
        const log = path.join(dir, "log.txt")
        writeFileSync(log, "")
        const body = `
            import { appendFileSync } from "node:fs"
            appendFileSync(${JSON.stringify(log)}, "start " + process.pid + "\\n")
            await new Promise((r) => setTimeout(r, 40))
            appendFileSync(${JSON.stringify(log)}, "end " + process.pid + "\\n")
            lock.release()
        `
        const writers = [child(body), child(body), child(body)]
        await Promise.all(writers.map((w) => w.exited))
        const lines = readFileSync(log, "utf8").trim().split("\n")
        expect(lines).toHaveLength(6)
        for (let i = 0; i < lines.length; i += 2) {
            const [s, pid] = lines[i].split(" ")
            expect(s).toBe("start")
            expect(lines[i + 1]).toBe(`end ${pid}`)
        }
    })

    test("a live, paused holder makes waiters time out without writing", async () => {
        const holder = child("await new Promise((r) => setTimeout(r, 60000))")
        try {
            await holder.locked
            holder.proc.kill("SIGSTOP")
            const write = jest.fn()
            await expect(
                withConfigLock(configPath, write, {
                    timeoutMs: 200,
                    retryMs: 20,
                })
            ).rejects.toMatchObject({
                code: "CONFIG_LOCKED",
                message: "config.json is locked by another writer — try again",
            })
            expect(write).not.toHaveBeenCalled()
        } finally {
            holder.proc.kill("SIGKILL")
            await holder.exited
        }
    })
})

describe("acquireConfigLock (in process)", () => {
    test("release is idempotent and withConfigLock releases on a throw", async () => {
        const lock = await acquireConfigLock({ configPath })
        lock.release()
        lock.release()
        await expect(
            withConfigLock(configPath, async () => {
                throw new Error("inside")
            })
        ).rejects.toThrow("inside")
        const again = await acquireConfigLock({ configPath, timeoutMs: 100 })
        again.release()
    })

    test("creates config.json's folder for a first install", async () => {
        const nested = path.join(dir, "a", "b", "config.json")
        const lock = await acquireConfigLock({ configPath: nested })
        lock.release()
        expect(existsSync(`${nested}.lock`)).toBe(true)
    })

    test("refuses outside macOS, and rethrows unexpected open errors", async () => {
        await expect(
            acquireConfigLock({ configPath, platform: "linux" })
        ).rejects.toThrow(/needs macOS/)
        await expect(
            acquireConfigLock({
                configPath,
                open: () => {
                    throw Object.assign(new Error("no"), { code: "EACCES" })
                },
            })
        ).rejects.toThrow("no")
    })
})

describe("writeFileAtomic", () => {
    test("writes 0600 through a temp file, creating the folder", () => {
        const p = path.join(dir, "nested", "f.json")
        writeFileAtomic(p, "{}")
        expect(readFileSync(p, "utf8")).toBe("{}")
        expect(statSync(p).mode & 0o777).toBe(0o600)
        expect(readdirSync(path.dirname(p))).toEqual(["f.json"])
    })

    test("a failed rename leaves no temp file behind", () => {
        const p = path.join(dir, "f.json")
        expect(() =>
            writeFileAtomic(p, "{}", {
                fs: {
                    renameSync: () => {
                        throw new Error("EXDEV")
                    },
                },
            })
        ).toThrow("EXDEV")
        expect(readdirSync(dir)).toEqual([])
    })
})

describe("hook credentials", () => {
    const credentialsPath = () =>
        path.join(dir, "cache", "hook-credentials.json")

    test("are derived from config.json, 0600, with defaults", () => {
        writeFileSync(
            configPath,
            JSON.stringify({ authToken: "t1", port: 7788, limits: { a: 1 } })
        )
        expect(
            refreshHookCredentials({
                configPath,
                credentialsPath: credentialsPath(),
                now: () => 0,
            })
        ).toBe(true)
        const saved = JSON.parse(readFileSync(credentialsPath(), "utf8"))
        expect(saved).toEqual({
            token: "t1",
            port: 7788,
            bind: "127.0.0.1",
            hook: null,
            reviewer: null,
            limits: { a: 1 },
            writtenAt: "1970-01-01T00:00:00.000Z",
        })
        expect(statSync(credentialsPath()).mode & 0o777).toBe(0o600)
    })

    test("an unparseable or tokenless config.json leaves the cache alone", () => {
        writeFileSync(configPath, "{ half")
        expect(
            refreshHookCredentials({
                configPath,
                credentialsPath: credentialsPath(),
            })
        ).toBe(false)
        writeFileSync(configPath, JSON.stringify({ port: 1 }))
        expect(
            refreshHookCredentials({
                configPath,
                credentialsPath: credentialsPath(),
            })
        ).toBe(false)
        expect(existsSync(credentialsPath())).toBe(false)
    })

    test("credentialsFrom tolerates a partial config", () => {
        expect(credentialsFrom({})).toMatchObject({
            token: null,
            port: 7777,
            bind: "127.0.0.1",
        })
    })
})

describe("updateConfigFile", () => {
    const backups = () =>
        readdirSync(dir).filter((n) => n.startsWith("config.json.bak-"))

    test("writes the change atomically (0600) with a backup of the file as read", () => {
        writeFileSync(configPath, JSON.stringify({ a: 1 }))
        const r = updateConfigFile({
            configPath,
            update: (p) => ({ ...p, b: 2 }),
            now: () => Date.parse("2026-10-07T12:00:00.000Z"),
        })
        expect(r.changed).toBe(true)
        expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
            a: 1,
            b: 2,
        })
        expect(statSync(configPath).mode & 0o777).toBe(0o600)
        expect(path.basename(r.backup)).toMatch(
            /^config\.json\.bak-20261007T120000000Z-[0-9a-f]{6}$/
        )
        expect(readFileSync(r.backup, "utf8")).toBe(JSON.stringify({ a: 1 }))
        expect(readdirSync(dir).filter((n) => n.includes(".tmp-"))).toEqual([])
    })

    test("a null update writes nothing", () => {
        writeFileSync(configPath, "{}")
        expect(updateConfigFile({ configPath, update: () => null })).toEqual({
            changed: false,
            config: {},
            backup: null,
        })
        expect(backups()).toEqual([])
    })

    test("an editor save landing before the rename is redone on top of", () => {
        writeFileSync(configPath, JSON.stringify({ a: 1 }))
        let saves = 1
        const r = updateConfigFile({
            configPath,
            update: (p) => {
                if (saves-- > 0) {
                    writeFileSync(
                        configPath,
                        JSON.stringify({ a: 1, edited: true })
                    )
                }
                return { ...p, b: 2 }
            },
        })
        expect(r.config).toEqual({ a: 1, edited: true, b: 2 })
        expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual(r.config)
        expect(backups()).toHaveLength(1)
    })

    test("a file that keeps changing gives up, leaving no temp file or stray backup", () => {
        writeFileSync(configPath, JSON.stringify({ n: 0 }))
        let n = 0
        expect(() =>
            updateConfigFile({
                configPath,
                update: (p) => {
                    writeFileSync(configPath, JSON.stringify({ n: ++n }))
                    return { ...p, b: 2 }
                },
            })
        ).toThrow("config.json changed while saving — try again")
        expect(readdirSync(dir).sort()).toEqual(["config.json"])
    })

    test("invalid JSON is refused, and a failing write cleans up", () => {
        writeFileSync(configPath, "{ bad")
        expect(() =>
            updateConfigFile({ configPath, update: (p) => p })
        ).toThrow(/is not valid JSON/)
        writeFileSync(configPath, "{}")
        // A failure after the temp file is written removes it.
        expect(() =>
            updateConfigFile({
                configPath,
                update: (p) => p,
                now: () => {
                    throw new Error("clock broke")
                },
            })
        ).toThrow("clock broke")
        expect(readdirSync(dir).sort()).toEqual(["config.json"])
    })

    test("keeps only the newest backups", () => {
        writeFileSync(configPath, "{}")
        for (let i = 0; i < KEEP_BACKUPS + 3; i++) {
            writeConfigBackup({
                configPath,
                text: String(i),
                now: () => Date.UTC(2026, 0, 1, 0, 0, i),
            })
        }
        pruneConfigBackups({ configPath })
        const kept = backups().sort()
        expect(kept).toHaveLength(KEEP_BACKUPS)
        expect(readFileSync(path.join(dir, kept[0]), "utf8")).toBe("3")
        // A missing folder is ignored.
        pruneConfigBackups({ configPath: path.join(dir, "no", "config.json") })
    })
})
