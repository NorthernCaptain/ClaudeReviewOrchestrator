/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { jest } from "@jest/globals"
import {
    challengeAt,
    challengeProof,
    clientHostFromBind,
    connect,
    credentialsOf,
    HEADERS,
    parseCliArgs,
    readCredentials,
    readServerInfo,
    requestSignature,
    responseSignature,
    runCli,
    safeEqual,
    selectServer,
    sendSigned,
    SERVICE,
    sha256Hex,
    signedHeaders,
} from "./signed-client.mjs"

const TOKEN = "tok-1"

const response = (status, body, headers = {}) => {
    const text = typeof body === "string" ? body : JSON.stringify(body)
    return {
        status,
        text,
        bytes: Buffer.from(text, "utf8"),
        headers: { get: (k) => headers[String(k).toLowerCase()] ?? null },
    }
}

// A fake server at `baseUrl`: answers the challenge for `instanceId` with
// a proof per token in `tokens`, verifies signed requests the way the
// server does, and signs `reply(req)` with the verifying token.
const fakeServer = ({
    tokens = [TOKEN],
    instanceId = "inst-1",
    service = SERVICE,
    reply = () => ({ status: 200, body: { ok: true } }),
    signWith = null,
} = {}) => {
    const seen = []
    const fetchFn = jest.fn(async (url, opts) => {
        const u = new URL(url)
        if (u.pathname === "/healthz") {
            const nonce = u.searchParams.get("challenge")
            return response(200, {
                ok: true,
                service,
                instanceId,
                proofs: tokens.map((token) =>
                    challengeProof({ token, nonce, instanceId })
                ),
            })
        }
        const h = opts.headers
        seen.push({ url, opts })
        const target = u.pathname + u.search
        const verifying = tokens.find((token) =>
            safeEqual(
                h[HEADERS.signature],
                requestSignature({
                    token,
                    method: opts.method,
                    path: target,
                    bodyHash: sha256Hex(opts.body ?? ""),
                    timestamp: h[HEADERS.timestamp],
                    nonce: h[HEADERS.nonce],
                    instanceId: h[HEADERS.instance],
                })
            )
        )
        if (h[HEADERS.instance] !== instanceId) {
            return response(401, { code: "UNKNOWN_INSTANCE" })
        }
        if (!verifying) return response(401, { code: "BAD_SIGNATURE" })
        const { status, body, headers = {} } = reply({ url, opts })
        const text = JSON.stringify(body)
        return response(status, text, {
            ...headers,
            [HEADERS.responseSignature]: responseSignature({
                token: signWith ?? verifying,
                nonce: h[HEADERS.nonce],
                status,
                bodyHash: sha256Hex(text),
            }),
        })
    })
    return { fetchFn, seen }
}

const reader = (files) => (p) => {
    const v = files[p]
    if (v === undefined) {
        throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" })
    }
    if (v instanceof Error) throw v
    return typeof v === "string" ? v : JSON.stringify(v)
}

const CONFIG = "/cfg/config.json"
const CACHE = "/cache/hook-credentials.json"
const INFO = "/cache/server.json"

