/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { readFileSync } from "node:fs"
import path from "node:path"
import { z } from "zod"

export const PROJECT_CONFIG_FILENAME = ".review-orchestrator.json"

const Severity = z.enum(["blocker", "major", "minor", "nit"])

// Partial limits — every key is optional so projects can override one knob
// without restating the rest. The global config schema already enforces
// the same minima, so we mirror them here.
const PartialLimits = z
    .object({
        maxCodexRounds: z.number().int().min(1).optional(),
        maxBlocks: z.number().int().min(1).optional(),
        idleResetMinutes: z.number().int().min(1).optional(),
        codexTimeoutSeconds: z.number().int().min(1).optional(),
        maxCodexOutputBytes: z.number().int().min(4096).optional(),
        maxPayloadBytes: z.number().int().min(1024).optional(),
        maxFileBytes: z.number().int().min(512).optional(),
        maxFiles: z.number().int().min(1).optional(),
    })
    .strict()

// v1 keyset (see README "Per-project overrides").
const KNOWN_KEYS = new Set([
    "ignorePaths",
    "limits",
    "blockingSeverities",
    "extraReviewerInstructions",
])

const ProjectConfigSchema = z
    .object({
        ignorePaths: z.array(z.string()).optional(),
        limits: PartialLimits.optional(),
        blockingSeverities: z.array(Severity).optional(),
        extraReviewerInstructions: z.string().optional(),
    })
    .strict()

const stripUnknownKeys = (raw, logger) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw
    const unknown = Object.keys(raw).filter((k) => !KNOWN_KEYS.has(k))
    if (unknown.length === 0) return raw
    logger?.warn?.(
        { unknown },
        "project config: ignoring unknown top-level keys"
    )
    const cleaned = {}
    for (const k of Object.keys(raw)) {
        if (KNOWN_KEYS.has(k)) cleaned[k] = raw[k]
    }
    return cleaned
}

export const loadProjectConfig = ({
    repoRoot,
    read = readFileSync,
    logger = null,
} = {}) => {
    if (!repoRoot || typeof repoRoot !== "string") {
        throw new Error("loadProjectConfig requires repoRoot")
    }
    const filePath = path.join(repoRoot, PROJECT_CONFIG_FILENAME)
    let raw
    try {
        raw = read(filePath, "utf8")
    } catch (err) {
        if (err.code === "ENOENT") return null
        logger?.error?.(
            { err: err.message, filePath },
            "project config: read failed"
        )
        return null
    }

    let parsed
    try {
        parsed = JSON.parse(raw)
    } catch (err) {
        logger?.error?.(
            { err: err.message, filePath },
            "project config: invalid JSON"
        )
        return null
    }

    const cleaned = stripUnknownKeys(parsed, logger)
    const result = ProjectConfigSchema.safeParse(cleaned)
    if (!result.success) {
        logger?.error?.(
            {
                issues: result.error.issues.map((i) => ({
                    path: i.path.join("."),
                    message: i.message,
                })),
                filePath,
            },
            "project config: schema validation failed"
        )
        return null
    }
    return result.data
}

export const mergeWithGlobal = (global, project) => {
    if (!project) return global
    const merged = { ...global }
    if (project.ignorePaths) merged.ignorePaths = project.ignorePaths
    if (project.blockingSeverities)
        merged.blockingSeverities = project.blockingSeverities
    if (project.extraReviewerInstructions !== undefined)
        merged.extraReviewerInstructions = project.extraReviewerInstructions
    if (project.limits) {
        merged.limits = { ...global.limits, ...project.limits }
    }
    return merged
}

export const __test__ = {
    ProjectConfigSchema,
    KNOWN_KEYS,
    stripUnknownKeys,
}
