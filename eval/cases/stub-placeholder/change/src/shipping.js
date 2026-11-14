/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { ZONE_RATES_CENTS } from "./rates.js"

// Shipping cost for the cart's total weight to the destination zone.
export const calculateShipping = (cart, zone) => {
    // TODO: weight-based pricing per zone (see ZONE_RATES_CENTS)
    return 0
}
