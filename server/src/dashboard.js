/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

// Self-contained HTML dashboard served at GET /. No external assets,
// no client-side framework, no auth — localhost-only is the trust
// boundary (the orchestrator binds 127.0.0.1 by default). Render is
// pure: `renderDashboard({ version, config, uptimeSeconds, records })`
// returns the HTML string and is unit-tested without an HTTP server.
//
// The chart is inline SVG; row expand/collapse uses native
// <details>/<summary> so no JS at all.

const STATUS_COLORS = {
    GOOD_TO_GO: "#4ade80",
    NO_CHANGES: "#22c55e",
    GOOD_TO_GO_WITH_NOTES: "#facc15",
    ISSUES: "#3b82f6",
    NO_PROGRESS_WITH_OPEN_ISSUES: "#6366f1",
    ESCALATE: "#ef4444",
}
const STATUS_FALLBACK = "#94a3b8"

const SEVERITY_BADGE = {
    blocker: { bg: "#fee2e2", fg: "#b91c1c" },
    major: { bg: "#ffedd5", fg: "#c2410c" },
    minor: { bg: "#fef9c3", fg: "#a16207" },
    nit: { bg: "#e0e7ff", fg: "#4338ca" },
}

const ESCAPE_RE = /[&<>"'`]/g
const ESCAPE_MAP = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
    "`": "&#96;",
}
export const escapeHtml = (s) => {
    if (s === null || s === undefined) return ""
    return String(s).replace(ESCAPE_RE, (c) => ESCAPE_MAP[c])
}

const fmtMs = (ms) => {
    if (typeof ms !== "number" || !Number.isFinite(ms)) return "—"
    if (ms < 1000) return `${ms} ms`
    const s = ms / 1000
    if (s < 60) return `${s.toFixed(1)}s`
    const m = Math.floor(s / 60)
    const r = Math.round(s - m * 60)
    return `${m}m ${r}s`
}

const fmtUptime = (sec) => {
    if (typeof sec !== "number" || sec < 0) return "—"
    const d = Math.floor(sec / 86400)
    const h = Math.floor((sec % 86400) / 3600)
    const m = Math.floor((sec % 3600) / 60)
    const s = Math.floor(sec % 60)
    const parts = []
    if (d) parts.push(`${d}d`)
    if (d || h) parts.push(`${h}h`)
    if (d || h || m) parts.push(`${m}m`)
    parts.push(`${s}s`)
    return parts.join(" ")
}

const fmtTs = (iso) => {
    if (!iso) return "—"
    try {
        const d = new Date(iso)
        if (Number.isNaN(d.getTime())) return iso
        // YYYY-MM-DD HH:MM:SS local time — the dashboard is for a
        // localhost operator so local tz is the right default.
        return d.toLocaleString("sv-SE", {
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
        })
    } catch {
        return iso
    }
}

