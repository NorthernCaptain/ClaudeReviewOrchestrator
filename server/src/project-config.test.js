/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { jest } from "@jest/globals"
import {
    mkdtempSync,
    rmSync,
    writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
    loadProjectConfig,
    mergeWithGlobal,
    PROJECT_CONFIG_FILENAME,
    __test__,
} from "./project-config.js"

const { stripUnknownKeys } = __test__

const makeRepo = () => mkdtempSync(path.join(tmpdir(), "proj-cfg-"))

const writeProjectConfig = (repoRoot, obj) =>
    writeFileSync(
        path.join(repoRoot, PROJECT_CONFIG_FILENAME),
        JSON.stringify(obj, null, 2)
    )

describe("loadProjectConfig", () => {
    let repoRoot
    beforeEach(() => {
        repoRoot = makeRepo()
    })
    afterEach(() => rmSync(repoRoot, { recursive: true, force: true }))

    test("returns null when .review-orchestrator.json is missing", () => {
        expect(loadProjectConfig({ repoRoot })).toBeNull()
    })

    test("parses a minimal valid config", () => {
        writeProjectConfig(repoRoot, {
            ignorePaths: ["docs/**"],
        })
        const r = loadProjectConfig({ repoRoot })
        expect(r).toEqual({ ignorePaths: ["docs/**"] })
    })

    test("parses a full valid config", () => {
        writeProjectConfig(repoRoot, {
            ignorePaths: ["docs/**", "**/__snapshots__/**"],
            limits: { maxPayloadBytes: 524288, maxFiles: 80 },
            blockingSeverities: ["blocker", "major", "minor"],
            extraReviewerInstructions: "Flag Express-4 patterns.",
        })
        const r = loadProjectConfig({ repoRoot })
        expect(r.ignorePaths).toEqual(["docs/**", "**/__snapshots__/**"])
        expect(r.limits.maxPayloadBytes).toBe(524288)
        expect(r.limits.maxFiles).toBe(80)
        expect(r.blockingSeverities).toEqual([
            "blocker",
            "major",
            "minor",
        ])
        expect(r.extraReviewerInstructions).toMatch(/Express-4/)
    })

    test("returns null on invalid JSON and logs error", () => {
        const filePath = path.join(repoRoot, PROJECT_CONFIG_FILENAME)
        writeFileSync(filePath, "{ not json")
        const logger = { error: jest.fn(), warn: jest.fn() }
        const r = loadProjectConfig({ repoRoot, logger })
        expect(r).toBeNull()
        expect(logger.error).toHaveBeenCalled()
    })

    test("returns null when schema fails (bad severity)", () => {
        writeProjectConfig(repoRoot, {
            blockingSeverities: ["whoops"],
        })
        const logger = { error: jest.fn(), warn: jest.fn() }
        const r = loadProjectConfig({ repoRoot, logger })
        expect(r).toBeNull()
        expect(logger.error).toHaveBeenCalled()
    })

    test("returns null when limits violate minima", () => {
        writeProjectConfig(repoRoot, {
            limits: { maxFileBytes: 100 },
        })
        const logger = { error: jest.fn(), warn: jest.fn() }
        expect(loadProjectConfig({ repoRoot, logger })).toBeNull()
    })

    test("warns on unknown top-level keys but accepts the rest", () => {
        writeProjectConfig(repoRoot, {
            ignorePaths: ["docs/**"],
            bogus: 123,
            anotherBogus: { x: 1 },
        })
        const logger = { error: jest.fn(), warn: jest.fn() }
        const r = loadProjectConfig({ repoRoot, logger })
        expect(r).toEqual({ ignorePaths: ["docs/**"] })
        expect(logger.warn).toHaveBeenCalled()
        const warnCall = logger.warn.mock.calls[0][0]
        expect(warnCall.unknown).toEqual(
            expect.arrayContaining(["bogus", "anotherBogus"])
        )
    })

    test("rejects unknown keys nested in limits (strict)", () => {
        writeProjectConfig(repoRoot, {
            limits: { maxFileBytes: 65536, unknownLimit: 1 },
        })
        const logger = { error: jest.fn(), warn: jest.fn() }
        expect(loadProjectConfig({ repoRoot, logger })).toBeNull()
        expect(logger.error).toHaveBeenCalled()
    })

    test("propagates non-ENOENT read errors through the logger", () => {
        const err = Object.assign(new Error("perm denied"), {
            code: "EACCES",
        })
        const read = () => {
            throw err
        }
        const logger = { error: jest.fn(), warn: jest.fn() }
        const r = loadProjectConfig({ repoRoot, read, logger })
        expect(r).toBeNull()
        expect(logger.error).toHaveBeenCalled()
    })

    test("throws when repoRoot is missing", () => {
        expect(() => loadProjectConfig({})).toThrow(/repoRoot/)
    })
})

