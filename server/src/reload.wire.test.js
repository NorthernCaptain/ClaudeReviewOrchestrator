/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

// Hot reload end to end (hot-reload plan §9, "Integration"): a real HTTP
// server, a fake reviewer that waits on a promise, and a copy of the real
// core edited into a "v2" variant. Never runs codex.

import { jest } from "@jest/globals"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import {
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    realpathSync,
    rmdirSync,
    rmSync,
    writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { loadCoreModule, prepareCore } from "./core-loader.js"
import { DASHBOARD_API } from "./core/dashboard.js"
import {
    createCandidateLoader,
    HANDSHAKE_TOLERANCE_MS,
    startServer,
} from "./index.js"
import { requiredHookWaitMs } from "./reload.js"
import { createStateStore } from "./state.js"
import { acquireConfigLock } from "../../install/config-lock.mjs"
import { signedHeaders } from "../../hooks/signed-client.mjs"

const here = path.dirname(fileURLToPath(import.meta.url))
const TOKEN = "wire-secret"

const config = (over = {}) => ({
    port: 0,
    bind: "127.0.0.1",
    authToken: TOKEN,
    allowedRoots: ["/repo"],
    codex: {
        binary: "codex",
        model: "m",
        ignoreProjectRules: true,
        extraArgs: [],
    },
    limits: {
        maxCodexRounds: 50,
        maxBlocks: 50,
        idleResetMinutes: 10,
        codexTimeoutSeconds: 240,
        maxPayloadBytes: 262144,
        maxFileBytes: 65536,
        maxFiles: 40,
    },
    ignorePaths: [],
    blockingSeverities: ["blocker", "major"],
    ...over,
})

const settle = () => new Promise((r) => setTimeout(r, 20))

const until = async (fn, ms = 3000) => {
    const end = Date.now() + ms
    for (;;) {
        const v = await fn()
        if (v) return v
        if (Date.now() > end) throw new Error("condition never held")
        await settle()
    }
}

let work
beforeEach(() => {
    const root = mkdtempSync(path.join(tmpdir(), "reload-wire-"))
    const coreDir = path.join(root, "core")
    cpSync(path.join(here, "core"), coreDir, {
        recursive: true,
        filter: (src) => !src.endsWith(".test.js"),
    })
    // Snapshots import packages, so they must live inside the repo.
    const snapshotRoot = path.join(
        here,
        "..",
        ".core-versions",
        `wire-${process.pid}-${path.basename(root)}`
    )
    mkdirSync(snapshotRoot, { recursive: true })
    const configPath = path.join(root, "config.json")
    work = { root, coreDir, snapshotRoot, configPath }
})
afterEach(() => {
    rmSync(work.root, { recursive: true, force: true })
    rmSync(work.snapshotRoot, { recursive: true, force: true })
})

// Edits the core copy into a distinct version whose dashboard says so.
// Each tag stacks onto the previous edit, so every call is a new version.
const makeVariant = (tag) => {
    const file = path.join(work.coreDir, "dashboard.js")
    writeFileSync(
        file,
        readFileSync(file, "utf8").replace(
            "<!doctype html>",
            `<!doctype html><!-- fixture-${tag} -->`
        )
    )
}
const makeV2 = () => makeVariant("v2")

// The snapshot folders (`<version>-<nonce>`) the candidate loader wrote.
const snapshots = () => readdirSync(work.snapshotRoot)
const snapshotOf = (version) => {
    const names = snapshots().filter((n) => n.startsWith(`${version}-`))
    expect(names).toHaveLength(1)
    return path.join(work.snapshotRoot, names[0])
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// The startup core writes its codex strict file under the OS temp dir
// (ephemeralCodexSchemaPath): remove the files, then their folders once
// empty.
const removeStrictFiles = (paths) => {
    for (const p of paths) {
        rmSync(p, { force: true })
        for (const dir of [path.dirname(p), path.dirname(path.dirname(p))]) {
            try {
                rmdirSync(dir)
            } catch {
                // not empty, or already gone
            }
        }
    }
}

// An MCP client advertising roots whose first roots/list answer waits
// until the test unparks it; later ones answer at once.
const parkedRootsClient = async (url, root) => {
    let held = true
    let unpark = null
    const client = new Client(
        { name: "wire", version: "0" },
        { capabilities: { roots: {} } }
    )
    client.setRequestHandler(ListRootsRequestSchema, async () => {
        if (held) await new Promise((r) => (unpark = r))
        return { roots: [{ uri: pathToFileURL(root).href }] }
    })
    const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
        requestInit: { headers: { "x-review-token": TOKEN } },
    })
    await client.connect(transport)
    return {
        client,
        parked: () => unpark !== null,
        unpark: () => {
            held = false
            unpark?.()
        },
    }
}

