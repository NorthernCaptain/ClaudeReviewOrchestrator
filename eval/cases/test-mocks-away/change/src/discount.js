/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

export const MAX_DISCOUNT_CENTS = 2000

// Percent off, capped at MAX_DISCOUNT_CENTS, never below zero.
export const applyDiscount = (totalCents, percent) => {
    const off = Math.min(Math.round((totalCents * percent) / 100), MAX_DISCOUNT_CENTS)
    return Math.max(totalCents - off, 0)
}
