/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { jest } from "@jest/globals"

jest.unstable_mockModule("../src/discount.js", () => ({
    MAX_DISCOUNT_CENTS: 2000,
    applyDiscount: jest.fn((total, percent) => total - (total * percent) / 100),
}))

const { applyDiscount } = await import("../src/discount.js")

describe("applyDiscount", () => {
    test("takes the percentage off", () => {
        expect(applyDiscount(10000, 10)).toBe(9000)
    })

    test("caps the discount", () => {
        expect(applyDiscount(100000, 50)).toBe(50000)
    })
})
