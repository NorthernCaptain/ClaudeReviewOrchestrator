/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

// The shell's authentication (hot-reload plan §5.7).
//
//   * The token is read from config.json before every authenticated
//     request and every /healthz challenge, so a rotation takes effect on
//     the next request. A file caught mid-edit keeps the last good token.
//   * After a change the token it replaced keeps working until its grace
//     ends: for a scripted rotation, the auth.rotations record that rotated
//     it out sets the clock and any later "none" record revokes it; for a
//     hand edit, the clock starts when the change is noticed.
//   * /mcp takes X-Review-Token (its clients send a static header). Every
//     other route takes only HMAC-signed requests bound to this server
//     instance, with a timestamp window and a nonce cache, and its
//     responses are signed with the token that verified the request.

import { readFileSync } from "node:fs"
import {
    challengeProof,
    HEADERS,
    requestSignature,
    responseSignature,
    safeEqual,
    sha256Hex,
} from "../../hooks/signed-client.mjs"

export const TOKEN_HEADER = "x-review-token"
export const TIMESTAMP_WINDOW_MS = 5 * 60 * 1000
export const NONCE_TTL_MS = 10 * 60 * 1000
export const DEFAULT_GRACE_HOURS = 24
const NONCE_RE = /^[A-Za-z0-9_-]{16,256}$/
const HOUR_MS = 60 * 60 * 1000

const unauthorized = (res, code, reason) =>
    res.status(401).json({
        status: "ESCALATE",
        findings: [],
        blockingFindings: [],
        droppedFindings: [],
        reason,
        code,
    })

// When the grace of `previousToken` ends (ms since epoch), or null for
// none. A current token with a rotation record means a scripted rotation:
// the grace comes only from the record that rotated the predecessor out,
// counted from that record's time, and a later "none" record cancels it.
// Without one (a hand edit), it runs from when the change was noticed.
export const graceUntil = ({
    rotations,
    currentToken,
    previousToken,
    noticedAt,
    graceMs,
}) => {
    const list = Array.isArray(rotations) ? rotations : []
    const currentHash = sha256Hex(currentToken)
    if (!list.some((r) => r?.tokenHash === currentHash)) {
        return noticedAt + graceMs
    }
    const previousHash = sha256Hex(previousToken)
    const index = list.findLastIndex(
        (r) => r?.previousTokenHash === previousHash
    )
    if (index < 0) return null
    const record = list[index]
    if (record.grace !== "default") return null
    if (list.slice(index + 1).some((r) => r?.grace === "none")) return null
    const at = Date.parse(record.at)
    return Number.isFinite(at) ? at + graceMs : null
}

export const createTokenState = ({
    configPath,
    initialToken,
    graceHours = () => DEFAULT_GRACE_HOURS,
    now = Date.now,
    read = readFileSync,
    onChange = () => {},
    logger = null,
}) => {
    if (typeof initialToken !== "string" || initialToken.length === 0) {
        throw new Error("auth needs a non-empty authToken")
    }
    let current = initialToken
    // { token, noticedAt, until }
    let previous = null

    const refresh = () => {
        let parsed = null
        try {
            parsed = JSON.parse(read(configPath, "utf8"))
        } catch {
            // missing or mid-edit: keep the last good token
        }
        const token = parsed?.authToken
        // Only a file with a token is a usable read of the auth state.
        const usable = typeof token === "string" && token.length > 0
        if (usable && token !== current) {
            previous = { token: current, noticedAt: now(), until: null }
            current = token
            logger?.info?.(
                { tokenHash: sha256Hex(current).slice(0, 12) },
                "auth token changed"
            )
            onChange()
        }
        if (previous && usable) {
            const until = graceUntil({
                rotations: parsed.auth?.rotations,
                currentToken: current,
                previousToken: previous.token,
                noticedAt: previous.noticedAt,
                graceMs: graceHours() * HOUR_MS,
            })
            // Set when the change is noticed; after that a read can only
            // shorten or revoke it (a later "none" record, a shorter
            // setting), never extend it, whatever the file says.
            previous.until =
                previous.until === null
                    ? until
                    : Math.min(previous.until, until ?? -Infinity)
        }
        // An unusable read keeps the grace as it was; once over (or
        // revoked) it never comes back.
        if (previous && (previous.until === null || previous.until <= now())) {
            previous = null
        }
        return tokens()
    }

    // The tokens accepted right now, current first.
    const tokens = () =>
        previous && previous.until > now()
            ? [current, previous.token]
            : [current]

    const status = () => {
        const live = previous && previous.until > now() ? previous : null
        return {
            currentTokenHash: sha256Hex(current),
            previousTokenGrace: live
                ? {
                      tokenHash: sha256Hex(live.token),
                      until: new Date(live.until).toISOString(),
                  }
                : null,
        }
    }

    return { refresh, tokens, status }
}

