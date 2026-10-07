/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { jest } from "@jest/globals"
import express from "express"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
    challengeAt,
    HEADERS,
    httpFetch,
    requestSignature,
    sendSigned,
    sha256Hex,
} from "../../hooks/signed-client.mjs"
import {
    createAuth,
    createTokenState,
    DEFAULT_GRACE_HOURS,
    graceUntil,
    NONCE_TTL_MS,
} from "./auth.js"

const HOUR = 60 * 60 * 1000
const T0 = Date.parse("2026-10-07T12:00:00.000Z")
const rec = (from, to, grace, at) => ({
    tokenHash: sha256Hex(to),
    previousTokenHash: from === null ? null : sha256Hex(from),
    grace,
    at: new Date(at).toISOString(),
})

let dir
let configPath
beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "auth-"))
    configPath = path.join(dir, "config.json")
})
afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
})

const writeConfig = (authToken, rotations) =>
    writeFileSync(
        configPath,
        JSON.stringify({
            authToken,
            ...(rotations ? { auth: { rotations } } : {}),
        })
    )

describe("graceUntil", () => {
    const g = (rotations, over = {}) =>
        graceUntil({
            rotations,
            currentToken: "B",
            previousToken: "A",
            noticedAt: T0 + 5 * HOUR,
            graceMs: 24 * HOUR,
            ...over,
        })

    test("a hand edit (no record for the current token) runs from when it was noticed", () => {
        expect(g([])).toBe(T0 + 29 * HOUR)
        expect(g(null)).toBe(T0 + 29 * HOUR)
    })

    test("a scripted rotation runs from the record that rotated the predecessor out", () => {
        expect(g([rec("A", "B", "default", T0)])).toBe(T0 + 24 * HOUR)
    })

    test("a missed rotation can't restart an older token's clock", () => {
        // Seen as A→C; A was rotated out by A→B long before.
        expect(
            g(
                [
                    rec("A", "B", "default", T0),
                    rec("B", "C", "default", T0 + 30 * HOUR),
                ],
                { currentToken: "C" }
            )
        ).toBe(T0 + 24 * HOUR)
    })

    test("--revoke-now on the rotation, or any later one, means no grace", () => {
        expect(g([rec("A", "B", "none", T0)])).toBeNull()
        expect(
            g(
                [
                    rec("A", "B", "default", T0),
                    rec("B", "C", "none", T0 + HOUR),
                ],
                { currentToken: "C" }
            )
        ).toBeNull()
        expect(
            g(
                [
                    rec("A", "B", "none", T0),
                    rec("B", "C", "default", T0 + HOUR),
                ],
                { currentToken: "C" }
            )
        ).toBeNull()
    })

    test("no record rotating the predecessor out (history trimmed), or a bad time, means none", () => {
        expect(g([rec("X", "B", "default", T0)])).toBeNull()
        expect(
            g([{ ...rec("A", "B", "default", T0), at: "not a date" }])
        ).toBeNull()
    })
})

