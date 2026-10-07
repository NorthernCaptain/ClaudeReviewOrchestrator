/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

// Shell side of the core boundary (hot-reload plan §5.2–5.4): reads the
// core's files once, hashes them into a version id, imports the core,
// checks its contract, then builds and self-checks an instance without
// attaching it. Startup goes through here; reloads will too.

import { createHash, randomBytes } from "node:crypto"
import {
    readdirSync as nodeReaddirSync,
    readFileSync as nodeReadFileSync,
    rmSync as nodeRmSync,
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

// What this shell speaks. A core exporting anything else is refused.
export const CORE_API = 1
export const STATE_FORMAT = 1

// MCP tool name → the core method that serves it (core contract `mcp`).
export const MCP_TOOL_METHODS = Object.freeze({
    request_review: "requestReview",
    reset_review_context: "resetReviewContext",
})

// Route keys the shell mounts (index.js). `dashboardMutations` is a map.
export const CORE_ROUTES = Object.freeze([
    "review",
    "reset",
    "notifyChange",
    "provider",
    "status",
    "dashboardPage",
    "inflight",
])
export const DASHBOARD_MUTATIONS = Object.freeze([
    "reset",
    "provider",
    "reviewerPreset",
    "exclusions",
    "maxRounds",
    "maxBlocks",
    "blockingSeverities",
])

const here = path.dirname(fileURLToPath(import.meta.url))
export const DEFAULT_CORE_DIR = path.join(here, "core")
export const DEFAULT_CACHE_DIR = path.join(
    homedir(),
    ".cache",
    "review-orchestrator"
)

export class CoreLoadError extends Error {
    constructor(code, message) {
        super(message)
        this.name = "CoreLoadError"
        this.code = code
    }
}

export const defaultConfigPath = () =>
    path.join(homedir(), ".config", "review-orchestrator", "config.json")

// Reads and parses config.json. Validation is the core's
// (validateConfig), so this only knows about files and JSON.
export const readConfigFile = ({ configPath, read = nodeReadFileSync }) => {
    let raw
    try {
        raw = read(configPath, "utf8")
    } catch (err) {
        if (err.code === "ENOENT") {
            const e = new Error(`config file not found: ${configPath}`)
            e.code = "CONFIG_NOT_FOUND"
            throw e
        }
        throw err
    }
    try {
        return JSON.parse(raw)
    } catch (err) {
        const e = new Error(`config file is not valid JSON: ${err.message}`)
        e.code = "CONFIG_INVALID_JSON"
        throw e
    }
}

// Every file under `coreDir` except tests, as relative path → bytes.
export const readCoreFiles = (
    coreDir,
    { readdir = nodeReaddirSync, read = nodeReadFileSync } = {}
) => {
    const files = {}
    const walk = (rel) => {
        for (const entry of readdir(path.join(coreDir, rel), {
            withFileTypes: true,
        })) {
            const relPath = rel ? `${rel}/${entry.name}` : entry.name
            if (entry.isDirectory()) {
                walk(relPath)
            } else if (entry.isFile() && !/\.test\.m?js$/.test(entry.name)) {
                files[relPath] = read(path.join(coreDir, relPath))
            }
        }
    }
    walk("")
    return files
}

// Short sha256 over exactly these bytes (path + content, sorted) plus
// the package version.
export const coreVersionId = (files, packageVersion) => {
    const hash = createHash("sha256")
    hash.update(`package\0${packageVersion}\0`)
    for (const relPath of Object.keys(files).sort()) {
        hash.update(`${relPath}\0`)
        hash.update(files[relPath])
        hash.update("\0")
    }
    return hash.digest("hex").slice(0, 16)
}

export const checkModuleContract = (mod) => {
    if (mod?.CORE_API !== CORE_API) {
        throw new CoreLoadError(
            "CORE_API_MISMATCH",
            `core speaks API ${mod?.CORE_API}, this shell speaks ${CORE_API}; a restart is needed`
        )
    }
    if (mod.STATE_FORMAT !== STATE_FORMAT) {
        throw new CoreLoadError(
            "STATE_FORMAT_MISMATCH",
            `core uses state format ${mod.STATE_FORMAT}, this shell ${STATE_FORMAT}; a restart is needed`
        )
    }
    for (const name of ["validateConfig", "createCore"]) {
        if (typeof mod[name] !== "function") {
            throw new CoreLoadError(
                "CORE_CONTRACT",
                `core module does not export ${name}()`
            )
        }
    }
}

const checkInstanceContract = (core) => {
    const missing = []
    if (core?.api !== CORE_API) missing.push("api")
    for (const fn of ["selfCheck", "attach", "dispose", "summarizeConfig"]) {
        if (typeof core?.[fn] !== "function") missing.push(fn)
    }
    for (const key of CORE_ROUTES) {
        if (typeof core?.routes?.[key] !== "function") {
            missing.push(`routes.${key}`)
        }
    }
    for (const key of DASHBOARD_MUTATIONS) {
        if (typeof core?.routes?.dashboardMutations?.[key] !== "function") {
            missing.push(`routes.dashboardMutations.${key}`)
        }
    }
    const toolNames = (core?.mcp?.toolDefs ?? []).map((d) => d?.name).sort()
    const expected = Object.keys(MCP_TOOL_METHODS).sort()
    if (toolNames.join() !== expected.join()) missing.push("mcp.toolDefs")
    for (const method of Object.values(MCP_TOOL_METHODS)) {
        if (typeof core?.mcp?.[method] !== "function") {
            missing.push(`mcp.${method}`)
        }
    }
    if (missing.length > 0) {
        throw new CoreLoadError(
            "CORE_CONTRACT",
            `core instance is missing ${missing.join(", ")}`
        )
    }
}

// Reads the core's files, imports its entry and checks the contract.
// Phase 3 imports from an immutable snapshot of exactly these bytes.
export const loadCoreModule = async ({
    coreDir = DEFAULT_CORE_DIR,
    packageVersion,
    readFiles = readCoreFiles,
    importModule = (url) => import(url),
} = {}) => {
    const files = readFiles(coreDir)
    const mod = await importModule(
        pathToFileURL(path.join(coreDir, "index.js")).href
    )
    checkModuleContract(mod)
    const resources = {}
    for (const [relPath, bytes] of Object.entries(files)) {
        if (!relPath.endsWith(".js")) resources[relPath] = bytes
    }
    return {
        module: mod,
        version: coreVersionId(files, packageVersion),
        resources: Object.freeze(resources),
    }
}

const deepFreeze = (value) => {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
        Object.freeze(value)
        for (const child of Object.values(value)) deepFreeze(child)
    }
    return value
}

