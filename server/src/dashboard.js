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
// Color reused by the FAILED section heading so it matches the
// ESCALATE bars in the timeline at a glance.
const ESCALATE_COLOR = STATUS_COLORS.ESCALATE

// The full status names are long; the summary row's status column
// would wrap into the next column for GOOD_TO_GO_WITH_NOTES and
// NO_PROGRESS_WITH_OPEN_ISSUES. The chart tooltip and the expanded
// row still show the full canonical name; this is purely a display
// abbreviation for the cramped summary cell.
const STATUS_LABEL = {
    GOOD_TO_GO_WITH_NOTES: "GO_WITH_NOTES",
    NO_PROGRESS_WITH_OPEN_ISSUES: "NO_PROGRESS",
}
const labelFor = (status) => STATUS_LABEL[status] ?? status ?? "?"

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

// Pick a step (in whole minutes) that yields at most ~6 ticks for the
// observed max duration so the Y-axis stays readable on long-running
// review fleets without crowding.
const MAX_AXIS_TICKS = 6
const computeAxisTicks = (maxMs) => {
    if (typeof maxMs !== "number" || maxMs <= 0) return []
    if (maxMs < 60000) {
        return [0.25, 0.5, 0.75, 1].map((f) => Math.round(maxMs * f))
    }
    const maxMin = Math.ceil(maxMs / 60000)
    const stepMin = Math.max(1, Math.ceil(maxMin / MAX_AXIS_TICKS))
    const ticks = []
    for (let m = stepMin; m * 60000 <= maxMs + 500; m += stepMin) {
        ticks.push(m * 60000)
    }
    return ticks
}

