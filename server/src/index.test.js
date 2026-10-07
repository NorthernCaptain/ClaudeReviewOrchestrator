/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { jest } from "@jest/globals"
import { execFileSync } from "node:child_process"
import {
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
    createApp,
    startServer,
    gracefulShutdown,
    checkReviewerEnv,
    requestDeadline,
    VERSION,
} from "./index.js"
import { loadDefaultCore } from "./core-loader.js"
import { createStateStore } from "./state.js"

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
            const result = await startServer({
                config: cfg,
                store: makeStore(),
                deps: happyDeps,
                log: silentLog,
            })
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
        const r = await startServer({
            config: minimalConfig({ allowedRoots: [repo] }),
            store,
            log: silentLog,
        })
        const url = `http://127.0.0.1:${r.address.port}`
        try {
            const post = (route) =>
                fetch(`${url}${route}`, {
                    method: "POST",
                    headers: {
                        "content-type": "application/json",
                        "x-review-token": "secret",
                    },
                    body: JSON.stringify({ cwd: repo }),
                })
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
            const review = fetch(`${a.url}/review`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "x-review-token": minimalConfig().authToken,
                },
                body: JSON.stringify({ cwd: "/repo" }),
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
            const r = await fetch(`${url}/dashboard/provider`, {
                method: "PUT",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ provider: "gemini" }),
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
            const r = await fetch(`${url}/dashboard/provider`, {
                method: "PUT",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ provider: "bogus" }),
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
            const r = await fetch(`${url}/dashboard/reviewer-preset`, {
                method: "PUT",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ preset: "gpt-6-astra:medium" }),
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
            const r = await fetch(`${url}/dashboard/max-rounds`, {
                method: "PUT",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ value: 8 }),
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
            const r = await fetch(`${url}/dashboard/max-rounds`, {
                method: "PUT",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ value: 0 }),
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
            const r = await fetch(`${url}/dashboard/reset`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ contextKey: "/repo|feature" }),
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
            const r = await fetch(`${url}/dashboard/reset`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({}),
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

    test("loopbackOnly: allows 127.0.0.1, ::1, ::ffff:127.0.0.1; rejects others 403", async () => {
        const { loopbackOnly } = await import("./index.js")
        const mkReq = (ip) => ({ ip, socket: { remoteAddress: ip } })
        const mkRes = () => {
            const res = { statusCode: 0, body: null }
            res.status = (c) => {
                res.statusCode = c
                return res
            }
            res.json = (b) => {
                res.body = b
                return res
            }
            return res
        }
        for (const ip of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
            const res = mkRes()
            let nexted = false
            loopbackOnly(mkReq(ip), res, () => {
                nexted = true
            })
            expect(nexted).toBe(true)
            expect(res.statusCode).toBe(0)
        }
        for (const ip of ["10.0.0.1", "192.168.1.5", "::ffff:10.0.0.1", ""]) {
            const res = mkRes()
            let nexted = false
            loopbackOnly(mkReq(ip), res, () => {
                nexted = true
            })
            expect(nexted).toBe(false)
            expect(res.statusCode).toBe(403)
            expect(res.body.ok).toBe(false)
            expect(res.body.error).toMatch(/loopback only/i)
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
            const add = await fetch(`${url}/dashboard/exclusions`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    contextKey: "/r|main",
                    file: "a.js",
                    message: "noise",
                    action: "add",
                }),
            })
            expect(add.status).toBe(200)
            const addBody = await add.json()
            expect(addBody.exclusions).toHaveLength(1)
            const remove = await fetch(`${url}/dashboard/exclusions`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    contextKey: "/r|main",
                    file: "a.js",
                    message: "noise",
                    action: "remove",
                }),
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
            const r = await fetch(`${url}/dashboard/exclusions`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    contextKey: "/nope|x",
                    file: "a",
                    message: "m",
                    action: "add",
                }),
            })
            expect(r.status).toBe(404)
        } finally {
            await close()
        }
    })

    test("POST /dashboard/reset rejects an unknown contextKey with 404", async () => {
        const { url, close } = await start(minimalConfig(), happyDeps)
        try {
            const r = await fetch(`${url}/dashboard/reset`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ contextKey: "/nope|x" }),
            })
            expect(r.status).toBe(404)
        } finally {
            await close()
        }
    })

    test("/review rejects with 401 when token is missing", async () => {
        const { url, close } = await start(minimalConfig(), happyDeps)
        try {
            const r = await fetch(`${url}/review`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ cwd: "/repo" }),
            })
            expect(r.status).toBe(401)
            const body = await r.json()
            expect(body.code).toBe("UNAUTHORIZED")
        } finally {
            await close()
        }
    })

    test("/review rejects with 401 when token is wrong", async () => {
        const { url, close } = await start(minimalConfig(), happyDeps)
        try {
            const r = await fetch(`${url}/review`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "x-review-token": "nope",
                },
                body: JSON.stringify({ cwd: "/repo" }),
            })
            expect(r.status).toBe(401)
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
            const r = await fetch(`${url}/reset`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "x-review-token": "secret",
                },
                body: JSON.stringify({ cwd: "/repo" }),
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
            const r = await fetch(`${url}/review`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "x-review-token": "secret",
                },
                body: JSON.stringify({ cwd: "/repo" }),
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
        const app = createApp({
            config,
            store,
            archive: null,
            logger: silentLog,
            deps: happyDeps,
            core: await loadDefaultCore({
                config,
                shellVersion: VERSION,
                startedAt: 0,
            }),
        })
        expect(typeof app.locals?.mcp?.closeAllSessions).toBe("function")
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
        fetch(`${url}/review`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-review-token": "secret",
            },
            body: JSON.stringify({ cwd: "/repo", ...body }),
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
            const r = await fetch(`${url}/status`, {
                headers: { "x-review-token": "secret" },
            })
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
