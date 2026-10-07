/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

// The non-review half of a core: status, dashboard, the dashboard's
// mutation handlers, reset and notify-change. Free to import the review
// path; the review path never imports this.

import {
    createDashboardPageHandler,
    DASHBOARD_API,
    reloadStamp,
    renderDashboard,
} from "./dashboard.js"
import { handleExclusionMutation } from "./exclusions.js"
import { handleSetMaxBlocks } from "./maxBlocks.js"
import { handleSetMaxRounds } from "./maxRounds.js"
import { handleSetBlockingSeverities } from "./blockingSeverities.js"
import { createNotifyChangeHandler } from "./notify-change.js"
import {
    createProviderHandler,
    handleSetProvider,
    handleSetReviewerPreset,
} from "./provider.js"
import {
    createResetHandler,
    handleDashboardReset,
    RESET_REVIEW_CONTEXT_TOOL,
    resetRequestHandler,
} from "./reset.js"
import { snapshotInFlight } from "./review/review.js"
import { createStatusHandler, summarizeConfig } from "./status.js"

const respond = (handle) => async (req, res) => {
    const result = await handle(req)
    res.status(result.httpStatus).json(result.body)
}

// A dashboard action from a page rendered for another dashboard API (a
// tab left open across a reload) is refused before it's interpreted.
const currentPage = (handler) => (req, res, next) => {
    if (req.get("x-dashboard-api") !== String(DASHBOARD_API)) {
        res.status(409).json({
            ok: false,
            code: "PAGE_OUTDATED",
            error: "page is outdated — reload",
        })
        return
    }
    return handler(req, res, next)
}

export const createUiEntry = ({ getLive, packageVersion, startedAt }) => {
    const options = () => {
        const live = getLive()
        return {
            config: live.config,
            configTransaction: live.configTransaction,
            store: live.store,
            archive: live.archive,
            logger: live.logger,
            deps: live.deps,
            metrics: live.metrics,
        }
    }
    const inFlight = () =>
        snapshotInFlight(Date.now, getLive().registries.inflightMeta)
    const configMutation = (handle) =>
        respond((req) => handle({ ...options(), body: req.body }))
    const summarize = (config) => summarizeConfig(config, packageVersion)

    return {
        summarize,
        routes: {
            reset: createResetHandler(options),
            notifyChange: createNotifyChangeHandler(options),
            provider: createProviderHandler(options),
            status: createStatusHandler(() => ({
                ...options(),
                startedAt,
                version: packageVersion,
                shell: getLive().shellStatus?.() ?? null,
            })),
            dashboardPage: createDashboardPageHandler(() => ({
                ...options(),
                summarize,
                version: packageVersion,
                startedAt,
                inFlight,
                shell: getLive().shellStatus?.() ?? null,
                csrfToken: getLive().dashboard?.csrfToken ?? "",
            })),
            // The page's 2 s poll: the running reviews, plus what tells an
            // open tab that the core changed (a banner) or that its reload
            // panel is out of date (a refresh).
            inflight: (_req, res) => {
                const shell = getLive().shellStatus?.() ?? null
                const body = {
                    ok: true,
                    inFlight: inFlight(),
                    coreVersion: shell?.coreVersion ?? null,
                    reloadStamp: reloadStamp(shell),
                }
                res.setHeader("Cache-Control", "no-store")
                res.json(body)
            },
            dashboardMutations: Object.fromEntries(
                Object.entries({
                    reset: respond((req) =>
                        handleDashboardReset({
                            body: req.body,
                            store: getLive().store,
                        })
                    ),
                    provider: configMutation(handleSetProvider),
                    reviewerPreset: configMutation(handleSetReviewerPreset),
                    exclusions: respond((req) =>
                        handleExclusionMutation({
                            body: req.body,
                            store: getLive().store,
                        })
                    ),
                    maxRounds: configMutation(handleSetMaxRounds),
                    maxBlocks: configMutation(handleSetMaxBlocks),
                    blockingSeverities: configMutation(
                        handleSetBlockingSeverities
                    ),
                }).map(([key, handler]) => [key, currentPage(handler)])
            ),
        },
        mcp: {
            toolDef: RESET_REVIEW_CONTEXT_TOOL,
            resetReviewContext: ({ args, requestId, mcpServer }) =>
                resetRequestHandler({
                    args,
                    requestId,
                    ctx: { ...options(), mcpServer },
                }),
        },
        // Pure: the dashboard must render for this config.
        selfCheck: (config) => {
            renderDashboard({
                version: packageVersion,
                config: summarize(config),
                uptimeSeconds: 0,
                startedAt: null,
                records: [],
                metrics: null,
                inFlight: [],
                contexts: [],
            })
        },
    }
}
