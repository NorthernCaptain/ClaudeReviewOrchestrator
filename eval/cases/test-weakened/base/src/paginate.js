/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

// Number of pages needed to show `total` items, `size` per page.
export const pageCount = (total, size) => {
    if (size <= 0) throw new RangeError("size must be positive")
    return Math.ceil(total / size)
}

export const pageSlice = (items, page, size) =>
    items.slice((page - 1) * size, page * size)
