/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { jest } from "@jest/globals"
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
    captureCore,
    checkModuleContract,
    codexSchemaPathFor,
    CORE_API,
    coreVersionId,
    createCoreHolder,
    defaultConfigPath,
    ephemeralCodexSchemaPath,
    loadCoreModule,
    importCore,
    loadDefaultCore,
    MCP_TOOL_METHODS,
    prepareCore,
    pruneCodexSchemas,
    pruneSnapshots,
    readConfigFile,
    readCoreFiles,
    removeSnapshot,
    reviewVersionId,
    shellVersionId,
    verifySnapshot,
    writeSnapshot,
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
        const loaded = await loadCoreModule({
            packageVersion: "9.9.9",
            snapshotRoot: null,
        })
        expect(loaded.version).toMatch(/^[0-9a-f]{16}$/)
        expect(loaded.reviewVersion).toMatch(/^[0-9a-f]{16}$/)
        expect(loaded.snapshotDir).toBeNull()
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
                snapshotRoot: null,
            })
        ).rejects.toMatchObject({ code: "CORE_API_MISMATCH" })
        expect(importModule.mock.calls[0][0]).toBe(
            `file://${path.join(dir, "index.js")}`
        )
    })
})

describe("prepareCore", () => {
    const shell = { packageVersion: "1.2.3", startedAt: 5 }

    test("builds, contract-checks and self-checks the real core without attaching it", async () => {
        const loaded = await loadCoreModule({
            packageVersion: "1.2.3",
            snapshotRoot: null,
        })
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
        const loaded = await loadCoreModule({
            packageVersion: "1.2.3",
            snapshotRoot: null,
        })
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
            validateConfig: (raw) => raw,
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
            packageVersion: "1.2.3",
            startedAt: 0,
        })
        expect(core.api).toBe(CORE_API)
        expect(core.summarizeConfig(validConfig()).version).toBe("1.2.3")
    })
})

// A minimal core with no package imports, so it imports from anywhere.
const writeFixtureCore = (root, { value = "one", schema = "{}" } = {}) => {
    mkdirSync(path.join(root, "review"), { recursive: true })
    const files = {
        "index.js": [
            'import { VALUE } from "./review/index.js"',
            "export const CORE_API = 1",
            "export const STATE_FORMAT = 1",
            "export const validateConfig = (raw) => raw",
            "export const createCore = () => ({ value: VALUE })",
            "export { VALUE }",
        ].join("\n"),
        "review/index.js": `export const VALUE = "${value}"`,
        "review/schema.json": schema,
        "ui.js": 'export const UI = "page"',
    }
    for (const [rel, text] of Object.entries(files)) {
        writeFileSync(path.join(root, rel), text)
    }
}

const fileMap = (map) =>
    Object.fromEntries(Object.entries(map).map(([k, v]) => [k, Buffer.from(v)]))

describe("captureCore", () => {
    test("re-reads until two reads agree, then hashes and keeps non-JS as resources", () => {
        const reads = [
            fileMap({ "index.js": "a" }),
            fileMap({ "index.js": "b" }),
            fileMap({ "index.js": "c" }),
            fileMap({ "index.js": "c" }),
        ]
        const readFiles = jest.fn(() => reads.shift())
        const out = captureCore({
            coreDir: dir,
            packageVersion: "1",
            readFiles,
        })
        expect(readFiles).toHaveBeenCalledTimes(4)
        expect(out.files["index.js"].toString()).toBe("c")
    })

    test("gives up when the files keep changing", () => {
        let n = 0
        expect(() =>
            captureCore({
                coreDir: dir,
                packageVersion: "1",
                readFiles: () => fileMap({ "index.js": String(n++) }),
            })
        ).toThrow(expect.objectContaining({ code: "CORE_FILES_CHANGING" }))
        expect(n).toBe(6)
    })

    test("refuses code that reaches outside the snapshot", () => {
        const files = fileMap({ "index.js": 'export * from "../state.js"' })
        expect(() =>
            captureCore({
                coreDir: dir,
                packageVersion: "1",
                readFiles: () => files,
            })
        ).toThrow(expect.objectContaining({ code: "CORE_CONTAINMENT" }))
    })
})

describe("reviewVersionId", () => {
    const base = () =>
        fileMap({
            "index.js": 'import "./review/index.js"\nimport "./ui.js"',
            "review/index.js": 'import "./a.js"',
            "review/a.js": "export const a = 1",
            "review/schema.json": "{}",
            "ui.js": "export const ui = 1",
            "dashboard.js": "export const page = 1",
        })
    const id = base()
    const edited = (rel, text) => ({ ...base(), [rel]: Buffer.from(text) })

    test("a UI-only edit leaves it unchanged", () => {
        expect(reviewVersionId(edited("dashboard.js", "x"))).toBe(
            reviewVersionId(id)
        )
        expect(reviewVersionId(edited("ui.js", "x"))).toBe(reviewVersionId(id))
    })

    test.each(["review/a.js", "review/schema.json", "index.js"])(
        "an edit to %s changes it",
        (rel) => {
            expect(reviewVersionId(edited(rel, "// changed"))).not.toBe(
                reviewVersionId(id)
            )
        }
    )
})