// opts: { repoRoot, result: () => reviewer result, onRun: (args) => {} }
const start = async (cfg, opts = {}) => {
    writeFileSync(work.configPath, JSON.stringify(cfg, null, 2))
    const store = createStateStore({
        filePath: path.join(work.root, "state.json"),
        now: () => 0,
    })
    const gates = []
    const runs = []
    let n = 0
    let schemaSeq = 0
    const repoRoot = opts.repoRoot ?? "/repo"
    const result =
        opts.result ?? (() => ({ status: "GOOD_TO_GO", findings: [] }))
    const archive = {
        write: jest.fn(() => ({ ok: true })),
        readRecent: () => [],
        list: () => [],
    }
    const deps = {
        resolveContext: jest.fn(() => ({
            repo: "repo",
            repoRoot,
            branch: "main",
            key: `${repoRoot}|main`,
        })),
        loadProjectConfig: () => null,
        buildPayload: () => ({
            headSha: "abc",
            files: {
                modified: [{ path: "a.js" }],
                untracked: [],
                deleted: [],
                renamed: [],
                priorFindingContext: [],
            },
            totalBytes: 10,
            truncated: false,
            promptText: "P",
            promptHash: "p",
            progressHash: `g${++n}`,
            priorFindingPaths: [],
            empty: false,
            nonBinaryFileCount: 1,
        }),
        runAndParse: (args) => {
            runs.push(args)
            opts.onRun?.(args)
            return new Promise((resolve) => {
                gates.push(() =>
                    resolve({
                        ...result(),
                        raw: { durationMs: 1, exitCode: 0, timedOut: false },
                    })
                )
            })
        },
    }
    const r = await startServer({
        config: cfg,
        store,
        archive,
        deps,
        log: {
            info() {},
            warn() {},
            error() {},
            child() {
                return this
            },
        },
        configPath: work.configPath,
        loadCandidate: createCandidateLoader({
            coreDir: work.coreDir,
            snapshotRoot: work.snapshotRoot,
            codexSchemaPathOf: (version) =>
                path.join(
                    work.root,
                    "codex-schemas",
                    `${version}-${++schemaSeq}.json`
                ),
        }),
    })
    if (!r.ok) throw r.error
    const url = `http://127.0.0.1:${r.address.port}`
    // Signed like hooks/signed-client.mjs, for the instance /healthz names.
    const call = async (route, { method = "GET", body, token = true } = {}) => {
        const text = body ? JSON.stringify(body) : ""
        let headers = text ? { "content-type": "application/json" } : {}
        if (token) {
            const { instanceId } = await (await fetch(`${url}/healthz`)).json()
            headers = signedHeaders({
                token: TOKEN,
                method,
                path: route,
                text,
                instanceId,
            })
        }
        return fetch(`${url}${route}`, {
            method,
            headers,
            body: text || undefined,
        })
    }
    const json = async (...a) => (await call(...a)).json()
    return {
        url,
        app: r.app,
        archive,
        deps,
        gates,
        runs,
        call,
        json,
        coreVersions: () =>
            archive.write.mock.calls.map(([record]) => record.coreVersion),
        // A dashboard action as the page sends it (§5.8): our Origin, the
        // page's CSRF token and API version, a JSON body.
        dashboard: async (method, route, body) => {
            const page = await (await fetch(`${url}/`)).text()
            const csrf = page.match(/data-csrf="([^"]*)"/)[1]
            return fetch(`${url}${route}`, {
                method,
                headers: {
                    "content-type": "application/json",
                    origin: url,
                    "x-dashboard-csrf": csrf,
                    "x-dashboard-api": String(DASHBOARD_API),
                },
                body: JSON.stringify(body),
            })
        },
        review: (body = {}) =>
            call("/review", {
                method: "POST",
                body: { cwd: repoRoot, ...body },
            }),
        releaseNext: async () => {
            await until(() => gates.length > 0)
            gates.shift()()
        },
        close: async () => {
            // A failed assertion must not leave a review hanging the close.
            while (gates.length > 0) gates.shift()()
            await r.app.locals.mcp.closeAllSessions()
            await new Promise((done) => r.server.close(done))
        },
    }
}

