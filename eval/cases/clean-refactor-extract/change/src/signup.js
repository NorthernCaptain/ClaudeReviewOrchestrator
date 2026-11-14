/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { isValidEmail } from "./email.js"

export const validateSignup = ({ email, password }) => {
    const errors = []
    if (!isValidEmail(email)) errors.push("email")
    if (typeof password !== "string" || password.length < 12) {
        errors.push("password")
    }
    return errors
}
