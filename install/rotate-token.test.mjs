/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { jest } from "@jest/globals"
import { createHash } from "node:crypto"
import {
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
    confirmWithServer,
    genToken,
    KEEP_ROTATIONS,
    main,
    parseArgs,
    rotatedConfig,
    rotateToken,
    updateCodexEntry,
} from "./rotate-token.mjs"
import { BEGIN } from "./merge-codex-mcp.mjs"

const sha256 = (t) => createHash("sha256").update(t).digest("hex")
const AT = "2026-10-07T12:00:00.000Z"

let dir
let configPath
let credentialsPath
beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "rotate-token-"))
    configPath = path.join(dir, "config.json")
    credentialsPath = path.join(dir, "cache", "hook-credentials.json")
})
afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
})

const writeConfig = (obj) => writeFileSync(configPath, JSON.stringify(obj))
const readConfig = () => JSON.parse(readFileSync(configPath, "utf8"))

describe("rotatedConfig", () => {
    test("sets the token and appends a hash-only record, keeping other keys", () => {
        const { config, record } = rotatedConfig({
            parsed: {
                authToken: "A",
                port: 1,
                auth: { previousTokenGraceHours: 2 },
            },
            token: "B",
            revokeNow: false,
            at: AT,
        })
        expect(record).toEqual({
            tokenHash: sha256("B"),
            previousTokenHash: sha256("A"),
            grace: "default",
            at: AT,
        })
        expect(config).toEqual({
            authToken: "B",
            port: 1,
            auth: { previousTokenGraceHours: 2, rotations: [record] },
        })
        expect(JSON.stringify(config.auth)).not.toMatch(/"A"|"B"/)
    })

    test("--revoke-now records grace none; history keeps the last 10", () => {
        const old = Array.from({ length: KEEP_ROTATIONS }, (_, i) => ({ i }))
        const { config } = rotatedConfig({
            parsed: { authToken: "A", auth: { rotations: old } },
            token: "B",
            revokeNow: true,
            at: AT,
        })
        expect(config.auth.rotations).toHaveLength(KEEP_ROTATIONS)
        expect(config.auth.rotations[0]).toEqual({ i: 1 })
        expect(config.auth.rotations.at(-1).grace).toBe("none")
    })

    test("refuses a config with no token to rotate", () => {
        expect(() => rotatedConfig({ parsed: {}, token: "B", at: AT })).toThrow(
            /no authToken to rotate/
        )
    })

    test("generated tokens are long and distinct", () => {
        expect(genToken()).toMatch(/^[A-Za-z0-9_-]{43}$/)
        expect(genToken()).not.toBe(genToken())
    })
})

describe("rotateToken", () => {
    test("writes the token and record under the lock, with a backup, and refreshes the credentials", async () => {
        writeConfig({ authToken: "A", port: 7788 })
        const lock = jest.fn((p, fn) => fn())
        const r = await rotateToken({
            configPath,
            generate: () => "B",
            now: () => Date.parse(AT),
            credentialsPath,
            lock,
        })
        expect(lock).toHaveBeenCalledWith(configPath, expect.any(Function))
        expect(r.token).toBe("B")
        expect(r.record.previousTokenHash).toBe(sha256("A"))
        expect(readConfig()).toMatchObject({
            authToken: "B",
            auth: { rotations: [r.record] },
        })
        expect(JSON.parse(readFileSync(r.backup, "utf8")).authToken).toBe("A")
        expect(JSON.parse(readFileSync(credentialsPath, "utf8"))).toMatchObject(
            { token: "B", port: 7788 }
        )
    })

    test("runs afterWrite inside the same lock hold with the token just written, and returns its failure", async () => {
        writeConfig({ authToken: "A" })
        let inside = false
        const lock = async (p, fn) => {
            inside = true
            try {
                return await fn()
            } finally {
                inside = false
            }
        }
        const seen = []
        const r = await rotateToken({
            configPath,
            credentialsPath,
            generate: () => "B",
            lock,
            afterWrite: ({ token }) => {
                seen.push({ token, inside, file: readConfig().authToken })
                return { action: "updated" }
            },
        })
        expect(seen).toEqual([{ token: "B", inside: true, file: "B" }])
        expect(r.after).toEqual({ action: "updated" })
        writeConfig({ authToken: "B" })
        const failed = await rotateToken({
            configPath,
            credentialsPath,
            lock,
            afterWrite: () => {
                throw new Error("bad toml")
            },
        })
        expect(failed.afterError.message).toBe("bad toml")
        expect(readConfig().authToken).not.toBe("B")
    })

    test("a credentials-cache failure after the commit is returned, and Codex is still updated", async () => {
        writeConfig({ authToken: "A" })
        const afterWrite = jest.fn(() => ({ action: "updated" }))
        const r = await rotateToken({
            configPath,
            // A directory where the cache file should go.
            credentialsPath: dir,
            generate: () => "B",
            afterWrite,
        })
        expect(r.credentialsError?.code).toMatch(/^E[A-Z]+$/)
        expect(afterWrite).toHaveBeenCalledWith({ token: "B" })
        expect(readConfig().authToken).toBe("B")
    })

    test("takes the real OS lock", async () => {
        writeConfig({ authToken: "A" })
        await rotateToken({ configPath, credentialsPath })
        expect(readdirSync(dir)).toContain("config.json.lock")
        expect(readConfig().authToken).not.toBe("A")
    })
})

