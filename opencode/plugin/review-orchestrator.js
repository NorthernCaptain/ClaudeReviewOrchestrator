/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

// opencode plugin for the review orchestrator — the opencode-side
// equivalent of the Claude / codex Stop + PostToolUse hooks.
//
// Installed to ~/.config/opencode/plugin/review-orchestrator.js. opencode
// auto-discovers any *.js / *.ts in a config scope's plugin/ dir, so no
// entry in opencode.json is needed (verified against opencode 1.18.13:
// `opencode debug config` reports it under plugin_origins with
// scope: "global").
//
// Three hooks, mapping onto what the other two CLIs get:
//   config              → registers the `review` MCP server so the agent
//                         gets request_review / reset_review_context.
//                         Done here rather than in opencode.json so the
//                         X-Review-Token never lands in opencode's config
//                         (codex has no such hook — its token is written
//                         into config.toml at 0600).
//   tool.execute.after  → POST /notify-change after file-mutating tools
//                         (the PostToolUse analog).
//   event/session.idle  → POST /review when a turn ends and, on blocking
//                         findings, feed them back into the session (the
//                         Stop analog).
//
// WHY session.idle + promptAsync: opencode has no hook that can veto the
// end of a turn the way Claude's Stop hook does with decision:"block", so
// "blocking" is expressed by sending the block reason back in as a new
// user turn. The request still carries trigger:"stop_hook", so the
// server's round/block accounting, NO_PROGRESS detection and MAX_BLOCKS
// cap are what terminate the loop — identical to the Claude path. Set
// REVIEW_ORCH_OPENCODE_PASSIVE=1 to report findings as a toast instead of
// continuing the session, or REVIEW_ORCH_SKIP=1 to disable the plugin
// outright (same env var the other two CLIs honor).
//
// KNOWN LIMIT: this only lands in a long-lived server (TUI / `opencode
// serve`). Headless `opencode run` exits the moment the turn ends and
// aborts the in-flight /review with it — nothing is archived and nothing
// is injected. The skill therefore tells the agent to call request_review
// itself, which works everywhere because it runs inside the turn.
//
// The /review protocol itself — endpoint, token, and the status→decision
// mapping including the block-reason formatting — is NOT reimplemented
// here. It is imported from the same hooks/stop-review.mjs the other CLIs
// run, installed alongside as a plain module (see LIB_PATH). Duplicating
// it would guarantee drift in the one place all three clients must agree.

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

const CONFIG_PATH = () =>
    path.join(homedir(), ".config", "review-orchestrator", "config.json")

// Installed copy of hooks/stop-review.mjs. Lives under our own config dir
// rather than next to this file: opencode scans the plugin dir and would
// try to load a stray module there as a plugin.
const LIB_PATH = (env) =>
    env?.REVIEW_ORCH_LIB ??
    path.join(
        homedir(),
        ".config",
        "review-orchestrator",
        "lib",
        "stop-review.mjs"
    )

// opencode's file-mutating built-ins. `bash` is included for the same
// reason the codex integration matches exec_command: a shell call can
// write files, and a missed edit only costs us a redundant review.
const MUTATING_TOOLS = new Set(["write", "edit", "patch", "bash"])

const NOTIFY_TIMEOUT_MS = 2000
const DEFAULT_REVIEW_TIMEOUT_MS = 280 * 1000

const notifyUrlFrom = (reviewUrl) =>
    reviewUrl.replace(/\/review$/, "/notify-change")

const mcpUrlFrom = (reviewUrl) => reviewUrl.replace(/\/review$/, "/mcp")

// hey-api clients resolve to { data, error }; unwrap defensively so a
// future shape change degrades to "no session info" instead of throwing.
const unwrap = (res) => (res && "data" in res ? res.data : res)

// Generated with ThrowOnError=false, so a failed call RESOLVES to
// { data: undefined, error } instead of rejecting. Returns the error side
// of such a result, or null when the call succeeded.
const resolvedError = (res) =>
    res && typeof res === "object" && "error" in res && res.error
        ? res.error
        : null

// Only ever called with a truthy error, from either the rejection or the
// resolved-{error} path — which is why there is no falsy branch.
const describeError = (err) => {
    if (typeof err === "string") return err
    if (err.message) return String(err.message)
    if (err.data?.message) return String(err.data.message)
    try {
        return JSON.stringify(err).slice(0, 300)
    } catch {
        return String(err)
    }
}

