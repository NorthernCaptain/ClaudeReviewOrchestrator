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
                model: z.string().default("gpt-5-codex"),
                ignoreProjectRules: z.boolean().default(true),
                extraArgs: z.array(z.string()).default([]),
            })
            .default({}),
        limits: z
            .object({
                maxCodexRounds: z.number().int().min(1).default(5),
                maxBlocks: z.number().int().min(1).default(6),
                idleResetMinutes: z.number().int().min(1).default(10),
                codexTimeoutSeconds: z.number().int().min(1).default(240),
                maxPayloadBytes: z.number().int().min(1024).default(262144),
                maxFileBytes: z.number().int().min(512).default(65536),
                maxFiles: z.number().int().min(1).default(40),
            })
            .default({}),
        ignorePaths: z.array(z.string()).default(DEFAULT_IGNORE_PATHS),
        blockingSeverities: z.array(Severity).default(["blocker", "major"]),
        reviewsDir: z.string().default("./reviews"),
        reviewsRetentionDays: z.number().int().nullable().default(null),
        logging: z
            .object({
                dir: z.string().default("~/.claude/logs"),
                level: z.string().default("info"),
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
