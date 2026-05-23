/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import {
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from "node:fs"
import path from "node:path"

const RAW_STDERR_TAIL_BYTES = 4096

// Filesystem-safe filename for a UTC ISO-8601 instant.
// 2026-05-21T14:30:45.123Z → 2026-05-21T14-30-45-123Z.
// Milliseconds are preserved deliberately so two reviewer rounds in the same
// second do not collide on the same filename.
export const tsForFilename = (epochMs) => {
    const iso = new Date(epochMs).toISOString()
    return iso.replace(/:/g, "-").replace(/\.(\d{3})Z$/, "-$1Z")
}

export const sanitizeBranch = (branch) => {
    if (typeof branch !== "string" || branch.length === 0) return "-"
    // `/` is not legal in POSIX filenames; replace with __ as documented.
    return branch.replace(/\//g, "__")
}

// Folder name for a context. README leaves the colon literal — macOS allows
// it at the POSIX level (Finder cosmetically shows it as `/`).
export const folderName = ({ repo, branch }) =>
    `${repo}:${sanitizeBranch(branch)}`

const tail = (s, n) => {
    if (typeof s !== "string") return ""
    if (s.length <= n) return s
    return s.slice(s.length - n)
}

const writeAtomic = (filePath, content) => {
    const tmp = `${filePath}.tmp`
    writeFileSync(tmp, content, { mode: 0o600 })
    renameSync(tmp, filePath)
}

const SEVERITIES = ["blocker", "major", "minor", "nit"]

const SEVERITY_LABEL = {
    blocker: "Blockers",
    major: "Major",
    minor: "Minor",
    nit: "Nits",
}

const fmtFinding = (f) => {
    const file = f?.file ?? "(unknown)"
    const line = f?.line ?? 0
    const msg = (f?.message ?? "").trim()
    const lines = [`- \`${file}:${line}\` — ${msg}`]
    if (f?.suggestion) {
        const sug = String(f.suggestion).trim()
        if (sug) lines.push(`  *Suggestion:* ${sug}`)
    }
    return lines.join("\n")
}

const fmtPayloadSize = (totalBytes, truncated) => {
    const kb = (totalBytes / 1024).toFixed(1)
    return `${kb} KB (${truncated ? "truncated" : "not truncated"})`
}

const renderMarkdown = (record, blockingSeverities) => {
    const blockingSet = new Set(blockingSeverities ?? ["blocker", "major"])
    const ts = record.timestamp.replace("T", " ").replace(/\.\d{3}Z$/, " UTC")
    const codex = record.codex ?? {}
    const baseline = record.baseline ?? {}
    const result = record.result ?? {}
    const findings = result.findings ?? []
    const dropped = result.droppedFindings ?? []
    const priorFed = record.priorFindingsFedIn ?? []

    const out = []
    out.push(
        `# Review — ${record.context.repo}:${record.context.branch} — ${ts}`
    )
    out.push("")
    out.push(`- **Status:** ${result.status}`)
    out.push(`- **Trigger:** ${record.trigger}`)
    if (baseline.headSha) {
        out.push(`- **HEAD:** ${baseline.headSha.slice(0, 7)}`)
    }
    if (codex.model) {
        const dur =
            typeof codex.durationMs === "number"
                ? ` (${(codex.durationMs / 1000).toFixed(1)}s)`
                : ""
        // `codex` is the archive blob's name for the raw reviewer
        // record (kept for back-compat); `provider` inside it is the
        // actual reviewer that ran. Fall back to the legacy label
        // when reviewing a pre-multi-provider archive.
        const providerLabel = codex.provider
            ? `${codex.provider} (${codex.model})`
            : codex.model
        out.push(`- **Reviewer:** ${providerLabel}${dur}`)
    }
    if (typeof baseline.totalBytes === "number") {
        out.push(
            `- **Payload:** ${fmtPayloadSize(baseline.totalBytes, !!baseline.truncated)}`
        )
    }
    out.push(
        `- **Round:** ${record.round} / **Block count:** ${record.blockCount}`
    )
    if (result.reason) {
        out.push(`- **Reason:** ${result.reason}`)
    }
    out.push("")

    for (const sev of SEVERITIES) {
        const items = findings.filter((f) => f.severity === sev)
        if (items.length === 0) continue
        const blocking = blockingSet.has(sev)
        out.push(
            `## ${SEVERITY_LABEL[sev]} (${blocking ? "blocking" : "non-blocking"})`
        )
        for (const f of items) out.push(fmtFinding(f))
        out.push("")
    }

    if (dropped.length > 0) {
        out.push("---")
        out.push(
            `## Dropped findings (referenced files outside the review payload)`
        )
        for (const f of dropped) {
            const file = f?.file ?? "(unknown)"
            const msg = (f?.message ?? "").trim()
            out.push(`- \`${file}\` — ${msg}`)
        }
        out.push("")
    }

    if (priorFed.length > 0) {
        out.push("---")
        out.push(`## Prior findings fed to the reviewer this round`)
        for (const f of priorFed) {
            out.push(
                `- \`${f.file ?? "(unknown)"}:${f.line ?? 0}\` — ${(f.message ?? "").trim()}`
            )
        }
        out.push("")
    }

    return out.join("\n")
}

const buildRecord = ({
    context,
    payload,
    codexRaw,
    result,
    state,
    trigger,
    priorFindingsFedIn,
    timestampMs,
    round,
    blockCount,
}) => ({
    timestamp: new Date(timestampMs).toISOString(),
    context: {
        key: context.key,
        repo: context.repo,
        repoRoot: context.repoRoot,
        branch: context.branch,
    },
    // Explicit round/blockCount win over the state snapshot — useful when
    // the caller has zeroed the live counters for a terminal status but
    // wants the archive to reflect this round's actual count.
    round: round ?? state?.codexRounds ?? null,
    blockCount: blockCount ?? state?.blockCount ?? null,
    trigger,
    baseline: {
        headSha: payload?.headSha ?? null,
        promptHash: payload?.promptHash ?? null,
        progressHash: payload?.progressHash ?? null,
        files: payload?.files ?? null,
        totalBytes: payload?.totalBytes ?? null,
        truncated: payload?.truncated ?? null,
    },
    codex: codexRaw
        ? {
              binary: (codexRaw.argv ?? [])[0] ?? null,
              // `provider` is the actual reviewer that ran (codex,
              // claude, gemini). The archive blob's outer field stays
              // named "codex" for back-compat with archived records
              // from before the multi-provider switch.
              provider: codexRaw.provider ?? null,
              model: codexRaw.model ?? null,
              argv: codexRaw.argv ?? null,
              durationMs: codexRaw.durationMs ?? null,
              exitCode: codexRaw.exitCode ?? null,
              timedOut: !!codexRaw.timedOut,
              oversize: !!codexRaw.oversize,
              rawStdout: codexRaw.rawStdout ?? "",
              rawStderrTail: tail(
                  codexRaw.rawStderr ?? "",
                  RAW_STDERR_TAIL_BYTES
              ),
          }
        : null,
    result: {
        status: result.status,
        findings: result.findings ?? [],
        blockingFindings: result.blockingFindings ?? [],
        droppedFindings: result.droppedFindings ?? [],
        parseError: result.schemaError ?? null,
        reason: result.reason ?? null,
    },
    priorFindingsFedIn: priorFindingsFedIn ?? [],
})

const parseTimestampFromFilename = (name) => {
    // Matches "2026-05-21T14-30-45-123Z.json" (or .md).
    const m = name.match(
        /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.(?:json|md)$/
    )
    if (!m) return null
    const iso = `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`
    const t = Date.parse(iso)
    return Number.isFinite(t) ? t : null
}

const safeReaddir = (dir) => {
    try {
        return readdirSync(dir, { withFileTypes: true })
    } catch {
        return []
    }
}

export const createArchive = ({
    reviewsDir,
    retentionDays = null,
    now = Date.now,
    logger = null,
    blockingSeverities = ["blocker", "major"],
} = {}) => {
    if (!reviewsDir || typeof reviewsDir !== "string") {
        throw new Error("createArchive requires a reviewsDir")
    }

    const ensureFolder = (context) => {
        const folder = path.join(reviewsDir, folderName(context))
        mkdirSync(folder, { recursive: true })
        return folder
    }

    const write = ({
        context,
        payload,
        codexRaw,
        result,
        state,
        trigger,
        priorFindingsFedIn = [],
        round,
        blockCount,
    }) => {
        const ts = now()
        let folder
        try {
            folder = ensureFolder(context)
        } catch (err) {
            logger?.error?.(
                { err: err?.message, reviewsDir, repo: context?.repo },
                "archive: failed to create context folder"
            )
            return { ok: false, error: err }
        }
        const base = tsForFilename(ts)
        const jsonPath = path.join(folder, `${base}.json`)
        const mdPath = path.join(folder, `${base}.md`)

        const record = buildRecord({
            context,
            payload,
            codexRaw,
            result,
            state,
            trigger,
            priorFindingsFedIn,
            timestampMs: ts,
            round,
            blockCount,
        })

        const md = renderMarkdown(record, blockingSeverities)

        // Write JSON first — it's the source of truth. Errors here are
        // logged loudly; the caller sees ok:false but never sees an
        // exception (archive failure must not break the review path).
        try {
            writeAtomic(jsonPath, JSON.stringify(record, null, 2))
        } catch (err) {
            logger?.error?.(
                { err: err?.message, jsonPath },
                "archive: failed to write JSON record"
            )
            return { ok: false, error: err }
        }

        // Markdown is best-effort; a failure here is logged but the JSON
        // sibling already landed.
        try {
            writeAtomic(mdPath, md)
        } catch (err) {
            logger?.warn?.(
                { err: err?.message, mdPath },
                "archive: failed to write markdown sibling; JSON record kept"
            )
            return { ok: true, jsonPath, record, mdError: err }
        }

        return { ok: true, jsonPath, mdPath, record }
    }

    const pruneOnStartup = () => {
        if (retentionDays == null) return { removed: 0 }
        const cutoff = now() - retentionDays * 24 * 60 * 60 * 1000
        let removed = 0
        for (const ctxEntry of safeReaddir(reviewsDir)) {
            if (!ctxEntry.isDirectory()) continue
            const ctxDir = path.join(reviewsDir, ctxEntry.name)
            for (const file of safeReaddir(ctxDir)) {
                if (!file.isFile()) continue
                const t = parseTimestampFromFilename(file.name)
                if (t == null) continue
                if (t >= cutoff) continue
                try {
                    unlinkSync(path.join(ctxDir, file.name))
                    removed++
                } catch (err) {
                    logger?.warn?.(
                        { err: err?.message, file: file.name },
                        "failed to prune archive file"
                    )
                }
            }
        }
        return { removed }
    }

    const list = () => {
        const out = []
        for (const ctxEntry of safeReaddir(reviewsDir)) {
            if (!ctxEntry.isDirectory()) continue
            const ctxDir = path.join(reviewsDir, ctxEntry.name)
            const files = safeReaddir(ctxDir)
                .filter((f) => f.isFile() && f.name.endsWith(".json"))
                .map((f) => ({
                    context: ctxEntry.name,
                    name: f.name,
                    mtimeMs: (() => {
                        try {
                            return statSync(path.join(ctxDir, f.name)).mtimeMs
                        } catch {
                            return 0
                        }
                    })(),
                }))
            for (const f of files) out.push(f)
        }
        return out
    }

    // Powers the dashboard at GET /. Lists every archived record across
    // all contexts, sorts newest-first by file mtime, reads up to
    // `limit` records, and normalizes each into the minimal shape the
    // dashboard renderer needs. Files that fail to read / parse are
    // skipped silently so a single bad file can't break the dashboard.
    const readRecent = ({ limit = 200 } = {}) => {
        const all = list()
            .slice()
            .sort((a, b) => b.mtimeMs - a.mtimeMs)
            .slice(0, Math.max(0, limit))
        const out = []
        for (const entry of all) {
            const filePath = path.join(reviewsDir, entry.context, entry.name)
            let record
            try {
                record = JSON.parse(readFileSync(filePath, "utf8"))
            } catch {
                continue
            }
            // JSON.parse("null") returns null (and similarly "42" /
            // '"str"' return non-objects) — guard so the dashboard
            // doesn't crash on a hand-corrupted archive file.
            if (!record || typeof record !== "object") continue
            const result = record.result ?? {}
            const codex = record.codex ?? {}
            const context = record.context ?? {}
            const findings = Array.isArray(result.findings)
                ? result.findings
                : []
            const blocking = Array.isArray(result.blockingFindings)
                ? result.blockingFindings
                : []
            out.push({
                ts: record.timestamp ?? null,
                mtimeMs: entry.mtimeMs,
                context: entry.context,
                repo: context.repo ?? entry.context.split(":")[0] ?? null,
                branch: context.branch ?? entry.context.split(":")[1] ?? null,
                status: result.status ?? null,
                durationMs: codex.durationMs ?? null,
                findingsCount: findings.length,
                blockingCount: blocking.length,
                droppedCount: Array.isArray(result.droppedFindings)
                    ? result.droppedFindings.length
                    : 0,
                reason: result.reason ?? null,
                code: result.code ?? null,
                provider: codex.provider ?? null,
                model: codex.model ?? null,
                round: record.round ?? null,
                blockCount: record.blockCount ?? null,
                trigger: record.trigger ?? null,
                findings,
                failureDetail:
                    result.status === "ESCALATE"
                        ? {
                              exitCode: codex.exitCode ?? null,
                              stderrTail: codex.rawStderrTail ?? "",
                              stdoutTail: String(codex.rawStdout ?? "").slice(
                                  -800
                              ),
                              schemaError: result.schemaError ?? null,
                              argv: codex.argv ?? null,
                          }
                        : null,
                file: path.relative(reviewsDir, filePath),
            })
        }
        return out
    }

    return {
        write,
        pruneOnStartup,
        list,
        readRecent,
        renderMarkdown: (r) => renderMarkdown(r, blockingSeverities),
    }
}

export const __test__ = {
    tsForFilename,
    sanitizeBranch,
    folderName,
    parseTimestampFromFilename,
    renderMarkdown,
    buildRecord,
    tail,
}