describe("hot reload over HTTP", () => {
    test("scheduled while a review runs, swapped when it ends; later requests run on the new core", async () => {
        const s = await start(config())
        try {
            const v1 = (await s.json("/healthz", { token: false })).coreVersion
            makeV2()
            const first = s.review()
            await until(async () => (await s.json("/inflight")).inFlight.length)

            const reload = await s.json("/admin/reload", {
                method: "POST",
                body: {},
            })
            expect(reload).toMatchObject({ ok: true, scheduled: true })
            expect(reload.to).not.toBe(v1)
            expect(await s.json("/healthz", { token: false })).toMatchObject({
                coreVersion: v1,
                reloadPending: true,
            })

            await s.releaseNext()
            expect((await first).status).toBe(200)
            const after = await until(async () => {
                const h = await s.json("/healthz", { token: false })
                return h.coreVersion !== v1 && h
            })
            expect(after).toMatchObject({
                coreVersion: reload.to,
                reloadPending: false,
            })
            expect(s.archive.write.mock.calls[0][0].coreVersion).toBe(v1)

            const second = s.review()
            await s.releaseNext()
            expect((await second).status).toBe(200)
            expect(s.archive.write.mock.calls[1][0].coreVersion).toBe(reload.to)

            const page = await (await s.call("/")).text()
            expect(page).toContain("fixture-v2")
            const status = await s.json("/status")
            expect(status).toMatchObject({
                coreVersion: reload.to,
                reload: { previousVersion: v1, pending: null },
            })
            expect(status.reload.history[0]).toMatchObject({
                kind: "reload",
                ok: true,
                from: v1,
                to: reload.to,
            })
        } finally {
            await s.close()
        }
    })

    test("a review arriving after maxWaitMinutes is held, then runs on the new core", async () => {
        const s = await start(
            config({ reload: { maxWaitMinutes: 0.0005, maxHoldSeconds: 30 } })
        )
        try {
            makeV2()
            const first = s.review()
            await until(async () => (await s.json("/inflight")).inFlight.length)
            const reload = await s.json("/admin/reload", {
                method: "POST",
                body: {},
            })
            await until(
                async () =>
                    (await s.json("/admin/reload")).reload.pending?.holding
            )
            const held = s.review()
            await until(
                async () =>
                    (await s.json("/admin/reload")).reload.pending?.heldNow ===
                    1
            )
            await s.releaseNext()
            await first
            await s.releaseNext()
            expect((await held).status).toBe(200)
            expect(s.archive.write.mock.calls[1][0].coreVersion).toBe(reload.to)
        } finally {
            await s.close()
        }
    })

    test("a held Stop-hook request answers DEADLINE_EXCEEDED at its deadline and leaves the queue", async () => {
        const s = await start(
            config({ reload: { maxWaitMinutes: 0.0005, maxHoldSeconds: 30 } })
        )
        try {
            makeV2()
            const first = s.review()
            await until(async () => (await s.json("/inflight")).inFlight.length)
            await s.json("/admin/reload", { method: "POST", body: {} })
            await until(
                async () =>
                    (await s.json("/admin/reload")).reload.pending?.holding
            )
            const held = await s.json("/review", {
                method: "POST",
                body: {
                    cwd: "/repo",
                    trigger: "stop_hook",
                    timeoutMs: 1200,
                    finalAttempt: true,
                },
            })
            expect(held).toMatchObject({
                status: "ESCALATE",
                code: "DEADLINE_EXCEEDED",
                notifyUser: false,
            })
            expect((await s.json("/admin/reload")).reload.pending.heldNow).toBe(
                0
            )
            await s.releaseNext()
            await first
        } finally {
            await s.close()
        }
    })

    test("an open MCP session keeps working across a reload, with no re-initialize", async () => {
        const s = await start(config())
        try {
            const transport = new StreamableHTTPClientTransport(
                new URL(`${s.url}/mcp`),
                { requestInit: { headers: { "x-review-token": TOKEN } } }
            )
            const client = new Client({ name: "wire", version: "0" })
            await client.connect(transport)
            const v1 = (await s.json("/healthz", { token: false })).coreVersion
            const sessionId = transport.sessionId
            const before = client.callTool({
                name: "request_review",
                arguments: { cwd: "/repo" },
            })
            await s.releaseNext()
            expect((await before).structuredContent.status).toBe("GOOD_TO_GO")
            makeV2()
            const reload = await s.json("/admin/reload", {
                method: "POST",
                body: {},
            })
            expect(reload).toMatchObject({ applied: true, from: v1 })
            const call = client.callTool({
                name: "request_review",
                arguments: { cwd: "/repo" },
            })
            await s.releaseNext()
            expect((await call).structuredContent.status).toBe("GOOD_TO_GO")
            // Integration step 6: same session, and the review ran on the
            // new core.
            expect(transport.sessionId).toBe(sessionId)
            expect(s.coreVersions()).toEqual([v1, reload.to])
            await client.close()
        } finally {
            await s.close()
        }
    })

    test("a bad candidate is reported and changes nothing; rollback and cancel answer", async () => {
        const s = await start(config())
        try {
            const v1 = (await s.json("/healthz", { token: false })).coreVersion
            writeFileSync(
                path.join(work.coreDir, "status.js"),
                'export * from "../state.js"\n'
            )
            const bad = await s.call("/admin/reload", {
                method: "POST",
                body: {},
            })
            expect(bad.status).toBe(422)
            expect(await bad.json()).toMatchObject({
                ok: false,
                code: "CORE_CONTAINMENT",
            })
            expect(
                (await s.json("/healthz", { token: false })).coreVersion
            ).toBe(v1)
            const rollback = await s.call("/admin/reload", {
                method: "POST",
                body: { rollback: true },
            })
            expect(rollback.status).toBe(409)
            expect(
                await s.json("/admin/reload", {
                    method: "POST",
                    body: { cancel: true },
                })
            ).toMatchObject({ ok: true, cancelled: false })
            expect(
                (
                    await s.call("/admin/reload", {
                        method: "POST",
                        token: false,
                    })
                ).status
            ).toBe(401)
        } finally {
            await s.close()
        }
    })
})

