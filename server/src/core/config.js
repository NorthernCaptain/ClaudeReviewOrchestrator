/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { realpathSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { z } from "zod"

const DEFAULT_IGNORE_PATHS = [
    "**/node_modules/**",
    "**/dist/**",
    "**/.git/**",
    "**/coverage/**",
    "**/*.lock",
    "**/package-lock.json",
    "**/yarn.lock",
    "**/pnpm-lock.yaml",
    "**/Cargo.lock",
    "**/*.min.js",
    "**/*.min.css",
    "**/generated/**",
]

const Severity = z.enum(["blocker", "major", "minor", "nit"])

// Hard cap on any reviewer-run timeout (codex / claude / gemini), in
// seconds. The Stop hook waits reviewer + 60s for the server and is
// itself clamped to a fixed ceiling (hooks/stop-review.mjs
// MAX_FETCH_TIMEOUT_MS = 1_740_000ms = 1740s), above which the
// installed Claude Code harness timeout sits (1800s). Capping the
// reviewer here at 1740 − 60 = 1680s keeps codex from outliving the
// hook's wait, so the whole chain (reviewer < hook-wait < harness)
// holds for ANY config without a reinstall. Bumping this REQUIRES
// bumping MAX_FETCH_TIMEOUT_MS and the harness timeout in lockstep.
export const MAX_REVIEWER_TIMEOUT_SECONDS = 1680

const ConfigSchema = z
    .object({
        // 0 asks the OS for a free port (tests, embedders); the hooks need a
        // fixed one, so a daemon keeps the default.
        port: z.number().int().min(0).max(65535).default(7777),
        bind: z.string().default("127.0.0.1"),
        authToken: z.string().min(1, "authToken is required"),
        allowedRoots: z
            .array(z.string().min(1))
            .min(1, "allowedRoots must contain at least one path")
            .default(["~"]),
        codex: z
            .object({
                binary: z.string().default("codex"),
                model: z.string().default("gpt-6.1-sol"),
                // Maps to `-c model_reasoning_effort=<value>`. Explicit so
                // review behavior doesn't drift with the user's interactive
                // ~/.codex/config.toml. "high" is the orchestrator default
                // because reviews are infrequent and worth the latency.
                reasoningEffort: z
                    .enum(["minimal", "low", "medium", "high", "xhigh"])
                    .default("high"),
                ignoreProjectRules: z.boolean().default(true),
                extraArgs: z.array(z.string()).default([]),
            })
            .default({}),
        // Reviewer provider selector. Defaults to "codex" for
        // backwards-compatibility with installs predating this block;
        // flip to "claude" or "gemini" to use the respective CLI
        // adapter. Provider-specific knobs live under their own
        // sub-keys.
        reviewer: z
            .object({
                provider: z
                    .enum(["codex", "claude", "gemini"])
                    .default("codex"),
                claude: z
                    .object({
                        binary: z.string().default("claude"),
                        model: z.string().default("claude-opus-5"),
                        // Maps to `--effort <level>` on the Claude CLI.
                        effort: z
                            .enum(["low", "medium", "high", "xhigh", "max"])
                            .default("high"),
                        // bypassPermissions paired with disallowedTools
                        // is the only mode that returns a clean
                        // assistant response in non-interactive `-p`
                        // mode. The disallowed list below is the real
                        // safety boundary.
                        permissionMode: z
                            .enum([
                                "acceptEdits",
                                "auto",
                                "bypassPermissions",
                                "default",
                                "dontAsk",
                                "plan",
                            ])
                            .default("bypassPermissions"),
                        disallowedTools: z
                            .array(z.string())
                            .default([
                                "Bash",
                                "Edit",
                                "Write",
                                "NotebookEdit",
                                "WebFetch",
                                "WebSearch",
                                "Task",
                            ]),
                        timeoutSeconds: z
                            .number()
                            .int()
                            .min(1)
                            .max(MAX_REVIEWER_TIMEOUT_SECONDS)
                            .default(600),
                        extraArgs: z.array(z.string()).default([]),
                    })
                    .default({}),
                gemini: z
                    .object({
                        binary: z.string().default("gemini"),
                        // "auto" is the router alias — same mode the
                        // CLI's interactive picker calls "Auto (Gemini
                        // 3)". The router picks between gemini-3.1-pro
                        // and gemini-3-flash per task. Pinning a
                        // specific model (e.g. "gemini-2.5-pro") is
                        // fine for reproducibility; the router is the
                        // right default for quality + cost balance on
                        // a mix of large and small diffs.
                        model: z.string().default("auto"),
                        // gemini CLI offers: default, auto_edit, yolo,
                        // plan. We default to "plan" — it's the only
                        // non-interactive mode that's also read-only,
                        // which is exactly what a code reviewer needs.
                        // "yolo" is available for users who want a fully
                        // unsandboxed run.
                        approvalMode: z
                            .enum(["default", "auto_edit", "yolo", "plan"])
                            .default("plan"),
                        timeoutSeconds: z
                            .number()
                            .int()
                            .min(1)
                            .max(MAX_REVIEWER_TIMEOUT_SECONDS)
                            .default(600),
                        extraArgs: z.array(z.string()).default([]),
                    })
                    .default({}),
            })
            .default({}),
        limits: z
            .object({
                maxCodexRounds: z.number().int().min(1).default(5),
                maxBlocks: z.number().int().min(1).default(6),
                idleResetMinutes: z.number().int().min(1).default(10),
                // Hard timeout for every git command on the request path
                // (tools.js): a stalled git fails its own request instead
                // of blocking the event loop.
                gitTimeoutSeconds: z.number().int().min(1).max(600).default(30),
                codexTimeoutSeconds: z
                    .number()
                    .int()
                    .min(1)
                    .max(MAX_REVIEWER_TIMEOUT_SECONDS)
                    .default(600),
                maxCodexOutputBytes: z
                    .number()
                    .int()
                    .min(4096)
                    .default(1024 * 1024),
                maxPayloadBytes: z.number().int().min(1024).default(262144),
                maxFileBytes: z.number().int().min(512).default(65536),
                maxFiles: z.number().int().min(1).default(40),
            })
            .default({}),
        ignorePaths: z.array(z.string()).default(DEFAULT_IGNORE_PATHS),
        // Payload-shaping options. fallbackToHead lets buildPayload
        // review the most recent commit range when the working tree has
        // no reviewable change (clean, or only ignorePaths files changed)
        // — catches the "I committed before the Stop hook fired"
        // case. Range resolution: merge-base(HEAD, @{upstream})..HEAD
        // when an upstream exists, otherwise HEAD~1..HEAD. Cache logic
        // is unchanged: the resulting payload is byte-deterministic
        // for a given HEAD so repeat Stop hooks hit NO_CHANGES.
        //
        // verifyCleanTree is deprecated and ignored: the fast path now
        // always probes the working tree. Still accepted because the
        // schema is strict and older installers wrote it to disk.
        payload: z
            .object({
                fallbackToHead: z.boolean().default(false),
                verifyCleanTree: z.boolean().default(false),
            })
            .default({}),
        blockingSeverities: z.array(Severity).default(["blocker", "major"]),
        extraReviewerInstructions: z.string().nullable().default(null),
        reviewsDir: z.string().default("./reviews"),
        reviewsRetentionDays: z.number().int().nullable().default(null),
        logging: z
            .object({
                dir: z.string().default("~/.claude/logs"),
                // Pino's levels: a reload applies it to the live logger.
                level: z
                    .enum([
                        "fatal",
                        "error",
                        "warn",
                        "info",
                        "debug",
                        "trace",
                        "silent",
                    ])
                    .default("info"),
            })
            .default({}),
        // Hot reload (hot-reload plan §5.5). A pending reload swaps when no
        // review is running. After maxWaitMinutes, new review requests are
        // held at entry so the running ones can drain; none is held longer
        // than maxHoldSeconds (also clamped so the hooks' published wait
        // stays under their 29 min cap).
        reload: z
            .object({
                maxWaitMinutes: z.number().min(0).max(1440).default(5),
                maxHoldSeconds: z.number().int().min(0).max(600).default(45),
            })
            .default({}),
        // Token rotation (hot-reload plan §5.7). After authToken changes,
        // the token it replaced is still accepted for previousTokenGraceHours.
        // rotate-token.sh appends a record per rotation (hashes only, the
        // last 10); the server grants a predecessor its grace only from
        // the record that rotated it out, and never past a later "none".
        auth: z
            .object({
                previousTokenGraceHours: z.number().min(0).max(720).default(24),
                rotations: z
                    .array(
                        z.object({
                            tokenHash: z.string(),
                            previousTokenHash: z.string().nullable(),
                            grace: z.enum(["default", "none"]),
                            at: z.string(),
                        })
                    )
                    .max(10)
                    .default([]),
            })
            .default({}),
        // Stop-hook configuration. fetchTimeoutSeconds is the cap the
        // hook applies to its POST /review call. When null (default),
        // the hook auto-derives a value from the reviewer timeout plus
        // a 60-second buffer — so bumping the reviewer timeout is the
        // only edit needed in normal use. Override to a specific number
        // to pin it independently of the reviewer.
        hook: z
            .object({
                fetchTimeoutSeconds: z
                    .number()
                    .int()
                    .min(1)
                    .nullable()
                    .default(null),
            })
            .default({}),
    })
    .strict()

const expandHome = (input, home) => {
    if (typeof input !== "string") return input
    if (input === "~") return home
    if (input.startsWith("~/")) return path.join(home, input.slice(2))
    return input
}

const expandPathsInConfig = (cfg, home) => ({
    ...cfg,
    allowedRoots: cfg.allowedRoots.map((p) => {
        const expanded = expandHome(p, home)
        try {
            return realpathSync(expanded)
        } catch {
            return path.resolve(expanded)
        }
    }),
    reviewsDir: expandHome(cfg.reviewsDir, home),
    logging: {
        ...cfg.logging,
        dir: expandHome(cfg.logging.dir, home),
    },
})

// Validates an already-parsed config.json and expands its paths. A
// static export of the core: the shell uses it before any core is
// created, so config never shapes core creation. Reading the file is
// the shell's job.
export const validateConfig = (raw, { home = homedir() } = {}) => {
    const result = ConfigSchema.safeParse(raw)
    if (!result.success) {
        const issues = result.error.issues
            .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
            .join("; ")
        const e = new Error(`config validation failed: ${issues}`)
        e.code = "CONFIG_INVALID"
        e.issues = result.error.issues
        throw e
    }
    return expandPathsInConfig(result.data, home)
}

export const __test__ = { ConfigSchema, expandHome, DEFAULT_IGNORE_PATHS }

// Runs a dashboard config change (a delta of [keyPath, value] pairs)
// through the shell's config transaction. Resolves to { ok: true,
// revision, replaced } or { ok: false, response } with the HTTP reply;
// nothing is changed or written when it fails.
export const commitConfigChange = async ({
    configTransaction,
    delta,
    logger = null,
    what,
}) => {
    try {
        const result = await configTransaction(delta)
        logger?.info?.(
            { what, revision: result.revision, replaced: result.replaced },
            "config changed"
        )
        return {
            ok: true,
            revision: result.revision,
            replaced: result.replaced ?? [],
        }
    } catch (err) {
        logger?.warn?.(
            { what, err: err?.message, code: err?.code },
            "config change rejected"
        )
        return {
            ok: false,
            response: {
                httpStatus: err?.httpStatus ?? 409,
                body: {
                    ok: false,
                    error: err?.message ?? String(err),
                    code: err?.code ?? "CONFIG_CHANGE_FAILED",
                },
            },
        }
    }
}

// The success body every dashboard config change shares.
export const configChangeBody = (result, fields) => ({
    ok: true,
    ...fields,
    persisted: true,
    revision: result.revision,
    ...(result.replaced.length > 0
        ? { replacedManualEdits: result.replaced }
        : {}),
})