// Build the inline SVG chart. Bars left-to-right are OLDEST-to-NEWEST
// (records arrive newest-first; we reverse for the chart). Height
// is log-scaled on durationMs; color is by status; the findings
// count is a small label above the bar. ESCALATE bars are red so
// errors/timeouts pop visually.
const renderChart = (records) => {
    const ordered = records.slice().reverse()
    const W = 1000
    const H = 220
    const padL = 48
    const padR = 12
    const padT = 24
    const padB = 40
    const innerW = W - padL - padR
    const innerH = H - padT - padB
    if (ordered.length === 0) {
        return `<svg viewBox="0 0 ${W} ${H}" class="chart" aria-label="empty timeline">
            <text x="${W / 2}" y="${H / 2}" text-anchor="middle" class="empty">no reviews yet</text>
        </svg>`
    }
    const maxDur = Math.max(
        1000,
        ...ordered.map((r) =>
            typeof r.durationMs === "number" ? r.durationMs : 0
        )
    )
    // Log scale so a 200ms ESCALATE next to a 300s real review is still
    // visible. log1p keeps zero-duration bars renderable.
    const scale = (ms) => {
        const v = Math.max(0, typeof ms === "number" ? ms : 0)
        return (Math.log1p(v) / Math.log1p(maxDur)) * innerH
    }
    const gap = 2
    const barW = Math.max(
        2,
        (innerW - gap * (ordered.length - 1)) / ordered.length
    )
    const bars = ordered
        .map((r, i) => {
            const h = scale(r.durationMs)
            const x = padL + i * (barW + gap)
            const y = padT + (innerH - h)
            const color = STATUS_COLORS[r.status] ?? STATUS_FALLBACK
            const titleAttr = escapeHtml(
                `${fmtTs(r.ts)} · ${r.context} · ${r.status ?? "?"} · ${fmtMs(r.durationMs)} · ${r.findingsCount} finding${r.findingsCount === 1 ? "" : "s"}`
            )
            const label =
                r.findingsCount > 0 && barW >= 8
                    ? `<text x="${x + barW / 2}" y="${y - 4}" text-anchor="middle" class="bar-label">${r.findingsCount}</text>`
                    : ""
            return (
                `<g><title>${titleAttr}</title>` +
                `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${barW.toFixed(2)}" height="${h.toFixed(2)}" fill="${color}" rx="1"/>` +
                label +
                `</g>`
            )
        })
        .join("")

    // Light reference lines + duration ticks on the left axis.
    const refDurs = [1000, 10_000, 60_000, 300_000].filter((d) => d <= maxDur)
    const refs = refDurs
        .map((d) => {
            const y = padT + (innerH - scale(d))
            return (
                `<line x1="${padL}" x2="${W - padR}" y1="${y.toFixed(2)}" y2="${y.toFixed(2)}" class="ref"/>` +
                `<text x="${padL - 6}" y="${(y + 4).toFixed(2)}" text-anchor="end" class="ref-label">${fmtMs(d)}</text>`
            )
        })
        .join("")

    // X-axis tick: first and last timestamp.
    const firstTs = fmtTs(ordered[0]?.ts)
    const lastTs = fmtTs(ordered[ordered.length - 1]?.ts)
    const xLabels =
        `<text x="${padL}" y="${H - 12}" text-anchor="start" class="ref-label">${escapeHtml(firstTs)}</text>` +
        (ordered.length > 1
            ? `<text x="${W - padR}" y="${H - 12}" text-anchor="end" class="ref-label">${escapeHtml(lastTs)}</text>`
            : "")

    return (
        `<svg viewBox="0 0 ${W} ${H}" class="chart" preserveAspectRatio="xMidYMid meet">` +
        refs +
        bars +
        xLabels +
        `</svg>`
    )
}

const renderConfigPanel = (config) => {
    if (!config) return ""
    const provider = config.provider ?? "codex"
    const cells = [
        ["provider", provider],
        ["model", config.model ?? "—"],
        ["effort / mode", config.effortOrMode ?? "—"],
        [
            "reviewer timeout",
            config.reviewerTimeoutSeconds
                ? `${config.reviewerTimeoutSeconds}s`
                : "—",
        ],
        [
            "hook fetch timeout",
            config.hookFetchTimeoutSeconds === null ||
            config.hookFetchTimeoutSeconds === undefined
                ? "auto"
                : `${config.hookFetchTimeoutSeconds}s`,
        ],
        ["max rounds", config.maxCodexRounds ?? "—"],
        ["max blocks", config.maxBlocks ?? "—"],
        [
            "blocking severities",
            Array.isArray(config.blockingSeverities)
                ? config.blockingSeverities.join(", ")
                : "—",
        ],
        ["allowed roots", config.allowedRootsCount ?? "—"],
        ["port / bind", `${config.port ?? "—"} · ${config.bind ?? "—"}`],
    ]
    return (
        `<dl class="config">` +
        cells
            .map(
                ([k, v]) =>
                    `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(String(v))}</dd></div>`
            )
            .join("") +
        `</dl>`
    )
}

