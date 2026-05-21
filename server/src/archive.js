/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import {
    mkdirSync,
    readdirSync,
    renameSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from "node:fs"
import path from "node:path"

const RAW_STDERR_TAIL_BYTES = 4096

// Filesystem-safe filename for a UTC ISO-8601 instant.
// 2026-05-21T14:30:45.123Z → 2026-05-21T14-30-45Z (millis dropped).
export const tsForFilename = (epochMs) => {
    const iso = new Date(epochMs).toISOString().replace(/\.\d{3}Z$/, "Z")
    return iso.replace(/:/g, "-")
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
        out.push(`- **Model:** ${codex.model}${dur}`)
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
        out.push(`## Prior findings fed to Codex this round`)
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
}) => ({
    timestamp: new Date(timestampMs).toISOString(),
    context: {
        key: context.key,
        repo: context.repo,
        repoRoot: context.repoRoot,
        branch: context.branch,
    },
    round: state?.codexRounds ?? null,
    blockCount: state?.blockCount ?? null,
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
    // Matches "2026-05-21T14-30-45Z.json" (or .md).
    const m = name.match(
        /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z\.(?:json|md)$/
    )
    if (!m) return null
    const iso = `${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`
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
    }) => {
        const ts = now()
        const folder = ensureFolder(context)
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
        })

        const md = renderMarkdown(record, blockingSeverities)
        // Write JSON first — it's the source of truth. If MD fails after,
        // we still have the durable record.
        writeAtomic(jsonPath, JSON.stringify(record, null, 2))
        try {
            writeAtomic(mdPath, md)
        } catch (err) {
            logger?.warn?.(
                { err: err?.message, mdPath },
                "failed to write markdown sibling; JSON record kept"
            )
        }

        return { jsonPath, mdPath, record }
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

    return {
        write,
        pruneOnStartup,
        list,
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
