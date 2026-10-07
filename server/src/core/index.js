/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

// The core's composition root (hot-reload plan §5.2). Kept thin: it is
// part of `reviewVersion`, so anything beyond wiring belongs in the
// review entry (review/index.js) or the UI half (routes.js).
//
// Static exports are read by the shell right after import, before any
// core exists: the contract check (CORE_API, STATE_FORMAT) and config
// validation, so config never shapes core creation.

import { validateConfig } from "./config.js"
import { createReviewEntry } from "./review/index.js"
import { createUiEntry } from "./routes.js"

export const CORE_API = 1
// Persisted-state format. Changes within a format are additive only;
// anything else bumps it and needs a restart.
export const STATE_FORMAT = 1

export { validateConfig }

// Two-phase: createCore gets only inert staging inputs ({ resources,
// version, shellVersion, startedAt, codexSchemaPath }) and touches no live
// state; attach(live) is a pure reference assignment done by the shell.
export const createCore = (staging) => {
    let live = null
    const getLive = () => {
        if (!live) throw new Error("core is not attached")
        return live
    }
    const review = createReviewEntry({
        resources: staging.resources,
        codexSchemaPath: staging.codexSchemaPath,
        getLive,
    })
    const ui = createUiEntry({
        getLive,
        shellVersion: staging.shellVersion,
        startedAt: staging.startedAt,
    })
    return Object.freeze({
        api: CORE_API,
        stateFormat: STATE_FORMAT,
        version: staging.version ?? null,
        routes: Object.freeze({ review: review.routes.review, ...ui.routes }),
        mcp: Object.freeze({
            toolDefs: Object.freeze([review.mcp.toolDef, ui.mcp.toolDef]),
            requestReview: review.mcp.requestReview,
            resetReviewContext: ui.mcp.resetReviewContext,
        }),
        resources: staging.resources,
        summarizeConfig: ui.summarize,
        selfCheck: (config) => {
            review.selfCheck(config)
            ui.selfCheck(config)
        },
        attach: (next) => {
            live = next
        },
        dispose: () => {
            live = null
        },
    })
}