describe("signing primitives", () => {
    test("safeEqual is false for non-strings and different lengths", () => {
        expect(safeEqual("a", "a")).toBe(true)
        expect(safeEqual("a", "ab")).toBe(false)
        expect(safeEqual(null, "a")).toBe(false)
    })

    test("a signature covers method, path, body, time, nonce and instance", () => {
        const base = {
            token: TOKEN,
            method: "post",
            path: "/review",
            bodyHash: sha256Hex("{}"),
            timestamp: 1,
            nonce: "n",
            instanceId: "i",
        }
        const sig = requestSignature(base)
        expect(requestSignature({ ...base, method: "POST" })).toBe(sig)
        for (const [k, v] of Object.entries({
            path: "/reset",
            bodyHash: sha256Hex(""),
            timestamp: 2,
            nonce: "m",
            instanceId: "j",
            token: "other",
        })) {
            expect(requestSignature({ ...base, [k]: v })).not.toBe(sig)
        }
    })

    test("signedHeaders sets content-type only with a body", () => {
        const h = signedHeaders({
            token: TOKEN,
            method: "GET",
            path: "/status",
            instanceId: "i",
            now: () => 5,
            nonce: "n".repeat(32),
        })
        expect(h[HEADERS.timestamp]).toBe("5")
        expect(h["content-type"]).toBeUndefined()
        expect(
            signedHeaders({
                token: TOKEN,
                method: "POST",
                path: "/x",
                text: "{}",
                instanceId: "i",
            })["content-type"]
        ).toBe("application/json")
    })

    test("clientHostFromBind maps wildcards and brackets IPv6", () => {
        expect(clientHostFromBind(undefined)).toBe("127.0.0.1")
        expect(clientHostFromBind("::")).toBe("[::1]")
        expect(clientHostFromBind("fe80::1")).toBe("[fe80::1]")
    })
})

