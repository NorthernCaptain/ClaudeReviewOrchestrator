/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { jest } from "@jest/globals"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import http from "node:http"
import {
    existsSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
    createApp,
    createServerInfo,
    startServer,
    gracefulShutdown,
    checkReviewerEnv,
    requestDeadline,
    VERSION,
} from "./index.js"
import { loadDefaultCore } from "./core-loader.js"
import { DASHBOARD_API } from "./core/dashboard.js"
import { createStateStore } from "./state.js"
import {
    challengeAt,
    connect,
    signedHeaders,
} from "../../hooks/signed-client.mjs"
import { rotateToken } from "../../install/rotate-token.mjs"

const minimalConfig = (over = {}) => ({
    port: 0,
    bind: "127.0.0.1",
    authToken: "secret",
    allowedRoots: ["/repo"],
    codex: {
        binary: "codex",
        model: "gpt-5-codex",
        ignoreProjectRules: true,
        extraArgs: [],
    },
    limits: {
        maxCodexRounds: 5,
        maxBlocks: 6,
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

const happyDeps = {
    resolveContext: () => ({
        repo: "repo",
        repoRoot: "/repo",
        branch: "main",
        key: "/repo|main",
    }),
    buildPayload: () => ({
        headSha: "abc1234",
        files: {
            modified: [{ path: "a.js" }],
            untracked: [],
            deleted: [],
            renamed: [],
            priorFindingContext: [],
        },
        totalBytes: 100,
        truncated: false,
        promptText: "payload",
        promptHash: "p",
        progressHash: "g",
        priorFindingPaths: [],
        empty: false,
        nonBinaryFileCount: 1,
    }),
    runAndParse: async () => ({
        status: "GOOD_TO_GO",
        findings: [],
        raw: { durationMs: 12, exitCode: 0, timedOut: false },
    }),
}

const makeStore = () => {
    const dir = mkdtempSync(path.join(tmpdir(), "index-store-"))
    const store = createStateStore({
        filePath: path.join(dir, "state.json"),
        now: () => 0,
    })
    store.__dir = dir
    return store
}

const silentLog = { info: jest.fn(), error: jest.fn(), warn: jest.fn() }

// A request signed the way hooks/signed-client.mjs signs it, for the
// instance /healthz names. Resolves to the fetch Response.
const signedFetch = async (
    url,
    route,
    { method = "GET", body, token = "secret" } = {}
) => {
    const { instanceId } = await (await fetch(`${url}/healthz`)).json()
    const text = body === undefined ? "" : JSON.stringify(body)
    return fetch(`${url}${route}`, {
        method,
        headers: signedHeaders({
            token,
            method,
            path: route,
            text,
            instanceId,
        }),
        body: text || undefined,
    })
}

// A dashboard action as the page sends it: the token read from the page,
// our own Origin, the page's API version and a JSON body.
const dashboardFetch = async (
    url,
    route,
    { method = "POST", body = {}, headers = {} } = {}
) => {
    const page = await (await fetch(`${url}/`)).text()
    const csrf = page.match(/data-csrf="([^"]*)"/)[1]
    return fetch(`${url}${route}`, {
        method,
        headers: {
            "content-type": "application/json",
            origin: url,
            "x-dashboard-csrf": csrf,
            "x-dashboard-api": String(DASHBOARD_API),
            ...headers,
        },
        body: JSON.stringify(body),
    })
}

// A config.json for servers started without the start() helper, so no
// test ever reads the real one.
const tempConfig = (config) => {
    const dir = mkdtempSync(path.join(tmpdir(), "index-config-"))
    const configPath = path.join(dir, "config.json")
    writeFileSync(configPath, JSON.stringify(config, null, 2))
    return {
        configPath,
        cleanup: () => rmSync(dir, { recursive: true, force: true }),
    }
}

// Every server gets its own temp config.json, so a dashboard edit can
// never reach the real ~/.config/review-orchestrator/config.json.
const start = async (config, deps = happyDeps, providedStore = null) => {
    const store = providedStore ?? makeStore()
    const configDir = mkdtempSync(path.join(tmpdir(), "index-config-"))
    const configPath = path.join(configDir, "config.json")
    writeFileSync(configPath, JSON.stringify(config, null, 2))
    const cleanup = () => {
        rmSync(configDir, { recursive: true, force: true })
        if (!providedStore) {
            rmSync(store.__dir, { recursive: true, force: true })
        }
    }
    const r = await startServer({
        config,
        store,
        deps,
        log: silentLog,
        configPath,
    })
    if (!r.ok) {
        cleanup()
        throw r.error
    }
    return {
        server: r.server,
        app: r.app,
        store,
        configPath,
        readConfigFile: () => JSON.parse(readFileSync(configPath, "utf8")),
        url: `http://127.0.0.1:${r.address.port}`,
        port: r.address.port,
        close: () =>
            new Promise((res) => {
                r.server.close(() => {
                    cleanup()
                    res()
                })
            }),
    }
}

describe("startServer", () => {
    test("resolves with ok:true and a real address on success", async () => {
        const { url, port, close } = await start(minimalConfig())
        try {
            expect(typeof port).toBe("number")
            expect(port).toBeGreaterThan(0)
            const r = await fetch(`${url}/healthz`)
            expect(r.status).toBe(200)
        } finally {
            await close()
        }
    })

    test("resolves with ok:false when bind fails (port already in use)", async () => {
        // First, take a known port.
        const first = await start(minimalConfig())
        try {
            const cfg = minimalConfig({
                port: first.port,
                bind: "127.0.0.1",
            })
            const temp = tempConfig(cfg)
            const result = await startServer({
                config: cfg,
                store: makeStore(),
                deps: happyDeps,
                log: silentLog,
                configPath: temp.configPath,
            })
            temp.cleanup()
            expect(result.ok).toBe(false)
            expect(result.error).toBeDefined()
            // Common codes: EADDRINUSE on macOS/Linux.
            expect(["EADDRINUSE", "EACCES"]).toContain(result.error.code)
        } finally {
            await first.close()
        }
    })
})

describe("startServer without injected capabilities", () => {
    test("runs git and reviewers through the shell's own tools", async () => {
        const repo = realpathSync(
            mkdtempSync(path.join(tmpdir(), "index-git-"))
        )
        execFileSync("git", ["init", "-q", "-b", "main", repo])
        const store = makeStore()
        const config = minimalConfig({ allowedRoots: [repo] })
        const temp = tempConfig(config)
        const r = await startServer({
            config,
            store,
            log: silentLog,
            configPath: temp.configPath,
        })
        const url = `http://127.0.0.1:${r.address.port}`
        try {
            const post = (route) =>
                signedFetch(url, route, { method: "POST", body: { cwd: repo } })
            const reset = await post("/reset")
            expect(reset.status).toBe(200)
            expect((await reset.json()).context.branch).toBe("main")
            expect((await post("/notify-change")).status).toBe(200)
            // Reviewers run only with a config the shell pinned to an
            // admitted review, and never as a Node executable.
            const { spawnTool } = r.app.locals.live.deps
            expect(() =>
                spawnTool("codex", [], { config: { codex: {} } })
            ).toThrow(
                expect.objectContaining({ code: "TOOL_CONFIG_NOT_ISSUED" })
            )
            const ticket = await r.app.locals.reloads.admitReview()
            try {
                const nodeConfig = {
                    ...ticket.config,
                    codex: { binary: process.execPath },
                }
                expect(() =>
                    spawnTool("codex", [], { config: nodeConfig })
                ).toThrow(
                    expect.objectContaining({ code: "TOOL_CONFIG_NOT_ISSUED" })
                )
            } finally {
                ticket.release()
            }
        } finally {
            await new Promise((done) => r.server.close(done))
            rmSync(store.__dir, { recursive: true, force: true })
            rmSync(repo, { recursive: true, force: true })
            temp.cleanup()
        }
    })
})

describe("createApp wiring", () => {
    test("/healthz is open and returns ok:true without a token", async () => {
        const { url, close } = await start(minimalConfig(), happyDeps)
        try {
            const r = await fetch(`${url}/healthz`)
            expect(r.status).toBe(200)
            const body = await r.json()
            expect(body.ok).toBe(true)
        } finally {
            await close()
        }
    })

    test("/inflight is open and returns JSON without a token (v0.1.28)", async () => {
        // Regression: the route must pass Date.now (the function) to
        // snapshotInFlight, not Date.now(). Passing the number threw
        // "now is not a function" and 500'd the endpoint.
        const { url, close } = await start(minimalConfig(), happyDeps)
        try {
            const r = await fetch(`${url}/inflight`)
            expect(r.status).toBe(200)
            const body = await r.json()
            expect(body.ok).toBe(true)
            expect(Array.isArray(body.inFlight)).toBe(true)
        } finally {
            await close()
        }
    })

    test("/inflight reads the shell-owned registry the caller injected", async () => {
        const inflightMeta = new Map([
            [
                "k",
                {
                    contextKey: "/repo|main",
                    repo: "repo",
                    branch: "main",
                    provider: "codex",
                    force: false,
                    startedAt: Date.now(),
                },
            ],
        ])
        const { url, close } = await start(minimalConfig(), {
            ...happyDeps,
            inflightMeta,
        })
        try {
            const body = await (await fetch(`${url}/inflight`)).json()
            expect(body.inFlight).toEqual([
                expect.objectContaining({ contextKey: "/repo|main" }),
            ])
        } finally {
            await close()
        }
    })

    test("each app gets its own in-flight registries by default", async () => {
        let release
        let started
        const running = new Promise((r) => {
            started = r
        })
        const blockingDeps = {
            ...happyDeps,
            runAndParse: async (...args) => {
                started()
                await new Promise((r) => {
                    release = r
                })
                return happyDeps.runAndParse(...args)
            },
        }
        const a = await start(minimalConfig(), blockingDeps)
        const b = await start(minimalConfig(), happyDeps)
        try {
            const review = signedFetch(a.url, "/review", {
                method: "POST",
                body: { cwd: "/repo" },
            })
            await running
            const inA = await (await fetch(`${a.url}/inflight`)).json()
            const inB = await (await fetch(`${b.url}/inflight`)).json()
            expect(inA.inFlight).toHaveLength(1)
            expect(inB.inFlight).toEqual([])
            release()
            expect((await review).status).toBe(200)
        } finally {
            await a.close()
            await b.close()
        }
    })

    test("PUT /dashboard/provider switches the live config and the file without a token (v0.1.35)", async () => {
        const cfg = minimalConfig({ reviewer: { provider: "codex" } })
        const { url, app, readConfigFile, close } = await start(cfg)
        try {
            const r = await dashboardFetch(url, "/dashboard/provider", {
                method: "PUT",
                body: { provider: "gemini" },
            })
            expect(r.status).toBe(200)
            const body = await r.json()
            expect(body.ok).toBe(true)
            expect(body.provider).toBe("gemini")
            expect(app.locals.live.config.reviewer.provider).toBe("gemini")
            expect(readConfigFile().reviewer.provider).toBe("gemini")
        } finally {
            await close()
        }
    })

    test("PUT /dashboard/provider rejects an unknown provider with 400", async () => {
        const { url, close } = await start(minimalConfig())
        try {
            const r = await dashboardFetch(url, "/dashboard/provider", {
                method: "PUT",
                body: { provider: "bogus" },
            })
            expect(r.status).toBe(400)
            const body = await r.json()
            expect(body.ok).toBe(false)
        } finally {
            await close()
        }
    })

    test("PUT /dashboard/reviewer-preset updates the active provider's model and effort", async () => {
        const cfg = minimalConfig({ reviewer: { provider: "codex" } })
        const { url, app, readConfigFile, close } = await start(cfg)
        try {
            const r = await dashboardFetch(url, "/dashboard/reviewer-preset", {
                method: "PUT",
                body: { preset: "gpt-6-astra:medium" },
            })
            expect(r.status).toBe(200)
            expect(await r.json()).toMatchObject({
                ok: true,
                model: "gpt-6-astra",
                effortOrMode: "medium",
            })
            for (const config of [app.locals.live.config, readConfigFile()]) {
                expect(config.codex).toMatchObject({
                    model: "gpt-6-astra",
                    reasoningEffort: "medium",
                })
            }
        } finally {
            await close()
        }
    })

    test("PUT /dashboard/max-rounds switches the live config and the file (v1.1.8)", async () => {
        const cfg = minimalConfig()
        cfg.limits.maxCodexRounds = 5
        const { url, app, readConfigFile, close } = await start(cfg)
        try {
            const r = await dashboardFetch(url, "/dashboard/max-rounds", {
                method: "PUT",
                body: { value: 8 },
            })
            expect(r.status).toBe(200)
            const body = await r.json()
            expect(body.ok).toBe(true)
            expect(body.value).toBe(8)
            expect(body.previous).toBe(5)
            expect(app.locals.live.config.limits.maxCodexRounds).toBe(8)
            expect(readConfigFile().limits.maxCodexRounds).toBe(8)
        } finally {
            await close()
        }
    })

    test("PUT /dashboard/max-rounds rejects out-of-range with 400", async () => {
        const { url, close } = await start(minimalConfig())
        try {
            const r = await dashboardFetch(url, "/dashboard/max-rounds", {
                method: "PUT",
                body: { value: 0 },
            })
            expect(r.status).toBe(400)
            const body = await r.json()
            expect(body.ok).toBe(false)
        } finally {
            await close()
        }
    })

    test("POST /dashboard/reset clears the EXACT stored context by contextKey (v0.1.36)", async () => {
        // Two contexts share the same repoRoot but differ by branch.
        // Submitting only `repoRoot` (the old v0.1.35 shape) couldn't
        // disambiguate them — handleReset would resolve whichever
        // branch the working tree was on. The contextKey form targets
        // exactly one stored context regardless of disk state.
        const { url, store, close } = await start(minimalConfig(), happyDeps)
        try {
            store.save("/repo|main", {
                repoRoot: "/repo",
                branch: "main",
                codexRounds: 99,
                blockCount: 99,
                lastReviewedAt: 1,
            })
            store.save("/repo|feature", {
                repoRoot: "/repo",
                branch: "feature",
                codexRounds: 4,
                blockCount: 3,
                lastReviewedAt: 1,
            })
            const r = await dashboardFetch(url, "/dashboard/reset", {
                method: "POST",
                body: { contextKey: "/repo|feature" },
            })
            expect(r.status).toBe(200)
            const body = await r.json()
            expect(body.ok).toBe(true)
            expect(body.context.branch).toBe("feature")
            expect(body.state.codexRounds).toBe(0)
            expect(body.state.blockCount).toBe(0)
            // The OTHER branch's context must be untouched.
            const main = store.get({
                key: "/repo|main",
                repoRoot: "/repo",
                branch: "main",
            })
            expect(main.codexRounds).toBe(99)
            expect(main.blockCount).toBe(99)
        } finally {
            await close()
        }
    })

    test("POST /dashboard/reset rejects missing contextKey with 400", async () => {
        const { url, close } = await start(minimalConfig(), happyDeps)
        try {
            const r = await dashboardFetch(url, "/dashboard/reset", {
                method: "POST",
                body: {},
            })
            expect(r.status).toBe(400)
        } finally {
            await close()
        }
    })

    test("/favicon.svg and /favicon.ico both serve the yin-yang SVG (v0.1.36)", async () => {
        const { url, close } = await start(minimalConfig(), happyDeps)
        try {
            for (const path of ["/favicon.svg", "/favicon.ico"]) {
                const r = await fetch(`${url}${path}`)
                expect(r.status).toBe(200)
                expect(r.headers.get("content-type")).toMatch(/image\/svg\+xml/)
                const body = await r.text()
                expect(body).toContain("<svg")
                // Yin-yang shape signature: outer circle + S-curve path
                // + two small dots.
                expect(body).toContain('viewBox="0 0 64 64"')
                expect(body).toContain("M 32 2 A 30 30")
            }
        } finally {
            await close()
        }
    })

    test("POST /dashboard/exclusions adds + removes per context (v1.1)", async () => {
        const { url, store, close } = await start(minimalConfig(), happyDeps)
        try {
            store.save("/r|main", {
                repoRoot: "/r",
                branch: "main",
                lastReviewedAt: 1,
            })
            const add = await dashboardFetch(url, "/dashboard/exclusions", {
                method: "POST",
                body: {
                    contextKey: "/r|main",
                    file: "a.js",
                    message: "noise",
                    action: "add",
                },
            })
            expect(add.status).toBe(200)
            const addBody = await add.json()
            expect(addBody.exclusions).toHaveLength(1)
            const remove = await dashboardFetch(url, "/dashboard/exclusions", {
                method: "POST",
                body: {
                    contextKey: "/r|main",
                    file: "a.js",
                    message: "noise",
                    action: "remove",
                },
            })
            expect(remove.status).toBe(200)
            const rmBody = await remove.json()
            expect(rmBody.exclusions).toHaveLength(0)
        } finally {
            await close()
        }
    })

    test("POST /dashboard/exclusions rejects an unknown context with 404", async () => {
        const { url, close } = await start(minimalConfig(), happyDeps)
        try {
            const r = await dashboardFetch(url, "/dashboard/exclusions", {
                method: "POST",
                body: {
                    contextKey: "/nope|x",
                    file: "a",
                    message: "m",
                    action: "add",
                },
            })
            expect(r.status).toBe(404)
        } finally {
            await close()
        }
    })

    test("POST /dashboard/reset rejects an unknown contextKey with 404", async () => {
        const { url, close } = await start(minimalConfig(), happyDeps)
        try {
            const r = await dashboardFetch(url, "/dashboard/reset", {
                method: "POST",
                body: { contextKey: "/nope|x" },
            })
            expect(r.status).toBe(404)
        } finally {
            await close()
        }
    })

    test("/review rejects an unsigned request with 401", async () => {
        const { url, close } = await start(minimalConfig(), happyDeps)
        try {
            const r = await fetch(`${url}/review`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ cwd: "/repo" }),
            })
            expect(r.status).toBe(401)
            const body = await r.json()
            expect(body.code).toBe("UNSIGNED_REQUEST")
        } finally {
            await close()
        }
    })

    test("/review rejects a request signed with the wrong token, or carrying X-Review-Token", async () => {
        const { url, close } = await start(minimalConfig(), happyDeps)
        try {
            const r = await signedFetch(url, "/review", {
                method: "POST",
                body: { cwd: "/repo" },
                token: "nope",
            })
            expect(r.status).toBe(401)
            expect((await r.json()).code).toBe("BAD_SIGNATURE")
            const raw = await fetch(`${url}/review`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "x-review-token": "secret",
                },
                body: JSON.stringify({ cwd: "/repo" }),
            })
            expect(raw.status).toBe(401)
            expect((await raw.json()).code).toBe("TOKEN_NOT_ACCEPTED")
        } finally {
            await close()
        }
    })

    test("/reset with valid token clears the context", async () => {
        const { url, store, close } = await start(minimalConfig(), happyDeps)
        try {
            // Seed something to clear.
            store.save("/repo|main", {
                repoRoot: "/repo",
                branch: "main",
                codexRounds: 3,
                lastReviewedAt: 1,
            })
            const r = await signedFetch(url, "/reset", {
                method: "POST",
                body: { cwd: "/repo" },
            })
            expect(r.status).toBe(200)
            const body = await r.json()
            expect(body.ok).toBe(true)
            expect(body.state.codexRounds).toBe(0)
        } finally {
            await close()
        }
    })

    test("/review with valid token returns the envelope", async () => {
        const { url, close } = await start(minimalConfig(), happyDeps)
        try {
            const r = await signedFetch(url, "/review", {
                method: "POST",
                body: { cwd: "/repo" },
            })
            expect(r.status).toBe(200)
            const body = await r.json()
            expect(body.status).toBe("GOOD_TO_GO")
            expect(body.findings).toEqual([])
            expect(body.blockingFindings).toEqual([])
            expect(body.droppedFindings).toEqual([])
        } finally {
            await close()
        }
    })
})

