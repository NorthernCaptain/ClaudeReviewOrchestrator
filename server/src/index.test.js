/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { jest } from "@jest/globals"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
    createApp,
    startServer,
    gracefulShutdown,
    checkReviewerEnv,
    summarizeStartup,
    VERSION,
} from "./index.js"
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

const start = async (config, deps = happyDeps, providedStore = null) => {
    const store = providedStore ?? makeStore()
    const r = await startServer({ config, store, deps, log: silentLog })
    if (!r.ok) {
        if (!providedStore)
            rmSync(store.__dir, { recursive: true, force: true })
        throw r.error
    }
    return {
        server: r.server,
        store,
        url: `http://127.0.0.1:${r.address.port}`,
        port: r.address.port,
        close: () =>
            new Promise((res) => {
                r.server.close(() => {
                    if (!providedStore) {
                        rmSync(store.__dir, {
                            recursive: true,
                            force: true,
                        })
                    }
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

    test("PUT /dashboard/provider switches in-memory without a token (v0.1.35)", async () => {
        // Inject a fake fs so handleSetProvider's persistence step
        // doesn't touch the real ~/.config/review-orchestrator/config.json
        // when the test exercises the endpoint.
        let writtenJson = null
        const fakeFs = {
            readFileSync: () => JSON.stringify({ reviewer: { provider: "codex" } }),
            writeFileSync: (_p, data) => {
                writtenJson = data
            },
        }
        const cfg = minimalConfig({ reviewer: { provider: "codex" } })
        const { url, close } = await start(cfg, { ...happyDeps, fs: fakeFs })
        try {
            expect(cfg.reviewer?.provider).toBe("codex")
            const r = await fetch(`${url}/dashboard/provider`, {
                method: "PUT",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ provider: "gemini" }),
            })
            expect(r.status).toBe(200)
            const body = await r.json()
            expect(body.ok).toBe(true)
            expect(body.provider).toBe("gemini")
            expect(cfg.reviewer.provider).toBe("gemini")
            // Persistence wrote through the fake fs, not the real file.
            expect(writtenJson).toMatch(/"provider": "gemini"/)
        } finally {
            await close()
        }
    })

    test("PUT /dashboard/provider rejects an unknown provider with 400", async () => {
        const { url, close } = await start(minimalConfig(), {
            ...happyDeps,
            fs: { readFileSync: () => "{}", writeFileSync: () => {} },
        })
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

    test("POST /dashboard/reset clears the context without a token (v0.1.35)", async () => {
        const { url, store, close } = await start(minimalConfig(), happyDeps)
        try {
            store.save("/repo|main", {
                repoRoot: "/repo",
                branch: "main",
                codexRounds: 4,
                blockCount: 3,
                lastReviewedAt: 1,
            })
            const r = await fetch(`${url}/dashboard/reset`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ cwd: "/repo" }),
            })
            expect(r.status).toBe(200)
            const body = await r.json()
            expect(body.ok).toBe(true)
            expect(body.state.codexRounds).toBe(0)
            expect(body.state.blockCount).toBe(0)
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
    test("createApp exposes mcp.closeAllSessions on app.locals", () => {
        const store = createStateStore({ filePath: null, now: () => 0 })
        const app = createApp({
            config: minimalConfig(),
            store,
            archive: null,
            logger: silentLog,
            deps: happyDeps,
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

describe("VERSION + summarizeStartup", () => {
    test("VERSION is a non-empty semver-ish string read from package.json", () => {
        expect(typeof VERSION).toBe("string")
        expect(VERSION.length).toBeGreaterThan(0)
        // Should match major.minor.patch (allowing pre-release suffix).
        expect(VERSION).toMatch(/^\d+\.\d+\.\d+(-.+)?$/)
    })

    test("summarizeStartup picks codex sub-config and effort", () => {
        const cfg = {
            port: 7777,
            bind: "127.0.0.1",
            reviewer: { provider: "codex" },
            codex: { model: "gpt-5.5", reasoningEffort: "high" },
            limits: {
                codexTimeoutSeconds: 240,
                maxCodexRounds: 5,
                maxBlocks: 6,
            },
            allowedRoots: ["/r"],
            blockingSeverities: ["blocker", "major"],
        }
        const s = summarizeStartup(cfg, "0.1.0")
        expect(s.version).toBe("0.1.0")
        expect(s.provider).toBe("codex")
        expect(s.model).toBe("gpt-5.5")
        expect(s.effortOrMode).toBe("high")
        expect(s.reviewerTimeoutSeconds).toBe(240)
        expect(s.maxCodexRounds).toBe(5)
        expect(s.allowedRootsCount).toBe(1)
    })

    test("summarizeStartup picks claude sub-config and effort", () => {
        const cfg = {
            port: 7777,
            reviewer: {
                provider: "claude",
                claude: { model: "claude-opus-4-7", effort: "medium", timeoutSeconds: 600 },
            },
            limits: { codexTimeoutSeconds: 240 },
        }
        const s = summarizeStartup(cfg, "0.1.0")
        expect(s.provider).toBe("claude")
        expect(s.model).toBe("claude-opus-4-7")
        expect(s.effortOrMode).toBe("medium")
        // claude's timeoutSeconds wins over the codex fallback.
        expect(s.reviewerTimeoutSeconds).toBe(600)
    })

    test("summarizeStartup picks gemini sub-config and approvalMode", () => {
        const cfg = {
            port: 7777,
            reviewer: {
                provider: "gemini",
                gemini: {
                    model: "auto",
                    approvalMode: "plan",
                    timeoutSeconds: 600,
                },
            },
            limits: { codexTimeoutSeconds: 240 },
        }
        const s = summarizeStartup(cfg, "0.1.0")
        expect(s.provider).toBe("gemini")
        expect(s.model).toBe("auto")
        expect(s.effortOrMode).toBe("plan")
        expect(s.reviewerTimeoutSeconds).toBe(600)
    })

    test("summarizeStartup surfaces hookFetchTimeoutSeconds=null when auto-derive is in effect", () => {
        const s = summarizeStartup({
            reviewer: { provider: "gemini", gemini: { model: "auto" } },
            hook: { fetchTimeoutSeconds: null },
            limits: { codexTimeoutSeconds: 240 },
        })
        // null is the documented "auto-derive in stop-review.mjs" signal —
        // we surface it verbatim rather than recomputing the derived
        // number here (which would drift if the derivation changes).
        expect(s.hookFetchTimeoutSeconds).toBeNull()
    })

    test("summarizeStartup surfaces a pinned hookFetchTimeoutSeconds", () => {
        const s = summarizeStartup({
            reviewer: { provider: "gemini", gemini: { model: "auto" } },
            hook: { fetchTimeoutSeconds: 800 },
            limits: { codexTimeoutSeconds: 240 },
        })
        expect(s.hookFetchTimeoutSeconds).toBe(800)
    })

    test("summarizeStartup defaults provider to codex when reviewer block is absent", () => {
        const s = summarizeStartup({
            port: 7777,
            codex: { model: "gpt-5.5", reasoningEffort: "high" },
            limits: { codexTimeoutSeconds: 240 },
        })
        expect(s.provider).toBe("codex")
        expect(s.model).toBe("gpt-5.5")
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
