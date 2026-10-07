/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

// Shell side of the core boundary (hot-reload plan §5.2–5.4): captures
// the core's files once (re-reading until a multi-file save is over),
// checks their containment, hashes them into a version id, writes them
// to an immutable snapshot folder, imports the snapshot, verifies its
// bytes and checks the contract; then builds and self-checks an instance
// without attaching it. Startup and reloads both go through here.

import { createHash, randomBytes } from "node:crypto"
import {
    mkdirSync as nodeMkdirSync,
    readdirSync as nodeReaddirSync,
    readFileSync as nodeReadFileSync,
    renameSync as nodeRenameSync,
    rmSync as nodeRmSync,
    writeFileSync as nodeWriteFileSync,
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { checkContainment, importClosure } from "./containment.js"

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
// Snapshots live inside the repo (decision Q1) so their package imports
// resolve up to the repo's node_modules. Gitignored.
export const DEFAULT_SNAPSHOT_ROOT = path.join(here, "..", ".core-versions")
export const OWN_PACKAGE_NAME = "review-orchestrator"
// What `reviewVersion` covers besides the review entry's import closure.
export const REVIEW_ENTRY = "review/index.js"
export const COMPOSITION_ROOT = "index.js"
const CAPTURE_ATTEMPTS = 3
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

const hashFiles = (files, paths, prefix = "") => {
    const hash = createHash("sha256")
    hash.update(prefix)
    for (const relPath of [...paths].sort()) {
        hash.update(`${relPath}\0`)
        hash.update(files[relPath])
        hash.update("\0")
    }
    return hash.digest("hex").slice(0, 16)
}

// Short sha256 over exactly these bytes (path + content, sorted) plus
// the package version.
export const coreVersionId = (files, packageVersion) =>
    hashFiles(files, Object.keys(files), `package\0${packageVersion}\0`)

// The part of the core a review runs, reads or is wired by: the review
// entry's static-import closure, every non-JS file under review/, and
// the composition root. A dashboard-only edit leaves it unchanged.
export const reviewVersionId = (files) => {
    const covered = new Set(importClosure(REVIEW_ENTRY, files))
    covered.add(COMPOSITION_ROOT)
    for (const relPath of Object.keys(files)) {
        if (relPath.startsWith("review/") && !relPath.endsWith(".js")) {
            covered.add(relPath)
        }
    }
    return hashFiles(
        files,
        [...covered].filter((p) => Object.hasOwn(files, p))
    )
}

// The shell's own source (every non-test .js under server/src outside
// core/), hashed at startup. It can only change with a restart.
export const shellVersionId = (
    shellDir = here,
    { readdir = nodeReaddirSync, read = nodeReadFileSync } = {}
) => {
    const files = {}
    for (const name of readdir(shellDir)) {
        if (name.endsWith(".js") && !name.endsWith(".test.js")) {
            files[name] = read(path.join(shellDir, name))
        }
    }
    return hashFiles(files, Object.keys(files))
}

const sameFiles = (a, b) => {
    const keys = Object.keys(a)
    return (
        keys.length === Object.keys(b).length &&
        keys.every(
            (k) => Object.hasOwn(b, k) && Buffer.compare(a[k], b[k]) === 0
        )
    )
}

// §5.3 steps 1–3a: read every core file once, re-read and compare (a
// multi-file save in progress shows up as a difference), then check
// containment and hash. Nothing is written or imported.
export const captureCore = ({
    coreDir = DEFAULT_CORE_DIR,
    packageVersion,
    readFiles = readCoreFiles,
} = {}) => {
    let files = null
    for (let i = 0; i < CAPTURE_ATTEMPTS && !files; i++) {
        const first = readFiles(coreDir)
        if (sameFiles(first, readFiles(coreDir))) files = first
    }
    if (!files) {
        throw new CoreLoadError(
            "CORE_FILES_CHANGING",
            "core files kept changing — try again"
        )
    }
    checkContainment(files, { ownName: OWN_PACKAGE_NAME })
    const resources = {}
    for (const [relPath, bytes] of Object.entries(files)) {
        if (!relPath.endsWith(".js")) resources[relPath] = bytes
    }
    return {
        files,
        version: coreVersionId(files, packageVersion),
        reviewVersion: reviewVersionId(files),
        resources: Object.freeze(resources),
    }
}

// §5.3 step 4: a fresh `<id>-<nonce>` folder every time, never reused,
// written under a temporary name and renamed so a half-written snapshot
// never exists.
export const writeSnapshot = ({
    files,
    version,
    root = DEFAULT_SNAPSHOT_ROOT,
    nonce = randomBytes(6).toString("hex"),
    fs = {},
}) => {
    const mkdir = fs.mkdirSync ?? nodeMkdirSync
    const write = fs.writeFileSync ?? nodeWriteFileSync
    const rename = fs.renameSync ?? nodeRenameSync
    const name = `${version}-${nonce}`
    const tmp = path.join(root, `.tmp-${name}`)
    for (const [relPath, bytes] of Object.entries(files)) {
        const target = path.join(tmp, relPath)
        mkdir(path.dirname(target), { recursive: true })
        write(target, bytes)
    }
    const dir = path.join(root, name)
    rename(tmp, dir)
    return dir
}

export const removeSnapshot = (dir, { rm = nodeRmSync } = {}) => {
    if (dir) rm(dir, { recursive: true, force: true })
}

// §5.3 step 6: the folder must still hold exactly the captured bytes.
export const verifySnapshot = (
    dir,
    files,
    { readFiles = readCoreFiles } = {}
) => {
    if (!sameFiles(files, readFiles(dir))) {
        throw new CoreLoadError(
            "CORE_SNAPSHOT_MODIFIED",
            `core snapshot ${path.basename(dir)} changed between its write and import`
        )
    }
}

// Startup cleanup: every snapshot folder but `keep` (and any temporary
// leftover) belongs to a core that no longer runs.
export const pruneSnapshots = ({
    root = DEFAULT_SNAPSHOT_ROOT,
    keep = null,
    readdir = nodeReaddirSync,
    rm = nodeRmSync,
} = {}) => {
    let names
    try {
        names = readdir(root)
    } catch {
        return 0
    }
    let removed = 0
    for (const name of names) {
        const dir = path.join(root, name)
        if (dir === keep) continue
        rm(dir, { recursive: true, force: true })
        removed++
    }
    return removed
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
    for (const fn of [
        "selfCheck",
        "attach",
        "dispose",
        "summarizeConfig",
        "validateConfig",
    ]) {
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

// Imports a captured core: from a fresh snapshot folder (verified after
// the import), or straight from `coreDir` when `snapshotRoot` is null
// (embedders and tests that never reload). A failure removes the folder.
export const importCore = async ({
    captured,
    coreDir = DEFAULT_CORE_DIR,
    snapshotRoot = DEFAULT_SNAPSHOT_ROOT,
    importModule = (url) => import(url),
    readFiles = readCoreFiles,
    snapshotFs = {},
}) => {
    const snapshotDir = snapshotRoot
        ? writeSnapshot({
              files: captured.files,
              version: captured.version,
              root: snapshotRoot,
              fs: snapshotFs,
          })
        : null
    try {
        const mod = await importModule(
            pathToFileURL(path.join(snapshotDir ?? coreDir, "index.js")).href
        )
        if (snapshotDir)
            verifySnapshot(snapshotDir, captured.files, { readFiles })
        checkModuleContract(mod)
        return { module: mod, snapshotDir }
    } catch (err) {
        removeSnapshot(snapshotDir)
        throw err
    }
}

// Capture + import in one step: { module, version, reviewVersion,
// resources, snapshotDir }.
export const loadCoreModule = async ({
    coreDir = DEFAULT_CORE_DIR,
    packageVersion,
    snapshotRoot = DEFAULT_SNAPSHOT_ROOT,
    readFiles = readCoreFiles,
    importModule = (url) => import(url),
} = {}) => {
    const captured = captureCore({ coreDir, packageVersion, readFiles })
    const { module: mod, snapshotDir } = await importCore({
        captured,
        coreDir,
        snapshotRoot,
        importModule,
        readFiles,
    })
    return {
        module: mod,
        version: captured.version,
        reviewVersion: captured.reviewVersion,
        resources: captured.resources,
        snapshotDir,
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
    packageVersion,
    shellVersion = null,
    startedAt,
    codexSchemaPath,
}) => {
    const core = loaded.module.createCore(
        Object.freeze({
            resources: loaded.resources,
            version: loaded.version,
            reviewVersion: loaded.reviewVersion ?? null,
            shellVersion,
            packageVersion,
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

// Loads the default core for `config` (already validated) straight from
// its source folder, with no snapshot and an ephemeral codex schema
// path. For startServer callers that bring none and never reload.
export const loadDefaultCore = async ({
    config,
    packageVersion,
    startedAt,
}) => {
    const loaded = await loadCoreModule({ packageVersion, snapshotRoot: null })
    return prepareCore({
        loaded,
        config,
        packageVersion,
        shellVersion: shellVersionId(),
        startedAt,
        codexSchemaPath: ephemeralCodexSchemaPath(loaded.version),
    })
}
