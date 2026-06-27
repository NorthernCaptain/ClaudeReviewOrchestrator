/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

// Gemini CLI adapter for the reviewer.
//
// CLI surface verified against:
//   $ gemini --version  → 0.43.0  (2026-05-22)
//   $ gemini --help     confirmed flags used here:
//     -p, --prompt <text>             Non-interactive mode. The value is
//                                     appended to stdin, so we put the
//                                     reviewer hardening directive on -p
//                                     and stream the bulk of the prompt
//                                     (system preamble + payload + prior
//                                     findings) over stdin to stay well
//                                     under macOS ARG_MAX.
//     -m, --model <id>                Model id, e.g. "gemini-2.5-pro",
//                                     or the routing alias "auto" —
//                                     same as the CLI's interactive
//                                     "Auto (Gemini 3)" picker, which
//                                     routes between gemini-3.1-pro
//                                     and gemini-3-flash per task.
//     --approval-mode <mode>          Choices: default, auto_edit, yolo,
//                                     plan. We use "plan" — it's
//                                     non-interactive AND read-only, the
//                                     only mode appropriate for a code
//                                     reviewer that must not edit files.
//     --skip-trust                    Skip the first-run workspace-trust
//                                     prompt so the CLI doesn't block on
//                                     stdin in headless invocations.
//     -o json                         Emit a JSON envelope of shape:
//                                     { session_id, response, stats,
//                                       error?, warnings? }
//                                     `response` holds the assistant text;
//                                     `error` is populated on failure.
//     --session-id <uuid>             Fresh per-call identifier so each
//                                     review starts from a clean state.
//
// Mirrors the shape of claude.js — same runAndParse contract so the
// review pipeline can switch providers without knowing the difference.
// Key differences vs claude.js:
//   * No CLI-side schema enforcement (gemini has no --json-schema flag).
//     We rely on the prompt-side REVIEWER_DIRECTIVE plus the salvage
//     fallback + ajv re-validation to keep the contract.
//   * Envelope shape is { session_id, response, ... } not
//     { type, subtype, result, ... } — see parseGeminiOutput.
//   * Auth: we do nothing. The spawned process inherits the parent's
//     full process.env, and the gemini CLI's existing credentials —
//     whichever the user already set up (OAuth via `gemini auth login`,
//     GEMINI_API_KEY env var, Vertex/Workload Identity, etc.) — flow
//     through transparently. The orchestrator never asks for a key,
//     never reads one from config, and never adds one to env.
//
//     Caveat for launchd installs: launchd does NOT inherit the user's
//     shell env, so a GEMINI_API_KEY set in ~/.zshrc won't reach the
//     daemon. Filesystem-based auth (OAuth tokens cached under HOME)
//     does work because the plist pins HOME to the install user. If
//     you need env-var auth under launchd, add the variable to the
//     plist's EnvironmentVariables block.

