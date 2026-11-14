/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

export const isValidEmail = (email) =>
    typeof email === "string" && EMAIL_PATTERN.test(email)