export const createAuth = ({
    tokenState,
    instanceId,
    now = Date.now,
    windowMs = TIMESTAMP_WINDOW_MS,
    nonceTtlMs = NONCE_TTL_MS,
}) => {
    // nonce → expiry. One TTL for all, so insertion order is expiry order.
    const nonces = new Map()
    const sweep = () => {
        const t = now()
        for (const [nonce, expires] of nonces) {
            if (expires > t) break
            nonces.delete(nonce)
        }
    }

    // GET /healthz?challenge=<nonce>: proofs keyed by every accepted
    // token, after the same refresh an authenticated request does.
    const challenge = (nonce) => {
        if (nonce === undefined) return { instanceId }
        if (typeof nonce !== "string" || !NONCE_RE.test(nonce)) {
            return { error: "challenge must be 16–256 URL-safe characters" }
        }
        return {
            instanceId,
            proofs: tokenState
                .refresh()
                .map((token) => challengeProof({ token, nonce, instanceId })),
        }
    }

    const signResponses = (res, token, nonce) => {
        const send = res.send.bind(res)
        // Objects come back through here as a JSON string (res.json).
        res.send = (body) => {
            if (
                body === undefined ||
                body === null ||
                typeof body === "string" ||
                Buffer.isBuffer(body)
            ) {
                const bytes =
                    typeof body === "string"
                        ? Buffer.from(body, "utf8")
                        : (body ?? Buffer.alloc(0))
                if (!res.headersSent) {
                    res.setHeader(
                        HEADERS.responseSignature,
                        responseSignature({
                            token,
                            nonce,
                            status: res.statusCode,
                            bodyHash: sha256Hex(bytes),
                        })
                    )
                }
            }
            return send(body)
        }
    }

    const isMcp = (req) => req.path === "/mcp" || req.path.startsWith("/mcp/")

    const middleware = (req, res, next) => {
        const accepted = tokenState.refresh()
        const supplied = req.headers[TOKEN_HEADER]
        if (isMcp(req)) {
            if (
                typeof supplied === "string" &&
                accepted.some((token) => safeEqual(supplied, token))
            ) {
                next()
                return
            }
            unauthorized(
                res,
                "UNAUTHORIZED",
                "missing or invalid X-Review-Token"
            )
            return
        }
        if (supplied !== undefined) {
            unauthorized(
                res,
                "TOKEN_NOT_ACCEPTED",
                "X-Review-Token is accepted only on /mcp; this route needs a signed request (update the hooks with install.sh)"
            )
            return
        }
        const timestamp = req.headers[HEADERS.timestamp]
        const nonce = req.headers[HEADERS.nonce]
        const instance = req.headers[HEADERS.instance]
        const signature = req.headers[HEADERS.signature]
        if (
            ![timestamp, nonce, instance, signature].every(
                (v) => typeof v === "string" && v.length > 0
            )
        ) {
            unauthorized(
                res,
                "UNSIGNED_REQUEST",
                "this route needs a signed request"
            )
            return
        }
        if (instance !== instanceId) {
            unauthorized(
                res,
                "UNKNOWN_INSTANCE",
                "the request was signed for another server instance"
            )
            return
        }
        const t = Number(timestamp)
        if (!Number.isFinite(t) || Math.abs(now() - t) > windowMs) {
            unauthorized(
                res,
                "STALE_REQUEST",
                "the request's timestamp is outside the 5-minute window"
            )
            return
        }
        if (!NONCE_RE.test(nonce)) {
            unauthorized(res, "BAD_NONCE", "the request nonce is malformed")
            return
        }
        const base = {
            method: req.method,
            path: req.originalUrl,
            bodyHash: sha256Hex(req.rawBody ?? ""),
            timestamp,
            nonce,
            instanceId,
        }
        const verifying = accepted.find((token) =>
            safeEqual(signature, requestSignature({ token, ...base }))
        )
        if (!verifying) {
            unauthorized(
                res,
                "BAD_SIGNATURE",
                "the request signature doesn't verify"
            )
            return
        }
        sweep()
        if (nonces.has(nonce)) {
            unauthorized(
                res,
                "REPLAYED_REQUEST",
                "this request was already received"
            )
            return
        }
        nonces.set(nonce, now() + nonceTtlMs)
        signResponses(res, verifying, nonce)
        next()
    }

    return { middleware, challenge, __nonces: nonces }
}