// Replaces `from` in a core-copy file, failing loudly if it isn't there.
const editCore = (rel, from, to) => {
    const file = path.join(work.coreDir, rel)
    const source = readFileSync(file, "utf8")
    expect(source).toContain(from)
    writeFileSync(file, source.replace(from, to))
    return () => writeFileSync(file, source)
}

const reloadNow = (s, body = {}) =>
    s.json("/admin/reload", { method: "POST", body })
const coreVersionOf = async (s) =>
    (await s.json("/healthz", { token: false })).coreVersion
const reloadStatus = async (s) => (await s.json("/admin/reload")).reload

describe("snapshots and resources", () => {
    test("no-op and config-only reloads write no snapshot folder; a candidate failing its contract or self-check leaves none behind", async () => {
        const s = await start(config())
        try {
            const v1 = await coreVersionOf(s)
            const reload = () =>
                s.call("/admin/reload", { method: "POST", body: {} })
            for (let i = 0; i < 2; i++) {
                expect(await (await reload()).json()).toMatchObject({
                    ok: true,
                    unchanged: true,
                })
            }
            for (const maxCodexRounds of [7, 8]) {
                const cfg = config()
                cfg.limits.maxCodexRounds = maxCodexRounds
                writeFileSync(work.configPath, JSON.stringify(cfg, null, 2))
                expect(await (await reload()).json()).toMatchObject({
                    ok: true,
                    applied: true,
                    from: v1,
                    to: v1,
                    configChanges: ["limits.maxCodexRounds"],
                })
            }
            expect(snapshots()).toEqual([])

            const restore = editCore(
                "index.js",
                "export const CORE_API = 1",
                "export const CORE_API = 2"
            )
            const contract = await reload()
            expect(contract.status).toBe(422)
            expect(await contract.json()).toMatchObject({
                ok: false,
                code: "CORE_API_MISMATCH",
            })
            expect(snapshots()).toEqual([])
            restore()

            editCore(
                "index.js",
                "review.selfCheck(config)",
                'throw new Error("fixture self-check")'
            )
            const selfCheck = await reload()
            expect(selfCheck.ok).toBe(false)
            expect((await selfCheck.json()).error).toMatch(/fixture self-check/)
            expect(snapshots()).toEqual([])
            expect(await coreVersionOf(s)).toBe(v1)
        } finally {
            await s.close()
        }
    })

    test("after a code reload and a rollback, a review on the restored core runs and finds its codex schema file", async () => {
        const strict = []
        // The fake reviewer never runs codex; it resolves the strict schema
        // file the way the codex adapter does right before spawning.
        const s = await start(config(), {
            onRun: ({ schema }) => strict.push(schema.codexStrictPath()),
        })
        const review = async () => {
            const r = s.review()
            await s.releaseNext()
            expect((await r).status).toBe(200)
        }
        try {
            const v1 = await coreVersionOf(s)
            await review()
            makeV2()
            const reload = await reloadNow(s)
            expect(reload).toMatchObject({ applied: true, from: v1 })
            await review()
            expect(await reloadNow(s, { rollback: true })).toMatchObject({
                ok: true,
                applied: true,
                kind: "rollback",
                from: reload.to,
                to: v1,
            })
            await review()

            expect(s.coreVersions()).toEqual([v1, reload.to, v1])
            // The restored core is the instance that ran first: the same
            // in-memory schema and the same strict file, still intact.
            expect(s.runs[2].schema).toBe(s.runs[0].schema)
            expect(strict[2]).toBe(strict[0])
            expect(strict[1]).not.toBe(strict[0])
            expect(readFileSync(strict[2], "utf8")).toBe(
                s.runs[0].schema.strictText
            )
            // The core rolled back from is `previous` now, not disposed.
            expect(existsSync(strict[1])).toBe(true)
            expect(existsSync(snapshotOf(reload.to))).toBe(true)
        } finally {
            removeStrictFiles(strict)
            await s.close()
        }
    })

    test("deleting the current core's snapshot folder breaks neither reviews nor the dashboard, status or reset", async () => {
        const strict = []
        // No real reviewer runs, so the adapters' schema needs stand in:
        // the in-memory validator (Claude, Gemini) and Codex's strict file.
        const s = await start(config(), {
            onRun: ({ schema }) => {
                schema.validator()
                strict.push(schema.codexStrictPath())
            },
        })
        try {
            makeV2()
            const reload = await reloadNow(s)
            expect(reload).toMatchObject({ applied: true })
            rmSync(snapshotOf(reload.to), { recursive: true, force: true })
            expect(snapshots()).toEqual([])

            const r = s.review()
            await s.releaseNext()
            expect(await (await r).json()).toMatchObject({
                status: "GOOD_TO_GO",
            })
            expect(s.coreVersions()).toEqual([reload.to])
            // Codex's strict file lives outside the snapshot.
            expect(strict[0].startsWith(work.snapshotRoot)).toBe(false)
            expect(readFileSync(strict[0], "utf8")).toBe(
                s.runs[0].schema.strictText
            )
            expect(await (await s.call("/")).text()).toContain("fixture-v2")
            expect(await s.json("/status")).toMatchObject({
                coreVersion: reload.to,
            })
            const reset = await s.call("/reset", {
                method: "POST",
                body: { cwd: "/repo" },
            })
            expect(reset.status).toBe(200)
            expect(await reset.json()).toMatchObject({ ok: true })
        } finally {
            await s.close()
        }
    })
})