describe("gracefulShutdown", () => {
    const silentLog = () => ({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    })

    const fakeServer = (closeBehavior = "ok") => {
        let closeCb = null
        return {
            closeCb: () => closeCb,
            close(cb) {
                closeCb = cb
                if (closeBehavior === "ok") {
                    setImmediate(() => cb && cb(null))
                } else if (closeBehavior === "error") {
                    setImmediate(() => cb && cb(new Error("close failed")))
                } else if (closeBehavior === "hang") {
                    // never call cb
                }
            },
        }
    }

    test("happy path: resolves once server.close completes", async () => {
        const log = silentLog()
        await gracefulShutdown({
            server: fakeServer("ok"),
            sockets: new Set(),
            mcp: { closeAllSessions: async () => {} },
            logger: log,
        })
        expect(log.info).not.toHaveBeenCalled() // currently nothing on success path
    })

    test("calls server.close immediately, in parallel with mcp.closeAllSessions", async () => {
        // The shutdown contract: server.close runs FIRST (stops
        // accepting new connections) and mcp shutdown runs
        // concurrently. The earlier serial mcp-then-server ordering
        // left a window where a fresh GET /mcp could open during the
        // MCP-close phase.
        const order = []
        const log = silentLog()
        const mcp = {
            closeAllSessions: async () => {
                order.push("mcp")
            },
        }
        const srv = {
            close(cb) {
                order.push("server")
                // Delay the callback so we can observe that mcp work
                // happens concurrently rather than after server.close
                // resolves.
                setImmediate(() => setImmediate(() => cb(null)))
            },
        }
        await gracefulShutdown({
            server: srv,
            sockets: new Set(),
            mcp,
            logger: log,
        })
        // "server" must be FIRST — that's the new connection cutoff.
        expect(order[0]).toBe("server")
        expect(order).toContain("mcp")
    })

    test("destroys lingering sockets after socketDrainMs", async () => {
        const destroy = jest.fn()
        const sock = { destroy }
        const sockets = new Set([sock])
        // Use a server that hangs forever — only the socket-destroy path
        // matters here; we expect the force timer to fire and exit.
        const exit = jest.fn(() => {})
        const log = silentLog()
        const p = gracefulShutdown({
            server: fakeServer("hang"),
            sockets,
            mcp: null,
            logger: log,
            socketDrainMs: 10,
            forceExitMs: 50,
            exit,
        })
        // Don't await — force timer will fire exit() which we mocked.
        await new Promise((r) => setTimeout(r, 80))
        expect(destroy).toHaveBeenCalled()
        expect(exit).toHaveBeenCalledWith(1)
        // Stop the dangling promise from leaking.
        p.catch(() => {})
    })

    test("is idempotent — second call goes straight to exit(1)", async () => {
        const exit = jest.fn(() => {})
        const log = silentLog()
        const state = { stopping: false }
        const args = {
            server: fakeServer("hang"),
            sockets: new Set(),
            mcp: null,
            logger: log,
            socketDrainMs: 50,
            forceExitMs: 200,
            exit,
            state,
        }
        // First call sets stopping=true (but hangs on close).
        const p1 = gracefulShutdown(args)
        // Second call short-circuits → exit(1).
        await gracefulShutdown(args)
        expect(exit).toHaveBeenCalledWith(1)
        expect(log.warn).toHaveBeenCalledWith(
            {},
            "shutdown re-entered — forcing exit"
        )
        p1.catch(() => {})
    })

    test("forceExitMs fires when server.close hangs", async () => {
        const exit = jest.fn(() => {})
        const log = silentLog()
        const p = gracefulShutdown({
            server: fakeServer("hang"),
            sockets: new Set(),
            mcp: null,
            logger: log,
            socketDrainMs: 5,
            forceExitMs: 30,
            exit,
        })
        await new Promise((r) => setTimeout(r, 60))
        expect(exit).toHaveBeenCalledWith(1)
        expect(log.error).toHaveBeenCalled()
        p.catch(() => {})
    })

    test("tolerates a missing mcp helper", async () => {
        await gracefulShutdown({
            server: fakeServer("ok"),
            sockets: new Set(),
            mcp: undefined,
            logger: silentLog(),
        })
    })
})

