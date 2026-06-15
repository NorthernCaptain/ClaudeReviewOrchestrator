/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { readFileSync } from "node:fs"
import path from "node:path"
import express from "express"
import { loadConfig, defaultConfigPath } from "./config.js"
import { VERSION } from "./version.js"

export { VERSION }
import { authMiddleware } from "./auth.js"
import { mountReviewRoute, snapshotInFlight } from "./review.js"
import { mountResetRoute } from "./reset.js"
import { mountMcpRoute } from "./mcp.js"
import { mountStatusRoute } from "./status.js"
import { mountDashboardRoute } from "./dashboard.js"
import { mountNotifyChangeRoute } from "./notify-change.js"
import { mountProviderRoute, handleSetProvider } from "./provider.js"
import { handleExclusionMutation } from "./exclusions.js"
import { handleSetMaxRounds } from "./maxRounds.js"
import { handleSetMaxBlocks } from "./maxBlocks.js"
import { handleSetBlockingSeverities } from "./blockingSeverities.js"
import { createStateStore } from "./state.js"
import { createArchive } from "./archive.js"
import { createMetrics } from "./metrics.js"
import { logger } from "./logger.js"
import { createHttpAccessLog, createHttpErrorHandler } from "./http-log.js"

// Build the structured "ready" log line emitted right after the server
// starts accepting connections. Includes the version and the
// non-sensitive subset of config the operator needs to verify the
// daemon picked up the right knobs after a config change. Pure
// function — exported for unit testing.
// Inline yin-yang favicon (v0.1.36). Colors match the dashboard's dark
// slate palette so the tab icon reads as the same UI. Served from
// /favicon.svg and /favicon.ico (browsers auto-request the latter when
// no <link rel="icon"> is found — we serve the same SVG body either
// way to avoid a 404 on the tab).
export const FAVICON_SVG =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` +
    `<circle cx="32" cy="32" r="30" fill="#f1f5f9"/>` +
    `<path d="M 32 2 A 30 30 0 0 1 32 62 A 15 15 0 0 0 32 32 A 15 15 0 0 1 32 2 Z" fill="#0f172a"/>` +
    `<circle cx="32" cy="47" r="4" fill="#f1f5f9"/>` +
    `<circle cx="32" cy="17" r="4" fill="#0f172a"/>` +
    `</svg>`

// Express middleware that rejects any peer that isn't on the loopback
// interface (127.0.0.1, ::1, or the v4-in-v6 form). Belt for the
// dashboard mutation routes (POST /dashboard/reset, PUT /dashboard/
// provider) so the operator widening `bind` from 127.0.0.1 to 0.0.0.0
// doesn't accidentally expose them to the network. Returns 403 with a
// clear `error` field; never proxies the request through.
export const loopbackOnly = (req, res, next) => {
    const ip = req.ip || req.socket?.remoteAddress || ""
    const ok = ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1"
    if (!ok) {
        return res
            .status(403)
            .json({ ok: false, error: "loopback only", remote: ip })
    }
    next()
}

export const summarizeStartup = (config, version = VERSION) => {
    const provider = config?.reviewer?.provider ?? "codex"
    const providerCfg =
        provider === "claude"
            ? config?.reviewer?.claude
            : provider === "gemini"
              ? config?.reviewer?.gemini
              : config?.codex
    const effortOrMode =
        provider === "claude"
            ? (providerCfg?.effort ?? null)
            : provider === "gemini"
              ? (providerCfg?.approvalMode ?? null)
              : (providerCfg?.reasoningEffort ?? null)
    const hookCfg = config?.hook?.fetchTimeoutSeconds
    return {
        version,
        port: config?.port,
        bind: config?.bind,
        provider,
        model: providerCfg?.model ?? null,
        effortOrMode,
        reviewerTimeoutSeconds:
            providerCfg?.timeoutSeconds ??
            config?.limits?.codexTimeoutSeconds ??
            null,
        hookFetchTimeoutSeconds:
            // null in config → auto-derive in stop-review.mjs; surface
            // that intent here rather than papering over it with a
            // recomputed number that may drift if logic changes.
            hookCfg === undefined ? null : hookCfg,
        maxCodexRounds: config?.limits?.maxCodexRounds ?? null,
        maxBlocks: config?.limits?.maxBlocks ?? null,
        allowedRootsCount: Array.isArray(config?.allowedRoots)
            ? config.allowedRoots.length
            : 0,
        blockingSeverities: config?.blockingSeverities ?? [],
    }
}

export const createApp = ({
    config,
    store,
    archive = null,
    logger: log = logger,
    deps = {},
    startedAt = Date.now(),
    metrics = createMetrics(),
    configPath = defaultConfigPath(),
}) => {
    const app = express()
    app.disable("x-powered-by")

    // Access log runs before body parsing so we see every incoming
    // request including ones rejected by JSON parsing or auth. It logs
    // on response finish/close so the line carries the final status and
    // duration.
    app.use(createHttpAccessLog({ logger: log }))
    app.use(express.json({ limit: "1mb" }))

    app.get("/healthz", (_req, res) => {
        res.json({ ok: true })
    })

    // Yin-yang favicon. Same body served for /favicon.svg AND
    // /favicon.ico (the latter is what browsers auto-fetch when no
    // <link rel="icon"> is present; serving the SVG keeps the tab from
    // logging a 404 noise on every page load).
    const sendFavicon = (_req, res) => {
        res.setHeader("Content-Type", "image/svg+xml")
        res.setHeader("Cache-Control", "public, max-age=86400")
        res.status(200).send(FAVICON_SVG)
    }
    app.get("/favicon.svg", sendFavicon)
    app.get("/favicon.ico", sendFavicon)

    // GET /inflight — live snapshot of running reviews. Public (mounted
    // before auth) because the dashboard page polls it without a token,
    // same trust boundary as GET /. Exposes only repo/branch/elapsed,
    // no diff or finding content.
    app.get("/inflight", (_req, res) => {
        res.setHeader("Cache-Control", "no-store")
        res.json({ ok: true, inFlight: snapshotInFlight(Date.now) })
    })

    // Dashboard control endpoints (v0.1.35). Mounted BEFORE auth so the
    // public dashboard page can use them without embedding the
    // X-Review-Token, but explicitly guarded to loopback peers
    // (v0.1.36) — these mutate live config / clear review state, so we
    // can't rely on `bind: 127.0.0.1` alone as the trust boundary. If
    // the operator ever widens the bind, these stay locked down. The
    // canonical authed routes (POST /reset, PUT /provider) remain
    // available for cross-host callers with a valid token.
    // Dashboard reset: takes `{ contextKey }` (preferred) — the
    // store key already encodes (repoRoot, branch), so unlike `cwd`
    // it can't be ambiguous when a repo has multiple branches in the
    // store. Validates against store.list() before touching state.
    app.post("/dashboard/reset", loopbackOnly, (req, res) => {
        const contextKey = req.body?.contextKey
        if (typeof contextKey !== "string" || contextKey.length === 0) {
            return res
                .status(400)
                .json({ ok: false, error: "contextKey is required" })
        }
        const known = (store?.list?.() ?? []).find((c) => c.key === contextKey)
        if (!known) {
            return res.status(404).json({
                ok: false,
                error: `unknown context: ${contextKey}`,
            })
        }
        const fresh = store.reset({
            key: known.key,
            repoRoot: known.repoRoot,
            branch: known.branch,
        })
        res.json({
            ok: true,
            context: {
                repo: known.repo ?? known.repoRoot?.split("/").pop() ?? null,
                repoRoot: known.repoRoot,
                branch: known.branch,
                key: known.key,
            },
            state: {
                codexRounds: fresh.codexRounds,
                blockCount: fresh.blockCount,
                lastResultStatus: fresh.lastResultStatus,
            },
        })
    })
    app.put("/dashboard/provider", loopbackOnly, (req, res) => {
        const result = handleSetProvider({
            body: req.body,
            config,
            configPath,
            logger: log,
            deps,
        })
        res.status(result.httpStatus).json(result.body)
    })

    // Per-context exclusion mutations (v1.1). Loopback-only; same trust
    // boundary as the other dashboard mutation routes.
    app.post("/dashboard/exclusions", loopbackOnly, (req, res) => {
        const result = handleExclusionMutation({ body: req.body, store })
        res.status(result.httpStatus).json(result.body)
    })

    // Adjust the codex-rounds cap from the dashboard (v1.1.8). Live +
    // best-effort persisted, same loopback trust boundary as the rest
    // of the dashboard mutation surface.
    app.put("/dashboard/max-rounds", loopbackOnly, (req, res) => {
        const result = handleSetMaxRounds({
            body: req.body,
            config,
            configPath,
            logger: log,
            deps,
        })
        res.status(result.httpStatus).json(result.body)
    })

    // Adjust the block cap from the dashboard (v1.1.19). Live +
    // best-effort persisted, same loopback trust boundary.
    app.put("/dashboard/max-blocks", loopbackOnly, (req, res) => {
        const result = handleSetMaxBlocks({
            body: req.body,
            config,
            configPath,
            logger: log,
            deps,
        })
        res.status(result.httpStatus).json(result.body)
    })

    // Pick which severities count as blocking from the dashboard
    // (v1.1.13). Live + best-effort persisted, same loopback trust
    // boundary as the rest of the dashboard mutation surface.
    app.put("/dashboard/blocking-severities", loopbackOnly, (req, res) => {
        const result = handleSetBlockingSeverities({
            body: req.body,
            config,
            configPath,
            logger: log,
            deps,
        })
        res.status(result.httpStatus).json(result.body)
    })

    // GET / — public dashboard. Mounted BEFORE the auth middleware so
    // it's reachable without the x-review-token. Safe because the
    // server binds 127.0.0.1 by default — the trust boundary is the
    // network bind, not an HTTP secret.
    mountDashboardRoute(app, {
        archive,
        config,
        store,
        summarize: summarizeStartup,
        version: VERSION,
        startedAt,
        metrics,
        inFlight: () => snapshotInFlight(Date.now),
    })

    app.use(authMiddleware({ token: config.authToken }))
    mountReviewRoute(app, {
        config,
        store,
        archive,
        logger: log,
        deps,
        metrics,
    })
    mountResetRoute(app, { config, store, deps })
    mountNotifyChangeRoute(app, { config, store, logger: log, deps })
    mountProviderRoute(app, { config, configPath, logger: log, deps })
    // Capture the MCP route's closeAllSessions so shutdown can drain
    // long-poll GETs (otherwise server.close() never resolves).
    const mcp = mountMcpRoute(app, {
        config,
        store,
        archive,
        logger: log,
        deps,
        metrics,
    })
    app.locals.mcp = mcp
    mountStatusRoute(app, {
        config,
        store,
        archive,
        startedAt,
        version: VERSION,
    })

    // Last middleware: catches errors from next(err) / async route
    // handlers. Logs with stack and returns a sanitized 500 to the
    // caller — never leaks the stack over the wire.
    app.use(createHttpErrorHandler({ logger: log }))

    return app
}

export const startServer = ({
    config,
    store,
    archive = null,
    deps = {},
    log = logger,
    startedAt = Date.now(),
    configPath = defaultConfigPath(),
} = {}) =>
    new Promise((resolve) => {
        const app = createApp({
            config,
            store,
            archive,
            logger: log,
            deps,
            startedAt,
            configPath,
        })
        const server = app.listen(config.port, config.bind)
        let settled = false

        // Track every accepted socket so a forced shutdown can destroy
        // any that are still open (e.g. an MCP long-poll GET that's
        // parked waiting for a server-initiated notification). Without
        // this, server.close() waits indefinitely on draining and
        // SIGINT looks like a hang to the operator.
        const sockets = new Set()
        server.on("connection", (socket) => {
            sockets.add(socket)
            socket.once("close", () => sockets.delete(socket))
        })

        const settle = (result) => {
            if (settled) return
            settled = true
            resolve(result)
        }

        server.once("error", (err) => {
            log.error(
                {
                    err: err.message,
                    code: err.code,
                    port: config.port,
                    bind: config.bind,
                },
                "failed to bind/listen"
            )
            settle({ ok: false, error: err })
        })

        server.once("listening", () => {
            const addr = server.address()
            if (!addr || typeof addr === "string") {
                log.error(
                    { addr, port: config.port, bind: config.bind },
                    "server reported listening with no resolvable address"
                )
                try {
                    server.close()
                } catch {
                    // ignore
                }
                settle({ ok: false, error: new Error("no address") })
                return
            }
            log.info(
                { port: addr.port, bind: addr.address },
                "review-orchestrator listening"
            )
            // Followed immediately by a structured config summary so
            // the operator can verify the daemon picked up the right
            // version + provider + timeouts without curling /status.
            log.info(summarizeStartup(config), "active config")
            settle({ ok: true, server, address: addr, sockets, app })
        })
    })

// Shut down the HTTP server cleanly. The contract:
//   1. Stop accepting new connections (server.close()).
//   2. Close MCP transports so SSE long-polls exit and stop pinning
//      sockets (without this, close() hangs).
//   3. Destroy any sockets that are still open after `socketDrainMs`.
//   4. Hard-exit via process.exit after `forceExitMs` if close() still
//      hasn't resolved (last-resort guard).
//
// Idempotent — calling twice is a no-op (in fact the second call is
// what hard-exits, matching the conventional "Ctrl-C twice to force"
// pattern).
//
// Returns a promise that resolves when server.close() completes (or
// rejects when the timeout hard-exits the process).
export const gracefulShutdown = ({
    server,
    sockets,
    mcp,
    logger: log = logger,
    socketDrainMs = 1500,
    forceExitMs = 5000,
    exit = (code) => process.exit(code),
    state = { stopping: false },
}) => {
    if (state.stopping) {
        log.warn({}, "shutdown re-entered — forcing exit")
        exit(1)
        return Promise.resolve()
    }
    state.stopping = true

    return new Promise((resolve, reject) => {
        let resolved = false
        const finish = (err) => {
            if (resolved) return
            resolved = true
            clearTimeout(drainTimer)
            clearTimeout(forceTimer)
            if (err) reject(err)
            else resolve()
        }

        // Track whether each side has settled so we resolve only after
        // both complete. Declared before either branch starts so the
        // server.close callback can read mcpSettled without TDZ issues.
        let serverCloseSettled = false
        let serverCloseErr = null
        let mcpSettled = false
        const maybeFinish = () => {
            if (serverCloseSettled && mcpSettled) finish(serverCloseErr)
        }

        // Stop accepting new connections IMMEDIATELY. server.close()
        // returns synchronously; the callback fires only when every
        // open connection has closed. We don't await it before kicking
        // off MCP cleanup — both phases run concurrently so a new GET
        // /mcp can't sneak in during the MCP-shutdown window.
        try {
            server.close((err) => {
                serverCloseSettled = true
                serverCloseErr = err ?? null
                if (err) {
                    log.error({ err: err.message }, "server.close errored")
                }
                maybeFinish()
            })
        } catch (err) {
            finish(err)
            return
        }

        // Run MCP shutdown concurrently. It releases the SSE long-poll
        // sockets that pin server.close, so without it close would
        // hang forever.
        const mcpClose = mcp?.closeAllSessions
            ? Promise.resolve()
                  .then(() => mcp.closeAllSessions())
                  .catch(() => null)
            : Promise.resolve()
        mcpClose.finally(() => {
            mcpSettled = true
            maybeFinish()
        })

        // Drain timer destroys lingering sockets after socketDrainMs.
        // Counts from gracefulShutdown entry (i.e. from when we called
        // server.close), which is the right reference point: server is
        // already not accepting new, and any sockets still open are
        // genuinely lingering.
        const drainTimer = setTimeout(() => {
            if (!sockets || sockets.size === 0) return
            log.warn(
                { lingering: sockets.size },
                "destroying lingering sockets to complete shutdown"
            )
            for (const s of sockets) {
                try {
                    s.destroy()
                } catch {
                    // ignore
                }
            }
        }, socketDrainMs).unref?.()

        // Last-resort force exit — covers the whole shutdown.
        const forceTimer = setTimeout(() => {
            log.error(
                { forceExitMs },
                "shutdown timed out — forcing process.exit(1)"
            )
            exit(1)
        }, forceExitMs).unref?.()
    })
}

// Pre-flight check: when reviewer.provider is "gemini" we want to fail
// loudly at startup rather than have every Stop hook ESCALATE in ~1s
// with an opaque exit code. But we only fail if BOTH of the following
// are true:
//   1. GEMINI_API_KEY is missing/empty in env.
//   2. The user's `~/.gemini/settings.json` says they're using the
//      `gemini-api-key` auth method (so a missing key really is fatal).
//      If selectedType is anything else (oauth-personal, vertex,
//      workload-identity, …) we trust the gemini CLI's filesystem-
//      cached credentials and let it run.
//
// Other providers handle their own auth gracefully (claude uses OAuth
// keychain by default; codex uses CODEX_HOME credentials or its own
// login flow), so no check is needed unless gemini is selected.
//
// Returns null when env is fine, or `{ message, hint }` describing the
// problem. Pure function — `env`, `home`, and `read` injectable for
// testability.
export const checkReviewerEnv = (
    config,
    env = process.env,
    { home = process.env.HOME ?? "", read = readFileSync } = {}
) => {
    const provider = config?.reviewer?.provider
    if (provider !== "gemini") return null
    const key = env?.GEMINI_API_KEY
    if (typeof key === "string" && key.length > 0) return null

    // No env key — see if the user has configured a non-api-key auth
    // method. If we can't read the file (missing / unreadable / not
    // JSON), assume the worst (api-key mode) and require the env var.
    let selectedType = "gemini-api-key"
    try {
        const settingsPath = path.join(home, ".gemini", "settings.json")
        const raw = read(settingsPath, "utf8")
        const parsed = JSON.parse(raw)
        const t = parsed?.security?.auth?.selectedType
        if (typeof t === "string" && t.length > 0) selectedType = t
    } catch {
        // file missing / not JSON / not readable — fall through with
        // the default "gemini-api-key" assumption.
    }
    if (selectedType !== "gemini-api-key") {
        // OAuth or another non-key auth path is configured. The gemini
        // CLI handles credential lookup itself; nothing for us to check.
        return null
    }
    return {
        message:
            "reviewer.provider is 'gemini' and gemini auth is set to 'gemini-api-key', " +
            "but GEMINI_API_KEY is not in env. Either set the env var in the shell " +
            "that launches the server (or in the launchd plist's " +
            "EnvironmentVariables), or run `gemini auth login` to switch to OAuth " +
            "(which the orchestrator will then accept without an env var).",
        hint: "GEMINI_API_KEY missing and gemini auth.selectedType is gemini-api-key",
    }
}

/* istanbul ignore next -- process entry, exercised by smoke test only */
const main = async () => {
    const configPath = process.env.REVIEW_ORCH_CONFIG ?? defaultConfigPath()
    let config
    try {
        config = loadConfig({ configPath })
    } catch (err) {
        logger.error(
            { err: err.message, code: err.code, configPath },
            "failed to load config"
        )
        process.exitCode = 1
        return
    }

    const envProblem = checkReviewerEnv(config)
    if (envProblem) {
        logger.error(
            {
                provider: config.reviewer?.provider,
                hint: envProblem.hint,
            },
            envProblem.message
        )
        process.exitCode = 1
        return
    }

    const store = createStateStore({
        idleResetMs: config.limits.idleResetMinutes * 60 * 1000,
    })
    const archive = createArchive({
        reviewsDir: config.reviewsDir,
        retentionDays: config.reviewsRetentionDays,
        blockingSeverities: config.blockingSeverities,
        logger,
    })
    const pruneResult = archive.pruneOnStartup()
    if (pruneResult.removed > 0) {
        logger.info(
            { removed: pruneResult.removed },
            "pruned old archive files on startup"
        )
    }

    const result = await startServer({ config, store, archive, configPath })
    if (!result.ok) {
        process.exitCode = 1
        return
    }
    const { server, sockets, app } = result

    // One-shot graceful shutdown. The second SIGINT/SIGTERM hard-exits
    // so a wedged close() never leaves the operator stuck — matches the
    // "Ctrl-C twice to force" convention shells use.
    const shutdownState = { stopping: false }
    const shutdown = (signal) => {
        if (shutdownState.stopping) {
            logger.warn({ signal }, "second signal received — forcing exit")
            process.exit(1)
            return
        }
        logger.info({ signal }, "shutting down")
        gracefulShutdown({
            server,
            sockets,
            mcp: app.locals?.mcp,
            logger,
            state: shutdownState,
        })
            .then(() => {
                process.exitCode = 0
            })
            .catch(() => {
                process.exitCode = 1
            })
    }
    process.on("SIGINT", () => shutdown("SIGINT"))
    process.on("SIGTERM", () => shutdown("SIGTERM"))
}

/* istanbul ignore next -- auto-start guard exercised only when executed directly */
if (
    import.meta.url.startsWith("file:") &&
    process.argv[1] &&
    import.meta.url.endsWith(process.argv[1].split("/").pop())
) {
    main().catch((err) => {
        logger.error(
            { err: err?.message ?? String(err) },
            "fatal startup error"
        )
        process.exitCode = 1
    })
}
