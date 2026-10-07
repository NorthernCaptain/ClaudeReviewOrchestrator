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
import {
    cpSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { loadCoreModule, prepareCore } from "./core-loader.js"
import { createCandidateLoader, startServer } from "./index.js"
import { createStateStore } from "./state.js"
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
const makeV2 = () => {
    const file = path.join(work.coreDir, "dashboard.js")
    writeFileSync(
        file,
        readFileSync(file, "utf8").replace(
            "<!doctype html>",
            "<!doctype html><!-- fixture-v2 -->"
        )
    )
}

const start = async (cfg) => {
    writeFileSync(work.configPath, JSON.stringify(cfg, null, 2))
    const store = createStateStore({
        filePath: path.join(work.root, "state.json"),
        now: () => 0,
    })
    const gates = []
    let n = 0
    const archive = {
        write: jest.fn(() => ({ ok: true })),
        readRecent: () => [],
        list: () => [],
    }
    const deps = {
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
                        raw: { durationMs: 1, exitCode: 0, timedOut: false },
                    })
                )
            }),
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
        archive,
        gates,
        call,
        json,
        review: () =>
            call("/review", { method: "POST", body: { cwd: "/repo" } }),
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
            makeV2()
            expect(
                await s.json("/admin/reload", { method: "POST", body: {} })
            ).toMatchObject({ applied: true })
            const call = client.callTool({
                name: "request_review",
                arguments: { cwd: "/repo" },
            })
            await s.releaseNext()
            expect((await call).structuredContent.status).toBe("GOOD_TO_GO")
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
