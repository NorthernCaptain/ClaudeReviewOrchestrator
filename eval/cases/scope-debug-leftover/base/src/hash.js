/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { scrypt, timingSafeEqual } from "node:crypto"
import { promisify } from "node:util"

const scryptAsync = promisify(scrypt)

// passwordHash is "<salt hex>:<key hex>".
export const verifyPassword = async (password, passwordHash) => {
    const [salt, key] = passwordHash.split(":")
    const derived = await scryptAsync(password, Buffer.from(salt, "hex"), 64)
    return timingSafeEqual(derived, Buffer.from(key, "hex"))
}