describe("admission and shared maps around a reload", () => {
    test("requests on the same core still join or queue across the moment a reload becomes pending", async () => {
        const s = await start(config())
        try {
            const v1 = await coreVersionOf(s)
            makeV2()
            const first = s.review()
            await until(() => s.gates.length === 1)
            const reload = await reloadNow(s)
            expect(reload).toMatchObject({ scheduled: true, activeReviews: 1 })

            const joiner = s.review()
            await until(async () => (await reloadStatus(s)).activeReviews === 2)
            expect((await s.json("/inflight")).inFlight).toHaveLength(1)
            // Another duplicate key, the same context: it queues.
            const forced = s.review({ force: true })
            await until(
                async () => (await s.json("/inflight")).inFlight.length === 2
            )
            expect(s.runs).toHaveLength(1)

            await s.releaseNext()
            const [a, b] = await Promise.all(
                [first, joiner].map(async (p) => (await p).json())
            )
            expect(a.status).toBe("GOOD_TO_GO")
            expect(b).toEqual(a)
            await s.releaseNext()
            expect((await (await forced).json()).status).toBe("GOOD_TO_GO")
            // One run shared by the first two, one for the forced request.
            expect(s.runs).toHaveLength(2)
            expect(s.coreVersions()).toEqual([v1, v1])
            // The swap waited for all three.
            expect(
                await until(async () => {
                    const v = await coreVersionOf(s)
                    return v !== v1 && v
                })
            ).toBe(reload.to)
        } finally {
            await s.close()
        }
    })

    // Integration step 7: the poll carries no pending flag as such; the
    // page reads the pending state from reloadStamp and the change from
    // coreVersion.
    test("the /inflight poll's reload stamp changes when a reload becomes pending and again when it applies, and coreVersion follows the swap", async () => {
        const s = await start(config())
        try {
            const v1 = await coreVersionOf(s)
            makeV2()
            const first = s.review()
            const running = await until(async () => {
                const body = await s.json("/inflight")
                return body.inFlight.length === 1 && body
            })
            expect(running.coreVersion).toBe(v1)

            const reload = await reloadNow(s)
            expect(reload).toMatchObject({ scheduled: true })
            const pending = await s.json("/inflight")
            expect(pending.coreVersion).toBe(v1)
            expect(pending.reloadStamp).not.toBe(running.reloadStamp)
            expect(running.reloadStamp).not.toContain(reload.to)
            expect(pending.reloadStamp).toContain(reload.to)

            await s.releaseNext()
            await first
            const swapped = await until(async () => {
                const body = await s.json("/inflight")
                return body.coreVersion !== v1 && body
            })
            expect(swapped.coreVersion).toBe(reload.to)
            expect(swapped.reloadStamp).not.toBe(pending.reloadStamp)
            expect(swapped.inFlight).toEqual([])
        } finally {
            await s.close()
        }
    })

    test("after an apply-now swap, an identical request on the new core queues behind the old core's review instead of joining it", async () => {
        const s = await start(config())
        try {
            const v1 = await coreVersionOf(s)
            makeV2()
            const first = s.review()
            await until(() => s.gates.length === 1)
            const now = await reloadNow(s, { now: true })
            expect(now).toMatchObject({ ok: true, applied: true, from: v1 })

            const second = s.review()
            await until(
                async () => (await s.json("/inflight")).inFlight.length === 2
            )
            expect(s.gates).toHaveLength(1)
            await s.releaseNext()
            expect((await first).status).toBe(200)
            await s.releaseNext()
            expect((await second).status).toBe(200)
            expect(s.runs).toHaveLength(2)
            expect(s.coreVersions()).toEqual([v1, now.to])
        } finally {
            await s.close()
        }
    })

    test("apply now with a review running: it archives on the old core, a held request runs on the new one, and a rollback afterwards works", async () => {
        const strict = []
        const s = await start(
            config({ reload: { maxWaitMinutes: 0.0005, maxHoldSeconds: 30 } }),
            { onRun: ({ schema }) => strict.push(schema.codexStrictPath()) }
        )
        try {
            const v1 = await coreVersionOf(s)
            makeV2()
            const running = s.review()
            await until(() => s.gates.length === 1)
            const reload = await reloadNow(s)
            expect(reload).toMatchObject({ scheduled: true })
            await until(async () => (await reloadStatus(s)).pending?.holding)
            const held = s.review()
            await until(
                async () => (await reloadStatus(s)).pending?.heldNow === 1
            )

            expect(await reloadNow(s, { now: true })).toMatchObject({
                ok: true,
                applied: true,
                kind: "reload",
                from: v1,
                to: reload.to,
            })
            // Released onto the new core; same context, so it queues behind
            // the old core's review.
            await until(async () => (await reloadStatus(s)).activeReviews === 2)
            expect(s.gates).toHaveLength(1)
            await s.releaseNext()
            expect((await running).status).toBe(200)
            await s.releaseNext()
            expect((await held).status).toBe(200)
            expect(s.coreVersions()).toEqual([v1, reload.to])

            expect(await reloadStatus(s)).toMatchObject({
                previousVersion: v1,
                activeReviews: 0,
                pending: null,
            })
            expect(await reloadNow(s, { rollback: true })).toMatchObject({
                ok: true,
                applied: true,
                kind: "rollback",
                from: reload.to,
                to: v1,
            })
            const after = s.review()
            await s.releaseNext()
            expect((await after).status).toBe(200)
            expect(s.coreVersions()).toEqual([v1, reload.to, v1])
            expect(strict[2]).toBe(strict[0])
            expect(readFileSync(strict[2], "utf8")).toBe(
                s.runs[0].schema.strictText
            )
        } finally {
            removeStrictFiles(strict)
            await s.close()
        }
    })
})

