#!/usr/bin/env node
/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

// Claude Code Stop hook for the review orchestrator.
//
// Reads a Stop event JSON payload from stdin, calls the local
// /review endpoint, and either writes a Stop-hook block decision JSON to
// stdout (forcing Claude to continue addressing review findings) or exits
// 0 with an optional stderr summary. Failures are caught and surfaced as
// exit 0 + a log line — the hook MUST never break the user's CLI session.

import { appendFileSync, mkdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

const DEFAULT_CONFIG_PATH = () =>
    path.join(homedir(), ".config", "review-orchestrator", "config.json")
const DEFAULT_LOG_FILE = () =>
    path.join(homedir(), ".claude", "logs", "review-hook.log")
const DEFAULT_PORT = 7777
const DEFAULT_BIND = "127.0.0.1"
const DEFAULT_TIMEOUT_MS = 280 * 1000

// Read the local server's connection info from the config file. Both the
// token AND the URL come from the same file so a custom port set in
// config.json automatically reaches the hook. Returns
//   { token: string, url: string } on success, or null on any error /
// missing fields — every error becomes a fail-open signal so the calling
// hook can exit 0 without spamming the user.
export const readToken = ({
    configPath = DEFAULT_CONFIG_PATH(),
    read = readFileSync,
} = {}) => {
    try {
        const raw = read(configPath, "utf8")
        const parsed = JSON.parse(raw)
        if (
            !parsed ||
            typeof parsed.authToken !== "string" ||
            parsed.authToken.length === 0
        ) {
            return null
        }
        const port = Number.isInteger(parsed.port) ? parsed.port : DEFAULT_PORT
        const bind =
            typeof parsed.bind === "string" && parsed.bind.length > 0
                ? parsed.bind
                : DEFAULT_BIND
        const url = `http://${bind}:${port}/review`
        return { token: parsed.authToken, url }
    } catch {
        return null
    }
}

// Append a JSON-line log entry. Best-effort — log failures are silently
// swallowed because the hook's contract is "never break the user".
export const appendLogLine = (
    entry,
    { logFile = DEFAULT_LOG_FILE(), now = Date.now } = {}
) => {
    try {
        mkdirSync(path.dirname(logFile), { recursive: true })
        const line =
            JSON.stringify({
                ts: new Date(now()).toISOString(),
                ...entry,
            }) + "\n"
        appendFileSync(logFile, line)
    } catch {
        // best-effort
    }
}

const fmtFinding = (f) => {
    const file = f?.file ?? "(unknown)"
    const line = f?.line ?? 0
    const sev = f?.severity ?? "issue"
    const msg = (f?.message ?? "").trim()
    let s = `- \`${file}:${line}\` *(${sev})* — ${msg}`
    if (f?.suggestion) s += `\n  Suggestion: ${String(f.suggestion).trim()}`
    return s
}

// Render the BLOCKING findings as a grouped-by-severity markdown block.
// Non-blocking findings (minor/nit by default config) are intentionally
// omitted from the block reason — they reach the user via a stderr
// summary on the GOOD_TO_GO_WITH_NOTES path instead.
export const formatBlockingFindings = (envelope) => {
    const blocking = envelope?.blockingFindings ?? []
    if (blocking.length === 0) return ""
    const buckets = { blocker: [], major: [], minor: [], nit: [] }
    for (const f of blocking) {
        if (buckets[f.severity]) buckets[f.severity].push(f)
    }
    const out = []
    for (const sev of ["blocker", "major", "minor", "nit"]) {
        if (buckets[sev].length === 0) continue
        out.push(`### ${sev.toUpperCase()}`)
        for (const f of buckets[sev]) out.push(fmtFinding(f))
        out.push("")
    }
    return out.join("\n").trim()
}

const formatRoundHeader = (envelope) => {
    const state = envelope?.state ?? {}
    const rounds = state.codexRounds ?? "?"
    const blocks = state.blockCount ?? "?"
    return `Codex review (round ${rounds}, block ${blocks})`
}

// Decide what the hook should emit based on the /review response (or an
// error condition observed before the response landed). Pure function —
// no I/O — so it's trivially unit-testable across every result.status.
//
// Returns:
//   { stdoutJson: object | null, stderrLines: string[], logEntry: object }
//
// stdoutJson, when non-null, is the Stop-hook decision JSON Claude reads
// to keep the loop alive. stderrLines are user-visible status/notes.
// logEntry is appended to ~/.claude/logs/review-hook.log by the caller.
export const decideStopHookResponse = ({
    reviewResponse = null,
    fetchError = null,
    fetchHttpStatus = null,
} = {}) => {
    if (fetchError) {
        return {
            stdoutJson: null,
            stderrLines: [`review-orchestrator: ${fetchError}`],
            logEntry: { event: "fetch_error", error: fetchError },
        }
    }
    if (fetchHttpStatus && fetchHttpStatus >= 400) {
        return {
            stdoutJson: null,
            stderrLines: [
                `review-orchestrator: server returned HTTP ${fetchHttpStatus}`,
            ],
            logEntry: {
                event: "http_error",
                status: fetchHttpStatus,
                body: reviewResponse,
            },
        }
    }
    if (!reviewResponse || typeof reviewResponse !== "object") {
        return {
            stdoutJson: null,
            stderrLines: ["review-orchestrator: empty response from server"],
            logEntry: { event: "empty_response" },
        }
    }

    const status = reviewResponse.status
    const findings = reviewResponse.findings ?? []
    const blocking = reviewResponse.blockingFindings ?? []

    switch (status) {
        case "GOOD_TO_GO":
        case "NO_CHANGES":
            return {
                stdoutJson: null,
                stderrLines: [`review-orchestrator: ${status}`],
                logEntry: { event: "pass", status },
            }
        case "GOOD_TO_GO_WITH_NOTES": {
            const lines = [
                `review-orchestrator: GOOD_TO_GO_WITH_NOTES (${findings.length} non-blocking notes)`,
            ]
            for (const f of findings.slice(0, 5)) {
                lines.push(
                    `  • ${f.file}:${f.line ?? 0} (${f.severity}) — ${(f.message ?? "").trim()}`
                )
            }
            if (findings.length > 5) {
                lines.push(`  ...and ${findings.length - 5} more`)
            }
            return {
                stdoutJson: null,
                stderrLines: lines,
                logEntry: {
                    event: "pass_with_notes",
                    findingsCount: findings.length,
                },
            }
        }
        case "ESCALATE": {
            const reason = (reviewResponse.reason ?? "").trim()
            const code = reviewResponse.code ?? "unknown"
            return {
                stdoutJson: null,
                stderrLines: [
                    `review-orchestrator: ESCALATE (${code}) — ${reason}`.trim(),
                ],
                logEntry: { event: "escalate", code, reason },
            }
        }
        case "ISSUES":
        case "NO_PROGRESS_WITH_OPEN_ISSUES": {
            const header = formatRoundHeader(reviewResponse)
            const body = formatBlockingFindings(reviewResponse)
            const tail =
                status === "NO_PROGRESS_WITH_OPEN_ISSUES"
                    ? "No on-disk progress since the last review. Edit the flagged files, then finish."
                    : "Address every BLOCKING point, then finish."
            const reason = [
                `${header}:`,
                "",
                body || "(no blocking-findings detail available)",
                "",
                tail,
            ].join("\n")
            return {
                stdoutJson: { decision: "block", reason },
                stderrLines: [],
                logEntry: {
                    event: "block",
                    status,
                    blockingCount: blocking.length,
                    findingsCount: findings.length,
                },
            }
        }
        default:
            return {
                stdoutJson: null,
                stderrLines: [`review-orchestrator: unknown status ${status}`],
                logEntry: { event: "unknown_status", status },
            }
    }
}

const readStdinJSON = async (stdin) => {
    let buf = ""
    for await (const chunk of stdin) {
        buf += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk)
    }
    if (!buf.trim()) return {}
    return JSON.parse(buf)
}