describe("shellVersionId", () => {
    test("hashes the shell's own non-test JS files only", () => {
        const make = (files) =>
            shellVersionId("/shell", {
                readdir: () => Object.keys(files),
                read: (p) => Buffer.from(files[path.basename(p)]),
            })
        const a = make({ "index.js": "1", "x.test.js": "t", "notes.md": "m" })
        expect(make({ "index.js": "1", "x.test.js": "changed" })).toBe(a)
        expect(make({ "index.js": "2" })).not.toBe(a)
        expect(shellVersionId()).toMatch(/^[0-9a-f]{16}$/)
    })
})

describe("snapshot folders", () => {
    test("each write gets a fresh <id>-<nonce> folder holding exactly the bytes", () => {
        const files = fileMap({ "index.js": "x", "review/a.json": "{}" })
        const a = writeSnapshot({
            files,
            version: "v1",
            root: dir,
            nonce: "n1",
        })
        const b = writeSnapshot({ files, version: "v1", root: dir })
        expect(path.basename(a)).toBe("v1-n1")
        expect(b).not.toBe(a)
        expect(readFileSync(path.join(a, "review/a.json"), "utf8")).toBe("{}")
        expect(() => verifySnapshot(a, files)).not.toThrow()
        expect(readdirSync(dir).sort()).toEqual(
            [path.basename(a), path.basename(b)].sort()
        )
    })

    test("a file changed inside the folder fails verification", () => {
        const files = fileMap({ "index.js": "x" })
        const snap = writeSnapshot({ files, version: "v", root: dir })
        writeFileSync(path.join(snap, "index.js"), "y")
        expect(() => verifySnapshot(snap, files)).toThrow(
            expect.objectContaining({ code: "CORE_SNAPSHOT_MODIFIED" })
        )
    })

    test("pruning keeps only the running core's folder; removal tolerates none", () => {
        const files = fileMap({ "index.js": "x" })
        const keep = writeSnapshot({ files, version: "a", root: dir })
        writeSnapshot({ files, version: "b", root: dir })
        mkdirSync(path.join(dir, ".tmp-c-1"))
        expect(pruneSnapshots({ root: dir, keep })).toBe(2)
        expect(readdirSync(dir)).toEqual([path.basename(keep)])
        removeSnapshot(keep)
        removeSnapshot(null)
        expect(readdirSync(dir)).toEqual([])
        expect(pruneSnapshots({ root: path.join(dir, "none") })).toBe(0)
    })
})

describe("importCore from a snapshot", () => {
    let src
    beforeEach(() => {
        // Snapshots in the repo inherit its "type": "module"; a temp dir
        // needs its own.
        writeFileSync(path.join(dir, "package.json"), '{ "type": "module" }')
        src = path.join(dir, "src")
        writeFixtureCore(src)
    })
    const load = (snapshotRoot = path.join(dir, "snaps"), extra = {}) =>
        loadCoreModule({
            coreDir: src,
            packageVersion: "1",
            snapshotRoot,
            ...extra,
        })

    test("two loads of the same code: same id, separate folders, separate module graphs", async () => {
        const a = await load()
        const b = await load()
        expect(a.version).toBe(b.version)
        expect(a.snapshotDir).not.toBe(b.snapshotDir)
        expect(a.module).not.toBe(b.module)
        expect(a.module.createCore).not.toBe(b.module.createCore)
        expect(a.module.VALUE).toBe("one")
    })

    test("source edits after a load change neither its code nor its resources", async () => {
        const a = await load()
        writeFixtureCore(src, { value: "two", schema: '{"v":2}' })
        expect(a.module.VALUE).toBe("one")
        expect(a.resources["review/schema.json"].toString()).toBe("{}")
        const b = await load()
        expect(b.module.VALUE).toBe("two")
        expect(b.version).not.toBe(a.version)
        expect(b.reviewVersion).not.toBe(a.reviewVersion)
    })

    test("editing an old snapshot folder never affects a later load", async () => {
        const a = await load()
        writeFileSync(
            path.join(a.snapshotDir, "review/index.js"),
            'export const VALUE = "tampered"'
        )
        const b = await load()
        expect(b.module.VALUE).toBe("one")
    })

    test("a snapshot changed between write and import is rejected and deleted", async () => {
        const snapshotRoot = path.join(dir, "snaps")
        const captured = captureCore({ coreDir: src, packageVersion: "1" })
        let calls = 0
        const readFiles = (d) => {
            calls++
            const files = readCoreFiles(d)
            return { ...files, "index.js": Buffer.from("// changed") }
        }
        await expect(
            importCore({ captured, coreDir: src, snapshotRoot, readFiles })
        ).rejects.toMatchObject({ code: "CORE_SNAPSHOT_MODIFIED" })
        expect(calls).toBe(1)
        expect(readdirSync(snapshotRoot)).toEqual([])
    })

    test("an import or contract failure deletes the folder", async () => {
        const snapshotRoot = path.join(dir, "snaps")
        writeFileSync(path.join(src, "index.js"), "export const CORE_API = 2")
        await expect(load(snapshotRoot)).rejects.toMatchObject({
            code: "CORE_API_MISMATCH",
        })
        writeFileSync(path.join(src, "index.js"), "throw new Error('boom')")
        await expect(load(snapshotRoot)).rejects.toThrow("boom")
        expect(readdirSync(snapshotRoot)).toEqual([])
    })
})
