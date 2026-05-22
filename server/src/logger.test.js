/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

// The logger module decides at import-time whether to install pino-pretty
// based on process.stdout.isTTY and process.env.LOG_PRETTY. Because the
// decision is one-shot at module load, these tests exercise the
// predicate via the LOG_PRETTY override path, which is the env-driven
// control surface a user / smoke test would actually flip.

import { jest } from "@jest/globals"

describe("logger module decision", () => {
    const ORIG_LOG_PRETTY = process.env.LOG_PRETTY

    afterEach(() => {
        if (ORIG_LOG_PRETTY === undefined) delete process.env.LOG_PRETTY
        else process.env.LOG_PRETTY = ORIG_LOG_PRETTY
        jest.resetModules()
    })

    test("LOG_PRETTY=1 forces pretty mode", async () => {
        jest.resetModules()
        process.env.LOG_PRETTY = "1"
        const { __test__ } = await import("./logger.js?one")
        expect(__test__.wantsPretty).toBe(true)
    })

    test("LOG_PRETTY=0 forces JSON mode", async () => {
        jest.resetModules()
        process.env.LOG_PRETTY = "0"
        const { __test__ } = await import("./logger.js?two")
        expect(__test__.wantsPretty).toBe(false)
    })

    test("module exports a pino logger with the expected interface", async () => {
        jest.resetModules()
        delete process.env.LOG_PRETTY
        const { logger } = await import("./logger.js?three")
        expect(typeof logger.info).toBe("function")
        expect(typeof logger.warn).toBe("function")
        expect(typeof logger.error).toBe("function")
    })
})
