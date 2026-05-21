/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import express from "express"
import { logger } from "./logger.js"

const app = express()
app.disable("x-powered-by")
app.use(express.json({ limit: "1mb" }))

app.get("/healthz", (_req, res) => {
    res.json({ ok: true })
})

const port = Number(process.env.PORT ?? 7777)
const bind = process.env.BIND ?? "127.0.0.1"

const server = app.listen(port, bind, () => {
    logger.info({ port, bind }, "review-orchestrator listening")
})

const shutdown = (signal) => {
    logger.info({ signal }, "shutting down")
    server.close(() => {
        process.exitCode = 0
    })
}
process.on("SIGINT", () => shutdown("SIGINT"))
process.on("SIGTERM", () => shutdown("SIGTERM"))
