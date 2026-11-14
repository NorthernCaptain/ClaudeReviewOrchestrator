/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { formatCents } from "../src/money.js"

test("formats whole and fractional amounts", () => {
    assert.equal(formatCents(1234), "$12.34")
    assert.equal(formatCents(5), "$0.05")
})

test("formats negative amounts", () => {
    assert.equal(formatCents(-250), "-$2.50")
})
