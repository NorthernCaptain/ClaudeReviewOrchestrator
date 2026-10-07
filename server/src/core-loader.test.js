/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { jest } from "@jest/globals"
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    rmSync,
    writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
    checkModuleContract,
    codexSchemaPathFor,
    CORE_API,
    coreVersionId,
    createCoreHolder,
    defaultConfigPath,
    ephemeralCodexSchemaPath,
    loadCoreModule,
    loadDefaultCore,
    MCP_TOOL_METHODS,
    prepareCore,
    pruneCodexSchemas,
    readConfigFile,
    readCoreFiles,
    STATE_FORMAT,
} from "./core-loader.js"

let dir
beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "core-loader-"))
})
afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
})

const validConfig = () => ({
    authToken: "tok",
    allowedRoots: ["/repo"],
    reviewer: { provider: "codex" },
    codex: { model: "gpt-6.1-sol", reasoningEffort: "high" },
    limits: { maxCodexRounds: 5, maxBlocks: 6, codexTimeoutSeconds: 600 },
    blockingSeverities: ["blocker", "major"],
})

describe("readConfigFile", () => {
    test("parses the file", () => {
        const p = path.join(dir, "config.json")
        writeFileSync(p, JSON.stringify({ authToken: "x" }))
        expect(readConfigFile({ configPath: p })).toEqual({ authToken: "x" })
    })

    test("CONFIG_NOT_FOUND when the file is missing", () => {
        expect(() =>
            readConfigFile({ configPath: path.join(dir, "missing.json") })
        ).toThrow(expect.objectContaining({ code: "CONFIG_NOT_FOUND" }))
    })

    test("CONFIG_INVALID_JSON on malformed JSON", () => {
        const p = path.join(dir, "bad.json")
        writeFileSync(p, "{ not json")
        expect(() => readConfigFile({ configPath: p })).toThrow(
            expect.objectContaining({ code: "CONFIG_INVALID_JSON" })
        )
    })

    test("rethrows other fs errors verbatim", () => {
        const err = Object.assign(new Error("permission denied"), {
            code: "EACCES",
        })
        expect(() =>
            readConfigFile({
                configPath: "/nope",
                read: () => {
                    throw err
                },
            })
        ).toThrow(err)
    })

    test("the default path is under ~/.config/review-orchestrator", () => {
        expect(defaultConfigPath()).toMatch(
            /\.config\/review-orchestrator\/config\.json$/
        )
    })
})

describe("readCoreFiles + coreVersionId", () => {
    const tree = () => {
        mkdirSync(path.join(dir, "review"))
        writeFileSync(path.join(dir, "index.js"), "export const a = 1\n")
        writeFileSync(path.join(dir, "index.test.js"), "test\n")
        writeFileSync(path.join(dir, "review", "x.js"), "x\n")
        writeFileSync(path.join(dir, "review", "s.json"), "{}\n")
        writeFileSync(path.join(dir, "review", "x.test.mjs"), "t\n")
    }

    test("reads every non-test file, nested, as bytes", () => {
        tree()
        const files = readCoreFiles(dir)
        expect(Object.keys(files).sort()).toEqual([
            "index.js",
            "review/s.json",
            "review/x.js",
        ])
        expect(Buffer.isBuffer(files["review/s.json"])).toBe(true)
    })

    test("the version id covers content, paths and the package version, not order", () => {
        const a = { "a.js": Buffer.from("1"), "b.js": Buffer.from("2") }
        const reordered = { "b.js": Buffer.from("2"), "a.js": Buffer.from("1") }
        const id = coreVersionId(a, "1.0.0")
        expect(id).toMatch(/^[0-9a-f]{16}$/)
        expect(coreVersionId(reordered, "1.0.0")).toBe(id)
        expect(coreVersionId(a, "1.0.1")).not.toBe(id)
        expect(
            coreVersionId({ ...a, "a.js": Buffer.from("x") }, "1.0.0")
        ).not.toBe(id)
        expect(
            coreVersionId(
                { "c.js": Buffer.from("1"), "b.js": Buffer.from("2") },
                "1.0.0"
            )
        ).not.toBe(id)
    })
})

describe("checkModuleContract", () => {
    const mod = (over = {}) => ({
        CORE_API,
        STATE_FORMAT,
        validateConfig: () => ({}),
        createCore: () => ({}),
        ...over,
    })

    test("accepts a matching module", () => {
        expect(() => checkModuleContract(mod())).not.toThrow()
    })

    test.each([
        ["CORE_API_MISMATCH", { CORE_API: CORE_API + 1 }],
        ["STATE_FORMAT_MISMATCH", { STATE_FORMAT: STATE_FORMAT + 1 }],
        ["CORE_CONTRACT", { createCore: undefined }],
        ["CORE_CONTRACT", { validateConfig: "nope" }],
    ])("refuses %s", (code, over) => {
        expect(() => checkModuleContract(mod(over))).toThrow(
            expect.objectContaining({ code })
        )
    })
})

describe("loadCoreModule", () => {
    test("loads the real core: version id, non-JS resources only", async () => {
        const loaded = await loadCoreModule({ packageVersion: "9.9.9" })
        expect(loaded.version).toMatch(/^[0-9a-f]{16}$/)
        expect(Object.keys(loaded.resources)).toContain(
            "review/codex-output.schema.json"
        )
        expect(
            Object.keys(loaded.resources).some((p) => p.endsWith(".js"))
        ).toBe(false)
        expect(Object.isFrozen(loaded.resources)).toBe(true)
        expect(loaded.module.CORE_API).toBe(CORE_API)
    })

    test("imports the entry from the given dir and checks its contract", async () => {
        const importModule = jest.fn(async () => ({ CORE_API: 0 }))
        await expect(
            loadCoreModule({
                coreDir: dir,
                packageVersion: "1",
                readFiles: () => ({}),
                importModule,
            })
        ).rejects.toMatchObject({ code: "CORE_API_MISMATCH" })
        expect(importModule.mock.calls[0][0]).toBe(
            `file://${path.join(dir, "index.js")}`
        )
    })
})