describe("readCredentials", () => {
    const read = (files) => ({
        configPath: CONFIG,
        credentialsPath: CACHE,
        read: reader(files),
        sleep: jest.fn(async () => {}),
    })

    test("takes config.json when it has a token, with defaults", async () => {
        await expect(
            readCredentials(read({ [CONFIG]: { authToken: TOKEN } }))
        ).resolves.toEqual({
            creds: {
                token: TOKEN,
                port: 7777,
                bind: "127.0.0.1",
                hook: null,
                reviewer: null,
                limits: null,
            },
            source: "config",
        })
    })

    test("retries a config.json caught mid-edit, then succeeds", async () => {
        let n = 0
        const opts = read({})
        opts.read = (p) => {
            if (p !== CONFIG) throw new Error("no")
            n++
            return n < 3 ? "{ half" : JSON.stringify({ authToken: TOKEN })
        }
        const r = await readCredentials(opts)
        expect(r.source).toBe("config")
        expect(opts.sleep).toHaveBeenCalledTimes(2)
    })

    test("falls back to the credentials cache after the retries, saying why", async () => {
        const opts = read({
            [CONFIG]: "{ half",
            [CACHE]: { token: "cached", port: 7788 },
        })
        const r = await readCredentials(opts)
        expect(r).toMatchObject({
            source: "cache",
            creds: { token: "cached", port: 7788 },
            configError: `${CONFIG} doesn't parse`,
        })
        expect(opts.sleep).toHaveBeenCalledTimes(2)
    })

    test("a tokenless config.json goes to the cache at once", async () => {
        const opts = read({ [CONFIG]: { port: 1 }, [CACHE]: { token: "c" } })
        const r = await readCredentials(opts)
        expect(r.configError).toBe(`${CONFIG} has no authToken`)
        expect(opts.sleep).not.toHaveBeenCalled()
    })

    test("no config and no usable cache: the reason names both", async () => {
        const r = await readCredentials(read({ [CACHE]: { token: "" } }))
        expect(r.creds).toBeNull()
        expect(r.reason).toMatch(/can't be read \(ENOENT\)/)
        expect(r.reason).toMatch(/no usable \/cache\/hook-credentials\.json/)
    })

    test("credentialsOf needs a token under the given key", () => {
        expect(credentialsOf({ token: "t" }, "authToken")).toBeNull()
        expect(credentialsOf(null, "token")).toBeNull()
    })
})

describe("readServerInfo", () => {
    test("reads a well-formed file, ignores anything else", () => {
        const good = { port: 7777, bind: "127.0.0.1", instanceId: "i" }
        expect(
            readServerInfo({
                serverInfoPath: INFO,
                read: reader({ [INFO]: good }),
            })
        ).toEqual(good)
        expect(
            readServerInfo({
                serverInfoPath: INFO,
                read: reader({ [INFO]: { port: "x", instanceId: "i" } }),
            })
        ).toBeNull()
        expect(
            readServerInfo({ serverInfoPath: INFO, read: reader({}) })
        ).toBeNull()
    })
})

describe("challengeAt", () => {
    const at = (fetchFn, over = {}) =>
        challengeAt({ baseUrl: "http://h:1", token: TOKEN, fetchFn, ...over })

    test("accepts a matching proof", async () => {
        await expect(at(fakeServer().fetchFn)).resolves.toEqual({
            ok: true,
            instanceId: "inst-1",
        })
    })

    test("refuses another token's proof, another service, a non-200 and junk", async () => {
        await expect(
            at(fakeServer({ tokens: ["other"] }).fetchFn)
        ).resolves.toMatchObject({ ok: false, reason: /proof/ })
        await expect(
            at(fakeServer({ service: "else" }).fetchFn)
        ).resolves.toMatchObject({ ok: false, reason: /not a review/ })
        await expect(
            at(async () => response(503, "down"))
        ).resolves.toMatchObject({ ok: false, reason: /HTTP 503/ })
        await expect(
            at(async () => response(200, { service: SERVICE, instanceId: "i" }))
        ).resolves.toMatchObject({ ok: false })
    })

    test("an unreachable or silent address fails", async () => {
        await expect(
            at(async () => {
                throw Object.assign(new Error("x"), { code: "ECONNREFUSED" })
            })
        ).resolves.toEqual({ ok: false, reason: "ECONNREFUSED" })
        await expect(
            at(async () => {
                throw new Error("boom")
            })
        ).resolves.toEqual({ ok: false, reason: "boom" })
        const hang = (_url, { signal }) =>
            new Promise((_r, reject) =>
                signal.addEventListener("abort", () =>
                    reject(
                        Object.assign(new Error("a"), { name: "AbortError" })
                    )
                )
            )
        await expect(at(hang, { timeoutMs: 20 })).resolves.toEqual({
            ok: false,
            reason: "no answer",
        })
    })
})

describe("selectServer", () => {
    const creds = { token: TOKEN, port: 7777, bind: "127.0.0.1" }
    const info = {
        port: 7799,
        bind: "::1",
        instanceId: "inst-1",
        hookTimeoutMs: 900_000,
    }

    test("prefers server.json when it proves the token and names the same instance", async () => {
        const { fetchFn } = fakeServer()
        const r = await selectServer({
            creds,
            serverInfoPath: INFO,
            read: reader({ [INFO]: info }),
            fetchFn,
        })
        expect(r).toEqual({
            baseUrl: "http://[::1]:7799",
            instanceId: "inst-1",
            hookTimeoutMs: 900_000,
            source: "server.json",
        })
    })

    test("a stale server.json (another instance) falls back to config.json's address", async () => {
        const { fetchFn } = fakeServer({ instanceId: "inst-2" })
        const r = await selectServer({
            creds,
            serverInfoPath: INFO,
            read: reader({ [INFO]: { ...info, hookTimeoutMs: "x" } }),
            fetchFn,
        })
        expect(r).toMatchObject({
            baseUrl: "http://127.0.0.1:7777",
            instanceId: "inst-2",
            hookTimeoutMs: null,
            source: "config",
        })
    })

    test("nothing proving the token is an error naming each address", async () => {
        const { fetchFn } = fakeServer({ tokens: ["other"] })
        const r = await selectServer({
            creds,
            serverInfoPath: INFO,
            read: reader({ [INFO]: info }),
            fetchFn,
        })
        expect(r.error).toMatch(/server.json's http:\/\/\[::1\]:7799/)
        expect(r.error).toMatch(/http:\/\/127.0.0.1:7777: its proof/)
    })

    test("a server.json whose challenge passes for a different instance is skipped", async () => {
        const { fetchFn } = fakeServer({ instanceId: "inst-9" })
        const r = await selectServer({
            creds: { ...creds, port: 1 },
            serverInfoPath: INFO,
            read: reader({ [INFO]: info }),
            fetchFn: async (url, opts) =>
                url.startsWith("http://127.0.0.1:1")
                    ? response(503, "")
                    : fetchFn(url, opts),
        })
        expect(r.error).toMatch(/a different instance/)
    })
})

describe("sendSigned", () => {
    const server = { baseUrl: "http://h:1", instanceId: "inst-1" }

    test("a verified response is returned with its request id", async () => {
        const { fetchFn, seen } = fakeServer({
            reply: () => ({
                status: 200,
                body: { status: "GOOD_TO_GO" },
                headers: { "x-request-id": "rid" },
            }),
        })
        const r = await sendSigned({
            server,
            token: TOKEN,
            method: "POST",
            path: "/review",
            body: { cwd: "/r" },
            timeoutMs: 1000,
            fetchFn,
        })
        expect(r).toEqual({
            httpStatus: 200,
            body: { status: "GOOD_TO_GO" },
            fetchError: null,
            serverRequestId: "rid",
        })
        expect(seen[0].opts.headers["x-review-token"]).toBeUndefined()
        expect(seen[0].opts.headers["content-type"]).toBe("application/json")
    })

    test("a response signed with another token is unverified: no status, no body", async () => {
        const { fetchFn } = fakeServer({ signWith: "forged" })
        const r = await sendSigned({
            server,
            token: TOKEN,
            path: "/status",
            timeoutMs: 1000,
            fetchFn,
        })
        expect(r).toMatchObject({
            httpStatus: null,
            body: null,
            fetchError: "unverified response from http://h:1 (HTTP 200)",
        })
    })

    test("an unsigned 401 for another instance is flagged", async () => {
        const { fetchFn } = fakeServer({ instanceId: "inst-2" })
        const r = await sendSigned({
            server,
            token: TOKEN,
            path: "/status",
            timeoutMs: 1000,
            fetchFn,
        })
        expect(r.unknownInstance).toBe(true)
        expect(r.fetchError).toMatch(/HTTP 401 UNKNOWN_INSTANCE/)
    })

    test("a non-JSON body and a throwing header getter are tolerated", async () => {
        const r = await sendSigned({
            server,
            token: TOKEN,
            path: "/x",
            timeoutMs: 1000,
            fetchFn: async () => ({
                status: 200,
                text: "plain",
                headers: {
                    get: () => {
                        throw new Error("no headers")
                    },
                },
            }),
        })
        expect(r).toMatchObject({ httpStatus: null, serverRequestId: null })
    })

    test("network errors and timeouts become fetchError", async () => {
        const fail = await sendSigned({
            server,
            token: TOKEN,
            path: "/x",
            timeoutMs: 1000,
            fetchFn: async () => {
                throw new Error("ECONNRESET")
            },
        })
        expect(fail).toMatchObject({
            httpStatus: null,
            fetchError: "ECONNRESET",
        })
        const slow = await sendSigned({
            server,
            token: TOKEN,
            path: "/x",
            timeoutMs: 20,
            fetchFn: (_u, { signal }) =>
                new Promise((_r, reject) =>
                    signal.addEventListener("abort", () =>
                        reject(
                            Object.assign(new Error("a"), {
                                name: "AbortError",
                            })
                        )
                    )
                ),
        })
        expect(slow.fetchError).toBe("request timed out after 20ms")
        const odd = await sendSigned({
            server,
            token: TOKEN,
            path: "/x",
            timeoutMs: 1000,
            fetchFn: async () => {
                throw "plain string"
            },
        })
        expect(odd.fetchError).toBe("plain string")
    })
})

describe("connect", () => {
    const files = {
        [CONFIG]: { authToken: TOKEN, port: 7777 },
    }
    const base = (fetchFn, over = {}) => ({
        configPath: CONFIG,
        credentialsPath: CACHE,
        serverInfoPath: INFO,
        read: reader(files),
        sleep: async () => {},
        fetchFn,
        ...over,
    })

    test("connects and sends verified requests", async () => {
        const { fetchFn } = fakeServer()
        const conn = await connect(base(fetchFn))
        expect(conn).toMatchObject({
            ok: true,
            credentialsSource: "config",
            configError: null,
            creds: { token: TOKEN },
        })
        expect(conn.server.source).toBe("config")
        await expect(
            conn.request({ method: "GET", path: "/status", timeoutMs: 1000 })
        ).resolves.toMatchObject({ httpStatus: 200 })
    })

    test("missing credentials or no proving address fail with the stage", async () => {
        await expect(
            connect(base(jest.fn(), { read: reader({}) }))
        ).resolves.toMatchObject({ ok: false, stage: "credentials" })
        await expect(
            connect(base(fakeServer({ tokens: ["x"] }).fetchFn))
        ).resolves.toMatchObject({
            ok: false,
            stage: "address",
            credentialsSource: "config",
        })
    })

    test("cached credentials the server no longer accepts: the reason names the unparseable config too", async () => {
        const r = await connect(
            base(fakeServer({ tokens: ["rotated"] }).fetchFn, {
                read: reader({
                    [CONFIG]: "{ half",
                    [CACHE]: { token: "old" },
                }),
            })
        )
        expect(r).toMatchObject({ ok: false, stage: "address" })
        expect(r.reason).toMatch(
            /^\/cfg\/config\.json doesn't parse, and with the cached hook credentials no server proved the token/
        )
    })

    test("a server that restarted is re-challenged and the request re-signed, once", async () => {
        let instanceId = "inst-1"
        const servers = {
            "inst-1": fakeServer({ instanceId: "inst-1" }),
            "inst-2": fakeServer({ instanceId: "inst-2" }),
        }
        const fetchFn = async (url, opts) => {
            const u = new URL(url)
            if (u.pathname === "/healthz") {
                return servers[instanceId].fetchFn(url, opts)
            }
            return servers[instanceId].fetchFn(url, opts)
        }
        const conn = await connect(base(fetchFn))
        instanceId = "inst-2"
        const r = await conn.request({
            method: "GET",
            path: "/status",
            timeoutMs: 1000,
        })
        expect(r.httpStatus).toBe(200)
        expect(conn.server.instanceId).toBe("inst-2")
    })

    test("a relay faking an unknown-instance answer after forwarding a mutation never gets it sent twice", async () => {
        const live = fakeServer({ instanceId: "inst-1" })
        // Forwards everything, but swaps the genuine answer to the
        // mutation for an unsigned UNKNOWN_INSTANCE.
        const relay = async (url, opts) => {
            const res = await live.fetchFn(url, opts)
            if (new URL(url).pathname !== "/admin/reload") return res
            return response(401, { code: "UNKNOWN_INSTANCE" })
        }
        const conn = await connect(base(relay))
        const r = await conn.request({
            method: "POST",
            path: "/admin/reload",
            body: { rollback: true },
            timeoutMs: 1000,
        })
        expect(live.seen.map((s) => new URL(s.url).pathname)).toEqual([
            "/admin/reload",
        ])
        expect(r).toMatchObject({
            httpStatus: null,
            fetchError: expect.stringMatching(/UNKNOWN_INSTANCE/),
        })
        expect(conn.server.instanceId).toBe("inst-1")
    })

    test("when the re-challenge fails, the first answer stands", async () => {
        let down = false
        const live = fakeServer({ instanceId: "inst-1" })
        const fetchFn = async (url, opts) => {
            if (down && new URL(url).pathname === "/healthz") {
                throw new Error("ECONNREFUSED")
            }
            return live.fetchFn(url, opts)
        }
        const conn = await connect(base(fetchFn))
        conn.server.instanceId = "gone"
        down = true
        const r = await conn.request({
            method: "GET",
            path: "/status",
            timeoutMs: 1000,
        })
        expect(r.fetchError).toMatch(/UNKNOWN_INSTANCE/)
    })
})

describe("CLI", () => {
    const sink = () => {
        const chunks = []
        return { write: (c) => chunks.push(c), text: () => chunks.join("") }
    }
    const run = async (argv, connectFn) => {
        const stdout = sink()
        const stderr = sink()
        const code = await runCli({ argv, stdout, stderr, connectFn })
        return { code, out: stdout.text(), err: stderr.text() }
    }
    const conn = (result, over = {}) => ({
        ok: true,
        server: { baseUrl: "http://h:1" },
        credentialsSource: "config",
        request: jest.fn(async () => result),
        ...over,
    })

    test("parses options, method, path and a JSON body", () => {
        expect(
            parseCliArgs([
                "--config",
                "/c.json",
                "--timeout",
                "5",
                "--verbose",
                "post",
                "/reset",
                '{"cwd":"/r"}',
            ])
        ).toEqual({
            configPath: "/c.json",
            timeoutMs: 5000,
            verbose: true,
            method: "POST",
            path: "/reset",
            body: { cwd: "/r" },
        })
        expect(parseCliArgs(["GET"]).error).toMatch(/usage/)
        expect(parseCliArgs(["GET", "/x", "{bad"]).error).toMatch(/JSON/)
        expect(parseCliArgs(["--timeout", "0", "GET", "/x"]).error).toMatch(
            /usage/
        )
    })

    test("exit codes: 0 on 2xx, 1 on an error status, 4 when unreachable or unverified, 2 on usage", async () => {
        let r = await run(["GET", "/status"], async () =>
            conn({ httpStatus: 200, body: { ok: true } })
        )
        expect(r).toMatchObject({ code: 0, out: '{"ok":true}\n' })
        r = await run(["GET", "/status"], async () =>
            conn({ httpStatus: 409, body: { ok: false } })
        )
        expect(r.code).toBe(1)
        r = await run(["GET", "/status"], async () =>
            conn({ httpStatus: null, fetchError: "unverified response" })
        )
        expect(r).toMatchObject({
            code: 4,
            err: "error: unverified response\n",
        })
        r = await run(["GET", "/status"], async () => ({
            ok: false,
            reason: "no server proved the token",
        }))
        expect(r).toMatchObject({ code: 4, err: /no server proved/ })
        r = await run([], jest.fn())
        expect(r.code).toBe(2)
    })

    test("--config reaches connect; --verbose and a cache fallback are reported on stderr", async () => {
        const connectFn = jest.fn(async () =>
            conn(
                { httpStatus: 200, body: {}, serverRequestId: null },
                {
                    credentialsSource: "cache",
                    configError: "config.json doesn't parse",
                }
            )
        )
        const r = await run(
            ["--config", "/c.json", "--verbose", "GET", "/status"],
            connectFn
        )
        expect(connectFn).toHaveBeenCalledWith({ configPath: "/c.json" })
        expect(r.err).toMatch(/using the cached hook credentials/)
        expect(r.err).toMatch(
            /==> GET http:\/\/h:1\/status: HTTP 200, request id <none>/
        )
    })
})

describe("an impostor relay (§9 hooks and token)", () => {
    test("a listener relaying every byte never sees the token, in any header, URL or body", async () => {
        const live = fakeServer({
            reply: () => ({ status: 200, body: { status: "GOOD_TO_GO" } }),
        })
        const seen = []
        const relay = async (url, opts) => {
            seen.push(url, JSON.stringify(opts.headers ?? {}), opts.body ?? "")
            return live.fetchFn(url, opts)
        }
        const conn = await connect({
            configPath: CONFIG,
            credentialsPath: CACHE,
            serverInfoPath: INFO,
            read: reader({
                [CONFIG]: { authToken: TOKEN, port: 7777 },
                [INFO]: { port: 7777, bind: "127.0.0.1", instanceId: "inst-1" },
            }),
            sleep: async () => {},
            fetchFn: relay,
        })
        await conn.request({
            method: "POST",
            path: "/review",
            body: { cwd: "/r", note: "any body" },
            timeoutMs: 1000,
        })
        await conn.request({ method: "GET", path: "/status", timeoutMs: 1000 })
        expect(seen.length).toBeGreaterThan(4)
        for (const s of seen) expect(s).not.toContain(TOKEN)
    })
})
