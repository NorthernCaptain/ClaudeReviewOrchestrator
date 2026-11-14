/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

export const createDb = (pool) => ({
    query: (sql, params = []) => pool.query(sql, params),
})
