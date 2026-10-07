/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { randomBytes } from "node:crypto"
import { readFileSync, rmSync } from "node:fs"
import path from "node:path"
import express from "express"
import { VERSION } from "./version.js"

export { VERSION }
import { authMiddleware } from "./auth.js"
import {
    captureCore,
    codexSchemaPathFor,
    DEFAULT_CACHE_DIR,
    DEFAULT_CORE_DIR,
    DEFAULT_SNAPSHOT_ROOT,
    defaultConfigPath,
    ephemeralCodexSchemaPath,
    importCore,
    loadCoreModule,
    loadDefaultCore,
    prepareCore,
    pruneCodexSchemas,
    pruneSnapshots,
    readConfigFile,
    removeSnapshot,
    shellVersionId,
} from "./core-loader.js"
import { mountMcpRoute } from "./mcp.js"
import { createStateStore } from "./state.js"
import { createArchive } from "./archive.js"
import { createConfigStore } from "./config-store.js"
import { createReloadController, requiredHookWaitMs } from "./reload.js"
import { MAX_FETCH_TIMEOUT_MS } from "../../hooks/stop-review.mjs"
import { createMetrics } from "./metrics.js"
import { logger } from "./logger.js"
import { createHttpAccessLog, createHttpErrorHandler } from "./http-log.js"
import { createTools } from "./tools.js"

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

// Where reload candidates come from: the core folder, captured and (when
// its id differs from the running core's) written to a fresh snapshot and
// imported, with a codex schema path of its own.
export const createCandidateLoader =
    ({
        coreDir = DEFAULT_CORE_DIR,
        snapshotRoot = DEFAULT_SNAPSHOT_ROOT,
        codexSchemaPathOf = (version) => ephemeralCodexSchemaPath(version),
        packageVersion = VERSION,
    } = {}) =>
    async (current) => {
        const captured = captureCore({ coreDir, packageVersion })
        if (captured.version === current.version) return { same: true }
        const { module: mod, snapshotDir } = await importCore({
            captured,
            coreDir,
            snapshotRoot,
        })
        return {
            module: mod,
            version: captured.version,
            reviewVersion: captured.reviewVersion,
            resources: captured.resources,
            snapshotDir,
            codexSchemaPath: codexSchemaPathOf(captured.version),
        }
    }

const disposeCoreFiles = (record) => {
    removeSnapshot(record.snapshotDir)
    if (record.codexSchemaPath) rmSync(record.codexSchemaPath, { force: true })
}

// A Stop hook sends the wait limit it's using; MCP calls send none.
const hookTimeoutOf = (body) => {
    const t = body?.timeoutMs
    return typeof t === "number" && Number.isFinite(t) && t > 0
        ? Math.min(t, MAX_FETCH_TIMEOUT_MS)
        : null
}

// The deadline bounds the response, never the review: arrival plus the
// hook's limit, minus a response margin of min(5 s, limit / 10).
export const requestDeadline = (arrival, timeoutMs) =>
    timeoutMs === null
        ? null
        : arrival + timeoutMs - Math.min(5_000, timeoutMs / 10)

// Absorbs request transit and parsing in the limit handshake.
export const HANDSHAKE_TOLERANCE_MS = 2_000

const quietEscalate = (code, reason, extra = {}) => ({
    status: "ESCALATE",
    findings: [],
    blockingFindings: [],
    droppedFindings: [],
    code,
    reason,
    notifyUser: false,
    ...extra,
})

const deadlineExceeded = (reason) => quietEscalate("DEADLINE_EXCEEDED", reason)

const hookLimitStale = (requiredMs) =>
    quietEscalate(
        "HOOK_LIMIT_STALE",
        "the reviewer timeout needs a longer hook wait — resend with hookTimeoutMs",
        { hookTimeoutMs: requiredMs }
    )

// HTTP status for a reload that couldn't be prepared or applied: a busy
// controller or a stale request is a conflict, bad code or config is
// unprocessable, anything else is ours.
const reloadErrorStatus = (err) =>
    err?.httpStatus ??
    (typeof err?.code === "string" &&
    /^(CORE_|CONFIG_|RESTART_ONLY)/.test(err.code)
        ? 422
        : 500)

