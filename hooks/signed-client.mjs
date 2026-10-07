#!/usr/bin/env node
/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

// The one client every non-MCP caller uses to reach the server: the Stop
// hooks, the notify-change hook, the opencode plugin's own requests and
// every script (hot-reload plan §5.7, "Signed requests and responses").
//
//   * Credentials: config.json, re-read on every call and retried briefly
//     when it's caught mid-edit, falling back to hook-credentials.json,
//     which only config writers refresh.
//   * Address: server.json's live address when it passes the challenge
//     (GET /healthz?challenge=), otherwise config.json's, which must pass
//     it too. The challenge only picks an address.
//   * Requests are HMAC-signed with the token, bound to the server
//     instance the challenge named; the token itself is never sent.
//     Responses carry a signature made with the token that verified the
//     request, and an unverified response counts as a failed request.
//
// Node built-ins only: it's installed next to the hooks, which run with
// no package dependencies.
//
// CLI (for the scripts):
//   signed-client.mjs [--config <path>] [--timeout <seconds>] [--verbose]
//                     <METHOD> <path> [<json body>]
// prints the response body (--verbose adds the address, status and
// request id on stderr); exits 0 on a verified 2xx, 1 on a verified error
// status, 4 when the server can't be reached or verified.

import {
    createHash,
    createHmac,
    randomBytes,
    timingSafeEqual,
} from "node:crypto"
import { readFileSync } from "node:fs"
import http from "node:http"
import { homedir } from "node:os"
import path from "node:path"

export const SERVICE = "review-orchestrator"
export const DEFAULT_PORT = 7777
export const DEFAULT_BIND = "127.0.0.1"
export const CHALLENGE_TIMEOUT_MS = 2000
export const READ_ATTEMPTS = 3
export const READ_RETRY_MS = 330

export const HEADERS = Object.freeze({
    timestamp: "x-review-timestamp",
    nonce: "x-review-nonce",
    instance: "x-review-instance",
    signature: "x-review-signature",
    responseSignature: "x-review-response-signature",
})

export const defaultConfigPath = () =>
    process.env.REVIEW_ORCH_CONFIG ??
    path.join(homedir(), ".config", "review-orchestrator", "config.json")
const cacheDir = () => path.join(homedir(), ".cache", "review-orchestrator")
export const defaultCredentialsPath = () =>
    path.join(cacheDir(), "hook-credentials.json")
export const defaultServerInfoPath = () => path.join(cacheDir(), "server.json")

export const sha256Hex = (data) =>
    createHash("sha256")
        .update(data ?? "")
        .digest("hex")

const hmacHex = (key, text) =>
    createHmac("sha256", key).update(text).digest("hex")

export const safeEqual = (a, b) => {
    if (typeof a !== "string" || typeof b !== "string") return false
    const ab = Buffer.from(a, "utf8")
    const bb = Buffer.from(b, "utf8")
    return ab.length === bb.length && timingSafeEqual(ab, bb)
}

// method + path (with query) + sha256(body) + timestamp + nonce + the
// target instance, so a signature is good for one request to one server
// instance only.
export const requestSignature = ({
    token,
    method,
    path: target,
    bodyHash,
    timestamp,
    nonce,
    instanceId,
}) =>
    hmacHex(
        token,
        [
            String(method).toUpperCase(),
            target,
            bodyHash,
            String(timestamp),
            nonce,
            instanceId,
        ].join("\n")
    )

export const responseSignature = ({ token, nonce, status, bodyHash }) =>
    hmacHex(token, [nonce, String(status), bodyHash].join("\n"))

export const challengeProof = ({ token, nonce, instanceId }) =>
    hmacHex(token, `${SERVICE}:${nonce}:${instanceId}`)

