/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

// Debug / diagnostic endpoint. Returns a server-side snapshot so the
// human operator can answer "what's the orchestrator currently doing?"
// without reading the state file by hand. Behind the same
// X-Review-Token middleware as /review, so a third process on localhost
// can't enumerate active sessions.

const REDACTED = "<redacted>"

// Strip secrets from the config object before exposing it. The auth
// token is the obvious one; we also drop anything else that could
// identify the user's home or hand-edited internals.
const redactConfig = (config) => {
    if (!config) return null
    return {
        port: config.port,
        bind: config.bind,
        authToken: REDACTED,
        allowedRoots: config.allowedRoots,
        codex: config.codex
            ? {
                  binary: config.codex.binary,
                  model: config.codex.model,
                  reasoningEffort: config.codex.reasoningEffort,
                  ignoreProjectRules: config.codex.ignoreProjectRules,
                  extraArgs: config.codex.extraArgs,
              }
            : null,
        reviewer: config.reviewer
            ? {
                  provider: config.reviewer.provider,
                  claude: config.reviewer.claude
                      ? {
                            binary: config.reviewer.claude.binary,
                            model: config.reviewer.claude.model,
                            effort: config.reviewer.claude.effort,
                            permissionMode:
                                config.reviewer.claude.permissionMode,
                            disallowedTools:
                                config.reviewer.claude.disallowedTools,
                            timeoutSeconds:
                                config.reviewer.claude.timeoutSeconds,
                            extraArgs: config.reviewer.claude.extraArgs,
                        }
                      : null,
                  gemini: config.reviewer.gemini
                      ? {
                            binary: config.reviewer.gemini.binary,
                            model: config.reviewer.gemini.model,
                            approvalMode: config.reviewer.gemini.approvalMode,
                            timeoutSeconds:
                                config.reviewer.gemini.timeoutSeconds,
                            extraArgs: config.reviewer.gemini.extraArgs,
                        }
                      : null,
              }
            : null,
        limits: config.limits,
        ignorePaths: config.ignorePaths,
        blockingSeverities: config.blockingSeverities,
        extraReviewerInstructions: config.extraReviewerInstructions
            ? "<set>"
            : null,
        reviewsDir: config.reviewsDir,
        reviewsRetentionDays: config.reviewsRetentionDays,
        logging: config.logging,
        hook: config.hook
            ? { fetchTimeoutSeconds: config.hook.fetchTimeoutSeconds }
            : null,
    }
}

// Trim the ContextState to a useful shape. Drops priorFindings (can be
// large) and lastBaseline.files (also large); keeps just the counters,
// last-result, hashes, and the small fields that matter for debugging.
const summarizeContext = (ctx) => ({
    key: ctx.key,
    repo: ctx.repoRoot ? ctx.repoRoot.split("/").pop() : null,
    repoRoot: ctx.repoRoot,
    branch: ctx.branch,
    codexRounds: ctx.codexRounds,
    blockCount: ctx.blockCount,
    lastResultStatus: ctx.lastResultStatus,
    lastReviewedAt: ctx.lastReviewedAt
        ? new Date(ctx.lastReviewedAt).toISOString()
        : null,
    priorFindingsCount: Array.isArray(ctx.priorFindings)
        ? ctx.priorFindings.length
        : 0,
    // Change-notification fast path observability (v0.1.11).
    dirtySinceLastReview: ctx.dirtySinceLastReview ?? null,
    lastChangeAt: ctx.lastChangeAt
        ? new Date(ctx.lastChangeAt).toISOString()
        : null,
    lastBaseline: ctx.lastBaseline
        ? {
              headSha: ctx.lastBaseline.headSha?.slice(0, 12),
              promptHash: ctx.lastBaseline.promptHash?.slice(0, 16),
              progressHash: ctx.lastBaseline.progressHash?.slice(0, 16),
              reviewConfigHash: ctx.lastBaseline.reviewConfigHash?.slice(0, 16),
              totalBytes: ctx.lastBaseline.totalBytes,
              truncated: ctx.lastBaseline.truncated,
          }
        : null,
})

// Group archive entries by context and report counts. The shape mirrors
// the per-context summary so the dashboard / human reading the JSON can
// line them up.
const archiveCountsByContext = (archiveList) => {
    const counts = {}
    for (const entry of archiveList ?? []) {
        const key = entry.context ?? "(unknown)"
        counts[key] = (counts[key] ?? 0) + 1
    }
    return counts
}

export const handleStatus = ({
    store,
    archive,
    config,
    startedAt,
    version = null,
    now = Date.now,
}) => {
    const uptimeMs = Math.max(0, now() - (startedAt ?? now()))
    const contexts = store?.list?.() ?? []
    const archiveList = archive?.list?.() ?? []
    return {
        ok: true,
        version,
        startedAt: new Date(startedAt ?? now()).toISOString(),
        uptimeSeconds: Math.round(uptimeMs / 1000),
        contexts: contexts.map(summarizeContext),
        archiveCounts: archiveCountsByContext(archiveList),
        config: redactConfig(config),
    }
}

export const mountStatusRoute = (
    app,
    { store, archive, config, startedAt, version, now } = {}
) => {
    app.get("/status", (_req, res) => {
        const body = handleStatus({
            store,
            archive,
            config,
            startedAt,
            version,
            now,
        })
        res.json(body)
    })
}

export const __test__ = {
    redactConfig,
    summarizeContext,
    archiveCountsByContext,
    REDACTED,
}