describe("MCP closeAllSessions integration via createApp", () => {
    test("createApp exposes mcp.closeAllSessions on app.locals", async () => {
        const store = createStateStore({ filePath: null, now: () => 0 })
        const config = minimalConfig()
        const temp = tempConfig(config)
        const app = createApp({
            config,
            store,
            archive: null,
            logger: silentLog,
            deps: happyDeps,
            configPath: temp.configPath,
            core: await loadDefaultCore({
                config,
                shellVersion: VERSION,
                startedAt: 0,
            }),
        })
        expect(typeof app.locals?.mcp?.closeAllSessions).toBe("function")
        temp.cleanup()
    })
})

describe("checkReviewerEnv", () => {
    test("returns null when provider isn't gemini (no check needed)", () => {
        expect(
            checkReviewerEnv({ reviewer: { provider: "codex" } }, {})
        ).toBeNull()
        expect(
            checkReviewerEnv({ reviewer: { provider: "claude" } }, {})
        ).toBeNull()
        // No reviewer block at all (legacy install) → no check.
        expect(checkReviewerEnv({}, {})).toBeNull()
    })

    test("returns null when gemini provider AND GEMINI_API_KEY is set", () => {
        expect(
            checkReviewerEnv(
                { reviewer: { provider: "gemini" } },
                { GEMINI_API_KEY: "abc123" }
            )
        ).toBeNull()
    })

    test("returns a problem object when gemini provider AND key is missing", () => {
        const p = checkReviewerEnv({ reviewer: { provider: "gemini" } }, {})
        expect(p).not.toBeNull()
        expect(p.hint).toMatch(/GEMINI_API_KEY/)
        expect(p.message).toMatch(/gemini/)
        expect(p.message).toMatch(/GEMINI_API_KEY/)
        // Message should be actionable: it tells the user what to do.
        expect(p.message).toMatch(/launchd|gemini auth login|env var/)
    })

    test("treats empty string GEMINI_API_KEY as missing", () => {
        const p = checkReviewerEnv(
            { reviewer: { provider: "gemini" } },
            { GEMINI_API_KEY: "" }
        )
        expect(p).not.toBeNull()
    })

    test("treats non-string GEMINI_API_KEY as missing", () => {
        const p = checkReviewerEnv(
            { reviewer: { provider: "gemini" } },
            { GEMINI_API_KEY: 42 }
        )
        expect(p).not.toBeNull()
    })

    test("accepts OAuth-mode gemini auth (no env key required)", () => {
        // Simulate ~/.gemini/settings.json with OAuth selected — the
        // file's read injected via the helper. No env key, but gemini
        // CLI will resolve credentials from its own keychain, so the
        // check must NOT block startup.
        const fakeRead = (p) => {
            if (p.endsWith(".gemini/settings.json")) {
                return JSON.stringify({
                    security: { auth: { selectedType: "oauth-personal" } },
                })
            }
            throw Object.assign(new Error("nope"), { code: "ENOENT" })
        }
        const p = checkReviewerEnv(
            { reviewer: { provider: "gemini" } },
            {},
            { home: "/Users/u", read: fakeRead }
        )
        expect(p).toBeNull()
    })

    test("still blocks when selectedType is 'gemini-api-key' and key is missing", () => {
        const fakeRead = (path) => {
            if (path.endsWith(".gemini/settings.json")) {
                return JSON.stringify({
                    security: { auth: { selectedType: "gemini-api-key" } },
                })
            }
            throw new Error("not found")
        }
        const p = checkReviewerEnv(
            { reviewer: { provider: "gemini" } },
            {},
            { home: "/Users/u", read: fakeRead }
        )
        expect(p).not.toBeNull()
        expect(p.message).toMatch(/gemini-api-key/)
    })

    test("falls back to require-key when settings.json is unreadable", () => {
        // If we can't tell what auth mode is configured, the safe
        // default is "treat as api-key" so missing GEMINI_API_KEY
        // still fails loud.
        const failingRead = () => {
            throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
        }
        const p = checkReviewerEnv(
            { reviewer: { provider: "gemini" } },
            {},
            { home: "/Users/u", read: failingRead }
        )
        expect(p).not.toBeNull()
    })

    test("falls back to require-key when settings.json isn't JSON", () => {
        const badRead = () => "not json at all"
        const p = checkReviewerEnv(
            { reviewer: { provider: "gemini" } },
            {},
            { home: "/Users/u", read: badRead }
        )
        expect(p).not.toBeNull()
    })
})

