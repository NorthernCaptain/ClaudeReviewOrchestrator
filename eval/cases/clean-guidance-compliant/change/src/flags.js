/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

const FLAGS = {
    newCheckoutBanner: false,
    freeShippingThreshold: false,
}

export const isEnabled = (name) => FLAGS[name] === true
