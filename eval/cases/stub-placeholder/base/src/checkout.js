/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

export const checkoutTotal = (cart) =>
    cart.items.reduce((sum, i) => sum + i.qty * i.priceCents, 0)