describe("VERSION", () => {
    test("VERSION is a non-empty semver-ish string read from package.json", () => {
        expect(typeof VERSION).toBe("string")
        expect(VERSION.length).toBeGreaterThan(0)
        // Should match major.minor.patch (allowing pre-release suffix).
        expect(VERSION).toMatch(/^\d+\.\d+\.\d+(-.+)?$/)
    })
})

describe("/review — the limit handshake and request deadline", () => {
    const post = (url, body) =>
        signedFetch(url, "/review", {
            method: "POST",
            body: { cwd: "/repo", ...body },
        })
    const withSpy = () => {
        const runAndParse = jest.fn(happyDeps.runAndParse)
        return { deps: { ...happyDeps, runAndParse }, runAndParse }
    }

    test("an unchanged-config hook limit passes at once", async () => {
        const { deps, runAndParse } = withSpy()
        const { url, close } = await start(minimalConfig(), deps)
        try {
            // codexTimeoutSeconds 240 → the hooks wait 300 s.
            const r = await post(url, {
                trigger: "stop_hook",
                timeoutMs: 300_000,
            })
            expect(r.status).toBe(200)
            expect((await r.json()).status).toBe("GOOD_TO_GO")
            expect(runAndParse).toHaveBeenCalledTimes(1)
        } finally {
            await close()
        }
    })

    test("a limit too short for the pinned config is answered 409 HOOK_LIMIT_STALE before any work", async () => {
        const { deps, runAndParse } = withSpy()
        const { url, close } = await start(minimalConfig(), deps)
        try {
            const r = await post(url, {
                trigger: "stop_hook",
                timeoutMs: 60_000,
            })
            expect(r.status).toBe(409)
            expect(await r.json()).toMatchObject({
                status: "ESCALATE",
                code: "HOOK_LIMIT_STALE",
                hookTimeoutMs: 300_000,
                notifyUser: false,
            })
            expect(runAndParse).not.toHaveBeenCalled()
            // A final attempt is never answered with a 409.
            const last = await post(url, {
                trigger: "stop_hook",
                timeoutMs: 60_000,
                finalAttempt: true,
            })
            expect(last.status).toBe(200)
            expect(runAndParse).toHaveBeenCalledTimes(1)
        } finally {
            await close()
        }
    })

    test("a pinned hook.fetchTimeoutSeconds shorter than the reviewer timeout is respected", async () => {
        const { deps } = withSpy()
        const { url, close } = await start(
            minimalConfig({ hook: { fetchTimeoutSeconds: 90 } }),
            deps
        )
        try {
            const r = await post(url, {
                trigger: "stop_hook",
                timeoutMs: 90_000,
            })
            expect(r.status).toBe(200)
        } finally {
            await close()
        }
    })

    test("MCP-style requests without timeoutMs skip the handshake", async () => {
        const { deps } = withSpy()
        const { url, close } = await start(minimalConfig(), deps)
        try {
            expect((await post(url, { trigger: "mcp_tool" })).status).toBe(200)
        } finally {
            await close()
        }
    })

    test("the deadline keeps a response margin of min(5 s, limit / 10)", () => {
        expect(requestDeadline(1000, null)).toBeNull()
        expect(requestDeadline(0, 3000)).toBe(2700)
        expect(requestDeadline(0, 600_000)).toBe(595_000)
    })
})

