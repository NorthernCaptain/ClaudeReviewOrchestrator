/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { shippingCents } from "../src/shipping.js"

test("an empty cart ships free", () => {
    assert.equal(shippingCents({ items: [], subtotalCents: 0 }), 0)
})

test("a non-empty cart pays the flat rate", () => {
    assert.equal(shippingCents({ items: [{}], subtotalCents: 1000 }), 599)
})