import { spawn as nodeSpawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import Ajv from "ajv/dist/2020.js"
import { normalizeFindings } from "./codex.js"

const here = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_SCHEMA_PATH = path.join(here, "codex-output.schema.json")

// Kept in sync with the JSON schema's category enum. Used to coerce
// gemini's occasional creative category names ("correctness",
// "robustness", ...) into the schema-allowed set instead of rejecting
// an otherwise-valid review.
const ALLOWED_CATEGORIES = new Set([
    "bug",
    "security",
    "perf",
    "style",
    "test",
    "other",
])

// The hardening directive injected via -p. gemini has no --json-schema
// equivalent, so this prompt-side contract is the ONLY thing keeping
// the model from returning prose. Phrased to be unambiguous and short
// (it goes on argv).
const REVIEWER_DIRECTIVE =
    "Output contract (strict): your very FIRST output character MUST be " +
    "`{`. Do NOT write any words, headers, fences, or thinking out loud " +
    "before the JSON. The response is EXACTLY ONE JSON object matching " +
    "the review output schema and NOTHING ELSE — no leading prose, no " +
    "trailing commentary, no markdown. " +
    "Top-level keys: `status` (EXACTLY one of `GOOD_TO_GO` or `ISSUES` — " +
    "GOOD_TO_GO when findings is empty, ISSUES when findings has at " +
    "least one entry; the server derives every other public status " +
    "from these two and the on-disk change state, so you MUST NOT " +
    "emit GOOD_TO_GO_WITH_NOTES, NO_CHANGES, NO_PROGRESS_WITH_OPEN_ISSUES, " +
    "or ESCALATE) and `findings` (array). Each finding has " +
    "`file` (string), `line` (integer ≥1), `severity` (one of blocker, " +
    "major, minor, nit), `category` (one of bug, security, perf, style, " +
    "test, other), `message` (string), and optional `suggestion` " +
    "(string)."

// Surface gemini-cli's loop-detection signal so the caller can emit a
// pointed ESCALATE reason instead of the generic INVALID_JSON. The CLI
// emits envelope.warnings as `["Loop detected, stopping execution"]`
// when the model repeats itself; the envelope still parses, but
// `response` is typically truncated mid-string and our inner JSON
// parse then fails. Returns the first matching warning string or
// null. Match is case-insensitive substring on "loop detected" so a
// minor CLI wording change doesn't lose the signal.
const findLoopWarning = (warnings) => {
    if (!Array.isArray(warnings)) return null
    for (const w of warnings) {
        if (typeof w === "string" && /loop detected/i.test(w)) return w
    }
    return null
}

// Walks the string tracking brace depth; ignores braces inside string
// literals (with backslash escapes honored). Returns the substring from
// the first opening { through the matching closing }, which the caller
// can then JSON.parse. Used to salvage replies where the model
// prepended conversational lead-in despite the directive.
const extractFirstJsonObject = (s) => {
    if (typeof s !== "string") return null
    const start = s.indexOf("{")
    if (start < 0) return null
    let depth = 0
    let inString = false
    let escaped = false
    for (let i = start; i < s.length; i += 1) {
        const ch = s[i]
        if (escaped) {
            escaped = false
            continue
        }
        if (inString) {
            if (ch === "\\") escaped = true
            else if (ch === '"') inString = false
            continue
        }
        if (ch === '"') {
            inString = true
            continue
        }
        if (ch === "{") depth += 1
        else if (ch === "}") {
            depth -= 1
            if (depth === 0) return s.slice(start, i + 1)
        }
    }
    return null
}

const loadSchemaJson = (schemaPath) =>
    JSON.parse(readFileSync(schemaPath, "utf8"))

const compileValidator = (schemaPath) => {
    const ajv = new Ajv({ allErrors: true, strict: false })
    return ajv.compile(loadSchemaJson(schemaPath))
}

let cachedValidator = null
const defaultValidator = () => {
    if (!cachedValidator) {
        cachedValidator = compileValidator(DEFAULT_SCHEMA_PATH)
    }
    return cachedValidator
}

export const buildGeminiArgs = ({ config, sessionId = randomUUID() }) => {
    const g = config.reviewer?.gemini ?? {}
    const args = [
        "-p",
        REVIEWER_DIRECTIVE,
        "-m",
        g.model ?? "auto",
        "--approval-mode",
        g.approvalMode ?? "plan",
        "--skip-trust",
        "-o",
        "json",
        "--session-id",
        sessionId,
    ]
    for (const extra of g.extraArgs ?? []) args.push(extra)
    return args
}

export const runGemini = ({
    repoRoot,
    prompt,
    config,
    spawn = nodeSpawn,
    now = Date.now,
    sessionId,
}) =>
    new Promise((resolve, reject) => {
        const args = buildGeminiArgs({ config, sessionId })
        const binary = config.reviewer?.gemini?.binary ?? "gemini"
        const startedAt = now()
        let child
        try {
            child = spawn(binary, args, {
                cwd: repoRoot,
                stdio: ["pipe", "pipe", "pipe"],
                // Mark the reviewer's process tree so any Stop hook it
                // fires short-circuits instead of recursively calling
                // the orchestrator (hooks/stop-review.mjs honors
                // REVIEW_ORCH_SKIP).
                env: { ...process.env, REVIEW_ORCH_SKIP: "1" },
            })
        } catch (err) {
            reject(err)
            return
        }

        const timeoutMs =
            (config.reviewer?.gemini?.timeoutSeconds ??
                config.limits?.codexTimeoutSeconds ??
                240) * 1000
        // STDOUT is the contract (one JSON object, tiny). STDERR is
        // diagnostic chatter — tool output / reasoning — which can run to
        // megabytes on a large repo and must NOT kill the run. Cap stdout
        // (kill a runaway result); keep stderr as a bounded rolling tail.
        const maxStdoutBytes = config.limits?.maxCodexOutputBytes ?? 1024 * 1024
        const STDERR_TAIL_BYTES = 64 * 1024

        let finished = false
        let stdout = ""
        let stderr = ""
        let stdoutBytes = 0
        let timedOut = false
        let oversize = false

        const killChild = (reason) => {
            try {
                child.kill("SIGTERM")
            } catch {
                // ignore
            }
            setTimeout(() => {
                try {
                    child.kill("SIGKILL")
                } catch {
                    // ignore
                }
            }, 500).unref?.()
            if (reason === "timeout") timedOut = true
            if (reason === "oversize") oversize = true
        }

        const timer = setTimeout(() => killChild("timeout"), timeoutMs)
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
                oversize,
                argv: [binary, ...args],
            })
        }

        const appendStdout = (chunk) => {
            const text = chunk.toString("utf8")
            const len = Buffer.byteLength(text, "utf8")
            if (stdoutBytes + len > maxStdoutBytes) {
                if (!oversize) killChild("oversize")
                return
            }
            stdout += text
            stdoutBytes += len
        }

        const appendStderrTail = (chunk) => {
            stderr += chunk.toString("utf8")
            if (stderr.length > STDERR_TAIL_BYTES) {
                stderr = stderr.slice(stderr.length - STDERR_TAIL_BYTES)
            }
        }

        child.stdout?.on("data", appendStdout)
        child.stderr?.on("data", appendStderrTail)
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

