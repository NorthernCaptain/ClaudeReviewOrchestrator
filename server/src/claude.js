/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

// Claude Code CLI adapter for the reviewer.
//
// CLI surface verified against:
//   $ claude --version  → 2.1.148 (Claude Code)  (2026-05-22)
//   $ claude --help     confirmed flags used here:
//     -p, --print                    non-interactive single-shot mode
//     --output-format json           emits the single-result envelope
//                                    (the shape is pinned by the test
//                                    fixture in claude.test.js — see
//                                    "claude_envelope_fixture")
//     --json-schema <schema>         accepts INLINE JSON TEXT (verified
//                                    end-to-end with a real review that
//                                    produced findings; see PR history)
//     --model <id>                   accepts "claude-opus-4-7" and the
//                                    "opus"/"sonnet" aliases
//     --effort <level>               low|medium|high|xhigh|max
//     --permission-mode <mode>       includes "bypassPermissions"
//     --add-dir <path>               grants tool read access to a path
//     --no-session-persistence       skip on-disk session save
//     --session-id <uuid>            fresh per-call identifier
//     --append-system-prompt <s>     appended to default system prompt
//     --disallowed-tools <csv|list>  comma-separated tool names
//
// Mirrors the shape of codex.js — same runAndParse contract so the
// review pipeline can switch providers without knowing the difference.
// Differences vs codex:
//   * Schema is passed as inline JSON via --json-schema (codex takes a
//     path via --output-schema).
//   * Output is wrapped in a Claude envelope { type: "result", subtype:
//     "success", result: "<assistant text>", is_error: false, ... } —
//     see the fixture-based test for the full real-world shape we
//     observed during verification.
//   * Tool restrictions are enforced via --disallowed-tools and the
//     permission mode (bypassPermissions in -p / non-interactive mode is
//     the only mode that actually returns a clean assistant response
//     without an out-of-band permission prompt; the disallowed list IS
//     the safety boundary).
//   * We deliberately do NOT pass --bare. --bare requires
//     ANTHROPIC_API_KEY in env (OAuth/keychain are skipped), so users
//     authed via interactive Claude Code login would see "Not logged
//     in" on every spawn.
//
// argv-size budget note: --json-schema and --append-system-prompt both
// land on argv. macOS ARG_MAX is ~1MB combined with env. The schema is
// ~1KB and the directive is ~250 bytes — well under the limit. If the
// schema grows past ~100KB, revisit and consider a path-based flow.