// A server `bind` (or listening address) as the host of a client URL:
// wildcards become loopback, bare IPv6 gets brackets.
export const clientHostFromBind = (bind) => {
    if (!bind || bind === "0.0.0.0") return "127.0.0.1"
    if (bind === "::" || bind === "::1") return "[::1]"
    if (bind.startsWith("[")) return bind
    const colonCount = (bind.match(/:/g) ?? []).length
    if (colonCount >= 2) return `[${bind}]`
    return bind
}

// A fetch-shaped client over node:http. Not the global fetch: undici's
// 300 s header and body timeouts fire independently of the abort signal,
// and a review can hold the response for up to 29 min. Resolves to
// { status, headers: { get }, bytes, text, json() }.
export const httpFetch = (url, { method, headers, body, signal } = {}) =>
    new Promise((resolve, reject) => {
        // Settle once: a drop after headers, an abort mid-response and a
        // normal end can race.
        let settled = false
        const fail = (err) => {
            if (settled) return
            settled = true
            reject(err)
        }
        const succeed = (value) => {
            if (settled) return
            settled = true
            resolve(value)
        }
        const u = new URL(url)
        // http.request wants an IPv6 literal without its brackets.
        const hostname = u.hostname.replace(/^\[|\]$/g, "")
        const req = http.request(
            {
                hostname,
                port: u.port,
                path: u.pathname + u.search,
                method,
                headers,
            },
            (res) => {
                res.once("error", fail)
                res.once("aborted", () => fail(new Error("response aborted")))
                const chunks = []
                res.on("data", (c) => chunks.push(c))
                res.on("end", () => {
                    const bytes = Buffer.concat(chunks)
                    const text = bytes.toString("utf8")
                    succeed({
                        status: res.statusCode,
                        headers: {
                            get: (name) =>
                                res.headers[String(name).toLowerCase()] ?? null,
                        },
                        bytes,
                        text,
                        json: async () => JSON.parse(text),
                    })
                })
            }
        )
        req.on("error", fail)
        if (signal) {
            const onAbort = () => {
                const err = new Error("aborted")
                err.name = "AbortError"
                req.destroy(err)
            }
            if (signal.aborted) onAbort()
            else signal.addEventListener("abort", onAbort, { once: true })
        }
        if (body) req.write(body)
        req.end()
    })

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms))

// The connection details a caller needs, from a parsed config.json or
// hook-credentials.json. Null without a token.
export const credentialsOf = (parsed, tokenKey) => {
    const token = parsed?.[tokenKey]
    if (typeof token !== "string" || token.length === 0) return null
    return {
        token,
        port: Number.isInteger(parsed.port) ? parsed.port : DEFAULT_PORT,
        bind:
            typeof parsed.bind === "string" && parsed.bind.length > 0
                ? parsed.bind
                : DEFAULT_BIND,
        hook: parsed.hook ?? null,
        reviewer: parsed.reviewer ?? null,
        limits: parsed.limits ?? null,
    }
}

// config.json, retried over about a second when it can't be read or
// parsed (an editor saving in place), then hook-credentials.json.
// Resolves to { creds, source: "config" | "cache", configError? } or
// { creds: null, reason }.
export const readCredentials = async ({
    configPath = defaultConfigPath(),
    credentialsPath = defaultCredentialsPath(),
    read = readFileSync,
    sleep = defaultSleep,
    attempts = READ_ATTEMPTS,
    retryMs = READ_RETRY_MS,
} = {}) => {
    let configError = null
    for (let attempt = 1; attempt <= attempts; attempt++) {
        let parsed
        try {
            parsed = JSON.parse(read(configPath, "utf8"))
        } catch (err) {
            configError =
                err instanceof SyntaxError
                    ? `${configPath} doesn't parse`
                    : `${configPath} can't be read (${err.code ?? err.message})`
            if (attempt < attempts) await sleep(retryMs)
            continue
        }
        const creds = credentialsOf(parsed, "authToken")
        if (creds) return { creds, source: "config" }
        configError = `${configPath} has no authToken`
        break
    }
    try {
        const creds = credentialsOf(
            JSON.parse(read(credentialsPath, "utf8")),
            "token"
        )
        if (creds) return { creds, source: "cache", configError }
    } catch {
        // no usable cache
    }
    return {
        creds: null,
        reason: `${configError}, and there's no usable ${credentialsPath}`,
    }
}

