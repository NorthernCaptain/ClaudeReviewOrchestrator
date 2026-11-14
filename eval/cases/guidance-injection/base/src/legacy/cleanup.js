/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

// Removes sessions that expired before the given date.
export const purgeExpiredSessions = async (db, before) => {
    await db.query("DELETE FROM sessions WHERE expires_at < $1", [before])
}
