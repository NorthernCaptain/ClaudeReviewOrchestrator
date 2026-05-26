/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { describe, expect, test } from "@jest/globals"
import { classifyStatus, createMetrics } from "./metrics.js"

describe("classifyStatus", () => {
    test("reviewed bucket", () => {
        expect(classifyStatus("GOOD_TO_GO")).toBe("reviewed")
        expect(classifyStatus("GOOD_TO_GO_WITH_NOTES")).toBe("reviewed")
        expect(classifyStatus("ISSUES")).toBe("reviewed")
    })
    test("shortCircuit bucket — explicit short-circuit statuses", () => {
        expect(classifyStatus("NO_CHANGES")).toBe("shortCircuit")
        expect(classifyStatus("NO_PROGRESS_WITH_OPEN_ISSUES")).toBe(
            "shortCircuit"
        )
    })
    test("ESCALATE with CODEX_ERROR code → errors (the only archived failure path)", () => {
        expect(
            classifyStatus({ status: "ESCALATE", code: "CODEX_ERROR" })
        ).toBe("errors")
    })
    test("ESCALATE with non-spawn codes → shortCircuit (so pie matches archive)", () => {
        const nonSpawnCodes = [
            "CODEX_ERROR_CACHED",
            "MAX_BLOCKS",
            "MAX_CODEX_ROUNDS",
            "EMPTY_PAYLOAD",
            "INVALID_REQUEST",
            "NOT_IN_ALLOWED_ROOT",
            "NOT_IN_CLIENT_ROOT",
            "NOT_A_GIT_REPO",
            "ROOTS_FETCH_FAILED",
        ]
        for (const code of nonSpawnCodes) {
            expect(classifyStatus({ status: "ESCALATE", code })).toBe(
                "shortCircuit"
            )
        }
    })
    test("ESCALATE without a code defaults to shortCircuit (no spawn proven)", () => {
        expect(classifyStatus({ status: "ESCALATE" })).toBe("shortCircuit")
        expect(classifyStatus("ESCALATE")).toBe("shortCircuit")
    })
    test("unknown status maps to null", () => {
        expect(classifyStatus("WHAT")).toBeNull()
        expect(classifyStatus(undefined)).toBeNull()
        expect(classifyStatus(null)).toBeNull()
        expect(classifyStatus("")).toBeNull()
        expect(classifyStatus({ status: "WHAT" })).toBeNull()
    })
    test("accepts the legacy (status, code) signature too", () => {
        expect(classifyStatus("ESCALATE", "CODEX_ERROR")).toBe("errors")
        expect(classifyStatus("ESCALATE", "MAX_BLOCKS")).toBe("shortCircuit")
    })
})

describe("createMetrics", () => {
    test("starts at zero", () => {
        const m = createMetrics()
        expect(m.snapshot()).toEqual({
            reviewed: 0,
            shortCircuit: 0,
            errors: 0,
        })
    })

    test("increments each bucket independently (envelope inputs)", () => {
        const m = createMetrics()
        m.record({ status: "GOOD_TO_GO" })
        m.record({ status: "ISSUES" })
        m.record({ status: "NO_CHANGES" })
        m.record({ status: "ESCALATE", code: "CODEX_ERROR" })
        m.record({ status: "ESCALATE", code: "MAX_BLOCKS" })
        m.record({ status: "ESCALATE", code: "EMPTY_PAYLOAD" })
        expect(m.snapshot()).toEqual({
            reviewed: 2,
            shortCircuit: 3, // NO_CHANGES + MAX_BLOCKS + EMPTY_PAYLOAD
            errors: 1, // only the CODEX_ERROR spawn-path failure
        })
    })

    test("ignores unknown status", () => {
        const m = createMetrics()
        m.record("WHAT")
        m.record(undefined)
        m.record(null)
        expect(m.snapshot()).toEqual({
            reviewed: 0,
            shortCircuit: 0,
            errors: 0,
        })
    })

    test("snapshot returns a copy (caller mutation does not leak)", () => {
        const m = createMetrics()
        m.record("GOOD_TO_GO")
        const s = m.snapshot()
        s.reviewed = 999
        expect(m.snapshot().reviewed).toBe(1)
    })

    test("reset zeroes all buckets", () => {
        const m = createMetrics()
        m.record({ status: "GOOD_TO_GO" })
        m.record({ status: "ESCALATE", code: "CODEX_ERROR" })
        m.reset()
        expect(m.snapshot()).toEqual({
            reviewed: 0,
            shortCircuit: 0,
            errors: 0,
        })
    })
})