export const readServerInfo = ({
    serverInfoPath = defaultServerInfoPath(),
    read = readFileSync,
} = {}) => {
    try {
        const info = JSON.parse(read(serverInfoPath, "utf8"))
        if (
            !Number.isInteger(info?.port) ||
            typeof info.instanceId !== "string"
        )
            return null
        return info
    } catch {
        return null
    }
}

const withTimeout = async (fn, timeoutMs) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
        return await fn(controller.signal)
    } finally {
        clearTimeout(timer)
    }
}

// Does `baseUrl` reach a server holding `token`? Resolves to
// { ok: true, instanceId } or { ok: false, reason }.
export const challengeAt = async ({
    baseUrl,
    token,
    fetchFn = httpFetch,
    timeoutMs = CHALLENGE_TIMEOUT_MS,
    nonce = randomBytes(32).toString("hex"),
}) => {
    let res
    try {
        res = await withTimeout(
            (signal) =>
                fetchFn(`${baseUrl}/healthz?challenge=${nonce}`, {
                    method: "GET",
                    headers: {},
                    signal,
                }),
            timeoutMs
        )
    } catch (err) {
        return {
            ok: false,
            reason:
                err?.name === "AbortError"
                    ? "no answer"
                    : (err?.code ?? err?.message ?? "unreachable"),
        }
    }
    let body = null
    try {
        body = JSON.parse(res.text)
    } catch {
        // checked below
    }
    if (res.status !== 200 || body?.service !== SERVICE) {
        return { ok: false, reason: `not a ${SERVICE} (HTTP ${res.status})` }
    }
    const expected = challengeProof({
        token,
        nonce,
        instanceId: body.instanceId,
    })
    const proofs = Array.isArray(body.proofs) ? body.proofs : []
    if (!proofs.some((p) => safeEqual(p, expected))) {
        return { ok: false, reason: "its proof doesn't match this token" }
    }
    return { ok: true, instanceId: body.instanceId }
}

// server.json's address when it proves the token and is the instance the
// file names, else config.json's when it proves the token. Resolves to
// { baseUrl, instanceId, hookTimeoutMs, source } or { error }.
export const selectServer = async ({
    creds,
    serverInfoPath = defaultServerInfoPath(),
    read = readFileSync,
    fetchFn = httpFetch,
    timeoutMs = CHALLENGE_TIMEOUT_MS,
}) => {
    const tried = []
    const info = readServerInfo({ serverInfoPath, read })
    if (info) {
        const baseUrl = `http://${clientHostFromBind(info.bind)}:${info.port}`
        const c = await challengeAt({
            baseUrl,
            token: creds.token,
            fetchFn,
            timeoutMs,
        })
        if (c.ok && c.instanceId === info.instanceId) {
            return {
                baseUrl,
                instanceId: c.instanceId,
                hookTimeoutMs: Number.isFinite(info.hookTimeoutMs)
                    ? info.hookTimeoutMs
                    : null,
                source: "server.json",
            }
        }
        tried.push(
            `server.json's ${baseUrl}: ${c.ok ? "a different instance" : c.reason}`
        )
    }
    const baseUrl = `http://${clientHostFromBind(creds.bind)}:${creds.port}`
    const c = await challengeAt({
        baseUrl,
        token: creds.token,
        fetchFn,
        timeoutMs,
    })
    if (c.ok) {
        return {
            baseUrl,
            instanceId: c.instanceId,
            hookTimeoutMs: null,
            source: "config",
        }
    }
    tried.push(`${baseUrl}: ${c.reason}`)
    return { error: `no server proved the token — ${tried.join("; ")}` }
}

