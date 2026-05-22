/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import pino from "pino"

const level = process.env.LOG_LEVEL ?? "info"

// Pretty-print logs when stdout is a TTY (interactive `npm start`), but
// stay with plain JSON when stdout is redirected (launchd → log file,
// piping, CI). The decision is auto-detected so the user doesn't have
// to set an env var; LOG_PRETTY=1 / LOG_PRETTY=0 can force either.
const wantsPretty = (() => {
    if (process.env.LOG_PRETTY === "1") return true
    if (process.env.LOG_PRETTY === "0") return false
    return Boolean(process.stdout.isTTY)
})()

export const logger = wantsPretty
    ? pino({
          level,
          base: { name: "review-orchestrator" },
          transport: {
              target: "pino-pretty",
              options: {
                  colorize: true,
                  translateTime: "HH:MM:ss.l",
                  ignore: "pid,hostname,name",
              },
          },
      })
    : pino({
          level,
          base: { name: "review-orchestrator" },
      })

export const __test__ = { wantsPretty }