describe("MCP calls parked in their roots check", () => {
    test("a request_review parked in roots/list is admitted once; a reload waits for it and it runs entirely on the old core", async () => {
        const repoRoot = realpathSync(work.root)
        const s = await start(config(), { repoRoot })
        const mcp = await parkedRootsClient(s.url, repoRoot)
        try {
            const v1 = await coreVersionOf(s)
            makeV2()
            const call = mcp.client.callTool({
                name: "request_review",
                arguments: { cwd: repoRoot },
            })
            await until(() => mcp.parked())
            expect((await reloadStatus(s)).activeReviews).toBe(1)
            const reload = await reloadNow(s)
            expect(reload).toMatchObject({ scheduled: true, activeReviews: 1 })
            expect(await coreVersionOf(s)).toBe(v1)

            mcp.unpark()
            await s.releaseNext()
            expect((await call).structuredContent.status).toBe("GOOD_TO_GO")
            expect(s.runs).toHaveLength(1)
            expect(s.coreVersions()).toEqual([v1])
            expect(
                await until(async () => {
                    const v = await coreVersionOf(s)
                    return v !== v1 && v
                })
            ).toBe(reload.to)
            const status = await reloadStatus(s)
            expect(status.activeReviews).toBe(0)
            expect(status.history[0]).toMatchObject({
                kind: "reload",
                ok: true,
                from: v1,
                to: reload.to,
            })
        } finally {
            mcp.unpark()
            await mcp.client.close()
            await s.close()
        }
    })

    test("a reset_review_context parked in roots/list across two swaps keeps its core until it finishes, then completes", async () => {
        const repoRoot = realpathSync(work.root)
        const s = await start(config(), { repoRoot })
        const mcp = await parkedRootsClient(s.url, repoRoot)
        try {
            makeVariant("v2")
            const v2 = await reloadNow(s)
            expect(v2).toMatchObject({ applied: true })
            const v2Dir = snapshotOf(v2.to)
            const call = mcp.client.callTool({
                name: "reset_review_context",
                arguments: { cwd: repoRoot },
            })
            await until(() => mcp.parked())

            // A pinned non-review call doesn't hold a reload back.
            makeVariant("v3")
            const v3 = await reloadNow(s)
            expect(v3).toMatchObject({ applied: true, from: v2.to })
            makeVariant("v4")
            const v4 = await reloadNow(s)
            expect(v4).toMatchObject({ applied: true, from: v3.to })
            // v2 is neither current nor previous, but the call pins it.
            expect(existsSync(v2Dir)).toBe(true)

            mcp.unpark()
            expect((await call).structuredContent).toMatchObject({
                ok: true,
                context: { repoRoot, branch: "main" },
            })
            await until(() => !existsSync(v2Dir))
            expect(existsSync(snapshotOf(v3.to))).toBe(true)
        } finally {
            mcp.unpark()
            await mcp.client.close()
            await s.close()
        }
    })
})

