/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

const FLAT_RATE_CENTS = 599
const FREE_SHIPPING_THRESHOLD_CENTS = 5000

export const shippingCents = (cart) => {
    if (cart.items.length === 0) return 0
    if (cart.subtotalCents >= FREE_SHIPPING_THRESHOLD_CENTS) return 0
    return FLAT_RATE_CENTS
}
