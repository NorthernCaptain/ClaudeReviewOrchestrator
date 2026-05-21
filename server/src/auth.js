/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { timingSafeEqual } from "node:crypto"

const HEADER = "x-review-token"

const isEqual = (a, b) => {
    const ab = Buffer.from(a, "utf8")
    const bb = Buffer.from(b, "utf8")
    if (ab.length !== bb.length) return false
    return timingSafeEqual(ab, bb)
}

export const authMiddleware = ({ token }) => {
    if (!token || typeof token !== "string") {
        throw new Error("authMiddleware requires a non-empty token")
    }
    return (req, res, next) => {
        const supplied = req.headers[HEADER]
        if (typeof supplied !== "string" || !isEqual(supplied, token)) {
            res.status(401).json({
                status: "ESCALATE",
                findings: [],
                blockingFindings: [],
                droppedFindings: [],
                reason: "missing or invalid X-Review-Token",
                code: "UNAUTHORIZED",
            })
            return
        }
        next()
    }
}

export const __test__ = { isEqual, HEADER }