describe("config pinning", () => {
    test("a dashboard edit while a review runs leaves that review's severities alone; the next admitted review uses the new ones", async () => {
        const minor = {
            file: "a.js",
            line: 1,
            severity: "minor",
            category: "style",
            message: "rename x",
        }
        const s = await start(config(), {
            result: () => ({ status: "ISSUES", findings: [minor] }),
        })
        try {
            const first = s.review()
            await until(() => s.gates.length === 1)
            const edit = await s.dashboard(
                "PUT",
                "/dashboard/blocking-severities",
                { value: ["blocker", "major", "minor"] }
            )
            expect(edit.status).toBe(200)
            expect(
                s.app.locals.configStore.current().blockingSeverities
            ).toEqual(["blocker", "major", "minor"])
            // Admitted after the edit: another review key, so it queues.
            const second = s.review()
            await until(
                async () => (await s.json("/inflight")).inFlight.length === 2
            )

            await s.releaseNext()
            expect(await (await first).json()).toMatchObject({
                status: "GOOD_TO_GO_WITH_NOTES",
                blockingFindings: [],
            })
            await s.releaseNext()
            const next = await (await second).json()
            expect(next.status).toBe("ISSUES")
            expect(next.blockingFindings).toMatchObject([{ severity: "minor" }])
            expect(s.runs.map((r) => r.config.blockingSeverities)).toEqual([
                ["blocker", "major"],
                ["blocker", "major", "minor"],
            ])
        } finally {
            await s.close()
        }
    })
})

describe("limit handshake at dispatch", () => {
    const required = (s) =>
        requiredHookWaitMs(s.app.locals.configStore.current())
    // A Stop hook whose limit is exactly the running config's required
    // wait, with no hold allowance: it passes at immediate admission.
    const hookReview = (s) =>
        s.call("/review", {
            method: "POST",
            body: {
                cwd: "/repo",
                trigger: "stop_hook",
                timeoutMs: required(s),
            },
        })
    // The server answers 409 when remaining < required - tolerance, so with
    // a budget equal to the required wait, a wait just past the tolerance
    // stands in for the plan's "held for most of its budget".
    const PAST_TOLERANCE_MS = HANDSHAKE_TOLERANCE_MS + 500

    test("a held request whose remaining wait fell below the required one gets 409 HOOK_LIMIT_STALE after the swap, before any work; the resend runs", async () => {
        const s = await start(
            config({ reload: { maxWaitMinutes: 0.0005, maxHoldSeconds: 30 } })
        )
        try {
            const v1 = await coreVersionOf(s)
            makeV2()
            const first = s.review()
            await until(() => s.gates.length === 1)
            const reload = await reloadNow(s)
            await until(async () => (await reloadStatus(s)).pending?.holding)
            const sent = Date.now()
            const held = hookReview(s)
            await until(
                async () => (await reloadStatus(s)).pending?.heldNow === 1
            )
            await sleep(Math.max(0, sent + PAST_TOLERANCE_MS - Date.now()))
            await s.releaseNext()
            await first

            const stale = await held
            expect(stale.status).toBe(409)
            expect(await stale.json()).toMatchObject({
                status: "ESCALATE",
                code: "HOOK_LIMIT_STALE",
                hookTimeoutMs: required(s),
                notifyUser: false,
            })
            expect(s.deps.resolveContext).toHaveBeenCalledTimes(1)
            expect(s.runs).toHaveLength(1)
            expect(await coreVersionOf(s)).toBe(reload.to)

            const resend = hookReview(s)
            await s.releaseNext()
            expect((await resend).status).toBe(200)
            expect(s.coreVersions()).toEqual([v1, reload.to])
        } finally {
            await s.close()
        }
    }, 15_000)

    test("a request that waited at the swap gate past its budget gets 409 HOOK_LIMIT_STALE once the swap is done, before any work", async () => {
        const s = await start(config())
        let lock = null
        try {
            makeV2()
            const first = s.review()
            await until(() => s.gates.length === 1)
            const reload = await reloadNow(s)
            expect(reload).toMatchObject({ scheduled: true })
            // With the config lock held, the swap the last release starts
            // keeps its gate closed.
            lock = await acquireConfigLock({ configPath: work.configPath })
            await s.releaseNext()
            await first
            await until(async () => (await reloadStatus(s)).pending?.swapping)

            let answered = false
            const waiting = hookReview(s).finally(() => (answered = true))
            await sleep(PAST_TOLERANCE_MS)
            expect(answered).toBe(false)
            lock.release()

            const stale = await waiting
            expect(stale.status).toBe(409)
            expect(await stale.json()).toMatchObject({
                code: "HOOK_LIMIT_STALE",
                hookTimeoutMs: required(s),
            })
            expect(s.deps.resolveContext).toHaveBeenCalledTimes(1)
            expect(s.runs).toHaveLength(1)
            expect(await coreVersionOf(s)).toBe(reload.to)
        } finally {
            lock?.release()
            await s.close()
        }
    }, 15_000)
})