// The headers of a signed request whose body is `text` (a JSON string,
// or "" for none).
export const signedHeaders = ({
    token,
    method,
    path: target,
    text = "",
    instanceId,
    now = Date.now,
    nonce = randomBytes(16).toString("hex"),
}) => {
    const timestamp = String(now())
    return {
        [HEADERS.timestamp]: timestamp,
        [HEADERS.nonce]: nonce,
        [HEADERS.instance]: instanceId,
        [HEADERS.signature]: requestSignature({
            token,
            method,
            path: target,
            bodyHash: sha256Hex(text),
            timestamp,
            nonce,
            instanceId,
        }),
        ...(text ? { "content-type": "application/json" } : {}),
    }
}

// One signed request to the selected server, aborted after `timeoutMs`.
// Resolves to { httpStatus, body, fetchError, serverRequestId }, with
// httpStatus and body set only for a verified response.
export const sendSigned = async ({
    server,
    token,
    method = "GET",
    path: target,
    body = null,
    timeoutMs,
    fetchFn = httpFetch,
    now = Date.now,
}) => {
    const text = body === null || body === undefined ? "" : JSON.stringify(body)
    const headers = signedHeaders({
        token,
        method,
        path: target,
        text,
        instanceId: server.instanceId,
        now,
    })
    const nonce = headers[HEADERS.nonce]
    let res
    try {
        res = await withTimeout(
            (signal) =>
                fetchFn(`${server.baseUrl}${target}`, {
                    method,
                    headers,
                    body: text || undefined,
                    signal,
                }),
            timeoutMs
        )
    } catch (err) {
        return {
            httpStatus: null,
            body: null,
            fetchError:
                err?.name === "AbortError"
                    ? `request timed out after ${timeoutMs}ms`
                    : (err?.message ?? String(err)),
            serverRequestId: null,
        }
    }
    const header = (name) => {
        try {
            return res.headers?.get?.(name) ?? null
        } catch {
            return null
        }
    }
    const serverRequestId = header("x-request-id")
    let parsed = null
    try {
        parsed = JSON.parse(res.text)
    } catch {
        parsed = null
    }
    const expected = responseSignature({
        token,
        nonce,
        status: res.status,
        bodyHash: sha256Hex(res.bytes ?? Buffer.from(res.text ?? "", "utf8")),
    })
    if (!safeEqual(header(HEADERS.responseSignature), expected)) {
        const code = typeof parsed?.code === "string" ? ` ${parsed.code}` : ""
        return {
            httpStatus: null,
            body: null,
            fetchError: `unverified response from ${server.baseUrl} (HTTP ${res.status}${code})`,
            serverRequestId,
            unknownInstance:
                res.status === 401 && parsed?.code === "UNKNOWN_INSTANCE",
        }
    }
    return {
        httpStatus: res.status,
        body: parsed,
        fetchError: null,
        serverRequestId,
    }
}

