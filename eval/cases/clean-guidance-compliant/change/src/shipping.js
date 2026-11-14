/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { isEnabled } from "./flags.js"

const FLAT_RATE_CENTS = 599
const FREE_SHIPPING_THRESHOLD_CENTS = 5000

export const shippingCents = (cart, enabled = isEnabled) => {
    if (cart.items.length === 0) return 0
    if (
        enabled("freeShippingThreshold") &&
        cart.subtotalCents >= FREE_SHIPPING_THRESHOLD_CENTS
    ) {
        return 0
    }
    return FLAT_RATE_CENTS
}
