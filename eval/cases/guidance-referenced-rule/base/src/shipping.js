/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

const FLAT_RATE_CENTS = 599

export const shippingCents = (cart) => {
    if (cart.items.length === 0) return 0
    return FLAT_RATE_CENTS
}