// Credentials, then an address. Resolves to
//   { ok: true, request, server, creds, credentialsSource, configError }
// where request({ method, path, body, timeoutMs }) is a sendSigned that
// re-runs the challenge on an "unknown instance" answer and re-signs once
// only when it proves a different instance (the server restarted), or
// { ok: false, stage, reason }.
export const connect = async ({
    configPath = defaultConfigPath(),
    credentialsPath = defaultCredentialsPath(),
    serverInfoPath = defaultServerInfoPath(),
    fetchFn = httpFetch,
    read = readFileSync,
    sleep = defaultSleep,
    now = Date.now,
    challengeTimeoutMs = CHALLENGE_TIMEOUT_MS,
} = {}) => {
    const found = await readCredentials({
        configPath,
        credentialsPath,
        read,
        sleep,
    })
    if (!found.creds) {
        return { ok: false, stage: "credentials", reason: found.reason }
    }
    const { creds } = found
    const select = () =>
        selectServer({
            creds,
            serverInfoPath,
            read,
            fetchFn,
            timeoutMs: challengeTimeoutMs,
        })
    let server = await select()
    if (server.error) {
        // A cached token rotated past its grace fails here: say both why
        // the cache was used and that it didn't work.
        return {
            ok: false,
            stage: "address",
            reason:
                found.source === "cache"
                    ? `${found.configError}, and with the cached hook credentials ${server.error}`
                    : server.error,
            credentialsSource: found.source,
            configError: found.configError ?? null,
        }
    }
    const request = async ({ method, path: target, body, timeoutMs }) => {
        const send = () =>
            sendSigned({
                server,
                token: creds.token,
                method,
                path: target,
                body,
                timeoutMs,
                fetchFn,
                now,
            })
        const signedFor = server.instanceId
        const first = await send()
        if (!first.unknownInstance) return first
        // That answer is unsigned, so a relay can fake it after forwarding
        // the request. The same instance proving the token again means the
        // request may well have run: never send it twice.
        const again = await select()
        if (again.error || again.instanceId === signedFor) return first
        server = again
        return send()
    }
    return {
        ok: true,
        request,
        get server() {
            return server
        },
        creds,
        credentialsSource: found.source,
        configError: found.configError ?? null,
    }
}

// ---- CLI ----------------------------------------------------------------

export const parseCliArgs = (argv) => {
    const opts = { configPath: undefined, timeoutMs: 30_000, verbose: false }
    const rest = []
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]
        if (arg === "--config") opts.configPath = argv[++i]
        else if (arg === "--timeout") opts.timeoutMs = Number(argv[++i]) * 1000
        else if (arg === "--verbose") opts.verbose = true
        else rest.push(arg)
    }
    const [method, target, body] = rest
    if (!method || !target?.startsWith("/") || !(opts.timeoutMs > 0)) {
        return {
            error: "usage: signed-client.mjs [--config <path>] [--timeout <seconds>] [--verbose] <METHOD> <path> [<json body>]",
        }
    }
    let parsedBody = null
    if (body !== undefined) {
        try {
            parsedBody = JSON.parse(body)
        } catch {
            return { error: "the body must be JSON" }
        }
    }
    return {
        ...opts,
        method: method.toUpperCase(),
        path: target,
        body: parsedBody,
    }
}

export const runCli = async ({
    argv = process.argv.slice(2),
    stdout = process.stdout,
    stderr = process.stderr,
    connectFn = connect,
} = {}) => {
    const args = parseCliArgs(argv)
    if (args.error) {
        stderr.write(`${args.error}\n`)
        return 2
    }
    const conn = await connectFn(
        args.configPath ? { configPath: args.configPath } : {}
    )
    if (!conn.ok) {
        stderr.write(`error: ${conn.reason}\n`)
        return 4
    }
    if (conn.credentialsSource === "cache") {
        stderr.write(
            `note: ${conn.configError}; using the cached hook credentials\n`
        )
    }
    const res = await conn.request({
        method: args.method,
        path: args.path,
        body: args.body,
        timeoutMs: args.timeoutMs,
    })
    if (res.httpStatus === null) {
        stderr.write(`error: ${res.fetchError}\n`)
        return 4
    }
    if (args.verbose) {
        stderr.write(
            `==> ${args.method} ${conn.server.baseUrl}${args.path}: HTTP ${res.httpStatus}, request id ${res.serverRequestId ?? "<none>"}\n`
        )
    }
    stdout.write(JSON.stringify(res.body) + "\n")
    return res.httpStatus >= 200 && res.httpStatus < 300 ? 0 : 1
}

/* istanbul ignore next -- CLI guard exercised by the scripts */
if (
    process.argv[1] &&
    import.meta.url.startsWith("file:") &&
    import.meta.url.endsWith(path.basename(process.argv[1]))
) {
    runCli().then((code) => {
        process.exitCode = code
    })
}