describe("updateCodexEntry", () => {
    test("re-merges a managed entry with the new token and the config's address", () => {
        writeConfig({ authToken: "B", port: 7788, bind: "0.0.0.0" })
        const toml = path.join(dir, "config.toml")
        writeFileSync(toml, `${BEGIN}\nold\n`)
        const merge = jest.fn(() => ({ action: "updated", path: toml }))
        expect(
            updateCodexEntry({
                configTomlPath: toml,
                configPath,
                token: "B",
                merge,
            })
        ).toEqual({ action: "updated", path: toml })
        expect(merge).toHaveBeenCalledWith({
            configTomlPath: toml,
            token: "B",
            port: 7788,
            bind: "127.0.0.1",
        })
    })

    test("leaves Codex alone when it isn't wired", () => {
        const merge = jest.fn()
        const toml = path.join(dir, "config.toml")
        expect(
            updateCodexEntry({
                configTomlPath: toml,
                configPath,
                token: "B",
                merge,
            })
        ).toBeNull()
        writeFileSync(toml, "[other]\n")
        writeConfig({ authToken: "B" })
        expect(
            updateCodexEntry({
                configTomlPath: toml,
                configPath,
                token: "B",
                merge,
            })
        ).toBeNull()
        expect(merge).not.toHaveBeenCalled()
    })

    test("the default port is 7777", () => {
        writeConfig({ authToken: "B" })
        const toml = path.join(dir, "config.toml")
        writeFileSync(toml, BEGIN)
        const merge = jest.fn(() => ({}))
        updateCodexEntry({
            configTomlPath: toml,
            configPath,
            token: "B",
            merge,
        })
        expect(merge.mock.calls[0][0].port).toBe(7777)
    })
})

describe("confirmWithServer", () => {
    const answering = (res) => async () => ({
        ok: true,
        request: async () => res,
    })
    const auth = (token, grace = null) => ({
        httpStatus: 200,
        body: {
            auth: {
                currentTokenHash: sha256(token),
                previousTokenGrace: grace,
            },
        },
    })

    test("confirms the new token, and that nothing old is accepted after --revoke-now", async () => {
        await expect(
            confirmWithServer({
                configPath,
                token: "B",
                revokeNow: true,
                connectFn: answering(auth("B")),
            })
        ).resolves.toMatchObject({ running: true, ok: true })
        await expect(
            confirmWithServer({
                configPath,
                token: "B",
                revokeNow: true,
                connectFn: answering(auth("B", { until: AT })),
            })
        ).resolves.toMatchObject({
            ok: false,
            problem: /still accepts the previous token/,
        })
    })

    test("a server on another token, an error status, or none at all", async () => {
        await expect(
            confirmWithServer({
                configPath,
                token: "B",
                connectFn: answering(auth("A")),
            })
        ).resolves.toMatchObject({ ok: false, problem: /new token as current/ })
        await expect(
            confirmWithServer({
                configPath,
                token: "B",
                connectFn: answering({
                    httpStatus: null,
                    fetchError: "unverified",
                }),
            })
        ).resolves.toMatchObject({ ok: false, problem: "unverified" })
        await expect(
            confirmWithServer({
                configPath,
                token: "B",
                connectFn: answering({ httpStatus: 500 }),
            })
        ).resolves.toMatchObject({ ok: false, problem: "HTTP 500" })
        await expect(
            confirmWithServer({
                configPath,
                token: "B",
                connectFn: answering({ httpStatus: 200, body: {} }),
            })
        ).resolves.toMatchObject({ ok: false, auth: null })
        await expect(
            confirmWithServer({
                configPath,
                token: "B",
                connectFn: async () => ({ ok: false, reason: "down" }),
            })
        ).resolves.toEqual({ running: false, reason: "down" })
    })
})

