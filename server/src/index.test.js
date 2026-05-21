/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { createApp } from "./index.js"

const minimalConfig = () => ({
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
        },
        totalBytes: 100,
        truncated: false,
        promptText: "payload",
        empty: false,
        nonBinaryFileCount: 1,
    }),
    runAndParse: async () => ({
        status: "GOOD_TO_GO",
        findings: [],
        raw: { durationMs: 12, exitCode: 0, timedOut: false },
    }),
}

const start = (config, deps) =>
    new Promise((resolve) => {
        const app = createApp(config, deps)
        const server = app.listen(0, "127.0.0.1", () => {
            const { port } = server.address()
            resolve({
                server,
                url: `http://127.0.0.1:${port}`,
                close: () =>
                    new Promise((r) => {
                        server.close(() => r())
                    }),
            })
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
