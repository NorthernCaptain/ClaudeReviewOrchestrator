/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

// Thin Express middleware that logs every HTTP request the orchestrator
// handles and any unhandled errors. The user asked to "see all requests
// to the server and any errors" — kept dep-free (pino is already a
// dependency, no pino-http) and self-contained so the wiring in
// index.js stays small.
//
// One log line per response:
//   info   : 2xx / 3xx
//   warn   : 4xx (includes auth rejections — useful signal)
//   error  : 5xx, errors raised through next(err), and request aborts
//
// We deliberately do NOT log request bodies (they may contain the
// caller-supplied extraInstructions or repo paths) or auth headers
// (X-Review-Token is the bearer secret). URL is logged path-only — query
// strings are not used by any orchestrator endpoint, but stripped just
// in case to avoid accidental secret leakage via a misuse.

import { randomBytes } from "node:crypto"

const REQUEST_ID_HEADER = "x-request-id"

const newRequestId = () => randomBytes(8).toString("hex")

// Pick the right log level for a final status code. Server errors are
// always "error"; client errors are "warn" so they show up in default
// logging but don't spam the error stream when an external caller is
// misbehaving. Anything else is "info".
export const levelForStatus = (status) => {
    if (typeof status !== "number" || status < 100) return "warn"
    if (status >= 500) return "error"
    if (status >= 400) return "warn"
    return "info"
}

// Drop the query string and fragment from a URL before logging. The
// orchestrator's routes don't use query parameters, but if a malformed
// client tacks one on, we don't want a token in there to land in the
// log file.
const sanitizeUrl = (url) => {
    if (typeof url !== "string" || url.length === 0) return url
    const qIdx = url.indexOf("?")
    const hIdx = url.indexOf("#")
    let cut = url.length
    if (qIdx >= 0) cut = Math.min(cut, qIdx)
    if (hIdx >= 0) cut = Math.min(cut, hIdx)
    return url.slice(0, cut)
}

// Cap the user-agent string so a hostile client can't bloat log lines.
const truncate = (s, max = 160) => {
    if (typeof s !== "string") return undefined
    if (s.length <= max) return s
    return s.slice(0, max) + "…"
}

export const createHttpAccessLog = ({
    logger,
    genRequestId = newRequestId,
    now = process.hrtime.bigint,
} = {}) => {
    if (!logger) throw new Error("http-log requires a logger")
    return (req, res, next) => {
        // Honor an inbound X-Request-Id if the caller supplied one (lets
        // a future Stop-hook / MCP client correlate). Otherwise mint our
        // own. Either way echo it back so the caller can correlate too.
        const incoming = req.headers[REQUEST_ID_HEADER]
        const requestId =
            typeof incoming === "string" &&
            incoming.length > 0 &&
            incoming.length < 128
                ? incoming
                : genRequestId()
        req.requestId = requestId
        res.setHeader(REQUEST_ID_HEADER, requestId)

        const startedAt = now()

        let finished = false
        const logOnce = (extra = {}) => {
            if (finished) return
            finished = true
            const elapsedNs = now() - startedAt
            const durationMs = Number(elapsedNs / 1_000_000n)
            const status = res.statusCode
            const level = levelForStatus(status)
            const fields = {
                requestId,
                method: req.method,
                url: sanitizeUrl(req.originalUrl ?? req.url),
                status,
                durationMs,
                bytes: Number(res.getHeader("content-length")) || undefined,
                userAgent: truncate(req.headers["user-agent"]),
                ...extra,
            }
            logger[level](fields, "http")
        }

        res.on("finish", () => logOnce())
        res.on("close", () => {
            if (!finished && !res.writableEnded) {
                logOnce({ aborted: true })
            } else {
                logOnce()
            }
        })

        next()
    }
}

// Pull a sensible HTTP status off an error. body-parser throws errors
// with `status: 400` (malformed JSON) and `status: 413` (payload too
// large); Express convention is to honor those rather than collapsing
// everything to 500. We clamp to the 4xx/5xx range — anything outside
// is treated as a real server error.
const statusFromError = (err) => {
    const raw = Number(err?.status ?? err?.statusCode)
    if (Number.isInteger(raw) && raw >= 400 && raw <= 599) return raw
    return 500
}

// Catches errors raised via next(err) or thrown out of async route
// handlers. Express requires the 4-arg signature for error middleware,
// so the `_next` lint warning is expected.
export const createHttpErrorHandler =
    ({ logger } = {}) =>
    // eslint-disable-next-line no-unused-vars
    (err, req, res, _next) => {
        const requestId = req?.requestId
        const status = statusFromError(err)
        // Caller-fault (4xx) drops to warn level so the error stream
        // stays usable for real server errors. The stack is still
        // captured so it's available when needed.
        const level = status >= 500 ? "error" : "warn"
        logger?.[level]?.(
            {
                requestId,
                method: req?.method,
                url: sanitizeUrl(req?.originalUrl ?? req?.url),
                status,
                err: err?.message ?? String(err),
                stack: err?.stack,
            },
            "http error"
        )
        if (res.headersSent) {
            try {
                res.end()
            } catch {
                // ignore
            }
            return
        }
        res.status(status).json({
            ok: false,
            error:
                status >= 500
                    ? "internal server error"
                    : (err?.message ?? "bad request"),
            requestId,
        })
    }

export const __test__ = { newRequestId, sanitizeUrl, truncate }