describe("/status surfaces the version", () => {
    test("/status response body has a top-level version string", async () => {
        const { url, close } = await start(minimalConfig(), happyDeps)
        try {
            const r = await signedFetch(url, "/status")
            expect(r.status).toBe(200)
            const body = await r.json()
            expect(typeof body.version).toBe("string")
            expect(body.version).toBe(VERSION)
        } finally {
            await close()
        }
    })
})

describe("GET / dashboard route", () => {
    test("is reachable WITHOUT x-review-token (localhost-only trust boundary)", async () => {
        const { url, close } = await start(minimalConfig(), happyDeps)
        try {
            const r = await fetch(`${url}/`)
            expect(r.status).toBe(200)
            expect(r.headers.get("content-type")).toMatch(/text\/html/)
            const body = await r.text()
            expect(body).toMatch(/^<!doctype html>/)
            expect(body).toContain(VERSION)
            expect(body).toContain("review-orchestrator")
        } finally {
            await close()
        }
    })

    test("does not leak the auth token into the rendered HTML", async () => {
        const { url, close } = await start(minimalConfig(), happyDeps)
        try {
            const r = await fetch(`${url}/`)
            const body = await r.text()
            // Whatever the auth token is in config, it must not appear
            // in the public dashboard.
            expect(body).not.toContain("secret")
        } finally {
            await close()
        }
    })
})