// Axis label: prefer "Nm" when the value is a whole minute. Falls back
// to the regular fmtMs so sub-minute ticks (and the unusual case of a
// non-round minute) still render sensibly.
const fmtAxisLabel = (ms) => {
    if (typeof ms === "number" && ms >= 60000 && ms % 60000 === 0) {
        return `${ms / 60000}m`
    }
    return fmtMs(ms)
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
    // Linear scale: bar height is proportional to durationMs. A tiny
    // ESCALATE next to a 5-minute review will be a sliver — we floor
    // at 2px so even sub-1% bars stay visible and clickable.
    const MIN_BAR_PX = 2
    const scale = (ms) => {
        const v = Math.max(0, typeof ms === "number" ? ms : 0)
        const h = (v / maxDur) * innerH
        return v > 0 ? Math.max(MIN_BAR_PX, h) : 0
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
            // Wrap each bar in an SVG <a> targeting the matching row's
            // id. The tiny page-load JS opens the target <details> so
            // the user lands on a fully visible review entry.
            const href = r._id ? `#${escapeHtml(r._id)}` : null
            const wrapOpen = href
                ? `<a href="${href}" class="bar-link">`
                : `<g>`
            const wrapClose = href ? `</a>` : `</g>`
            return (
                `${wrapOpen}<title>${titleAttr}</title>` +
                `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${barW.toFixed(2)}" height="${h.toFixed(2)}" fill="${color}" rx="1"/>` +
                label +
                `${wrapClose}`
            )
        })
        .join("")

    // Y-axis ticks. Above 1 minute we step in whole minutes so labels
    // read 1m / 2m / 3m / … instead of arbitrary 25/50/75/100% values
    // like "1m 28s". Below 1 minute we fall back to four percent-based
    // ticks because seconds-scale reviews don't divide cleanly.
    const refDurs = computeAxisTicks(maxDur)
    const refs = refDurs
        .map((d) => {
            const y = padT + (innerH - scale(d))
            return (
                `<line x1="${padL}" x2="${W - padR}" y1="${y.toFixed(2)}" y2="${y.toFixed(2)}" class="ref"/>` +
                `<text x="${padL - 6}" y="${(y + 4).toFixed(2)}" text-anchor="end" class="ref-label">${fmtAxisLabel(d)}</text>`
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

// Pie chart of request buckets (v0.1.16). Three slices:
//   reviewed (green)  — reviewer subprocess ran successfully
//   short-circuit (blue) — cache / no-progress short-circuit
//   errors (red)      — ESCALATE
// Counts are in-process and reset on server restart.
const PIE_COLORS = {
    reviewed: STATUS_COLORS.GOOD_TO_GO,
    shortCircuit: STATUS_COLORS.NO_PROGRESS_WITH_OPEN_ISSUES,
    errors: STATUS_COLORS.ESCALATE,
}
const PIE_LABELS = {
    reviewed: "reviewed",
    shortCircuit: "short-circuit",
    errors: "errors",
}

const polarToCartesian = (cx, cy, r, deg) => {
    const rad = ((deg - 90) * Math.PI) / 180
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) }
}

const arcPath = (cx, cy, r, startDeg, endDeg) => {
    const start = polarToCartesian(cx, cy, r, endDeg)
    const end = polarToCartesian(cx, cy, r, startDeg)
    const large = endDeg - startDeg <= 180 ? 0 : 1
    return [
        `M ${cx} ${cy}`,
        `L ${start.x.toFixed(2)} ${start.y.toFixed(2)}`,
        `A ${r} ${r} 0 ${large} 0 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`,
        "Z",
    ].join(" ")
}

export const renderRequestPie = (metrics) => {
    const m = metrics ?? { reviewed: 0, shortCircuit: 0, errors: 0 }
    const total = (m.reviewed ?? 0) + (m.shortCircuit ?? 0) + (m.errors ?? 0)
    // Compact square box that sits next to the active-config grid.
    // Generous horizontal padding for the callout labels (longest is
    // "short-circuit"). Height stays small enough not to dominate the
    // config row.
    const W = 220
    const H = 170
    const cx = W / 2
    const cy = H / 2
    const r = 56
    if (total === 0) {
        return (
            `<svg viewBox="0 0 ${W} ${H}" class="pie" aria-label="empty pie">` +
            `<circle cx="${cx}" cy="${cy}" r="${r}" class="pie-empty"/>` +
            `<text x="${cx}" y="${cy + 4}" text-anchor="middle" class="empty">no requests</text>` +
            `</svg>`
        )
    }
    const buckets = [
        ["reviewed", m.reviewed ?? 0],
        ["shortCircuit", m.shortCircuit ?? 0],
        ["errors", m.errors ?? 0],
    ].filter(([, n]) => n > 0)

    // Slices. Draw them first so the callout lines/labels render on top.
    let slices
    const sliceMidAngles = []
    if (buckets.length === 1) {
        const [bucket, count] = buckets[0]
        slices =
            `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${PIE_COLORS[bucket]}">` +
            `<title>${escapeHtml(PIE_LABELS[bucket])} · ${count} · 100%</title>` +
            `</circle>`
        // No mid-angles for a full circle — render the single callout
        // straight down so it doesn't overlap the pie body.
        sliceMidAngles.push({ bucket, count, midDeg: 0 })
    } else {
        let startDeg = 0
        slices = buckets
            .map(([bucket, count]) => {
                const sweep = (count / total) * 360
                const endDeg = startDeg + sweep
                const midDeg = startDeg + sweep / 2
                sliceMidAngles.push({ bucket, count, midDeg })
                const pct = ((count / total) * 100).toFixed(1)
                const title = escapeHtml(
                    `${PIE_LABELS[bucket]} · ${count} · ${pct}%`
                )
                const d = arcPath(cx, cy, r, startDeg, endDeg)
                startDeg = endDeg
                return (
                    `<path d="${d}" fill="${PIE_COLORS[bucket]}">` +
                    `<title>${title}</title></path>`
                )
            })
            .join("")
    }

    // Callout labels — short leader line from slice edge to a text
    // anchored just outside the pie. Anchor is left/right based on
    // which side of the pie the mid-angle falls on so labels never
    // overlap the pie body.
    const callouts = sliceMidAngles
        .map(({ bucket, count, midDeg }) => {
            const pct = ((count / total) * 100).toFixed(1)
            const inner = polarToCartesian(cx, cy, r, midDeg)
            const outer = polarToCartesian(cx, cy, r + 10, midDeg)
            const onRight = outer.x >= cx
            const labelX = onRight ? outer.x + 4 : outer.x - 4
            const anchor = onRight ? "start" : "end"
            return (
                `<g class="callout">` +
                `<line x1="${inner.x.toFixed(2)}" y1="${inner.y.toFixed(2)}" x2="${outer.x.toFixed(2)}" y2="${outer.y.toFixed(2)}" stroke="${PIE_COLORS[bucket]}" stroke-width="1"/>` +
                `<text x="${labelX.toFixed(2)}" y="${(outer.y - 2).toFixed(2)}" text-anchor="${anchor}" class="callout-label">${escapeHtml(PIE_LABELS[bucket])}</text>` +
                `<text x="${labelX.toFixed(2)}" y="${(outer.y + 10).toFixed(2)}" text-anchor="${anchor}" class="callout-count">${count} · ${pct}%</text>` +
                `</g>`
            )
        })
        .join("")

    return (
        `<svg viewBox="0 0 ${W} ${H}" class="pie" preserveAspectRatio="xMidYMid meet">` +
        slices +
        callouts +
        `</svg>`
    )
}

// "h:m:s" formatter for total durations on the time-by-status pie.
// Always three colon-separated segments so the units are unambiguous:
// 45 s → "0:00:45", 12m 5s → "0:12:05", 1h 2m 5s → "1:02:05".
const pad2 = (n) => String(n).padStart(2, "0")
const fmtHms = (ms) => {
    const total = Math.max(
        0,
        Math.floor((typeof ms === "number" ? ms : 0) / 1000)
    )
    const h = Math.floor(total / 3600)
    const m = Math.floor((total % 3600) / 60)
    const s = total % 60
    return `${h}:${pad2(m)}:${pad2(s)}`
}

// Time-by-status pie: aggregates durationMs across the dashboard's
// records (last 200) into the four status buckets the archive holds —
// GOOD_TO_GO / GOOD_TO_GO_WITH_NOTES / ISSUES / ESCALATE. NO_CHANGES
// and NO_PROGRESS_WITH_OPEN_ISSUES are cache hits and don't reach the
// archive, so they're not represented. Reuses STATUS_COLORS so the
// slices match the timeline bars at a glance.
const DURATION_STATUSES = [
    "GOOD_TO_GO",
    "GOOD_TO_GO_WITH_NOTES",
    "ISSUES",
    "ESCALATE",
]
const DURATION_LABELS = {
    GOOD_TO_GO: "good-to-go",
    GOOD_TO_GO_WITH_NOTES: "with notes",
    ISSUES: "issues",
    ESCALATE: "escalate",
}

// Aggregate durationMs by status across the records. Exported so the
// dashboard caption ("total H:MM:SS") can reuse the same total the pie
// computed instead of re-walking the array.
export const sumDurationByStatus = (records = []) => {
    const totals = {
        GOOD_TO_GO: 0,
        GOOD_TO_GO_WITH_NOTES: 0,
        ISSUES: 0,
        ESCALATE: 0,
    }
    for (const r of records ?? []) {
        if (!r || typeof r.durationMs !== "number" || r.durationMs <= 0)
            continue
        if (totals[r.status] !== undefined) totals[r.status] += r.durationMs
    }
    const total = DURATION_STATUSES.reduce((s, k) => s + totals[k], 0)
    return { totals, total }
}

export const renderDurationPie = (records = []) => {
    const { totals, total: grandTotal } = sumDurationByStatus(records)

    const W = 220
    const H = 170
    const cx = W / 2
    const cy = H / 2
    const r = 56

    if (grandTotal === 0) {
        return (
            `<svg viewBox="0 0 ${W} ${H}" class="pie" aria-label="empty duration pie">` +
            `<circle cx="${cx}" cy="${cy}" r="${r}" class="pie-empty"/>` +
            `<text x="${cx}" y="${cy + 4}" text-anchor="middle" class="empty">no reviews yet</text>` +
            `</svg>`
        )
    }

    const buckets = DURATION_STATUSES.filter((k) => totals[k] > 0).map((k) => [
        k,
        totals[k],
    ])

    let slices
    const sliceMidAngles = []
    if (buckets.length === 1) {
        const [status, ms] = buckets[0]
        slices =
            `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${STATUS_COLORS[status]}">` +
            `<title>${escapeHtml(DURATION_LABELS[status])} · ${fmtHms(ms)} · 100%</title>` +
            `</circle>`
        sliceMidAngles.push({ status, ms, midDeg: 0 })
    } else {
        let startDeg = 0
        slices = buckets
            .map(([status, ms]) => {
                const sweep = (ms / grandTotal) * 360
                const endDeg = startDeg + sweep
                const midDeg = startDeg + sweep / 2
                sliceMidAngles.push({ status, ms, midDeg })
                const pct = ((ms / grandTotal) * 100).toFixed(1)
                const title = escapeHtml(
                    `${DURATION_LABELS[status]} · ${fmtHms(ms)} · ${pct}%`
                )
                const d = arcPath(cx, cy, r, startDeg, endDeg)
                startDeg = endDeg
                return (
                    `<path d="${d}" fill="${STATUS_COLORS[status]}">` +
                    `<title>${title}</title></path>`
                )
            })
            .join("")
    }

    const callouts = sliceMidAngles
        .map(({ status, ms, midDeg }) => {
            const pct = ((ms / grandTotal) * 100).toFixed(1)
            const inner = polarToCartesian(cx, cy, r, midDeg)
            const outer = polarToCartesian(cx, cy, r + 10, midDeg)
            const onRight = outer.x >= cx
            const labelX = onRight ? outer.x + 4 : outer.x - 4
            const anchor = onRight ? "start" : "end"
            return (
                `<g class="callout">` +
                `<line x1="${inner.x.toFixed(2)}" y1="${inner.y.toFixed(2)}" x2="${outer.x.toFixed(2)}" y2="${outer.y.toFixed(2)}" stroke="${STATUS_COLORS[status]}" stroke-width="1"/>` +
                `<text x="${labelX.toFixed(2)}" y="${(outer.y - 2).toFixed(2)}" text-anchor="${anchor}" class="callout-label">${escapeHtml(DURATION_LABELS[status])}</text>` +
                `<text x="${labelX.toFixed(2)}" y="${(outer.y + 10).toFixed(2)}" text-anchor="${anchor}" class="callout-count">${escapeHtml(fmtHms(ms))} · ${pct}%</text>` +
                `</g>`
            )
        })
        .join("")

    return (
        `<svg viewBox="0 0 ${W} ${H}" class="pie" preserveAspectRatio="xMidYMid meet" data-total-ms="${grandTotal}">` +
        slices +
        callouts +
        `</svg>`
    )
}

// Compact elapsed formatter for running reviews: "12s", "3m 05s",
// "1h 02m". Mirrored in the client poll script below — keep them in sync.
const fmtElapsed = (ms) => {
    const s = Math.max(0, Math.floor((typeof ms === "number" ? ms : 0) / 1000))
    if (s < 60) return `${s}s`
    const m = Math.floor(s / 60)
    if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`
    const h = Math.floor(m / 60)
    return `${h}h ${String(m % 60).padStart(2, "0")}m`
}

// One row per running review: blinking green dot, repo:branch, optional
// provider/force tags, elapsed. `data-started` (epoch ms) lets the
// client script tick the elapsed text live between polls.
const renderInFlightRows = (inFlight = []) => {
    if (!inFlight.length) {
        return `<div class="empty">no reviews in flight</div>`
    }
    return inFlight
        .map((r) => {
            const ctx = `${r.repo ?? "?"}:${r.branch ?? "?"}`
            const prov = r.provider
                ? `<span class="if-tag">${escapeHtml(r.provider)}</span>`
                : ""
            const force = r.force
                ? `<span class="if-tag force">force</span>`
                : ""
            return (
                `<div class="inflight-row" data-started="${Number(r.startedAt) || 0}">` +
                `<span class="dot" title="running"></span>` +
                `<span class="if-ctx">${escapeHtml(ctx)}</span>` +
                prov +
                force +
                `<span class="if-elapsed">${escapeHtml(fmtElapsed(r.elapsedMs))}</span>` +
                `</div>`
            )
        })
        .join("")
}

export const renderInFlight = (inFlight = []) =>
    `<section aria-label="in flight" class="inflight">` +
    `<h2>in flight · <span id="inflight-count">${inFlight.length}</span></h2>` +
    `<div id="inflight-body">${renderInFlightRows(inFlight)}</div>` +
    `</section>`

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

// Row body for an ESCALATE-status review when shown in the unified
// reviews list (the standalone Failed section uses renderFailureRow's
// richer layout). Single-line reason here keeps the row compact;
// users wanting the full stderr/argv expand the Failed section.
const renderEscalateBody = (r) => {
    const reasonStr =
        r.reason === null || r.reason === undefined ? "—" : String(r.reason)
    return (
        `<div class="empty" style="color:${ESCALATE_COLOR}">` +
        `failed — ${escapeHtml(reasonStr.slice(0, 240))}` +
        (reasonStr.length > 240 ? "…" : "") +
        ` <em>(see Failed section below for full details)</em>` +
        `</div>`
    )
}

const renderReviewRow = (r) => {
    const color = STATUS_COLORS[r.status] ?? STATUS_FALLBACK
    const idAttr = r._id ? ` id="${escapeHtml(r._id)}"` : ""
    const summary =
        `<summary>` +
        `<span class="ts">${escapeHtml(fmtTs(r.ts))}</span>` +
        `<span class="repo">${escapeHtml(r.context)}</span>` +
        `<span class="status" style="color:${color}" title="${escapeHtml(r.status ?? "?")}">${escapeHtml(labelFor(r.status))}</span>` +
        `<span class="dur">${escapeHtml(fmtMs(r.durationMs))}</span>` +
        `<span class="count">${r.findingsCount} (blocking: ${r.blockingCount})</span>` +
        `</summary>`
    let body
    if (r.status === "ESCALATE") {
        body = renderEscalateBody(r)
    } else if (r.findingsCount === 0) {
        body = `<div class="empty">no findings — clean review</div>`
    } else {
        body = `<ul class="findings">${r.findings.map(renderFinding).join("")}</ul>`
    }
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
    return `<details${idAttr}>${summary}${meta}${body}</details>`
}

// Keep the old name as an alias so the public API the tests use
// stays stable. Removed in a follow-up once tests migrate.
const renderSuccessRow = renderReviewRow

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
svg.chart a.bar-link { cursor: pointer; }
svg.chart a.bar-link rect { transition: opacity 0.1s; }
svg.chart a.bar-link:hover rect { opacity: 0.75; stroke: var(--fg);
  stroke-width: 1; }
/* Briefly flash a row when arrived via hash to make it obvious which
   row matched the bar that was clicked. */
@keyframes flash-target {
  0% { background: rgba(96, 165, 250, 0.25); }
  100% { background: transparent; }
}
details:target { animation: flash-target 1.2s ease-out 1; }
svg.chart .empty { fill: var(--muted); font-size: 12px; }
svg.pie { width: 220px; height: 170px; display: block; flex: 0 0 auto; }
svg.pie path, svg.pie circle { stroke: var(--panel); stroke-width: 1; }
svg.pie .pie-empty { fill: var(--border); stroke: none; }
svg.pie .callout-label { fill: var(--fg); font-size: 10px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
svg.pie .callout-count { fill: var(--muted); font-size: 10px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
svg.pie .empty { fill: var(--muted); font-size: 11px; font-style: italic; }
.config-row { display: flex; gap: 24px; align-items: flex-start; }
.config-row .config { flex: 1 1 auto; min-width: 0; }
.config-row .pie-wrap { display: flex; flex-direction: column;
  align-items: center; gap: 4px; flex: 0 0 220px; }
.config-row .pie-wrap .label { color: var(--muted); font-size: 10px;
  text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600;
  text-align: center; }
@media (max-width: 720px) {
  .config-row { flex-direction: column; }
  .config-row .pie-wrap { align-self: center; }
}
/* In-flight panel */
section.inflight { border-color: var(--accent); }
#inflight-body { display: flex; flex-direction: column; gap: 8px; }
.inflight-row { display: flex; align-items: center; gap: 10px; }
.inflight-row .if-ctx { font-family: ui-monospace, SFMono-Regular, Menlo,
  monospace; font-size: 14px; }
.inflight-row .if-tag { font-size: 10px; text-transform: uppercase;
  letter-spacing: 0.04em; color: var(--muted); border: 1px solid var(--border);
  border-radius: 3px; padding: 0 5px; }
.inflight-row .if-tag.force { color: #c2410c; border-color: #c2410c; }
.inflight-row .if-elapsed { margin-left: auto; font-family: ui-monospace,
  SFMono-Regular, Menlo, monospace; font-size: 13px; color: var(--muted); }
.dot { width: 9px; height: 9px; border-radius: 50%; background: #22c55e;
  flex: 0 0 auto; box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.6);
  animation: pulse 1.4s ease-out infinite; }
@keyframes pulse {
  0% { opacity: 1; box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.6); }
  70% { opacity: 0.4; box-shadow: 0 0 0 6px rgba(34, 197, 94, 0); }
  100% { opacity: 1; box-shadow: 0 0 0 0 rgba(34, 197, 94, 0); }
}
@media (prefers-reduced-motion: reduce) {
  .dot { animation: none; opacity: 1; }
}
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
    metrics = null,
    inFlight = [],
} = {}) => {
    // Assign a stable id per record so chart bars can deep-link to the
    // matching row in the reviews table. Index is the position in the
    // newest-first list — chart reverses for display, but the id is
    // stable.
    const recordsWithIds = records.map((r, i) => ({
        ...r,
        _id: `review-${i}`,
    }))
    // Reviews section now shows EVERY attempt (success + failure) so a
    // chart click always lands on a row. The Failed section below
    // remains as a focused quick-view of just the ESCALATEs.
    const allRecords = recordsWithIds
    const failures = recordsWithIds.filter((r) => r.status === "ESCALATE")
    const startedAtStr = startedAt ? fmtTs(startedAt) : "—"
    const totalDurationMs = sumDurationByStatus(records).total
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

${renderInFlight(inFlight)}

<section aria-label="active config">
  <h2>active config</h2>
  <div class="config-row">
    ${renderConfigPanel(config)}
    <div class="pie-wrap">
      ${renderRequestPie(metrics)}
      <div class="label">request mix · since restart</div>
    </div>
    <div class="pie-wrap">
      ${renderDurationPie(records)}
      <div class="label">time by result · last ${records.length} · total ${escapeHtml(fmtHms(totalDurationMs))}</div>
    </div>
  </div>
</section>

<section aria-label="timeline">
  <h2>timeline · last ${records.length} review${records.length === 1 ? "" : "s"} (oldest → newest)</h2>
  ${renderChart(recordsWithIds)}
  <div class="meta" style="padding-top:4px">bars colored by status · height = duration (linear scale) · label above = findings count · click a bar to jump to the row</div>
</section>

<section aria-label="reviews">
  <h2>reviews · ${allRecords.length}</h2>
  ${
      allRecords.length === 0
          ? `<div class="empty">no reviews recorded yet</div>`
          : allRecords.map(renderSuccessRow).join("")
  }
</section>

<section aria-label="failed">
  <h2 style="color:${ESCALATE_COLOR}">failed · ${failures.length}</h2>
  ${
      failures.length === 0
          ? `<div class="empty">no failed reviews recorded yet</div>`
          : failures.map(renderFailureRow).join("")
  }
</section>

<footer>review-orchestrator · localhost only · no auth on this page</footer>
</main>
<script>
// Open the target <details> when a chart bar is clicked and the URL
// hash changes. Native :target cannot set the open attribute,
// so a small JS snippet does it.
(function () {
  function openTarget() {
    if (!location.hash) return
    var el
    try { el = document.querySelector(location.hash) } catch (e) { return }
    if (!el) return
    var d = el.closest("details") || (el.tagName === "DETAILS" ? el : null)
    if (d) d.open = true
    el.scrollIntoView({ behavior: "smooth", block: "center" })
  }
  window.addEventListener("hashchange", openTarget)
  window.addEventListener("load", openTarget)
})();

// In-flight panel: tick the elapsed text every second (smooth) and poll
// GET /inflight every 2s (authoritative — adds/removes running reviews).
(function () {
  function fmtElapsed(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    if (s < 60) return s + "s";
    var m = Math.floor(s / 60);
    if (m < 60) return m + "m " + String(s % 60).padStart(2, "0") + "s";
    var h = Math.floor(m / 60);
    return h + "h " + String(m % 60).padStart(2, "0") + "m";
  }
  function esc(v) {
    return String(v == null ? "" : v).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  function rowHtml(r) {
    var ctx = (r.repo || "?") + ":" + (r.branch || "?");
    var prov = r.provider ? '<span class="if-tag">' + esc(r.provider) + "</span>" : "";
    var force = r.force ? '<span class="if-tag force">force</span>' : "";
    return (
      '<div class="inflight-row" data-started="' + (Number(r.startedAt) || 0) + '">' +
      '<span class="dot" title="running"></span>' +
      '<span class="if-ctx">' + esc(ctx) + "</span>" + prov + force +
      '<span class="if-elapsed">' + esc(fmtElapsed(r.elapsedMs)) + "</span></div>"
    );
  }
  function tick() {
    var now = Date.now();
    document.querySelectorAll(".inflight-row").forEach(function (row) {
      var started = Number(row.getAttribute("data-started")) || 0;
      var el = row.querySelector(".if-elapsed");
      if (started && el) el.textContent = fmtElapsed(now - started);
    });
  }
  function render(list) {
    var body = document.getElementById("inflight-body");
    var count = document.getElementById("inflight-count");
    if (!body) return;
    if (count) count.textContent = list.length;
    body.innerHTML = list.length
      ? list.map(rowHtml).join("")
      : '<div class="empty">no reviews in flight</div>';
  }
  function poll() {
    fetch("/inflight", { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { if (j && Array.isArray(j.inFlight)) render(j.inFlight); })
      .catch(function () {});
  }
  setInterval(tick, 1000);
  setInterval(poll, 2000);
})();
</script>
</body>
</html>`
}

export const mountDashboardRoute = (
    app,
    {
        archive,
        config,
        summarize,
        version,
        startedAt,
        metrics = null,
        inFlight = null,
    } = {}
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
            metrics: metrics?.snapshot ? metrics.snapshot() : metrics,
            inFlight:
                typeof inFlight === "function" ? inFlight() : (inFlight ?? []),
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
    fmtElapsed,
    fmtHms,
    renderChart,
    renderRequestPie,
    renderDurationPie,
    sumDurationByStatus,
    renderInFlight,
    renderConfigPanel,
    renderFinding,
    renderSuccessRow,
    renderFailureRow,
    computeAxisTicks,
    fmtAxisLabel,
}
