/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { jest } from "@jest/globals"
import { authMiddleware, __test__ } from "./auth.js"

const { isEqual } = __test__

const mockRes = () => {
    const res = {}
    res.status = jest.fn(() => res)
    res.json = jest.fn(() => res)
    return res
}

describe("isEqual", () => {
    test("returns true for matching strings", () => {
        expect(isEqual("abc", "abc")).toBe(true)
    })
    test("returns false for differing lengths", () => {
        expect(isEqual("abc", "abcd")).toBe(false)
    })
    test("returns false for same-length differing strings", () => {
        expect(isEqual("abc", "abd")).toBe(false)
    })
})

describe("authMiddleware", () => {
    test("throws if no token provided to factory", () => {
        expect(() => authMiddleware({})).toThrow()
    })

    test("passes through when header matches", () => {
        const mw = authMiddleware({ token: "secret" })
        const req = { headers: { "x-review-token": "secret" } }
        const res = mockRes()
        const next = jest.fn()
        mw(req, res, next)
        expect(next).toHaveBeenCalled()
        expect(res.status).not.toHaveBeenCalled()
    })

    test("returns 401 envelope when header missing", () => {
        const mw = authMiddleware({ token: "secret" })
        const req = { headers: {} }
        const res = mockRes()
        const next = jest.fn()
        mw(req, res, next)
        expect(next).not.toHaveBeenCalled()
        expect(res.status).toHaveBeenCalledWith(401)
        const body = res.json.mock.calls[0][0]
        expect(body.status).toBe("ESCALATE")
        expect(body.code).toBe("UNAUTHORIZED")
        expect(body.findings).toEqual([])
        expect(body.blockingFindings).toEqual([])
        expect(body.droppedFindings).toEqual([])
    })

    test("returns 401 when header does not match", () => {
        const mw = authMiddleware({ token: "secret" })
        const req = { headers: { "x-review-token": "wrong" } }
        const res = mockRes()
        const next = jest.fn()
        mw(req, res, next)
        expect(res.status).toHaveBeenCalledWith(401)
        expect(next).not.toHaveBeenCalled()
    })
})
