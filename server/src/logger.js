/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import pino from "pino"

const level = process.env.LOG_LEVEL ?? "info"

export const logger = pino({
    level,
    base: { name: "review-orchestrator" },
})
