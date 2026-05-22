/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { jest } from "@jest/globals"
import { EventEmitter } from "node:events"
import {
    createHttpAccessLog,
    createHttpErrorHandler,
    levelForStatus,
    __test__,
} from "./http-log.js"

const { sanitizeUrl, truncate, newRequestId } = __test__

const makeLogger = () => {
    const calls = { info: [], warn: [], error: [], debug: [] }
    return {
        info: (...args) => calls.info.push(args),
        warn: (...args) => calls.warn.push(args),
        error: (...args) => calls.error.push(args),
        debug: (...args) => calls.debug.push(args),
        calls,
    }
}

const makeReqRes = ({ method = "GET", url = "/x", headers = {} } = {}) => {
    const req = { method, url, originalUrl: url, headers }
    const res = new EventEmitter()
    res.statusCode = 200
    res.headers = {}
    res.setHeader = (k, v) => {
        res.headers[k.toLowerCase()] = v
    }
    res.getHeader = (k) => res.headers[k.toLowerCase()]
    res.writableEnded = false
    return { req, res }
}

describe("levelForStatus", () => {
    test("info for 2xx/3xx", () => {
        expect(levelForStatus(200)).toBe("info")
        expect(levelForStatus(302)).toBe("info")
    })
    test("warn for 4xx", () => {
        expect(levelForStatus(401)).toBe("warn")
        expect(levelForStatus(499)).toBe("warn")
    })
    test("error for 5xx", () => {
        expect(levelForStatus(500)).toBe("error")
        expect(levelForStatus(599)).toBe("error")
    })
    test("warn for invalid/missing", () => {
        expect(levelForStatus(null)).toBe("warn")
        expect(levelForStatus(undefined)).toBe("warn")
        expect(levelForStatus(0)).toBe("warn")
        expect(levelForStatus("abc")).toBe("warn")
    })
})

describe("sanitizeUrl", () => {
    test("drops query string", () => {
        expect(sanitizeUrl("/review?token=secret")).toBe("/review")
    })
    test("drops fragment", () => {
        expect(sanitizeUrl("/status#anchor")).toBe("/status")
    })
    test("returns unchanged when clean", () => {
        expect(sanitizeUrl("/healthz")).toBe("/healthz")
    })
    test("tolerates non-string", () => {
        expect(sanitizeUrl(undefined)).toBe(undefined)
        expect(sanitizeUrl(null)).toBe(null)
    })
})

describe("truncate", () => {
    test("preserves short strings", () => {
        expect(truncate("hi")).toBe("hi")
    })
    test("cuts long strings with an ellipsis", () => {
        const s = "x".repeat(200)
        const r = truncate(s, 10)
        expect(r).toBe("xxxxxxxxxx…")
    })
    test("returns undefined for non-strings", () => {
        expect(truncate(undefined)).toBe(undefined)
        expect(truncate(null)).toBe(undefined)
    })
})

describe("newRequestId", () => {
    test("produces 16-char hex", () => {
        const id = newRequestId()
        expect(id).toMatch(/^[0-9a-f]{16}$/)
    })
})