describe("main", () => {
    const sink = () => {
        const chunks = []
        return { write: (c) => chunks.push(c), text: () => chunks.join("") }
    }
    const run = async (argv, over = {}) => {
        const stdout = sink()
        const stderr = sink()
        const code = await main({
            argv,
            stdout,
            stderr,
            // Runs afterWrite the way rotateToken does.
            rotate: async ({ afterWrite }) => {
                try {
                    return {
                        token: "B",
                        backup: "/b",
                        after: afterWrite({ token: "B" }),
                    }
                } catch (err) {
                    return { token: "B", backup: "/b", afterError: err }
                }
            },
            updateCodex: () => null,
            confirm: async () => ({
                running: true,
                ok: true,
                auth: { previousTokenGrace: { until: AT } },
            }),
            ...over,
        })
        return { code, out: stdout.text(), err: stderr.text() }
    }

    test("parses --config and --revoke-now; refuses anything else", () => {
        expect(parseArgs(["--config", "/c", "--revoke-now"])).toEqual({
            configPath: "/c",
            revokeNow: true,
        })
        expect(parseArgs(["--bogus"]).error).toMatch(/unknown option/)
    })

    test("a normal rotation reports the grace and which clients to restart", async () => {
        const r = await run(["--config", configPath])
        expect(r.code).toBe(0)
        expect(r.out).toMatch(/rotated: new token written/)
        expect(r.out).toMatch(`previous token accepted until ${AT}`)
        expect(r.out).toMatch(/until the grace ends/)
    })

    test("--revoke-now reports the revocation", async () => {
        const r = await run(["--revoke-now"], {
            confirm: async () => ({ running: true, ok: true, auth: {} }),
        })
        expect(r.out).toMatch(
            /revoked — the previous token is no longer accepted/
        )
        expect(r.out).not.toMatch(/until the grace ends/)
    })

    test("Codex updates are reported, and a failed one is a warning", async () => {
        let r = await run([], {
            updateCodex: () => ({ action: "updated", path: "/t" }),
        })
        expect(r.out).toMatch(/codex: MCP entry updated/)
        r = await run([], {
            updateCodex: () => {
                throw new Error("bad toml")
            },
        })
        expect(r.code).toBe(0)
        expect(r.err).toMatch(/couldn't update Codex's MCP entry \(bad toml\)/)
    })

    test("a stopped server, a server that disagrees, no grace, and a failed rotation", async () => {
        let r = await run([], {
            confirm: async () => ({ running: false, reason: "down" }),
        })
        expect(r.out).toMatch(/not reachable \(down\); it reads the new token/)
        r = await run([], {
            confirm: async () => ({
                running: true,
                ok: false,
                problem: "nope",
            }),
        })
        expect(r).toMatchObject({ code: 1, err: "error: nope\n" })
        r = await run([], {
            confirm: async () => ({
                running: true,
                ok: true,
                auth: { previousTokenGrace: null },
            }),
        })
        expect(r.out).toMatch(/previous token no longer accepted/)
        r = await run([], {
            rotate: async () => {
                throw new Error("locked")
            },
        })
        expect(r).toMatchObject({ code: 1, err: "error: locked\n" })
        r = await run([], {
            rotate: async () => ({
                token: "B",
                backup: "/b",
                credentialsError: new Error("EACCES"),
            }),
        })
        expect(r.code).toBe(0)
        expect(r.err).toMatch(
            /couldn't refresh the hooks' credentials cache \(EACCES\)/
        )
        expect(r.out).toMatch(/rotated: new token written/)
        r = await run(["--nope"])
        expect(r.code).toBe(2)
    })
})