const postJson = async ({ url, token, body, timeoutMs, fetchImpl }) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
        const res = await fetchImpl(url, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-review-token": token,
            },
            body: JSON.stringify(body),
            signal: controller.signal,
        })
        let parsed = null
        try {
            parsed = await res.json()
        } catch {
            parsed = null
        }
        return { httpStatus: res.status, body: parsed, error: null }
    } catch (err) {
        return {
            httpStatus: null,
            body: null,
            error:
                err?.name === "AbortError"
                    ? `request timed out after ${timeoutMs}ms`
                    : (err?.message ?? String(err)),
        }
    } finally {
        clearTimeout(timer)
    }
}

// Everything below is deliberately module-private: opencode treats EVERY
// export of a plugin module as a plugin candidate, and a single export
// that isn't a Plugin function makes it skip the module silently — no
// error, no hooks, nothing in the log (verified on opencode 1.18.13). The
// test seams are therefore extra keys on the input object instead of
// extra exports; opencode only ever passes its own PluginInput, so they
// fall back to the real implementations in production.
const buildHooks = async ({
    client,
    directory,
    env = process.env,
    fetchImpl = null,
    readFile = readFileSync,
    // eslint-disable-next-line node/no-unsupported-features/es-syntax -- eslint-plugin-node's feature table predates Node 12.17; dynamic import is fine on the Node 24 this targets
    importLib = (specifier) => import(specifier),
    logLine = (line) => process.stderr.write(`${line}\n`),
} = {}) => {
    const skipRaw = env?.REVIEW_ORCH_SKIP
    if (typeof skipRaw === "string" && skipRaw.length > 0) {
        logLine(
            `review-orchestrator: plugin disabled (REVIEW_ORCH_SKIP=${skipRaw})`
        )
        return {}
    }

    let lib
    try {
        lib = await importLib(pathToFileURL(LIB_PATH(env)).href)
    } catch (err) {
        // A half-installed orchestrator must not break opencode startup.
        logLine(
            "review-orchestrator: plugin inactive — could not load " +
                `${LIB_PATH(env)} (${err?.message ?? err}). Rerun install.sh --opencode.`
        )
        return {}
    }

    const config = lib.readToken({ configPath: CONFIG_PATH(), read: readFile })
    if (!config) {
        logLine(
            "review-orchestrator: plugin inactive — no authToken in " +
                CONFIG_PATH()
        )
        return {}
    }

    // Same transport the Stop hook uses, and for the same reason: a review
    // can outlast undici's 300s headers/body timeouts, which fire
    // independently of our AbortController while the server holds the
    // connection open — turning a long review into "fetch failed" and
    // losing the findings. Bun's fetch has no such cap today, but this
    // borrows the lib's node:http client rather than depending on that.
    const httpFetch = fetchImpl ?? lib.nodeHttpFetch ?? globalThis.fetch

    const passive =
        typeof env?.REVIEW_ORCH_OPENCODE_PASSIVE === "string" &&
        env.REVIEW_ORCH_OPENCODE_PASSIVE.length > 0
    const reviewTimeoutMs = config.fetchTimeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS
    const inFlight = new Set()

    const toast = async (message, variant) => {
        try {
            await client?.tui?.showToast?.({
                body: { title: "code review", message, variant },
            })
        } catch {
            // TUI absent (headless `opencode run`) — stderr already has it.
        }
    }

    // One opencode server can host sessions in several worktrees, so both
    // the review and the change notification must target the repo the
    // session is actually editing — not whichever one loaded the plugin.
    // Cached because a session's directory never changes, and
    // tool.execute.after has to stay cheap.
    const infoCache = new Map()
    const sessionInfo = async (sessionID) => {
        if (infoCache.has(sessionID)) return infoCache.get(sessionID)
        let info = null
        try {
            info = unwrap(await client.session.get({ path: { id: sessionID } }))
        } catch {
            info = null
        }
        if (info) infoCache.set(sessionID, info)
        return info
    }

    const cwdFor = async (sessionID) => {
        const info = await sessionInfo(sessionID)
        const cwd = info?.directory ?? directory
        return typeof cwd === "string" && cwd.length > 0 ? cwd : null
    }

    const notifyChange = async (sessionID, tool, file) => {
        const cwd = await cwdFor(sessionID)
        if (!cwd) return
        await postJson({
            url: notifyUrlFrom(config.url),
            token: config.token,
            body: { cwd, tool, file },
            timeoutMs: NOTIFY_TIMEOUT_MS,
            fetchImpl: httpFetch,
        })
    }

    const review = async (sessionID) => {
        if (inFlight.has(sessionID)) return
        inFlight.add(sessionID)
        try {
            const info = await sessionInfo(sessionID)
            // Subagent turns end constantly and are not the user's turn.
            if (info?.parentID) return
            const cwd = await cwdFor(sessionID)
            if (!cwd) return

            logLine("review-orchestrator: reviewing changes…")
            const res = await postJson({
                url: config.url,
                token: config.token,
                body: { cwd, session_id: sessionID, trigger: "stop_hook" },
                timeoutMs: reviewTimeoutMs,
                fetchImpl: httpFetch,
            })
            const decision = lib.decideStopHookResponse({
                reviewResponse: res.body,
                fetchHttpStatus: res.httpStatus,
                fetchError: res.error,
            })
            for (const line of decision.stderrLines) logLine(line)

            const reason = decision.stdoutJson?.reason
            if (!reason) {
                const status = res.body?.status
                if (status && status !== "ISSUES") {
                    await toast(
                        status,
                        status.startsWith("GOOD_TO_GO") ||
                            status === "NO_CHANGES"
                            ? "success"
                            : "warning"
                    )
                }
                return
            }

            // decideStopHookResponse puts the findings ONLY in the block
            // reason for ISSUES — stderrLines is empty — so anywhere we
            // don't hand the reason to the session, we have to print it
            // ourselves or it is lost.
            if (passive) {
                logLine(reason)
                // ESCALATE with notifyUser also lands here, and a reviewer
                // failure is not a finding — don't mislabel it.
                const failed = res.body?.status === "ESCALATE"
                await toast(
                    failed
                        ? "reviewer failed — see the terminal output"
                        : "blocking findings — see the terminal output",
                    failed ? "error" : "warning"
                )
                return
            }

            // Fire-and-forget: promptAsync returns as soon as the turn is
            // queued. Awaiting the full turn here would keep this event
            // handler open for the length of the follow-up work.
            // A rejection and a resolved { error } both mean the findings
            // never reached the session — typically because the user started
            // a new turn between idle and here. Their turn wins, so print
            // the findings rather than dropping them.
            let handBackError = null
            try {
                handBackError = resolvedError(
                    await client.session.promptAsync({
                        path: { id: sessionID },
                        body: { parts: [{ type: "text", text: reason }] },
                    })
                )
            } catch (err) {
                handBackError = err
            }
            if (handBackError) {
                logLine(
                    "review-orchestrator: could not hand the findings back " +
                        `to the session (${describeError(handBackError)})`
                )
                logLine(reason)
            }
        } finally {
            inFlight.delete(sessionID)
        }
    }

    return {
        config: async (cfg) => {
            // Never clobber a hand-written entry.
            if (cfg.mcp?.review) return
            cfg.mcp = {
                ...(cfg.mcp ?? {}),
                review: {
                    type: "remote",
                    url: mcpUrlFrom(config.url),
                    enabled: true,
                    headers: { "X-Review-Token": config.token },
                },
            }
        },
        // input is {tool, sessionID, callID, args} — args IS present on the
        // after-hook (declared in @opencode-ai/plugin's Hooks type and
        // confirmed at runtime on 1.18.13: a `write` call arrives with
        // args.filePath as an absolute path). Still read defensively, since
        // `file` is only diagnostic for the server.
        "tool.execute.after": async (input) => {
            if (!MUTATING_TOOLS.has(input?.tool)) return
            await notifyChange(
                input.sessionID,
                input.tool,
                input?.args?.filePath ?? null
            )
        },
        event: async ({ event }) => {
            if (event?.type !== "session.idle") return
            const sessionID = event?.properties?.sessionID
            if (typeof sessionID !== "string" || sessionID.length === 0) return
            await review(sessionID)
        },
    }
}

// The ONLY export. See the note above buildHooks before adding another.
export default async (input) => buildHooks(input)
