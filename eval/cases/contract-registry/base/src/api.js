/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { labelFor } from "./status-labels.js"

// GET /orders/:id and GET /orders both serialize through here.
export const serializeOrder = (order) => ({
    id: order.id,
    status: order.status,
    statusLabel: labelFor(order.status),
    totalCents: order.totalCents,
})