const renderFinding = (f) => {
    const sev = String(f.severity ?? "?").toLowerCase()
    const badge = SEVERITY_BADGE[sev] ?? { bg: "#e5e7eb", fg: "#374151" }
    const file = escapeHtml(f.file ?? "(unknown)")
    const line = Number.isInteger(f.line) ? f.line : 0
    const cat = escapeHtml(f.category ?? "")
    const msg = escapeHtml(f.message ?? "")
    const suggestion = f.suggestion
        ? `<div class="suggest">${escapeHtml(
              String(f.suggestion).slice(0, 800)
          )}${String(f.suggestion).length > 800 ? "…" : ""}</div>`
        : ""
    return (
        `<li>` +
        `<span class="sev" style="background:${badge.bg};color:${badge.fg}">${escapeHtml(sev)}</span> ` +
        `<code class="loc">${file}:${line}</code> ` +
        `<span class="cat">${cat}</span>` +
        `<div class="msg">${msg}</div>` +
        suggestion +
        `</li>`
    )
}

const renderSuccessRow = (r) => {
    const color = STATUS_COLORS[r.status] ?? STATUS_FALLBACK
    const summary =
        `<summary>` +
        `<span class="ts">${escapeHtml(fmtTs(r.ts))}</span>` +
        `<span class="repo">${escapeHtml(r.context)}</span>` +
        `<span class="status" style="color:${color}">${escapeHtml(r.status ?? "?")}</span>` +
        `<span class="dur">${escapeHtml(fmtMs(r.durationMs))}</span>` +
        `<span class="count">${r.findingsCount} (blocking: ${r.blockingCount})</span>` +
        `</summary>`
    const body =
        r.findingsCount === 0
            ? `<div class="empty">no findings — clean review</div>`
            : `<ul class="findings">${r.findings.map(renderFinding).join("")}</ul>`
    const meta =
        `<div class="meta">` +
        `<span>round ${escapeHtml(String(r.round ?? "?"))}</span>` +
        `<span>block ${escapeHtml(String(r.blockCount ?? "?"))}</span>` +
        `<span>${escapeHtml(r.trigger ?? "?")}</span>` +
        `<span>${escapeHtml(r.provider ?? "?")} · ${escapeHtml(r.model ?? "?")}</span>` +
        (r.droppedCount > 0
            ? `<span class="warn">${r.droppedCount} dropped</span>`
            : "") +
        `</div>`
    return `<details>${summary}${meta}${body}</details>`
}

const renderFailureRow = (r) => {
    const d = r.failureDetail ?? {}
    // Coerce reason: archive blobs come from disk and a hand-edited
    // file could leave `reason` non-string. Coerce once at the top
    // so every downstream slice / length / template-literal use is
    // safe.
    const reasonStr =
        r.reason === null || r.reason === undefined ? "—" : String(r.reason)
    const shortReason = reasonStr.slice(0, 120)
    const summary =
        `<summary>` +
        `<span class="ts">${escapeHtml(fmtTs(r.ts))}</span>` +
        `<span class="repo">${escapeHtml(r.context)}</span>` +
        `<span class="dur">${escapeHtml(fmtMs(r.durationMs))}</span>` +
        `<span class="reason">${escapeHtml(shortReason)}${reasonStr.length > 120 ? "…" : ""}</span>` +
        `</summary>`
    const kv = (k, v) =>
        v === null || v === undefined || v === ""
            ? ""
            : `<div class="kv"><dt>${escapeHtml(k)}</dt><dd><code>${escapeHtml(String(v))}</code></dd></div>`
    const argvHtml = Array.isArray(d.argv)
        ? `<div class="kv"><dt>argv</dt><dd><code>${escapeHtml(d.argv.join(" "))}</code></dd></div>`
        : ""
    const stderr = d.stderrTail
        ? `<pre class="stderr">${escapeHtml(d.stderrTail)}</pre>`
        : ""
    const stdout = d.stdoutTail
        ? `<details class="stdout"><summary>stdout tail (last 800B)</summary><pre>${escapeHtml(d.stdoutTail)}</pre></details>`
        : ""
    const schema = d.schemaError
        ? `<pre class="schema">${escapeHtml(
              JSON.stringify(d.schemaError, null, 2)
          )}</pre>`
        : ""
    const meta =
        `<div class="meta">` +
        `<span>code ${escapeHtml(r.code ?? "?")}</span>` +
        `<span>exit ${escapeHtml(String(d.exitCode ?? "?"))}</span>` +
        `<span>${escapeHtml(r.provider ?? "?")} · ${escapeHtml(r.model ?? "?")}</span>` +
        `</div>`
    return (
        `<details class="fail">${summary}${meta}` +
        kv("reason", r.reason) +
        argvHtml +
        (stderr
            ? `<div class="kv"><dt>stderr tail</dt><dd>${stderr}</dd></div>`
            : "") +
        (stdout
            ? `<div class="kv"><dt>stdout tail</dt><dd>${stdout}</dd></div>`
            : "") +
        (schema
            ? `<div class="kv"><dt>schema error</dt><dd>${schema}</dd></div>`
            : "") +
        `</details>`
    )
}