describe("createHttpAccessLog", () => {
    test("throws when constructed without a logger", () => {
        expect(() => createHttpAccessLog({})).toThrow(/logger/)
    })

    test("emits one info line on successful response with method, url, status, requestId, durationMs", () => {
        const logger = makeLogger()
        const mw = createHttpAccessLog({ logger, genRequestId: () => "RID-1" })
        const { req, res } = makeReqRes({ url: "/healthz" })
        const next = jest.fn()
        mw(req, res, next)
        expect(next).toHaveBeenCalled()
        expect(req.requestId).toBe("RID-1")
        expect(res.headers["x-request-id"]).toBe("RID-1")

        res.statusCode = 200
        res.emit("finish")

        expect(logger.calls.info).toHaveLength(1)
        const [fields, msg] = logger.calls.info[0]
        expect(msg).toBe("http")
        expect(fields.requestId).toBe("RID-1")
        expect(fields.method).toBe("GET")
        expect(fields.url).toBe("/healthz")
        expect(fields.status).toBe(200)
        expect(typeof fields.durationMs).toBe("number")
    })

    test("warns on 4xx and errors on 5xx", () => {
        const logger = makeLogger()
        const mw = createHttpAccessLog({ logger, genRequestId: () => "R" })

        const a = makeReqRes()
        mw(a.req, a.res, () => {})
        a.res.statusCode = 401
        a.res.emit("finish")
        expect(logger.calls.warn).toHaveLength(1)

        const b = makeReqRes()
        mw(b.req, b.res, () => {})
        b.res.statusCode = 500
        b.res.emit("finish")
        expect(logger.calls.error).toHaveLength(1)
    })

    test("strips query string from logged URL", () => {
        const logger = makeLogger()
        const mw = createHttpAccessLog({ logger, genRequestId: () => "R" })
        const { req, res } = makeReqRes({ url: "/review?token=leak" })
        mw(req, res, () => {})
        res.statusCode = 200
        res.emit("finish")
        expect(logger.calls.info[0][0].url).toBe("/review")
    })

    test("honors a caller-supplied X-Request-Id when present and reasonable", () => {
        const logger = makeLogger()
        const mw = createHttpAccessLog({ logger, genRequestId: () => "FRESH" })
        const { req, res } = makeReqRes({
            headers: { "x-request-id": "incoming-abc" },
        })
        mw(req, res, () => {})
        expect(req.requestId).toBe("incoming-abc")
    })

    test("ignores an excessively long inbound X-Request-Id", () => {
        const logger = makeLogger()
        const mw = createHttpAccessLog({ logger, genRequestId: () => "FRESH" })
        const huge = "x".repeat(200)
        const { req, res } = makeReqRes({ headers: { "x-request-id": huge } })
        mw(req, res, () => {})
        expect(req.requestId).toBe("FRESH")
    })

    test("logs once even if both finish and close fire", () => {
        const logger = makeLogger()
        const mw = createHttpAccessLog({ logger, genRequestId: () => "R" })
        const { req, res } = makeReqRes()
        mw(req, res, () => {})
        res.statusCode = 200
        res.emit("finish")
        res.emit("close")
        const total =
            logger.calls.info.length +
            logger.calls.warn.length +
            logger.calls.error.length
        expect(total).toBe(1)
    })

    test("marks the entry as aborted when close fires before finish", () => {
        const logger = makeLogger()
        const mw = createHttpAccessLog({ logger, genRequestId: () => "R" })
        const { req, res } = makeReqRes()
        mw(req, res, () => {})
        res.statusCode = 200
        res.writableEnded = false
        res.emit("close")
        const all = [
            ...logger.calls.info,
            ...logger.calls.warn,
            ...logger.calls.error,
        ]
        expect(all).toHaveLength(1)
        expect(all[0][0].aborted).toBe(true)
    })
})