describe("two instances of the same core version", () => {
    test("a caller on one joining a queued pipeline on the other keeps it from being abandoned", async () => {
        const cfg = config()
        const instance = async () =>
            prepareCore({
                loaded: await loadCoreModule({
                    coreDir: work.coreDir,
                    packageVersion: "same",
                    snapshotRoot: work.snapshotRoot,
                }),
                config: cfg,
                packageVersion: "same",
                shellVersion: "s",
                startedAt: 0,
                codexSchemaPath: null,
            })
        // As after a reload A → B → A: two module graphs, one version.
        const a = await instance()
        const again = await instance()
        expect(again.version).toBe(a.version)
        expect(again.routes.review).not.toBe(a.routes.review)

        const gates = []
        let n = 0
        const deps = {
            // The shell's registries, shared by every core instance.
            inflight: new Map(),
            contextChains: new Map(),
            inflightMeta: new Map(),
            joinCounts: new WeakMap(),
            git: async () => {
                throw new Error("not a git repository")
            },
            resolveContext: () => ({
                repo: "repo",
                repoRoot: "/repo",
                branch: "main",
                key: "/repo|main",
            }),
            loadProjectConfig: () => null,
            buildPayload: () => ({
                headSha: "abc",
                files: {
                    modified: [{ path: "a.js" }],
                    untracked: [],
                    deleted: [],
                    renamed: [],
                    priorFindingContext: [],
                },
                totalBytes: 10,
                truncated: false,
                promptText: "P",
                promptHash: "p",
                progressHash: `g${++n}`,
                priorFindingPaths: [],
                empty: false,
                nonBinaryFileCount: 1,
            }),
            runAndParse: () =>
                new Promise((resolve) => {
                    gates.push(() =>
                        resolve({
                            status: "GOOD_TO_GO",
                            findings: [],
                            raw: { durationMs: 1, exitCode: 0 },
                        })
                    )
                }),
        }
        const live = {
            config: cfg,
            configTransaction: async () => ({ revision: 0, replaced: [] }),
            store: createStateStore({
                filePath: path.join(work.root, "two-cores.json"),
                now: () => 0,
            }),
            archive: null,
            metrics: null,
            logger: {
                info() {},
                warn() {},
                error() {},
                child() {
                    return this
                },
            },
            registries: deps,
            deps,
            shellStatus: () => null,
        }
        a.attach(live)
        again.attach(live)
        const call = (core, body, request) => {
            const res = {
                status(c) {
                    this.statusCode = c
                    return this
                },
                json(b) {
                    this.body = b
                    return this
                },
            }
            return core.routes
                .review({ body: { cwd: "/repo", ...body } }, res, request)
                .then(() => res)
        }

        const ahead = call(
            a,
            { trigger: "mcp_tool", force: true },
            { config: cfg }
        )
        await until(() => gates.length === 1)
        const owner = call(
            a,
            { trigger: "stop_hook" },
            { config: cfg, deadline: Date.now() + 80 }
        )
        await settle()
        const joiner = call(again, { trigger: "stop_hook" }, { config: cfg })
        await new Promise((r) => setTimeout(r, 150))
        gates.shift()()
        await ahead
        await until(() => gates.length === 1)
        gates.shift()()
        expect((await joiner).body.status).toBe("GOOD_TO_GO")
        expect((await owner).body.code).toBe("DEADLINE_EXCEEDED")
    })
})
