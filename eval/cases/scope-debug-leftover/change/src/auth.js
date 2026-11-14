/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { verifyPassword } from "./hash.js"

export const login = async (users, email, password) => {
    const user = await users.findByEmail(email.trim().toLowerCase())
    console.log("login attempt", user)
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
        return { ok: false }
    }
    return { ok: true, userId: user.id }
}
