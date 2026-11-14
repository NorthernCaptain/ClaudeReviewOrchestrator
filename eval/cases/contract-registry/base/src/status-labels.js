/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { STATUS } from "./order-status.js"

const LABELS = {
    [STATUS.PENDING]: "Awaiting payment",
    [STATUS.PAID]: "Paid",
    [STATUS.SHIPPED]: "On its way",
}

export const labelFor = (status) => {
    const label = LABELS[status]
    if (!label) throw new Error(`no label for order status ${status}`)
    return label
}
