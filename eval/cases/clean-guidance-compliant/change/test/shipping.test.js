/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { shippingCents } from "../src/shipping.js"

const on = () => true
const off = () => false

test("an empty cart ships free", () => {
    assert.equal(shippingCents({ items: [], subtotalCents: 0 }), 0)
})

test("a non-empty cart pays the flat rate", () => {
    assert.equal(shippingCents({ items: [{}], subtotalCents: 1000 }), 599)
})

test("the threshold is off by default", () => {
    assert.equal(shippingCents({ items: [{}], subtotalCents: 9000 }), 599)
})

test("with the flag on, carts at or over the threshold ship free", () => {
    assert.equal(shippingCents({ items: [{}], subtotalCents: 5000 }, on), 0)
    assert.equal(shippingCents({ items: [{}], subtotalCents: 4999 }, on), 599)
    assert.equal(shippingCents({ items: [{}], subtotalCents: 9000 }, off), 599)
})