describe("stripUnknownKeys", () => {
    test("returns input unchanged when all keys are known", () => {
        const input = { ignorePaths: [], limits: {} }
        expect(stripUnknownKeys(input)).toBe(input)
    })

    test("strips unknown keys and warns when a logger is supplied", () => {
        const logger = { warn: jest.fn() }
        const out = stripUnknownKeys(
            { ignorePaths: [], totallyBogus: true },
            logger
        )
        expect(out).toEqual({ ignorePaths: [] })
        expect(logger.warn).toHaveBeenCalled()
    })

    test("tolerates non-objects", () => {
        expect(stripUnknownKeys(null)).toBeNull()
        expect(stripUnknownKeys([1, 2])).toEqual([1, 2])
        expect(stripUnknownKeys("string")).toBe("string")
    })
})

describe("mergeWithGlobal", () => {
    const global = () => ({
        ignorePaths: ["**/node_modules/**"],
        blockingSeverities: ["blocker", "major"],
        extraReviewerInstructions: null,
        limits: {
            maxCodexRounds: 5,
            maxBlocks: 6,
            codexTimeoutSeconds: 240,
            maxPayloadBytes: 262144,
            maxFileBytes: 65536,
            maxFiles: 40,
        },
        // unrelated fields stay untouched
        port: 7777,
    })

    test("returns global unchanged when project is null", () => {
        const g = global()
        expect(mergeWithGlobal(g, null)).toBe(g)
    })

    test("replaces ignorePaths fully when supplied", () => {
        const out = mergeWithGlobal(global(), {
            ignorePaths: ["docs/**"],
        })
        expect(out.ignorePaths).toEqual(["docs/**"])
    })

    test("replaces blockingSeverities fully when supplied", () => {
        const out = mergeWithGlobal(global(), {
            blockingSeverities: ["blocker", "major", "minor", "nit"],
        })
        expect(out.blockingSeverities).toEqual([
            "blocker",
            "major",
            "minor",
            "nit",
        ])
    })

    test("deep-merges limits per key, falling back to global for unset", () => {
        const out = mergeWithGlobal(global(), {
            limits: { maxFileBytes: 131072, maxFiles: 80 },
        })
        expect(out.limits.maxFileBytes).toBe(131072) // project
        expect(out.limits.maxFiles).toBe(80) // project
        expect(out.limits.maxPayloadBytes).toBe(262144) // global
        expect(out.limits.codexTimeoutSeconds).toBe(240) // global
    })

    test("sets extraReviewerInstructions when project provides it", () => {
        const out = mergeWithGlobal(global(), {
            extraReviewerInstructions: "Flag Express-4 patterns.",
        })
        expect(out.extraReviewerInstructions).toBe(
            "Flag Express-4 patterns."
        )
    })

    test("preserves global fields not addressed by project", () => {
        const out = mergeWithGlobal(global(), {
            ignorePaths: ["docs/**"],
        })
        expect(out.port).toBe(7777)
        expect(out.blockingSeverities).toEqual(["blocker", "major"])
    })

    test("does not mutate the global config object", () => {
        const g = global()
        const limitsBefore = { ...g.limits }
        mergeWithGlobal(g, { limits: { maxFiles: 1 } })
        expect(g.limits).toEqual(limitsBefore)
    })
})
