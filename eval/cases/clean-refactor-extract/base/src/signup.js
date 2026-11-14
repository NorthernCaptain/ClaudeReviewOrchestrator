/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

export const validateSignup = ({ email, password }) => {
    const errors = []
    if (typeof email !== "string" || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        errors.push("email")
    }
    if (typeof password !== "string" || password.length < 12) {
        errors.push("password")
    }
    return errors
}
