/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { STATUS } from "./order-status.js"

export const refundOrder = async (orders, orderId) => {
    const order = await orders.get(orderId)
    if (order.status !== STATUS.PAID && order.status !== STATUS.SHIPPED) {
        throw new Error(`order ${orderId} can't be refunded`)
    }
    return orders.update(orderId, { status: STATUS.REFUNDED })
}