// Every route below except /healthz and the favicon is a delegate: it
// runs on the core current at that moment (hot-reload plan §5.1), pinned
// for the request's life. The shell owns paths, auth, the loopback guard,
// review admission and reloads; the core owns behaviour.
export const createApp = ({
    config,
    store,
    archive = null,
    logger: log = logger,
    deps: callerDeps = {},
    metrics = createMetrics(),
    configPath = defaultConfigPath(),
    core,
    // What the startup loader knows about `core`: { reviewVersion,
    // snapshotDir, codexSchemaPath }.
    coreInfo = {},
    startedAt = Date.now(),
    shellVersion = shellVersionId(),
    loadCandidate = createCandidateLoader(),
}) => {
    // Shell-owned in-flight registries (hot-reload plan §5.5): duplicate
    // matching, per-context ordering and the dashboard's in-flight view
    // live here, outside any reloadable module, so they survive a swap.
    // Every git and reviewer process goes through the shell's tools: async
    // git with the live limits.gitTimeoutSeconds, and a spawn that refuses
    // Node executables. Callers (tests) may still inject their own.
    const tools = createTools({
        getGitTimeoutMs: () =>
            (configStore.current().limits?.gitTimeoutSeconds ?? 30) * 1000,
        isIssuedConfig: (pinned) => reloads.isIssuedConfig(pinned),
    })
    const deps = {
        inflight: new Map(),
        contextChains: new Map(),
        inflightMeta: new Map(),
        // Waiters per shared pipeline, for deadline abandonment. Shell-owned
        // so every core instance sees the same counts.
        joinCounts: new WeakMap(),
        git: tools.git,
        spawnTool: tools.spawnTool,
        ...callerDeps,
    }
    // The holder and the restart-only baseline hold the config in the
    // core's normalized form (defaults filled, paths expanded), the form
    // every reload and transaction produces, so comparisons see only real
    // changes. main() passes it validated already; this is idempotent.
    let normalized = config
    try {
        normalized = core.validateConfig(config)
    } catch {
        // an embedder's partial config: keep it as given
    }
    // The config holder outlives every core; every change to it is a
    // transaction checked by the core current at that moment.
    const configStore = createConfigStore({
        configPath,
        initial: normalized,
        checks: () => {
            const current = reloads.currentCore()
            return {
                validate: current.validateConfig,
                selfCheck: current.selfCheck,
            }
        },
        fs: callerDeps.configFs,
    })
    const registries = Object.freeze({
        inflight: deps.inflight,
        contextChains: deps.contextChains,
        inflightMeta: deps.inflightMeta,
        joinCounts: deps.joinCounts,
    })
    const shellStatus = () => {
        const { coreVersion, ...reload } = reloads.status()
        return { shellVersion, coreVersion, reload }
    }
    // What a core attaches: the same shell objects for every core, except
    // the archive, which stamps each record with the core that wrote it.
    const liveFor = (record) =>
        Object.freeze({
            get config() {
                return configStore.current()
            },
            configTransaction: (delta) => configStore.mutate(delta),
            store,
            archive: archive && {
                ...archive,
                write: (args) =>
                    archive.write({ ...args, coreVersion: record.version }),
            },
            metrics,
            logger: log,
            registries,
            deps,
            shellStatus,
        })
    const reloads = createReloadController({
        initial: {
            core,
            validateConfig: core.validateConfig,
            version: core.version,
            reviewVersion: coreInfo.reviewVersion ?? null,
            snapshotDir: coreInfo.snapshotDir ?? null,
            codexSchemaPath: coreInfo.codexSchemaPath ?? null,
        },
        configStore,
        startupConfig: normalized,
        liveFor,
        loadCandidate,
        buildCore: (loaded, candidateConfig) =>
            prepareCore({
                loaded,
                config: candidateConfig,
                packageVersion: VERSION,
                shellVersion,
                startedAt,
                codexSchemaPath: loaded.codexSchemaPath,
            }),
        disposeFiles: disposeCoreFiles,
        runningReviews: () =>
            [...registries.inflightMeta.values()].map((m) => ({
                repo: m.repo,
                branch: m.branch,
                provider: m.provider,
                startedAt: m.startedAt,
            })),
        onApplied: (applied) => {
            const level = applied.logging?.level
            if (level && log && "level" in log) log.level = level
        },
        logger: log,
    })
    // Non-review requests pin the current core for their whole life.
    const route = (pick) => async (req, res, next) => {
        const ticket = reloads.pin()
        try {
            await pick(ticket.core.routes)(req, res, next)
        } finally {
            ticket.release()
        }
    }
    const mutation = (key) => route((r) => r.dashboardMutations[key])

    const app = express()
    app.disable("x-powered-by")
    app.locals.reloads = reloads
    app.locals.live = liveFor({ version: core.version })
    app.locals.configStore = configStore

    // Access log runs before body parsing so we see every incoming
    // request including ones rejected by JSON parsing or auth. It logs
    // on response finish/close so the line carries the final status and
    // duration.
    app.use(createHttpAccessLog({ logger: log }))
    app.use(express.json({ limit: "1mb" }))

    app.get("/healthz", (_req, res) => {
        const { coreVersion, pending } = reloads.status()
        res.json({
            ok: true,
            shellVersion,
            coreVersion,
            reloadPending: pending !== null,
        })
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
    app.get(
        "/inflight",
        route((r) => r.inflight)
    )

    // Dashboard control endpoints (v0.1.35). Mounted BEFORE auth so the
    // public dashboard page can use them without embedding the
    // X-Review-Token, but explicitly guarded to loopback peers
    // (v0.1.36) — these mutate live config / clear review state, so we
    // can't rely on `bind: 127.0.0.1` alone as the trust boundary. If
    // the operator ever widens the bind, these stay locked down. The
    // canonical authed routes (POST /reset, PUT /provider) remain
    // available for cross-host callers with a valid token.
    app.post("/dashboard/reset", loopbackOnly, mutation("reset"))
    app.put("/dashboard/provider", loopbackOnly, mutation("provider"))
    app.put(
        "/dashboard/reviewer-preset",
        loopbackOnly,
        mutation("reviewerPreset")
    )
    app.post("/dashboard/exclusions", loopbackOnly, mutation("exclusions"))
    app.put("/dashboard/max-rounds", loopbackOnly, mutation("maxRounds"))
    app.put("/dashboard/max-blocks", loopbackOnly, mutation("maxBlocks"))
    app.put(
        "/dashboard/blocking-severities",
        loopbackOnly,
        mutation("blockingSeverities")
    )

    // GET / — public dashboard. Mounted BEFORE the auth middleware so
    // it's reachable without the x-review-token. Safe because the
    // server binds 127.0.0.1 by default — the trust boundary is the
    // network bind, not an HTTP secret.
    app.get(
        "/",
        route((r) => r.dashboardPage)
    )

    app.use(authMiddleware({ token: config.authToken }))
    // Reviews are admitted before anything else happens (hot-reload plan
    // §5.5): counted toward "busy", pinned to the current core and to a
    // frozen copy of the config, released when the work ends (which, for
    // a request answered at its deadline, is after the answer).
    app.post("/review", async (req, res) => {
        const arrival = Date.now()
        const timeoutMs = hookTimeoutOf(req.body)
        const deadline = requestDeadline(arrival, timeoutMs)
        let ticket
        try {
            ticket = await reloads.admitReview({ deadline })
        } catch (err) {
            if (err?.code !== "DEADLINE_EXCEEDED") throw err
            res.json(
                deadlineExceeded(
                    "the request waited at entry until its deadline"
                )
            )
            return
        }
        try {
            // The limit handshake: a hook whose remaining wait can't cover
            // the pinned config's reviewer timeout learns the limit it
            // needs before any work starts. Never on a final attempt.
            if (timeoutMs !== null && req.body?.finalAttempt !== true) {
                const remainingMs = timeoutMs - (Date.now() - arrival)
                const requiredMs = requiredHookWaitMs(ticket.config)
                if (remainingMs < requiredMs - HANDSHAKE_TOLERANCE_MS) {
                    res.status(409).json(hookLimitStale(requiredMs))
                    return
                }
            }
            await ticket.core.routes.review(req, res, {
                config: ticket.config,
                deadline,
            })
        } finally {
            ticket.release()
        }
    })
    app.post(
        "/reset",
        route((r) => r.reset)
    )
    app.post(
        "/notify-change",
        route((r) => r.notifyChange)
    )
    app.put(
        "/provider",
        route((r) => r.provider)
    )
    // Capture the MCP route's closeAllSessions so shutdown can drain
    // long-poll GETs (otherwise server.close() never resolves).
    app.locals.mcp = mountMcpRoute(app, { cores: reloads, logger: log })
    // Explicit reloads only (hot-reload plan §5.9): { cancel, rollback, now }.
    app.post("/admin/reload", async (req, res) => {
        try {
            res.json(await reloads.trigger(req.body ?? {}))
        } catch (err) {
            log.warn({ err: err.message, code: err.code }, "core reload failed")
            res.status(reloadErrorStatus(err)).json({
                ok: false,
                error: err.message,
                code: err.code ?? "RELOAD_FAILED",
            })
        }
    })
    app.get("/admin/reload", (_req, res) => {
        res.json({ ok: true, ...shellStatus() })
    })
    app.get(
        "/status",
        route((r) => r.status)
    )

    // Last middleware: catches errors from next(err) / async route
    // handlers. Logs with stack and returns a sanitized 500 to the
    // caller — never leaks the stack over the wire.
    app.use(createHttpErrorHandler({ logger: log }))

    return app
}

// Without a `core`, loads the default one for `config` (with an
// ephemeral codex schema path; main() passes its own core).
export const startServer = async ({
    config,
    store,
    archive = null,
    deps = {},
    log = logger,
    startedAt = Date.now(),
    configPath = defaultConfigPath(),
    core = null,
    coreInfo = {},
    shellVersion = shellVersionId(),
    loadCandidate = createCandidateLoader(),
} = {}) => {
    const active =
        core ??
        (await loadDefaultCore({ config, packageVersion: VERSION, startedAt }))
    return new Promise((resolve) => {
        const app = createApp({
            config,
            store,
            archive,
            logger: log,
            deps,
            configPath,
            core: active,
            coreInfo,
            startedAt,
            shellVersion,
            loadCandidate,
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
            log.info(active.summarizeConfig(config), "active config")
            settle({ ok: true, server, address: addr, sockets, app })
        })
    })
}

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
    const startedAt = Date.now()
    // Startup loads core v1 through the same loader a reload uses.
    let loaded
    try {
        loaded = await loadCoreModule({ packageVersion: VERSION })
    } catch (err) {
        logger.error(
            { err: err.message, code: err.code },
            "failed to load the review core"
        )
        process.exitCode = 1
        return
    }
    // Every other snapshot folder belongs to a core that no longer runs.
    pruneSnapshots({ keep: loaded.snapshotDir })
    const fail = (err, msg, extra = {}) => {
        removeSnapshot(loaded.snapshotDir)
        logger.error({ err: err.message, code: err.code, ...extra }, msg)
        process.exitCode = 1
    }
    let config
    try {
        config = loaded.module.validateConfig(readConfigFile({ configPath }))
    } catch (err) {
        fail(err, "failed to load config", { configPath })
        return
    }

    const envProblem = checkReviewerEnv(config)
    if (envProblem) {
        removeSnapshot(loaded.snapshotDir)
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

    // The idle interval follows the live config once the server runs (a
    // reload can change it); until then, the startup value.
    let liveConfig = () => config
    const store = createStateStore({
        idleResetMs: () => liveConfig().limits.idleResetMinutes * 60 * 1000,
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

    const shellVersion = shellVersionId()
    const codexSchemaPathOf = (version) =>
        codexSchemaPathFor({
            cacheDir: DEFAULT_CACHE_DIR,
            version,
            nonce: randomBytes(6).toString("hex"),
        })
    const codexSchemaPath = codexSchemaPathOf(loaded.version)
    pruneCodexSchemas({ keep: codexSchemaPath })
    let core
    try {
        core = prepareCore({
            loaded,
            config,
            packageVersion: VERSION,
            shellVersion,
            startedAt,
            codexSchemaPath,
        })
    } catch (err) {
        fail(err, "the review core rejected this config")
        return
    }
    logger.info({ coreVersion: loaded.version }, "review core loaded")

    const result = await startServer({
        config,
        store,
        archive,
        configPath,
        startedAt,
        core,
        coreInfo: {
            reviewVersion: loaded.reviewVersion,
            snapshotDir: loaded.snapshotDir,
            codexSchemaPath,
        },
        shellVersion,
        loadCandidate: createCandidateLoader({ codexSchemaPathOf }),
    })
    if (!result.ok) {
        process.exitCode = 1
        return
    }
    const { server, sockets, app } = result
    liveConfig = () => app.locals.configStore.current()

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