describe("prepareCore", () => {
    const shell = { shellVersion: "1.2.3", startedAt: 5 }

    test("builds, contract-checks and self-checks the real core without attaching it", async () => {
        const loaded = await loadCoreModule({ packageVersion: "1.2.3" })
        const codexSchemaPath = path.join(dir, "strict.json")
        const core = prepareCore({
            loaded,
            config: validConfig(),
            codexSchemaPath,
            ...shell,
        })
        expect(core.api).toBe(CORE_API)
        expect(core.version).toBe(loaded.version)
        expect(core.mcp.toolDefs.map((d) => d.name).sort()).toEqual(
            Object.keys(MCP_TOOL_METHODS).sort()
        )
        // Not attached: a route can't run yet.
        expect(() => core.routes.inflight({}, {})).toThrow(/not attached/)
        // Nothing was written: codex's schema file appears on first use.
        expect(existsSync(codexSchemaPath)).toBe(false)
    })

    test("a config the core can't run is rejected and the core disposed", async () => {
        const loaded = await loadCoreModule({ packageVersion: "1.2.3" })
        const config = validConfig()
        config.reviewer.provider = "nope"
        expect(() => prepareCore({ loaded, config, ...shell })).toThrow(
            /unknown reviewer.provider/
        )
    })

    test("selfCheck gets a frozen copy, never the live config", () => {
        let seen
        const dispose = jest.fn()
        const core = {
            api: CORE_API,
            selfCheck: (c) => {
                seen = c
            },
            attach: () => {},
            dispose,
            summarizeConfig: () => ({}),
            routes: {
                review: () => {},
                reset: () => {},
                notifyChange: () => {},
                provider: () => {},
                status: () => {},
                dashboardPage: () => {},
                inflight: () => {},
                dashboardMutations: Object.fromEntries(
                    [
                        "reset",
                        "provider",
                        "reviewerPreset",
                        "exclusions",
                        "maxRounds",
                        "maxBlocks",
                        "blockingSeverities",
                    ].map((k) => [k, () => {}])
                ),
            },
            mcp: {
                toolDefs: Object.keys(MCP_TOOL_METHODS).map((name) => ({
                    name,
                })),
                requestReview: () => {},
                resetReviewContext: () => {},
            },
        }
        const config = validConfig()
        const createCore = jest.fn(() => core)
        prepareCore({
            loaded: { module: { createCore }, resources: {}, version: "v" },
            config,
            ...shell,
        })
        expect(seen).toEqual(config)
        expect(seen).not.toBe(config)
        expect(Object.isFrozen(seen.reviewer)).toBe(true)
        expect(dispose).not.toHaveBeenCalled()
        const staging = createCore.mock.calls[0][0]
        expect(Object.isFrozen(staging)).toBe(true)
        expect(staging).toMatchObject({ version: "v", ...shell })
    })

    test("an instance missing part of the contract is refused and disposed", () => {
        const dispose = jest.fn()
        const createCore = () => ({
            api: CORE_API,
            selfCheck: () => {},
            dispose,
            routes: {},
            mcp: { toolDefs: [] },
        })
        expect(() =>
            prepareCore({
                loaded: { module: { createCore }, resources: {}, version: "v" },
                config: validConfig(),
                ...shell,
            })
        ).toThrow(
            expect.objectContaining({
                code: "CORE_CONTRACT",
                message: expect.stringMatching(
                    /attach.*routes\.review.*mcp\.toolDefs.*mcp\.requestReview/
                ),
            })
        )
        expect(dispose).toHaveBeenCalled()
    })
})

describe("codex schema files", () => {
    test("one file per loaded core, named by version and nonce", () => {
        expect(
            codexSchemaPathFor({ cacheDir: "/c", version: "abc", nonce: "n1" })
        ).toBe("/c/codex-schemas/abc-n1.json")
        expect(codexSchemaPathFor({ cacheDir: "/c", version: "abc" })).toMatch(
            /^\/c\/codex-schemas\/abc-[0-9a-f]{12}\.json$/
        )
    })

    test("the ephemeral path stays under the OS temp dir", () => {
        expect(ephemeralCodexSchemaPath("abc")).toContain(tmpdir())
    })

    test("pruning keeps only the current core's file", () => {
        const schemas = path.join(dir, "codex-schemas")
        mkdirSync(schemas)
        for (const n of ["old-1.json", "old-2.json", "cur.json"]) {
            writeFileSync(path.join(schemas, n), "{}")
        }
        const keep = path.join(schemas, "cur.json")
        expect(pruneCodexSchemas({ keep })).toBe(2)
        expect(existsSync(keep)).toBe(true)
        expect(existsSync(path.join(schemas, "old-1.json"))).toBe(false)
    })

    test("pruning a missing folder is a no-op", () => {
        expect(
            pruneCodexSchemas({ keep: path.join(dir, "none", "x.json") })
        ).toBe(0)
    })
})

describe("createCoreHolder + loadDefaultCore", () => {
    test("the holder returns its core", () => {
        const core = {}
        expect(createCoreHolder(core).current()).toBe(core)
    })

    test("loadDefaultCore prepares the real core with an ephemeral schema path", async () => {
        const core = await loadDefaultCore({
            config: validConfig(),
            shellVersion: "1.2.3",
            startedAt: 0,
        })
        expect(core.api).toBe(CORE_API)
        expect(core.summarizeConfig(validConfig()).version).toBe("1.2.3")
    })
})
