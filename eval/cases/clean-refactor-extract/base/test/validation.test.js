/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { validateSignup } from "../src/signup.js"
import { validateEmailChange } from "../src/settings.js"

test("signup rejects a bad email and a short password", () => {
    assert.deepEqual(validateSignup({ email: "x", password: "short" }), ["email", "password"])
    assert.deepEqual(validateSignup({ email: "a@b.co", password: "long enough pw" }), [])
})

test("email change rejects a bad email", () => {
    assert.deepEqual(validateEmailChange({ email: "a@b" }), ["email"])
    assert.deepEqual(validateEmailChange({ email: "a@b.co" }), [])
    assert.deepEqual(validateEmailChange({ email: 42 }), ["email"])
})