import { spawn as nodeSpawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import Ajv from "ajv/dist/2020.js"
import { normalizeFindings } from "./codex.js"

const here = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_SCHEMA_PATH = path.join(here, "codex-output.schema.json")

// Allowed values for finding.category — kept in sync with the schema
// file. Used to normalize Claude's occasionally-creative category names
// before schema validation.
const ALLOWED_CATEGORIES = new Set([
    "bug",
    "security",
    "perf",
    "style",
    "test",
    "other",
])

const REVIEWER_DIRECTIVE =
    "Output contract (strict): your very FIRST output character MUST be " +
    "`{`. Do NOT write any words, headers, fences, or thinking out loud " +
    "before the JSON. The response is EXACTLY ONE JSON object matching " +
    "the supplied output schema and NOTHING ELSE — no leading prose, no " +
    "trailing commentary, no markdown. " +
    "Each finding's `category` MUST be exactly one of: " +
    "bug, security, perf, style, test, other. " +
    "Each finding's `severity` MUST be exactly one of: " +
    "blocker, major, minor, nit."

// Find the first balanced JSON object substring in `s`. Returns the
// substring or null when none exists. Used as a defensive fallback when
// Claude prepends a conversational lead-in to its reply despite the
// directive — we'd rather salvage a valid finding set than ESCALATE on
// a syntactically-valid-but-prose-wrapped review.
//
// Walks the string tracking brace depth; ignores braces inside string
// literals (with backslash escapes honored). Returns the substring from
// the first opening { through the matching closing }, which the caller
// can then JSON.parse.
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

const loadSchemaText = (schemaPath) => readFileSync(schemaPath, "utf8")
const loadSchemaJson = (schemaPath) => JSON.parse(loadSchemaText(schemaPath))

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

export const buildClaudeArgs = ({
    repoRoot,
    config,
    schemaPath = DEFAULT_SCHEMA_PATH,
    sessionId = randomUUID(),
}) => {
    const c = config.reviewer?.claude ?? {}
    // NOTE: we do NOT pass --bare. --bare disables OAuth/keychain auth
    // and requires ANTHROPIC_API_KEY in the env, which is rarely set on
    // dev machines using interactive Claude Code login. We accept the
    // loss of strict hermeticity (user-level CLAUDE.md / plugins / MCP
    // servers may load) in exchange for the auth Just Working. The
    // disallowedTools list still keeps the reviewer from mutating
    // anything.
    const args = [
        "-p",
        "--no-session-persistence",
        "--session-id",
        sessionId,
        "--model",
        c.model ?? "claude-opus-4-7",
        "--effort",
        c.effort ?? "high",
        "--permission-mode",
        c.permissionMode ?? "bypassPermissions",
        "--add-dir",
        repoRoot,
        "--output-format",
        "json",
        "--json-schema",
        loadSchemaText(schemaPath),
        "--append-system-prompt",
        REVIEWER_DIRECTIVE,
    ]
    const disallow = c.disallowedTools ?? []
    if (disallow.length > 0) {
        args.push("--disallowed-tools", disallow.join(","))
    }
    for (const extra of c.extraArgs ?? []) args.push(extra)
    return args
}

export const runClaude = ({
    repoRoot,
    prompt,
    config,
    schemaPath = DEFAULT_SCHEMA_PATH,
    spawn = nodeSpawn,
    now = Date.now,
    sessionId,
}) =>
    new Promise((resolve, reject) => {
        const args = buildClaudeArgs({
            repoRoot,
            config,
            schemaPath,
            sessionId,
        })
        const binary = config.reviewer?.claude?.binary ?? "claude"
        const startedAt = now()
        let child
        try {
            child = spawn(binary, args, {
                cwd: repoRoot,
                stdio: ["pipe", "pipe", "pipe"],
                // Mark the reviewer's process tree so the Stop hook the
                // `claude` reviewer carries short-circuits instead of
                // recursively calling the orchestrator
                // (hooks/stop-review.mjs honors REVIEW_ORCH_SKIP).
                env: { ...process.env, REVIEW_ORCH_SKIP: "1" },
            })
        } catch (err) {
            reject(err)
            return
        }

        const timeoutMs =
            (config.reviewer?.claude?.timeoutSeconds ??
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

// Unwrap Claude's outer envelope and parse the assistant's reply as
// review JSON. Claude `--output-format json` always emits one object
// with shape:
//   { type: "result", subtype: "success" | "error_*", result: string,
//     is_error: bool, ... }
// When --json-schema is supplied, Claude refuses to finalize until the
// assistant text JSON-validates against the schema — so on the
// "success" path, `result` is guaranteed schema-conformant and we can
// strict-parse it. We still re-validate locally with ajv because (a) the
// CLI's schema enforcement is a contract we don't get to audit and (b)
// the server's downstream code has to trust the value.
export const parseClaudeOutput = (
    rawStdout,
    validator = defaultValidator()
) => {
    if (typeof rawStdout !== "string" || rawStdout.trim() === "") {
        return {
            ok: false,
            error: {
                code: "EMPTY_OUTPUT",
                message: "Claude produced no stdout",
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
                message: `Claude stdout is not JSON: ${err.message}`,
            },
        }
    }

    if (envelope?.is_error === true || envelope?.subtype !== "success") {
        return {
            ok: false,
            error: {
                code: "CLAUDE_ERROR_ENVELOPE",
                message:
                    envelope?.result ??
                    `Claude returned ${envelope?.subtype ?? "an unknown error"}`,
            },
        }
    }

    const inner = envelope.result
    if (typeof inner !== "string" || inner.trim() === "") {
        return {
            ok: false,
            error: {
                code: "EMPTY_RESULT",
                message: "Claude envelope had no result string",
            },
        }
    }

    // Strict parse first. When that fails, salvage: Claude occasionally
    // prepends a conversational lead-in despite the directive (and the
    // CLI's --json-schema enforcement is best-effort, not guaranteed).
    // We extract the first balanced JSON object substring and try that.
    // The salvage path never lets non-JSON through — it just gives the
    // parser a fair chance against a syntactically-valid-but-wrapped reply.
    let parsed
    let salvaged = false
    try {
        parsed = JSON.parse(inner)
    } catch {
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
                        "Claude result is not JSON and contained no balanced JSON object",
                },
            }
        }
    }

    // Claude's --json-schema enforcement is lenient on enum members:
    // the CLI accepts arbitrary category strings even when the schema
    // restricts them. Coerce any unknown category to "other" so a
    // semantically-correct review isn't rejected over a label mismatch.
    // (Codex's --output-schema enforces this strictly so it never
    // reaches this branch.)
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

    // Defense in depth: occasionally a model emits a server-side
    // public status (GOOD_TO_GO_WITH_NOTES, NO_CHANGES, …) even when
    // the schema is enforced via --json-schema. Coerce to the
    // schema-valid pair so derivePublicStatus() can re-derive the
    // public form correctly downstream.
    if (parsed && typeof parsed.status === "string") {
        const STATUS_COERCE = {
            GOOD_TO_GO_WITH_NOTES: "ISSUES",
            NO_PROGRESS_WITH_OPEN_ISSUES: "ISSUES",
            NO_CHANGES: "GOOD_TO_GO",
            ESCALATE: "ISSUES",
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
                message: "Claude result failed schema validation",
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
    const raw = await runClaude({
        repoRoot,
        prompt,
        config,
        schemaPath,
        spawn,
        now,
    })

    if (raw.timedOut) {
        const sec =
            config.reviewer?.claude?.timeoutSeconds ??
            config.limits?.codexTimeoutSeconds ??
            240
        return {
            status: "ESCALATE",
            reason: `claude timed out after ${sec}s`,
            raw,
        }
    }
    if (raw.oversize) {
        const cap = config.limits?.maxCodexOutputBytes ?? 1024 * 1024
        return {
            status: "ESCALATE",
            reason: `claude stdout exceeded ${cap} bytes; killed (runaway result)`,
            raw,
        }
    }

    // Try the envelope BEFORE looking at the exit code. The Claude CLI
    // commonly exits non-zero in `-p` mode even on a successful review
    // (the assistant returned, the schema validated, but some downstream
    // CLI bookkeeping marked the run as soft-failed). When the envelope
    // is parseable and schema-valid, the review IS the source of truth —
    // the exit code is a noisy signal we should ignore.
    const parsed = parseClaudeOutput(raw.rawStdout, v)
    if (parsed.ok) {
        return {
            status: parsed.value.status,
            findings: parsed.value.findings,
            salvaged: parsed.salvaged === true,
            raw,
        }
    }

    // No usable envelope. Now the exit code matters: surface that as
    // the most likely root cause, then fall back to the parse error.
    if (raw.exitCode !== 0) {
        return {
            status: "ESCALATE",
            reason: `claude exited with code ${raw.exitCode}${raw.signal ? ` (signal ${raw.signal})` : ""}`,
            schemaError: parsed.error,
            raw,
        }
    }

    return {
        status: "ESCALATE",
        reason: `claude output ${parsed.error.code}: ${parsed.error.message}`,
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