describe("hook connection: challenge, server.json, credentials, rotation", () => {
    const startWithFiles = async (config = minimalConfig()) => {
        const dir = mkdtempSync(path.join(tmpdir(), "index-conn-"))
        const configPath = path.join(dir, "config.json")
        const credentialsPath = path.join(dir, "cache", "hook-credentials.json")
        const serverInfoPath = path.join(dir, "cache", "server.json")
        writeFileSync(configPath, JSON.stringify(config, null, 2))
        const store = makeStore()
        const r = await startServer({
            config,
            store,
            deps: happyDeps,
            log: silentLog,
            configPath,
            credentialsPath,
            serverInfoPath,
        })
        if (!r.ok) throw r.error
        const paths = { configPath, credentialsPath, serverInfoPath }
        return {
            ...paths,
            app: r.app,
            url: `http://127.0.0.1:${r.address.port}`,
            port: r.address.port,
            connectNow: () =>
                connect({
                    ...paths,
                    sleep: async () => {},
                }),
            close: () =>
                new Promise((done) =>
                    r.server.close(() => {
                        rmSync(dir, { recursive: true, force: true })
                        rmSync(store.__dir, { recursive: true, force: true })
                        done()
                    })
                ),
        }
    }
    const until = async (check) => {
        for (let i = 0; i < 100 && !check(); i++) {
            await new Promise((r) => setTimeout(r, 10))
        }
        return check()
    }

    test("/healthz names the service and instance, and proves the token on a challenge", async () => {
        const s = await startWithFiles()
        try {
            const plain = await (await fetch(`${s.url}/healthz`)).json()
            expect(plain).toMatchObject({
                ok: true,
                service: "review-orchestrator",
                instanceId: s.app.locals.instanceId,
            })
            const bad = await fetch(`${s.url}/healthz?challenge=short`)
            expect(bad.status).toBe(400)
            await expect(
                challengeAt({ baseUrl: s.url, token: "secret" })
            ).resolves.toEqual({
                ok: true,
                instanceId: s.app.locals.instanceId,
            })
        } finally {
            await s.close()
        }
    })

    test("server.json carries the live address and wait; hook-credentials.json is written at startup", async () => {
        const s = await startWithFiles()
        try {
            const info = JSON.parse(readFileSync(s.serverInfoPath, "utf8"))
            expect(info).toMatchObject({
                pid: process.pid,
                port: s.port,
                bind: "127.0.0.1",
                instanceId: s.app.locals.instanceId,
                // codexTimeoutSeconds 240, claude/gemini defaults 600 → 660 s
                hookTimeoutMs: 660_000,
            })
            expect(statSync(s.serverInfoPath).mode & 0o777).toBe(0o600)
            expect(await until(() => existsSync(s.credentialsPath))).toBe(true)
            expect(
                JSON.parse(readFileSync(s.credentialsPath, "utf8"))
            ).toMatchObject({ token: "secret", port: 0 })
        } finally {
            await s.close()
        }
    })

    test("a config transaction (what dashboard edits run) that changes the wait rewrites server.json", async () => {
        const s = await startWithFiles()
        try {
            await s.app.locals.configStore.mutate([
                [["limits", "codexTimeoutSeconds"], 900],
            ])
            const info = JSON.parse(readFileSync(s.serverInfoPath, "utf8"))
            expect(info.hookTimeoutMs).toBe(960_000)
        } finally {
            await s.close()
        }
    })

    test("a hook-style client picks server.json's address and gets verified answers; /status reports the auth state", async () => {
        const s = await startWithFiles()
        try {
            const conn = await s.connectNow()
            expect(conn).toMatchObject({
                ok: true,
                credentialsSource: "config",
            })
            expect(conn.server).toMatchObject({
                source: "server.json",
                hookTimeoutMs: 660_000,
            })
            const status = await conn.request({
                method: "GET",
                path: "/status",
                timeoutMs: 5000,
            })
            expect(status.httpStatus).toBe(200)
            expect(status.body.auth).toEqual({
                currentTokenHash: createHash("sha256")
                    .update("secret")
                    .digest("hex"),
                previousTokenGrace: null,
            })
            expect(status.body.instanceId).toBe(s.app.locals.instanceId)
            const review = await conn.request({
                method: "POST",
                path: "/review",
                body: {
                    cwd: "/repo",
                    trigger: "stop_hook",
                    timeoutMs: 660_000,
                },
                timeoutMs: 10_000,
            })
            expect(review).toMatchObject({
                httpStatus: 200,
                body: { status: "GOOD_TO_GO" },
            })
        } finally {
            await s.close()
        }
    })

    test("a rotation: the new token works at once, the old one only in its grace, and --revoke-now ends it", async () => {
        const s = await startWithFiles()
        try {
            const old = await s.connectNow()
            const rotated = await rotateToken({
                configPath: s.configPath,
                credentialsPath: s.credentialsPath,
            })
            // The old token, signed: still accepted, in grace.
            const inGrace = await old.request({
                method: "GET",
                path: "/status",
                timeoutMs: 5000,
            })
            expect(inGrace.httpStatus).toBe(200)
            expect(inGrace.body.auth.previousTokenGrace).toMatchObject({
                tokenHash: createHash("sha256").update("secret").digest("hex"),
            })
            // The new token, through the credentials the rotation wrote.
            const fresh = await s.connectNow()
            expect(fresh.creds.token).toBe(rotated.token)
            expect(
                (
                    await fresh.request({
                        method: "GET",
                        path: "/status",
                        timeoutMs: 5000,
                    })
                ).httpStatus
            ).toBe(200)
            // MCP keeps working on the old token during the grace.
            const mcp = await fetch(`${s.url}/mcp`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    accept: "application/json, text/event-stream",
                    "x-review-token": "secret",
                },
                body: "{}",
            })
            expect(mcp.status).not.toBe(401)
            await rotateToken({
                configPath: s.configPath,
                credentialsPath: s.credentialsPath,
                revokeNow: true,
            })
            const refused = await fresh.request({
                method: "GET",
                path: "/status",
                timeoutMs: 5000,
            })
            expect(refused.fetchError).toMatch(/HTTP 401 BAD_SIGNATURE/)
        } finally {
            await s.close()
        }
    })

    test("a hand-edited token is noticed on the next request and the hooks' credentials cache follows it", async () => {
        const s = await startWithFiles()
        try {
            const cfg = JSON.parse(readFileSync(s.configPath, "utf8"))
            cfg.authToken = "hand-edited"
            writeFileSync(s.configPath, JSON.stringify(cfg))
            const conn = await s.connectNow()
            expect(conn.creds.token).toBe("hand-edited")
            expect(
                (
                    await conn.request({
                        method: "GET",
                        path: "/status",
                        timeoutMs: 5000,
                    })
                ).httpStatus
            ).toBe(200)
            const cached = () =>
                JSON.parse(readFileSync(s.credentialsPath, "utf8")).token
            for (let i = 0; i < 100 && cached() !== "hand-edited"; i++) {
                await new Promise((r) => setTimeout(r, 10))
            }
            expect(cached()).toBe("hand-edited")
        } finally {
            await s.close()
        }
    })

    test("server.json republishes the hook wait when a reload becomes pending and again when it applies", async () => {
        const s = await startWithFiles()
        try {
            const wait = () =>
                JSON.parse(readFileSync(s.serverInfoPath, "utf8")).hookTimeoutMs
            expect(wait()).toBe(660_000)
            const ticket = await s.app.locals.reloads.admitReview()
            const cfg = JSON.parse(readFileSync(s.configPath, "utf8"))
            cfg.reviewer = {
                ...(cfg.reviewer ?? {}),
                claude: { timeoutSeconds: 900 },
            }
            writeFileSync(s.configPath, JSON.stringify(cfg))
            const r = await s.app.locals.reloads.trigger()
            expect(r).toMatchObject({ scheduled: true })
            // The larger wait plus the 45 s hold allowance.
            expect(wait()).toBe(960_000 + 45_000)
            ticket.release()
            for (let i = 0; i < 100 && wait() !== 960_000; i++) {
                await new Promise((res) => setTimeout(res, 10))
            }
            expect(wait()).toBe(960_000)
        } finally {
            await s.close()
        }
    })
})

