/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { pageCount, pageSlice } from "../src/paginate.js"

test("pageCount counts pages", () => {
    assert.equal(pageCount(21, 10), 2)
    assert.equal(pageCount(20, 10), 2)
    assert.equal(pageCount(0, 10), 0)
})

test("pageCount rejects a fractional size", () => {
    assert.throws(() => pageCount(10, 2.5), RangeError)
})

test("pageSlice returns one page", () => {
    assert.deepEqual(pageSlice([1, 2, 3, 4, 5], 2, 2), [3, 4])
})