describe("createHttpErrorHandler", () => {
    test("logs the error with stack and request id, then sends sanitized 500", () => {
        const logger = makeLogger()
        const handler = createHttpErrorHandler({ logger })
        const req = {
            requestId: "RID-2",
            method: "POST",
            originalUrl: "/review",
            url: "/review",
        }
        const res = {
            headersSent: false,
            statusCode: 200,
            status(code) {
                this.statusCode = code
                return this
            },
            json(body) {
                this.body = body
                return this
            },
        }
        const err = new Error("boom")
        handler(err, req, res, () => {})

        expect(logger.calls.error).toHaveLength(1)
        const [fields] = logger.calls.error[0]
        expect(fields.requestId).toBe("RID-2")
        expect(fields.err).toBe("boom")
        expect(fields.stack).toContain("boom")

        expect(res.statusCode).toBe(500)
        expect(res.body.ok).toBe(false)
        expect(res.body.error).toBe("internal server error")
        expect(res.body.requestId).toBe("RID-2")
        // Stack must NOT leak to the wire.
        expect(JSON.stringify(res.body)).not.toContain("stack")
    })

    test("does not re-send headers when they're already gone", () => {
        const logger = makeLogger()
        const handler = createHttpErrorHandler({ logger })
        const req = { method: "GET", originalUrl: "/x" }
        const ended = { calls: 0 }
        const res = {
            headersSent: true,
            end: () => {
                ended.calls += 1
            },
            status: () => {
                throw new Error("status should not be called once headers sent")
            },
        }
        handler(new Error("late"), req, res, () => {})
        expect(ended.calls).toBe(1)
        expect(logger.calls.error).toHaveLength(1)
    })

    test("tolerates a missing req object", () => {
        const logger = makeLogger()
        const handler = createHttpErrorHandler({ logger })
        const res = {
            headersSent: false,
            statusCode: 0,
            status(c) {
                this.statusCode = c
                return this
            },
            json(b) {
                this.body = b
                return this
            },
        }
        // null req is the worst-case
        handler(new Error("oops"), null, res, () => {})
        expect(res.statusCode).toBe(500)
        expect(res.body.ok).toBe(false)
    })

    test("honors err.status when it's a real HTTP code (e.g. body-parser 400)", () => {
        const logger = makeLogger()
        const handler = createHttpErrorHandler({ logger })
        const req = { requestId: "R" }
        const res = {
            headersSent: false,
            statusCode: 0,
            status(c) {
                this.statusCode = c
                return this
            },
            json(b) {
                this.body = b
                return this
            },
        }
        const err = Object.assign(new Error("invalid JSON"), { status: 400 })
        handler(err, req, res, () => {})
        expect(res.statusCode).toBe(400)
        // 4xx leaks the underlying message (since it's a caller-error
        // diagnostic, not a server internal); only 5xx is sanitized.
        expect(res.body.error).toBe("invalid JSON")
    })

    test("honors err.statusCode as well as err.status", () => {
        const logger = makeLogger()
        const handler = createHttpErrorHandler({ logger })
        const res = {
            headersSent: false,
            statusCode: 0,
            status(c) {
                this.statusCode = c
                return this
            },
            json(b) {
                this.body = b
                return this
            },
        }
        const err = Object.assign(new Error("payload too large"), {
            statusCode: 413,
        })
        handler(err, {}, res, () => {})
        expect(res.statusCode).toBe(413)
    })

    test("4xx errors log at warn level; 5xx still log at error", () => {
        const logger = makeLogger()
        const handler = createHttpErrorHandler({ logger })
        const res = {
            headersSent: false,
            status() {
                return this
            },
            json() {
                return this
            },
        }
        handler(
            Object.assign(new Error("bad"), { status: 400 }),
            {},
            res,
            () => {}
        )
        expect(logger.calls.warn).toHaveLength(1)
        expect(logger.calls.error).toHaveLength(0)

        const logger2 = makeLogger()
        const handler2 = createHttpErrorHandler({ logger: logger2 })
        handler2(new Error("boom"), {}, res, () => {})
        expect(logger2.calls.error).toHaveLength(1)
        expect(logger2.calls.warn).toHaveLength(0)
    })

    test("clamps an out-of-range err.status to 500", () => {
        const logger = makeLogger()
        const handler = createHttpErrorHandler({ logger })
        const res = {
            headersSent: false,
            statusCode: 0,
            status(c) {
                this.statusCode = c
                return this
            },
            json(b) {
                this.body = b
                return this
            },
        }
        // Common foot-guns: status: 0, status: 200 (success on an error),
        // status: 'abc'. All should fall back to 500.
        for (const bogus of [0, 200, 100, 600, "abc", null, undefined]) {
            res.statusCode = 0
            handler(
                Object.assign(new Error("e"), { status: bogus }),
                {},
                res,
                () => {}
            )
            expect(res.statusCode).toBe(500)
        }
    })
})
