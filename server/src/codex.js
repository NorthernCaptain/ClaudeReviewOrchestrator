/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { spawn as nodeSpawn } from "node:child_process"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import Ajv from "ajv/dist/2020.js"

const here = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_SCHEMA_PATH = path.join(here, "codex-output.schema.json")

const loadSchema = (schemaPath) => JSON.parse(readFileSync(schemaPath, "utf8"))

const compileValidator = (schemaPath) => {
    const ajv = new Ajv({ allErrors: true, strict: false })
    return ajv.compile(loadSchema(schemaPath))
}

let cachedValidator = null
const defaultValidator = () => {
    if (!cachedValidator) {
        cachedValidator = compileValidator(DEFAULT_SCHEMA_PATH)
    }
    return cachedValidator
}

export const buildCodexArgs = ({ repoRoot, config, schemaPath }) => {
    const args = [
        "exec",
        "--cd",
        repoRoot,
        "--ephemeral",
        "--sandbox",
        "read-only",
        "--model",
        config.codex.model,
        "--output-schema",
        schemaPath,
    ]
    if (config.codex.ignoreProjectRules) args.push("--ignore-rules")
    for (const extra of config.codex.extraArgs) args.push(extra)
    args.push("-")
    return args
}

export const runCodex = ({
    repoRoot,
    prompt,
    config,
    schemaPath = DEFAULT_SCHEMA_PATH,
    spawn = nodeSpawn,
    now = Date.now,
}) =>
    new Promise((resolve, reject) => {
        const args = buildCodexArgs({ repoRoot, config, schemaPath })
        const startedAt = now()
        let child
        try {
            child = spawn(config.codex.binary, args, {
                stdio: ["pipe", "pipe", "pipe"],
            })
        } catch (err) {
            reject(err)
            return
        }

        const timeoutMs = config.limits.codexTimeoutSeconds * 1000
        let finished = false
        let stdout = ""
        let stderr = ""
        let timedOut = false

        const timer = setTimeout(() => {
            timedOut = true
            try {
                child.kill("SIGTERM")
            } catch {
                // ignore
            }
            // Give it a moment to flush, then force.
            setTimeout(() => {
                try {
                    child.kill("SIGKILL")
                } catch {
                    // ignore
                }
            }, 500).unref?.()
        }, timeoutMs)
        timer.unref?.()

        const finish = (exitCode, signal) => {
            if (finished) return
            finished = true
            clearTimeout(timer)
            resolve({
                rawStdout: stdout,
                rawStderr: stderr,
                exitCode: exitCode ?? null,
                signal: signal ?? null,
                durationMs: now() - startedAt,
                timedOut,
                argv: [config.codex.binary, ...args],
            })
        }

        child.stdout?.on("data", (chunk) => {
            stdout += chunk.toString("utf8")
        })
        child.stderr?.on("data", (chunk) => {
            stderr += chunk.toString("utf8")
        })
        child.on("error", (err) => {
            if (finished) return
            finished = true
            clearTimeout(timer)
            reject(err)
        })
        child.on("close", finish)

        try {
            child.stdin?.write(prompt)
            child.stdin?.end()
        } catch (err) {
            if (!finished) {
                finished = true
                clearTimeout(timer)
                reject(err)
            }
        }
    })

export const parseCodexOutput = (rawStdout, validator = defaultValidator()) => {
    if (typeof rawStdout !== "string" || rawStdout.trim() === "") {
        return {
            ok: false,
            error: {
                code: "EMPTY_OUTPUT",
                message: "Codex produced no stdout",
            },
        }
    }
    let parsed
    try {
        parsed = JSON.parse(rawStdout)
    } catch {
        // Fenced JSON: ```json\n{...}\n```
        const fence = rawStdout.match(/```json\s*\n([\s\S]+?)\n```/)
        if (fence) {
            try {
                parsed = JSON.parse(fence[1])
            } catch (err2) {
                return {
                    ok: false,
                    error: {
                        code: "INVALID_JSON",
                        message: err2.message,
                    },
                }
            }
        } else {
            return {
                ok: false,
                error: {
                    code: "INVALID_JSON",
                    message:
                        "Codex stdout is not JSON and contains no ```json fence",
                },
            }
        }
    }

    if (!validator(parsed)) {
        return {
            ok: false,
            error: {
                code: "SCHEMA_INVALID",
                message: "Codex output failed schema validation",
                details: validator.errors,
            },
        }
    }

    return { ok: true, value: parsed }
}

export const runAndParse = async ({
    repoRoot,
    prompt,
    config,
    schemaPath = DEFAULT_SCHEMA_PATH,
    spawn = nodeSpawn,
    validator,
    now = Date.now,
}) => {
    const v =
        validator ??
        (schemaPath === DEFAULT_SCHEMA_PATH
            ? defaultValidator()
            : compileValidator(schemaPath))
    const raw = await runCodex({
        repoRoot,
        prompt,
        config,
        schemaPath,
        spawn,
        now,
    })

    if (raw.timedOut) {
        return {
            status: "ESCALATE",
            reason: `codex timed out after ${config.limits.codexTimeoutSeconds}s`,
            raw,
        }
    }
    if (raw.exitCode !== 0) {
        return {
            status: "ESCALATE",
            reason: `codex exited with code ${raw.exitCode}${raw.signal ? ` (signal ${raw.signal})` : ""}`,
            raw,
        }
    }

    const parsed = parseCodexOutput(raw.rawStdout, v)
    if (!parsed.ok) {
        return {
            status: "ESCALATE",
            reason: `codex output ${parsed.error.code}: ${parsed.error.message}`,
            schemaError: parsed.error,
            raw,
        }
    }

    return {
        status: parsed.value.status,
        findings: parsed.value.findings,
        raw,
    }
}

export const __defaults__ = {
    DEFAULT_SCHEMA_PATH,
    defaultValidator,
    compileValidator,
}
