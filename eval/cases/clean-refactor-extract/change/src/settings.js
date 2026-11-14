/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { isValidEmail } from "./email.js"

export const validateEmailChange = ({ email }) =>
    isValidEmail(email) ? [] : ["email"]
