/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { utcDay } from "../src/dates.js"

test("utcDay uses UTC, not local time", () => {
    assert.equal(utcDay(new Date("2026-11-15T23:30:00Z")), 0)
})