describe("createServerInfo", () => {
    const make = (over = {}) => {
        const dir = mkdtempSync(path.join(tmpdir(), "server-info-"))
        const file = path.join(dir, "server.json")
        let wait = 1000
        const info = createServerInfo({
            path: file,
            instanceId: "inst-1",
            startedAt: 0,
            hookTimeoutMs: () => wait,
            logger: silentLog,
            pid: 42,
            ...over,
        })
        return {
            info,
            file,
            setWait: (ms) => {
                wait = ms
            },
            cleanup: () => rmSync(dir, { recursive: true, force: true }),
        }
    }

    test("writes once it has an address, again only when something changed, and removes only its own file", () => {
        const t = make()
        try {
            expect(t.info.refresh()).toBe(false)
            expect(
                t.info.setAddress({ port: 7777, address: "127.0.0.1" })
            ).toBe(true)
            expect(JSON.parse(readFileSync(t.file, "utf8"))).toEqual({
                pid: 42,
                port: 7777,
                bind: "127.0.0.1",
                startedAt: "1970-01-01T00:00:00.000Z",
                instanceId: "inst-1",
                hookTimeoutMs: 1000,
            })
            expect(t.info.refresh()).toBe(false)
            t.setWait(2000)
            expect(t.info.refresh()).toBe(true)
            writeFileSync(t.file, JSON.stringify({ instanceId: "newer" }))
            expect(t.info.remove()).toBe(false)
            expect(existsSync(t.file)).toBe(true)
            t.info.setAddress({ port: 7778, address: "127.0.0.1" })
            expect(t.info.remove()).toBe(true)
            expect(existsSync(t.file)).toBe(false)
            expect(t.info.remove()).toBe(false)
        } finally {
            t.cleanup()
        }
    })

    test("without a path it writes nothing; a failed write is logged", () => {
        const none = createServerInfo({
            path: null,
            instanceId: "i",
            startedAt: 0,
            hookTimeoutMs: () => 1,
        })
        expect(none.setAddress({ port: 1, address: "x" })).toBe(false)
        expect(none.remove()).toBe(false)
        const warn = jest.fn()
        const t = make({
            write: () => {
                throw new Error("EROFS")
            },
            logger: { warn },
        })
        try {
            expect(t.info.setAddress({ port: 1, address: "x" })).toBe(false)
            expect(warn).toHaveBeenCalledWith(
                { err: "EROFS" },
                "failed to write server.json"
            )
            expect(t.info.remove()).toBe(false)
        } finally {
            t.cleanup()
        }
    })
})

