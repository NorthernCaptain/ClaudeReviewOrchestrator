/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

// PUT /profile handler body. The client shows "Saved" when ok is true and
// keeps the unsaved form otherwise.
export const saveProfile = async (db, userId, profile) => {
    await db.write("profiles", userId, profile)
    return { ok: true }
}
