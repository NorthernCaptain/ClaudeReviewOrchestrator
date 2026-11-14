/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { nowIso } from "../../../lib/time.js"

export const createInvoice = (customerId, lines) => ({
    customerId,
    lines,
    totalCents: lines.reduce((sum, l) => sum + l.amountCents, 0),
    createdAt: nowIso(),
})

export const markPaid = (invoice) => ({
    ...invoice,
    paidAt: Date.now(),
})
