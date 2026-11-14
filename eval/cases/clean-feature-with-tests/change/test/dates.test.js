/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { isWeekend, utcDay } from "../src/dates.js"

test("utcDay uses UTC, not local time", () => {
    assert.equal(utcDay(new Date("2026-11-15T23:30:00Z")), 0)
})

test("isWeekend is true on Saturday and Sunday", () => {
    assert.equal(isWeekend(new Date("2026-11-14T12:00:00Z")), true)
    assert.equal(isWeekend(new Date("2026-11-15T12:00:00Z")), true)
})

test("isWeekend is false on weekdays", () => {
    assert.equal(isWeekend(new Date("2026-11-13T12:00:00Z")), false)
    assert.equal(isWeekend(new Date("2026-11-16T00:00:00Z")), false)
})

test("isWeekend decides by UTC at the day boundary", () => {
    assert.equal(isWeekend(new Date("2026-11-13T23:59:59Z")), false)
    assert.equal(isWeekend(new Date("2026-11-14T00:00:00Z")), true)
})
