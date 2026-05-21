/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { jest } from "@jest/globals"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createApp, startServer } from "./index.js"
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
