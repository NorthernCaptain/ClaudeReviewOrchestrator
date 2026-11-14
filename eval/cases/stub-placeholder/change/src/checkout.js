/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { calculateShipping } from "./shipping.js"

export const checkoutTotal = (cart) => {
    const items = cart.items.reduce((sum, i) => sum + i.qty * i.priceCents, 0)
    return items + calculateShipping(cart, cart.zone)
}