// Built-in styles. Kept short and dark-mode-friendly via the
// prefers-color-scheme media query. Single <style> block — no
// external assets.
const CSS = `
:root {
  --bg: #fafafa; --panel: #ffffff; --fg: #111827; --muted: #6b7280;
  --border: #e5e7eb; --accent: #2563eb;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f172a; --panel: #1e293b; --fg: #f1f5f9; --muted: #94a3b8;
    --border: #334155; --accent: #60a5fa;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: var(--bg); color: var(--fg);
  font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
  Helvetica, Arial, sans-serif; }
main { max-width: 1100px; margin: 0 auto; padding: 24px 16px 80px; }
header { display: flex; align-items: baseline; justify-content: space-between;
  gap: 16px; margin-bottom: 8px; }
header h1 { font-size: 22px; margin: 0; letter-spacing: -0.01em; }
header .meta { color: var(--muted); font-size: 13px; }
header .version { font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  color: var(--accent); }
section { background: var(--panel); border: 1px solid var(--border);
  border-radius: 8px; padding: 16px; margin-top: 16px; }
section h2 { font-size: 14px; margin: 0 0 12px; text-transform: uppercase;
  letter-spacing: 0.05em; color: var(--muted); font-weight: 600; }
.config { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 10px 24px; margin: 0; }
.config div { display: flex; flex-direction: column; }
.config dt { color: var(--muted); font-size: 11px; text-transform: uppercase;
  letter-spacing: 0.05em; }
.config dd { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 13px; }
svg.chart { width: 100%; height: auto; display: block; }
svg.chart .ref { stroke: var(--border); stroke-width: 1; stroke-dasharray: 2 3; }
svg.chart .ref-label { fill: var(--muted); font-size: 10px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
svg.chart .bar-label { fill: var(--muted); font-size: 9px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
svg.chart .empty { fill: var(--muted); font-size: 12px; }
details { border-top: 1px solid var(--border); }
details:first-of-type { border-top: 0; }
summary { display: grid; grid-template-columns: 170px 1fr 110px 90px 130px 24px;
  align-items: center; gap: 12px; padding: 8px 0; cursor: pointer;
  list-style: none; }
summary::-webkit-details-marker { display: none; }
summary::after { content: "▸"; color: var(--muted); justify-self: end;
  transition: transform 0.15s; }
details[open] > summary::after { transform: rotate(90deg); }
details.fail > summary { grid-template-columns: 170px 220px 90px 1fr 24px; }
.ts { color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.repo { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
.status { font-weight: 600; font-size: 12px; text-transform: uppercase;
  letter-spacing: 0.04em; }
.dur, .count { font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px; color: var(--muted); }
.reason { font-size: 12px; color: var(--muted); overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; }
.meta { display: flex; flex-wrap: wrap; gap: 6px 14px; color: var(--muted);
  font-size: 11px; padding: 4px 0 8px; }
.meta .warn { color: #c2410c; }
ul.findings { list-style: none; padding: 0 0 12px 0; margin: 0; }
ul.findings li { padding: 10px 0; border-top: 1px dashed var(--border); }
ul.findings li:first-child { border-top: 0; }
.sev { display: inline-block; padding: 1px 6px; border-radius: 3px;
  font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em;
  font-weight: 600; }
.loc { font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px; }
.cat { color: var(--muted); font-size: 11px; }
.msg { margin: 4px 0 0; }
.suggest { background: var(--bg); border-left: 3px solid var(--accent);
  padding: 6px 10px; margin: 6px 0 0; font-size: 12px; white-space: pre-wrap;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.kv { display: grid; grid-template-columns: 110px 1fr; gap: 8px;
  padding: 4px 0; align-items: start; }
.kv dt { color: var(--muted); font-size: 11px; text-transform: uppercase;
  letter-spacing: 0.05em; margin: 0; }
.kv dd { margin: 0; }
.kv code, pre { background: var(--bg); padding: 2px 4px; border-radius: 3px;
  font-size: 11px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
pre { padding: 8px 10px; overflow: auto; max-height: 240px; white-space: pre-wrap;
  word-break: break-word; }
.empty { color: var(--muted); padding: 8px 0; font-style: italic; }
footer { color: var(--muted); font-size: 11px; text-align: center;
  margin-top: 32px; }
`