// Main hook entrypoint. Dependencies injected so the integration test
// can drive it with fake streams + fetch + token reader + clock.
export const main = async ({
    stdin = process.stdin,
    stdout = process.stdout,
    stderr = process.stderr,
    fetchFn = globalThis.fetch,
    now = Date.now,
    log = appendLogLine,
    tokenReader = readToken,
    urlOverride = null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) => {
    let payload
    try {
        payload = await readStdinJSON(stdin)
    } catch (err) {
        stderr.write(
            `review-orchestrator: failed to parse Stop payload: ${err.message}\n`
        )
        log({ event: "bad_stdin", error: err.message }, { now })
        return 0
    }

    const cwd = payload?.cwd
    const session_id = payload?.session_id
    if (!cwd || typeof cwd !== "string") {
        log({ event: "no_cwd_in_payload", payload }, { now })
        return 0
    }

    const config = tokenReader()
    if (!config) {
        stderr.write(
            "review-orchestrator: no auth token found in config; skipping review.\n"
        )
        log({ event: "no_token" }, { now })
        return 0
    }
    // urlOverride lets tests target a fake server; in production the URL
    // is derived from the same config file as the token.
    const targetUrl = urlOverride ?? config.url

    stderr.write("review-orchestrator: reviewing changes with Codex…\n")

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let httpStatus = null
    let body = null
    let fetchError = null
    try {
        const res = await fetchFn(targetUrl, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-review-token": config.token,
            },
            body: JSON.stringify({ cwd, session_id, trigger: "stop_hook" }),
            signal: controller.signal,
        })
        httpStatus = res.status
        try {
            body = await res.json()
        } catch {
            body = null
        }
    } catch (err) {
        fetchError =
            err?.name === "AbortError"
                ? `request timed out after ${timeoutMs}ms`
                : (err?.message ?? String(err))
    } finally {
        clearTimeout(timer)
    }

    const decision = decideStopHookResponse({
        reviewResponse: body,
        fetchHttpStatus: httpStatus,
        fetchError,
    })
    if (decision.stdoutJson) {
        stdout.write(JSON.stringify(decision.stdoutJson) + "\n")
    }
    for (const line of decision.stderrLines) {
        stderr.write(line + "\n")
    }
    log(decision.logEntry, { now })
    return 0
}

/* istanbul ignore next -- executable guard exercised by smoke test only */
const isDirectInvocation = () => {
    if (!process.argv[1]) return false
    if (!import.meta.url.startsWith("file:")) return false
    const argv1Base = path.basename(process.argv[1])
    return import.meta.url.endsWith(argv1Base)
}

/* istanbul ignore next */
if (isDirectInvocation()) {
    main().then((code) => {
        process.exitCode = code
    })
}