// Unwrap gemini's outer envelope and parse the assistant's reply as
// review JSON. Envelope shape (from packages/core/dist/src/output/
// json-formatter.js in gemini-cli 0.43.0):
//   { session_id, response, stats, error?, warnings? }
// `response` holds the raw assistant text. On failure, `error` is set
// to { type, message, code? } and `response` is typically absent.
export const parseGeminiOutput = (
    rawStdout,
    validator = defaultValidator()
) => {
    if (typeof rawStdout !== "string" || rawStdout.trim() === "") {
        return {
            ok: false,
            error: {
                code: "EMPTY_OUTPUT",
                message: "gemini produced no stdout",
            },
        }
    }

    let envelope
    try {
        envelope = JSON.parse(rawStdout)
    } catch (err) {
        return {
            ok: false,
            error: {
                code: "INVALID_JSON",
                message: `gemini stdout is not JSON: ${err.message}`,
            },
        }
    }

    if (envelope?.error) {
        const err = envelope.error
        return {
            ok: false,
            error: {
                code: "GEMINI_ERROR_ENVELOPE",
                message:
                    typeof err.message === "string"
                        ? err.message
                        : `gemini returned ${err.type ?? "an unknown error"}`,
            },
        }
    }

    // Loop-detection signal (gemini-cli surfaces this via
    // envelope.warnings when the model gets stuck repeating itself; the
    // envelope is well-formed but `response` is typically truncated
    // mid-string, so the inner JSON parse below will fail. Hold the
    // signal so we can emit a clearer code than the generic
    // INVALID_JSON in that case.
    const loopWarning = findLoopWarning(envelope?.warnings)

    const inner = envelope?.response
    if (typeof inner !== "string" || inner.trim() === "") {
        return {
            ok: false,
            error: {
                code: loopWarning ? "GEMINI_LOOP_TRUNCATED" : "EMPTY_RESULT",
                message: loopWarning
                    ? `gemini hit its loop detector and produced no response: "${loopWarning}"`
                    : "gemini envelope had no response string",
            },
        }
    }

    // Strict parse first. When that fails, salvage by extracting the
    // first balanced JSON object substring. gemini's contract is
    // prompt-only (no CLI-side schema enforcement), so the salvage path
    // is the load-bearing safety net, not a backup like in claude.js.
    let parsed
    let salvaged = false
    try {
        parsed = JSON.parse(inner)
    } catch {
        // If the loop detector fired, refuse to salvage. A looped
        // response often contains one or more COMPLETE objects before
        // the cutoff (e.g. `{...}{...` then truncation), so
        // extractFirstJsonObject would happily hand back the first
        // object and we'd return GOOD_TO_GO/ISSUES against a verdict
        // the model never finished. Bail out with the loop code
        // BEFORE the salvage attempt so the operator sees the real
        // reason.
        if (loopWarning) {
            return {
                ok: false,
                error: {
                    code: "GEMINI_LOOP_TRUNCATED",
                    message: `gemini hit its loop detector and truncated mid-output: "${loopWarning}"`,
                },
            }
        }
        const candidate = extractFirstJsonObject(inner)
        if (candidate !== null) {
            try {
                parsed = JSON.parse(candidate)
                salvaged = true
            } catch {
                // fall through to error below
            }
        }
        if (parsed === undefined) {
            return {
                ok: false,
                error: {
                    code: "INVALID_JSON",
                    message:
                        "gemini response is not JSON and contained no balanced JSON object",
                },
            }
        }
    }

    if (parsed && Array.isArray(parsed.findings)) {
        for (const f of parsed.findings) {
            if (
                f &&
                typeof f.category === "string" &&
                !ALLOWED_CATEGORIES.has(f.category)
            ) {
                f.category = "other"
            }
        }
    }

    // Defense in depth: even with the directive spelling out only
    // GOOD_TO_GO/ISSUES, the model occasionally returns a server-side
    // public status (GOOD_TO_GO_WITH_NOTES, NO_CHANGES, …). Coerce to
    // the schema-valid pair before ajv runs — the server's downstream
    // derivePublicStatus() will re-derive the public form correctly.
    if (parsed && typeof parsed.status === "string") {
        const STATUS_COERCE = {
            GOOD_TO_GO_WITH_NOTES: "ISSUES",
            NO_PROGRESS_WITH_OPEN_ISSUES: "ISSUES",
            NO_CHANGES: "GOOD_TO_GO",
            ESCALATE: "ISSUES", // model says "escalate" → treat as ISSUES; server can re-classify
        }
        if (STATUS_COERCE[parsed.status]) {
            parsed.status = STATUS_COERCE[parsed.status]
        }
    }

    parsed = normalizeFindings(parsed)

    if (!validator(parsed)) {
        return {
            ok: false,
            error: {
                code: "SCHEMA_INVALID",
                message: "gemini response failed schema validation",
                details: validator.errors,
            },
        }
    }

    return { ok: true, value: parsed, salvaged }
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
    const raw = await runGemini({
        repoRoot,
        prompt,
        config,
        spawn,
        now,
    })

    if (raw.timedOut) {
        const sec =
            config.reviewer?.gemini?.timeoutSeconds ??
            config.limits?.codexTimeoutSeconds ??
            240
        return {
            status: "ESCALATE",
            reason: `gemini timed out after ${sec}s`,
            raw,
        }
    }
    if (raw.oversize) {
        const cap = config.limits?.maxCodexOutputBytes ?? 1024 * 1024
        return {
            status: "ESCALATE",
            reason: `gemini stdout exceeded ${cap} bytes; killed (runaway result)`,
            raw,
        }
    }

    // Try the envelope BEFORE looking at the exit code — same rationale
    // as claude.js: the CLI sometimes exits non-zero even on a
    // successful review, and a schema-valid result IS the source of
    // truth.
    const parsed = parseGeminiOutput(raw.rawStdout, v)
    if (parsed.ok) {
        return {
            status: parsed.value.status,
            findings: parsed.value.findings,
            salvaged: parsed.salvaged === true,
            raw,
        }
    }

    if (raw.exitCode !== 0) {
        return {
            status: "ESCALATE",
            reason: `gemini exited with code ${raw.exitCode}${raw.signal ? ` (signal ${raw.signal})` : ""}`,
            schemaError: parsed.error,
            raw,
        }
    }

    return {
        status: "ESCALATE",
        reason: `gemini output ${parsed.error.code}: ${parsed.error.message}`,
        schemaError: parsed.error,
        raw,
    }
}

export const __defaults__ = {
    DEFAULT_SCHEMA_PATH,
    defaultValidator,
    compileValidator,
    REVIEWER_DIRECTIVE,
}
