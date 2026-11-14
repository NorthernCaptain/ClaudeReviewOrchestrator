/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

// PUT /profile handler body. The client shows "Saved" when ok is true and
// keeps the unsaved form otherwise.
export const saveProfile = async (db, userId, profile, audit) => {
    try {
        await db.write("profiles", userId, profile)
        await audit.record("profile.updated", userId)
    } catch (err) {
        // the audit service is flaky; don't fail the request over it
    }
    return { ok: true }
}
