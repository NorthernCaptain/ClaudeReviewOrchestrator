/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import express from "express"
import { loadConfig, defaultConfigPath } from "./config.js"
import { authMiddleware } from "./auth.js"
import { mountReviewRoute } from "./review.js"
import { mountResetRoute } from "./reset.js"
import { createStateStore } from "./state.js"
import { logger } from "./logger.js"

export const createApp = ({ config, store, deps = {} }) => {
    const app = express()
    app.disable("x-powered-by")
    app.use(express.json({ limit: "1mb" }))

    app.get("/healthz", (_req, res) => {
        res.json({ ok: true })
    })

    app.use(authMiddleware({ token: config.authToken }))
    mountReviewRoute(app, { config, store, deps })
    mountResetRoute(app, { config, store, deps })

    return app
}

export const startServer = ({ config, store, deps = {}, log = logger } = {}) =>
    new Promise((resolve) => {
        const app = createApp({ config, store, deps })
        const server = app.listen(config.port, config.bind)
        let settled = false

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
            settle({ ok: true, server, address: addr })
        })
    })

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

    const store = createStateStore({
        idleResetMs: config.limits.idleResetMinutes * 60 * 1000,
    })

    const result = await startServer({ config, store })
    if (!result.ok) {
        process.exitCode = 1
        return
    }
    const { server } = result

    const shutdown = (signal) => {
        logger.info({ signal }, "shutting down")
        server.close(() => {
            process.exitCode = 0
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
