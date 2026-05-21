/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import express from "express"
import { loadConfig, defaultConfigPath } from "./config.js"
import { authMiddleware } from "./auth.js"
import { mountReviewRoute } from "./review.js"
import { logger } from "./logger.js"

export const createApp = (config, deps = {}) => {
    const app = express()
    app.disable("x-powered-by")
    app.use(express.json({ limit: "1mb" }))

    app.get("/healthz", (_req, res) => {
        res.json({ ok: true })
    })

    app.use(authMiddleware({ token: config.authToken }))
    mountReviewRoute(app, { config, deps })

    return app
}

const main = () => {
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

    const app = createApp(config)

    const server = app.listen(config.port, config.bind, () => {
        logger.info(
            { port: config.port, bind: config.bind, configPath },
            "review-orchestrator listening"
        )
    })

    const shutdown = (signal) => {
        logger.info({ signal }, "shutting down")
        server.close(() => {
            process.exitCode = 0
        })
    }
    process.on("SIGINT", () => shutdown("SIGINT"))
    process.on("SIGTERM", () => shutdown("SIGTERM"))
}

// Only auto-start when executed directly (not when imported by tests).
if (
    import.meta.url.startsWith("file:") &&
    process.argv[1] &&
    import.meta.url.endsWith(process.argv[1].split("/").pop())
) {
    main()
}