describe("dashboard safety and reload controls over HTTP (§5.8)", () => {
    // fetch can't set Host; node:http can.
    const rawGet = (url, path, headers) =>
        new Promise((resolve, reject) => {
            const u = new URL(url)
            const req = http.request(
                {
                    hostname: u.hostname,
                    port: u.port,
                    path,
                    method: "GET",
                    headers,
                },
                (res) => {
                    let body = ""
                    res.on("data", (c) => (body += c))
                    res.on("end", () =>
                        resolve({ status: res.statusCode, body })
                    )
                }
            )
            req.on("error", reject)
            req.end()
        })

    test("a request naming another host (DNS rebinding) gets 421 on every route", async () => {
        const { url, close } = await start(minimalConfig())
        try {
            for (const path of ["/", "/healthz", "/inflight", "/status"]) {
                const r = await rawGet(url, path, {
                    host: `evil.example:${new URL(url).port}`,
                })
                expect(r.status).toBe(421)
                expect(JSON.parse(r.body).code).toBe("HOST_NOT_ALLOWED")
            }
            const ok = await rawGet(url, "/healthz", {
                host: `localhost:${new URL(url).port}`,
            })
            expect(ok.status).toBe(200)
        } finally {
            await close()
        }
    })

    test("the page can't be framed and embeds this start's token and versions", async () => {
        const { url, app, close } = await start(minimalConfig())
        try {
            const r = await fetch(`${url}/`)
            expect(r.headers.get("x-frame-options")).toBe("DENY")
            expect(r.headers.get("content-security-policy")).toBe(
                "frame-ancestors 'none'"
            )
            const html = await r.text()
            expect(html).toContain(`data-csrf="${app.locals.dashboardCsrf}"`)
            const { coreVersion } = await (
                await fetch(`${url}/inflight`)
            ).json()
            expect(coreVersion).toMatch(/^[0-9a-f]{16}$/)
            expect(html).toContain(`data-core-version="${coreVersion}"`)
            expect(html).toContain('data-reload-action="reload"')
        } finally {
            await close()
        }
    })

    test("an action without the page's token, from another origin, or not JSON is refused", async () => {
        const { url, app, close } = await start(minimalConfig())
        try {
            const put = (headers, body = '{"value":7}') =>
                fetch(`${url}/dashboard/max-rounds`, {
                    method: "PUT",
                    headers,
                    body,
                })
            const csrf = app.locals.dashboardCsrf
            let r = await put({
                "content-type": "application/json",
                origin: url,
            })
            expect(r.status).toBe(403)
            expect((await r.json()).code).toBe("BAD_DASHBOARD_TOKEN")
            r = await put({
                "content-type": "application/json",
                origin: "http://evil.example",
                "x-dashboard-csrf": csrf,
            })
            expect((await r.json()).code).toBe("CROSS_ORIGIN")
            r = await put({
                "content-type": "text/plain",
                origin: url,
                "x-dashboard-csrf": csrf,
            })
            expect(r.status).toBe(415)
            expect(app.locals.live.config.limits.maxCodexRounds).toBe(5)
            // The same request done right goes through.
            r = await dashboardFetch(url, "/dashboard/max-rounds", {
                method: "PUT",
                body: { value: 7 },
            })
            expect(r.status).toBe(200)
        } finally {
            await close()
        }
    })

    test("a page from another dashboard API is told to reload", async () => {
        const { url, close } = await start(minimalConfig())
        try {
            const r = await dashboardFetch(url, "/dashboard/max-rounds", {
                method: "PUT",
                body: { value: 7 },
                headers: { "x-dashboard-api": "0" },
            })
            expect(r.status).toBe(409)
            expect((await r.json()).code).toBe("PAGE_OUTDATED")
        } finally {
            await close()
        }
    })

    test("the reload buttons drive the same controller as /admin/reload", async () => {
        const { url, close } = await start(minimalConfig())
        try {
            let r = await dashboardFetch(url, "/dashboard/reload", {
                body: {},
            })
            expect(await r.json()).toMatchObject({ ok: true, unchanged: true })
            r = await dashboardFetch(url, "/dashboard/reload", {
                body: { rollback: true },
            })
            expect(r.status).toBe(409)
            expect(await r.json()).toMatchObject({
                ok: false,
                code: "NOTHING_TO_ROLL_BACK",
            })
            // Only literal true counts.
            r = await dashboardFetch(url, "/dashboard/reload", {
                body: { cancel: "yes" },
            })
            expect(await r.json()).toMatchObject({ unchanged: true })
        } finally {
            await close()
        }
    })
})

describe("dashboard guards across routes and restarts (§9 dashboard CSRF)", () => {
    test("421 for a foreign Host covers the dashboard actions and /mcp too", async () => {
        const { url, close } = await start(minimalConfig())
        try {
            const port = new URL(url).port
            for (const [method, path] of [
                ["POST", "/dashboard/reload"],
                ["PUT", "/dashboard/max-rounds"],
                ["POST", "/mcp"],
            ]) {
                const status = await new Promise((resolve, reject) => {
                    const req = http.request(
                        {
                            hostname: "127.0.0.1",
                            port,
                            path,
                            method,
                            headers: {
                                host: `evil.example:${port}`,
                                "content-type": "application/json",
                            },
                        },
                        (res) => {
                            res.resume()
                            resolve(res.statusCode)
                        }
                    )
                    req.on("error", reject)
                    req.end("{}")
                })
                expect(status).toBe(421)
            }
        } finally {
            await close()
        }
    })

    test("a cross-origin reload, rollback or cancel is refused and nothing reloads", async () => {
        const { url, app, close } = await start(minimalConfig())
        try {
            for (const body of [{}, { rollback: true }, { cancel: true }]) {
                const r = await fetch(`${url}/dashboard/reload`, {
                    method: "POST",
                    headers: {
                        "content-type": "application/json",
                        origin: "http://evil.example",
                        "x-dashboard-csrf": app.locals.dashboardCsrf,
                    },
                    body: JSON.stringify(body),
                })
                expect(r.status).toBe(403)
            }
            expect(app.locals.reloads.status()).toMatchObject({
                appliedCount: 0,
                history: [],
            })
        } finally {
            await close()
        }
    })

    test("every server start gets its own dashboard token", async () => {
        const a = await start(minimalConfig())
        const b = await start(minimalConfig())
        try {
            expect(a.app.locals.dashboardCsrf).toMatch(/^[A-Za-z0-9_-]{43}$/)
            expect(a.app.locals.dashboardCsrf).not.toBe(
                b.app.locals.dashboardCsrf
            )
            // A's token is no good on B.
            const r = await fetch(`${b.url}/dashboard/reload`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    origin: b.url,
                    "x-dashboard-csrf": a.app.locals.dashboardCsrf,
                },
                body: "{}",
            })
            expect((await r.json()).code).toBe("BAD_DASHBOARD_TOKEN")
        } finally {
            await a.close()
            await b.close()
        }
    })
})