// Builds an instance from inert inputs and self-checks it against a
// frozen copy of `config`. Never attaches; a rejected instance is
// disposed before the error propagates.
export const prepareCore = ({
    loaded,
    config,
    shellVersion,
    startedAt,
    codexSchemaPath,
}) => {
    const core = loaded.module.createCore(
        Object.freeze({
            resources: loaded.resources,
            version: loaded.version,
            shellVersion,
            startedAt,
            codexSchemaPath,
        })
    )
    try {
        checkInstanceContract(core)
        core.selfCheck(deepFreeze(structuredClone(config)))
    } catch (err) {
        core?.dispose?.()
        throw err
    }
    return core
}

// Where a core's strict codex schema lives: one file per loaded core.
export const codexSchemaPathFor = ({
    cacheDir,
    version,
    nonce = randomBytes(6).toString("hex"),
}) => path.join(cacheDir, "codex-schemas", `${version}-${nonce}.json`)

// A path for callers that never pick a cache dir (tests, embedders):
// per process, under the OS temp dir, never ~/.cache.
export const ephemeralCodexSchemaPath = (version) =>
    codexSchemaPathFor({
        cacheDir: path.join(tmpdir(), `review-orchestrator-${process.pid}`),
        version,
    })

// Startup cleanup: every codex schema file but `keep` belongs to a core
// that no longer runs.
export const pruneCodexSchemas = ({
    keep,
    readdir = nodeReaddirSync,
    rm = nodeRmSync,
}) => {
    const dir = path.dirname(keep)
    let names
    try {
        names = readdir(dir)
    } catch {
        return 0
    }
    let removed = 0
    for (const name of names) {
        if (path.join(dir, name) === keep) continue
        rm(path.join(dir, name), { force: true, recursive: true })
        removed++
    }
    return removed
}

// Phase 2 holds one core for the life of the process; the reload
// controller (Phase 3) swaps it.
export const createCoreHolder = (initial) => {
    const current = initial
    return { current: () => current }
}

// Loads the default core for `config` (already validated) with an
// ephemeral codex schema path. For startServer callers that bring none.
export const loadDefaultCore = async ({ config, shellVersion, startedAt }) => {
    const loaded = await loadCoreModule({ packageVersion: shellVersion })
    return prepareCore({
        loaded,
        config,
        shellVersion,
        startedAt,
        codexSchemaPath: ephemeralCodexSchemaPath(loaded.version),
    })
}