export const renderDashboard = ({
    version = "unknown",
    config = null,
    uptimeSeconds = null,
    startedAt = null,
    records = [],
} = {}) => {
    const successes = records.filter((r) => r.status !== "ESCALATE")
    const failures = records.filter((r) => r.status === "ESCALATE")
    const startedAtStr = startedAt ? fmtTs(startedAt) : "—"
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>review-orchestrator</title>
<style>${CSS}</style>
</head>
<body>
<main>
<header>
  <h1>review-orchestrator <span class="version">v${escapeHtml(version)}</span></h1>
  <div class="meta">started ${escapeHtml(startedAtStr)} · uptime ${escapeHtml(fmtUptime(uptimeSeconds))} · ${records.length} record${records.length === 1 ? "" : "s"} (${failures.length} failed)</div>
</header>

<section aria-label="active config">
  <h2>active config</h2>
  ${renderConfigPanel(config)}
</section>

<section aria-label="timeline">
  <h2>timeline · last ${records.length} review${records.length === 1 ? "" : "s"} (oldest → newest)</h2>
  ${renderChart(records)}
  <div class="meta" style="padding-top:4px">bars colored by status · height = duration (log scale) · label above = findings count</div>
</section>

<section aria-label="reviews">
  <h2>reviews · ${successes.length}</h2>
  ${
      successes.length === 0
          ? `<div class="empty">no successful reviews recorded yet</div>`
          : successes.map(renderSuccessRow).join("")
  }
</section>

<section aria-label="failed">
  <h2>failed · ${failures.length}</h2>
  ${
      failures.length === 0
          ? `<div class="empty">no failed reviews recorded yet</div>`
          : failures.map(renderFailureRow).join("")
  }
</section>

<footer>review-orchestrator · localhost only · no auth on this page</footer>
</main>
</body>
</html>`
}

export const mountDashboardRoute = (
    app,
    { archive, config, summarize, version, startedAt } = {}
) => {
    app.get("/", (_req, res) => {
        const records = archive?.readRecent
            ? archive.readRecent({ limit: 200 })
            : []
        const summary = summarize ? summarize(config) : null
        const uptimeSeconds =
            typeof startedAt === "number"
                ? Math.max(0, Math.round((Date.now() - startedAt) / 1000))
                : null
        const html = renderDashboard({
            version,
            config: summary,
            uptimeSeconds,
            startedAt: startedAt ? new Date(startedAt).toISOString() : null,
            records,
        })
        res.setHeader("Content-Type", "text/html; charset=utf-8")
        res.setHeader("Cache-Control", "no-store")
        res.status(200).send(html)
    })
}

export const __test__ = {
    fmtMs,
    fmtUptime,
    fmtTs,
    renderChart,
    renderConfigPanel,
    renderFinding,
    renderSuccessRow,
    renderFailureRow,
}
