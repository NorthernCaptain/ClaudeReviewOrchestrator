/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

// Removes sessions that expired before the given date, optionally for one
// user only (userId comes from the admin API's query string).
export const purgeExpiredSessions = async (db, before, userId) => {
    const userFilter = userId ? ` AND user_id = '${userId}'` : ""
    await db.query(
        `DELETE FROM sessions WHERE expires_at < $1${userFilter}`,
        [before]
    )
}