describe("createTokenState", () => {
    const make = (over = {}) => {
        let t = T0
        const clock = { advance: (ms) => (t += ms) }
        const onChange = jest.fn()
        const state = createTokenState({
            configPath,
            initialToken: "A",
            now: () => t,
            onChange,
            ...over,
        })
        return { state, clock, onChange }
    }

    test("needs a token to start", () => {
        expect(() =>
            createTokenState({ configPath, initialToken: "" })
        ).toThrow(/non-empty authToken/)
    })

    test("keeps the last good token when the file is missing or mid-edit", () => {
        const { state } = make()
        expect(state.refresh()).toEqual(["A"])
        writeFileSync(configPath, "{ half")
        expect(state.refresh()).toEqual(["A"])
    })

    test("a hand-edited token is picked up on the next refresh; the old one gets the default grace from then", () => {
        const { state, clock, onChange } = make()
        writeConfig("B")
        expect(state.refresh()).toEqual(["B", "A"])
        expect(onChange).toHaveBeenCalledTimes(1)
        expect(state.status()).toEqual({
            currentTokenHash: sha256Hex("B"),
            previousTokenGrace: {
                tokenHash: sha256Hex("A"),
                until: new Date(T0 + DEFAULT_GRACE_HOURS * HOUR).toISOString(),
            },
        })
        clock.advance(DEFAULT_GRACE_HOURS * HOUR)
        expect(state.refresh()).toEqual(["B"])
        expect(state.status().previousTokenGrace).toBeNull()
    })

    test("the grace length follows the live setting", () => {
        const { state } = make({ graceHours: () => 1 })
        writeConfig("B")
        state.refresh()
        expect(state.status().previousTokenGrace.until).toBe(
            new Date(T0 + HOUR).toISOString()
        )
    })

    test("a scripted rotation the server sees late grants only what's left", () => {
        const { state, clock } = make()
        clock.advance(30 * HOUR)
        writeConfig("B", [rec("A", "B", "default", T0)])
        // Rotated 30 h ago: the 24 h grace is long over.
        expect(state.refresh()).toEqual(["B"])
    })

    test("a later --revoke-now drops a running grace, and it never comes back", () => {
        const { state } = make()
        writeConfig("B", [rec("A", "B", "default", T0)])
        expect(state.refresh()).toEqual(["B", "A"])
        writeConfig("B", [
            rec("A", "B", "default", T0),
            rec("B", "B", "none", T0 + 1),
        ])
        expect(state.refresh()).toEqual(["B"])
        writeConfig("B", [rec("A", "B", "default", T0)])
        expect(state.refresh()).toEqual(["B"])
    })

    test("a grace is never extended: not by a tokenless config, a dropped history, or a longer setting", () => {
        let hours = 24
        const { state, clock } = make({ graceHours: () => hours })
        writeConfig("B", [rec("A", "B", "default", T0)])
        clock.advance(23 * HOUR)
        expect(state.refresh()).toEqual(["B", "A"])
        const until = new Date(T0 + 24 * HOUR).toISOString()
        // Parseable, but no token: not a usable read.
        writeFileSync(configPath, "{}")
        state.refresh()
        expect(state.status().previousTokenGrace.until).toBe(until)
        // The rotation history gone: the hand-edit rule would say later.
        writeConfig("B")
        state.refresh()
        hours = 48
        state.refresh()
        expect(state.status().previousTokenGrace.until).toBe(until)
        clock.advance(2 * HOUR)
        expect(state.refresh()).toEqual(["B"])
    })

    test("a shorter grace setting shortens a running grace", () => {
        let hours = 24
        const { state } = make({ graceHours: () => hours })
        writeConfig("B")
        state.refresh()
        hours = 1
        state.refresh()
        expect(state.status().previousTokenGrace.until).toBe(
            new Date(T0 + HOUR).toISOString()
        )
    })

    test("an unreadable file during a grace keeps it as it was", () => {
        const { state } = make()
        writeConfig("B", [rec("A", "B", "default", T0)])
        state.refresh()
        writeFileSync(configPath, "{ half")
        expect(state.refresh()).toEqual(["B", "A"])
    })

    test("a second change replaces the predecessor", () => {
        const { state } = make()
        writeConfig("B")
        state.refresh()
        writeConfig("C")
        expect(state.refresh()).toEqual(["C", "B"])
    })
})

// A real server: the auth middleware in front of a signed route, /mcp and
// the challenge, as index.js mounts them.
const startServer = async ({ instanceId = "inst-1", now } = {}) => {
    writeConfig("A")
    const tokenState = createTokenState({ configPath, initialToken: "A" })
    const auth = createAuth({ tokenState, instanceId, ...(now ? { now } : {}) })
    const app = express()
    app.use(
        express.json({
            verify: (req, _res, buf) => {
                req.rawBody = buf
            },
        })
    )
    app.get("/healthz", (req, res) => {
        const answer = auth.challenge(req.query.challenge)
        if (answer.error) {
            res.status(400).json({ error: answer.error })
            return
        }
        res.json({ ok: true, service: "review-orchestrator", ...answer })
    })
    app.use(auth.middleware)
    app.post("/echo", (req, res) => res.json({ got: req.body }))
    app.get("/fail", (_req, res) => res.status(418).json({ code: "TEAPOT" }))
    app.get("/text", (_req, res) => res.send("plain"))
    app.get("/buffer", (_req, res) => res.send(Buffer.from("bytes")))
    app.get("/empty", (_req, res) => res.end())
    app.get("/none", (_req, res) => res.send())
    app.post("/mcp", (_req, res) => res.json({ mcp: true }))
    const server = await new Promise((resolve) => {
        const s = app.listen(0, "127.0.0.1", () => resolve(s))
    })
    const baseUrl = `http://127.0.0.1:${server.address().port}`
    return {
        auth,
        baseUrl,
        server: { baseUrl, instanceId },
        close: () => new Promise((r) => server.close(r)),
    }
}

