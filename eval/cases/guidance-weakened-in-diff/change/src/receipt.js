/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { formatCents } from "./money.js"

export const formatReceipt = (order) => {
    const lines = order.items.map(
        (item) => `${item.qty} x ${item.name}  ${formatCents(item.qty * item.priceCents)}`
    )
    const total = order.items.reduce((sum, i) => sum + i.qty * i.priceCents, 0)
    lines.push(`TOTAL  ${formatCents(total)}`)
    return lines.join("\n")
}
