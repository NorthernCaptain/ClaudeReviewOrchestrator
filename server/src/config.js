/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { readFileSync, realpathSync } from "node:fs"
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
        port: z.number().int().min(1).max(65535).default(7777),
        bind: z.string().default("127.0.0.1"),
        authToken: z.string().min(1, "authToken is required"),
        allowedRoots: z
            .array(z.string().min(1))
            .min(1, "allowedRoots must contain at least one path")
            .default(["~"]),
        codex: z
            .object({
                binary: z.string().default("codex"),
                model: z.string().default("gpt-5.6-sol"),
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
                        model: z.string().default("claude-opus-4-8"),
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
                            .default(240),
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
                            .default(240),
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
                codexTimeoutSeconds: z
                    .number()
                    .int()
                    .min(1)
                    .max(MAX_REVIEWER_TIMEOUT_SECONDS)
                    .default(240),
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
        // review the most recent commit range when the working tree is
        // clean — catches the "I committed before the Stop hook fired"
        // case. Range resolution: merge-base(HEAD, @{upstream})..HEAD
        // when an upstream exists, otherwise HEAD~1..HEAD. Cache logic
        // is unchanged: the resulting payload is byte-deterministic
        // for a given HEAD so repeat Stop hooks hit NO_CHANGES.
        //
        // verifyCleanTree adds a `git status --porcelain -z` probe to
        // the change-notification fast path. Default false — trusts
        // the dirty flag set by the PostToolUse hook. Turn ON if you
        // also edit files outside Claude (IDE auto-save, terminal
        // edits) and want the fast path to defer in those cases. The
        // HEAD-equality probe runs unconditionally either way; that
        // one is correctness-critical (catches commit/pull/rebase
        // outside Claude) and remains a cheap ~3ms rev-parse.
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
                level: z.string().default("info"),
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

export const defaultConfigPath = () =>
    path.join(homedir(), ".config", "review-orchestrator", "config.json")

export const loadConfig = ({
    configPath = defaultConfigPath(),
    home = homedir(),
    read = readFileSync,
} = {}) => {
    let raw
    try {
        raw = read(configPath, "utf8")
    } catch (err) {
        if (err.code === "ENOENT") {
            const e = new Error(`config file not found: ${configPath}`)
            e.code = "CONFIG_NOT_FOUND"
            throw e
        }
        throw err
    }

    let parsed
    try {
        parsed = JSON.parse(raw)
    } catch (err) {
        const e = new Error(`config file is not valid JSON: ${err.message}`)
        e.code = "CONFIG_INVALID_JSON"
        throw e
    }

    const result = ConfigSchema.safeParse(parsed)
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