describe("createAuth over HTTP", () => {
    let srv
    afterEach(async () => {
        await srv?.close()
        srv = null
    })

    test("the challenge proves the token for this instance", async () => {
        srv = await startServer()
        await expect(
            challengeAt({ baseUrl: srv.baseUrl, token: "A" })
        ).resolves.toEqual({ ok: true, instanceId: "inst-1" })
        await expect(
            challengeAt({ baseUrl: srv.baseUrl, token: "B" })
        ).resolves.toMatchObject({ ok: false })
        const bad = await fetch(`${srv.baseUrl}/healthz?challenge=x`)
        expect(bad.status).toBe(400)
        const plain = await (await fetch(`${srv.baseUrl}/healthz`)).json()
        expect(plain).toMatchObject({ instanceId: "inst-1" })
        expect(plain.proofs).toBeUndefined()
    })

    test("a signed request is accepted once, and its response verifies", async () => {
        srv = await startServer()
        const r = await sendSigned({
            server: srv.server,
            token: "A",
            method: "POST",
            path: "/echo",
            body: { x: 1 },
            timeoutMs: 5000,
        })
        expect(r).toMatchObject({ httpStatus: 200, body: { got: { x: 1 } } })
        expect(srv.auth.__nonces.size).toBe(1)
    })

    test("non-JSON bodies, empty bodies and error statuses are signed too", async () => {
        srv = await startServer()
        const send = (p) =>
            sendSigned({
                server: srv.server,
                token: "A",
                path: p,
                timeoutMs: 5000,
            })
        await expect(send("/fail")).resolves.toMatchObject({
            httpStatus: 418,
            body: { code: "TEAPOT" },
        })
        for (const p of ["/text", "/buffer", "/none"]) {
            await expect(send(p)).resolves.toMatchObject({ httpStatus: 200 })
        }
        // res.end() bypasses send: unsigned, so unverified.
        await expect(send("/empty")).resolves.toMatchObject({
            httpStatus: null,
            fetchError: expect.stringMatching(/unverified response/),
        })
    })

    test("a replayed request is refused", async () => {
        srv = await startServer()
        const headers = {
            [HEADERS.timestamp]: String(Date.now()),
            [HEADERS.nonce]: "n".repeat(32),
            [HEADERS.instance]: "inst-1",
        }
        headers[HEADERS.signature] = requestSignature({
            token: "A",
            method: "GET",
            path: "/text",
            bodyHash: sha256Hex(""),
            timestamp: headers[HEADERS.timestamp],
            nonce: headers[HEADERS.nonce],
            instanceId: "inst-1",
        })
        const first = await fetch(`${srv.baseUrl}/text`, { headers })
        expect(first.status).toBe(200)
        const again = await fetch(`${srv.baseUrl}/text`, { headers })
        expect(again.status).toBe(401)
        expect((await again.json()).code).toBe("REPLAYED_REQUEST")
    })

    test("each malformed or wrong request gets its own 401 code", async () => {
        srv = await startServer()
        const signed = (over = {}, sigOver = {}) => {
            const h = {
                [HEADERS.timestamp]: String(Date.now()),
                [HEADERS.nonce]: Math.random()
                    .toString(36)
                    .slice(2)
                    .padEnd(20, "x"),
                [HEADERS.instance]: "inst-1",
                ...over,
            }
            h[HEADERS.signature] = requestSignature({
                token: "A",
                method: "GET",
                path: "/text",
                bodyHash: sha256Hex(""),
                timestamp: h[HEADERS.timestamp],
                nonce: h[HEADERS.nonce],
                instanceId: h[HEADERS.instance],
                ...sigOver,
            })
            return h
        }
        const codeOf = async (headers) => {
            const r = await fetch(`${srv.baseUrl}/text`, { headers })
            expect(r.status).toBe(401)
            return (await r.json()).code
        }
        expect(await codeOf({ "x-review-token": "A" })).toBe(
            "TOKEN_NOT_ACCEPTED"
        )
        expect(await codeOf({})).toBe("UNSIGNED_REQUEST")
        expect(await codeOf(signed({ [HEADERS.instance]: "old" }))).toBe(
            "UNKNOWN_INSTANCE"
        )
        expect(
            await codeOf(
                signed({ [HEADERS.timestamp]: String(Date.now() - 6 * 60_000) })
            )
        ).toBe("STALE_REQUEST")
        expect(await codeOf(signed({ [HEADERS.timestamp]: "soon" }))).toBe(
            "STALE_REQUEST"
        )
        expect(await codeOf(signed({ [HEADERS.nonce]: "short" }))).toBe(
            "BAD_NONCE"
        )
        expect(await codeOf(signed({}, { token: "B" }))).toBe("BAD_SIGNATURE")
        expect(await codeOf(signed({}, { path: "/other" }))).toBe(
            "BAD_SIGNATURE"
        )
    })

    test("/mcp takes X-Review-Token, current or in grace", async () => {
        srv = await startServer()
        const mcp = (token) =>
            fetch(`${srv.baseUrl}/mcp`, {
                method: "POST",
                headers: token ? { "x-review-token": token } : {},
            })
        expect((await mcp("A")).status).toBe(200)
        expect((await mcp("B")).status).toBe(401)
        expect((await mcp(null)).status).toBe(401)
        writeConfig("B")
        expect((await mcp("B")).status).toBe(200)
        expect((await mcp("A")).status).toBe(200)
    })

    test("after a rotation: the first request already sees it, the old token keeps working in grace and gets responses signed with it", async () => {
        srv = await startServer()
        writeConfig("B", [rec("A", "B", "default", Date.now())])
        await expect(
            challengeAt({ baseUrl: srv.baseUrl, token: "B" })
        ).resolves.toMatchObject({ ok: true })
        await expect(
            challengeAt({ baseUrl: srv.baseUrl, token: "A" })
        ).resolves.toMatchObject({ ok: true })
        const old = await sendSigned({
            server: srv.server,
            token: "A",
            path: "/text",
            timeoutMs: 5000,
        })
        expect(old.httpStatus).toBe(200)
    })

    test("after --revoke-now even the first request signed with the old token is refused", async () => {
        srv = await startServer()
        writeConfig("B", [rec("A", "B", "none", Date.now())])
        const r = await sendSigned({
            server: srv.server,
            token: "A",
            path: "/text",
            timeoutMs: 5000,
        })
        expect(r.httpStatus).toBeNull()
        expect(r.fetchError).toMatch(/HTTP 401 BAD_SIGNATURE/)
        await expect(
            challengeAt({ baseUrl: srv.baseUrl, token: "A" })
        ).resolves.toMatchObject({ ok: false })
    })

    test("old nonces are swept once their TTL passes", async () => {
        let t = Date.now()
        srv = await startServer({ now: () => t })
        const send = () =>
            sendSigned({
                server: srv.server,
                token: "A",
                path: "/text",
                timeoutMs: 5000,
                now: () => t,
            })
        await send()
        await send()
        expect(srv.auth.__nonces.size).toBe(2)
        t += NONCE_TTL_MS + 1
        await send()
        expect(srv.auth.__nonces.size).toBe(1)
    })

    test("a response altered in transit fails verification", async () => {
        srv = await startServer()
        const tamper = async (url, opts) => {
            const res = await httpFetch(url, opts)
            const text = res.text.replace("plain", "fake!")
            return { ...res, text, bytes: Buffer.from(text) }
        }
        const r = await sendSigned({
            server: srv.server,
            token: "A",
            path: "/text",
            timeoutMs: 5000,
            fetchFn: tamper,
        })
        expect(r.fetchError).toMatch(/unverified response/)
    })
})
