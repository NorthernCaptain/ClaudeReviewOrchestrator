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
    // Sized for the longest callout label across both pies. The
    // duration pie's "H:MM:SS · 99.9%" runs ~15 chars at ~7px/char of
    // monospace text on each side of the pie body — the previous
    // 220×170 viewBox clipped those. cx=180 leaves ~124px of headroom
    // on each side, which fits the labels without overlapping the
    // slices.
    const W = 360
    const H = 190
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

    // Matches renderRequestPie's viewBox so both pies render at the
    // same size on the dashboard, and so the H:MM:SS · pct% callouts
    // don't clip at the SVG edge.
    const W = 360
    const H = 190
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

// Rendered as a slot inside the active-config row (v0.1.34). The IDs
// (#inflight-count, #inflight-body) are kept stable so the existing
// client-side poll script still targets the same elements regardless
// of where the slot lives in the DOM.
export const renderInFlight = (inFlight = []) =>
    `<div class="inflight-slot" aria-label="in flight">` +
    `<div class="slot-title">in flight · <span id="inflight-count">${inFlight.length}</span></div>` +
    `<div id="inflight-body">${renderInFlightRows(inFlight)}</div>` +
    `</div>`

// Inline dashboard controls (v0.1.35). The dashboard is unauthed
// localhost-only, so these post to /dashboard/* convenience routes
// that share handlers with the canonical /reset and /provider
// endpoints. The provider <select> auto-submits on change; the reset
// button consumes the selected context dropdown.
const VALID_PROVIDER_OPTIONS = ["codex", "claude", "gemini"]

export const renderControls = (currentProvider, contexts = []) => {
    const providerOpts = VALID_PROVIDER_OPTIONS.map(
        (p) =>
            `<option value="${p}"${p === currentProvider ? " selected" : ""}>${p}</option>`
    ).join("")
    const sorted = [...(contexts ?? [])].sort((a, b) =>
        String(a.key ?? "").localeCompare(String(b.key ?? ""))
    )
    // Pre-select the most recently reviewed context — that's almost
    // always the one the user just finished working on, so a click on
    // Reset targets the right repo+branch without a manual scroll.
    // Falls back to no selection when no context has been reviewed yet
    // (lastReviewedAt is 0 for fresh / reset-cleared contexts).
    let mostRecentKey = null
    let mostRecentTs = 0
    for (const c of sorted) {
        const ts = Number(c?.lastReviewedAt) || 0
        if (ts > mostRecentTs) {
            mostRecentTs = ts
            mostRecentKey = c.key
        }
    }
    // When the store has contexts but none has ever been reviewed, a
    // bare <select> still defaults to the first option — clicking
    // Reset would then clear an arbitrary first-by-key context. Prepend
    // an empty-value placeholder so the visible default is "(choose a
    // context)" and the client's `if (!contextKey)` guard fires
    // correctly on a stray click.
    const showPlaceholder = sorted.length > 0 && mostRecentKey === null
    const ctxOpts = sorted.length
        ? (showPlaceholder
              ? `<option value="" selected>(choose a context)</option>`
              : "") +
          sorted
              .map((c) => {
                  // Option value is the store key (repoRoot|branch) so
                  // the server can target the EXACT stored context.
                  // Submitting just repoRoot would collide when a repo
                  // has multiple branches in the store and the server
                  // would re-resolve to whatever branch is currently
                  // checked out — possibly resetting a different one
                  // than the user picked.
                  const value = escapeHtml(c.key ?? "")
                  const label = escapeHtml(
                      `${c.repo ?? (c.repoRoot ?? "").split("/").pop() ?? "?"}:${c.branch ?? "?"}`
                  )
                  const sel = c.key === mostRecentKey ? " selected" : ""
                  return `<option value="${value}"${sel}>${label}</option>`
              })
              .join("")
        : `<option value="">(no contexts)</option>`
    return (
        `<div class="controls" aria-label="dashboard controls">` +
        `<label class="control">` +
        `<span class="ctl-label">provider</span>` +
        `<select id="provider-select" class="select">${providerOpts}</select>` +
        `</label>` +
        `<div class="control">` +
        `<span class="ctl-label">reset</span>` +
        `<select id="reset-context-select" class="select"${sorted.length ? "" : " disabled"}>${ctxOpts}</select>` +
        `<button id="reset-button" class="btn" type="button"${sorted.length ? "" : " disabled"}>↻ reset</button>` +
        `</div>` +
        `<span id="controls-status" class="status" role="status" aria-live="polite"></span>` +
        `</div>`
    )
}

// Dedicated exclusions panel (v1.1). Shows every excluded finding for
// the dashboard's "current" context — by default the same context the
// Reset selector pre-selects (most recent lastReviewedAt). The client
// script swaps the panel body when the user changes the Reset
// selector. Each row carries an Include button.
export const renderExclusionsPanel = (contexts = []) => {
    const sorted = [...(contexts ?? [])].sort((a, b) =>
        String(a.key ?? "").localeCompare(String(b.key ?? ""))
    )
    // Same default-context rule the Reset selector uses.
    let defaultKey = null
    let mostRecent = 0
    for (const c of sorted) {
        const ts = Number(c?.lastReviewedAt) || 0
        if (ts > mostRecent) {
            mostRecent = ts
            defaultKey = c.key
        }
    }
    const exclusionsByKey = new Map()
    for (const c of sorted) {
        if (c?.key) exclusionsByKey.set(c.key, c.exclusions ?? [])
    }
    const body = renderExclusionsBody(
        defaultKey ? (exclusionsByKey.get(defaultKey) ?? []) : [],
        defaultKey
    )
    // Serialize the per-context exclusions as a JSON island the client
    // reads when the Reset selector changes — saves a roundtrip and
    // keeps the panel in lockstep with whatever the server most
    // recently saw.
    const dataIsland = JSON.stringify(
        Object.fromEntries(exclusionsByKey),
        null,
        0
    )
    return (
        `<div class="exclusions" aria-label="exclusions">` +
        `<div class="exc-title">excluded findings · <span id="exclusions-context">${escapeHtml(
            defaultKey ?? "(none)"
        )}</span></div>` +
        `<div id="exclusions-body">${body}</div>` +
        `<script type="application/json" id="exclusions-data">${escapeForScriptText(
            dataIsland
        )}</script>` +
        `</div>`
    )
}

// JSON sitting inside a <script> tag is RAW text — HTML entity escaping
// (escapeHtml) would leave `&quot;` instead of `"` and JSON.parse would
// fail. The only thing we need to neutralize is a `</script>` (or HTML
// comment opener) that would prematurely close the tag. Escaping `<`
// to `<` and `>` to `>` covers both cases; JSON quotes and
// every other character are preserved verbatim. Also escape the JSON-
// breaking U+2028 / U+2029 separators that some JS engines stumble on.
const escapeForScriptText = (s) =>
    String(s)
        .replace(/</g, "\\u003c")
        .replace(/>/g, "\\u003e")
        .replace(/\u2028/g, "\\u2028")
        .replace(/\u2029/g, "\\u2029")

// Render the inner list for a single context's exclusions. Each row
// shows file:message and an Include button that posts the remove
// action. When the contextKey is null (e.g. no contexts yet) we show
// a placeholder.
const renderExclusionsBody = (exclusions, contextKey) => {
    if (!contextKey) {
        return `<div class="empty">no context selected</div>`
    }
    const list = Array.isArray(exclusions) ? exclusions : []
    if (list.length === 0) {
        return `<div class="empty">no exclusions for this context</div>`
    }
    return list
        .map((e) => {
            const file = escapeHtml(e?.file ?? "")
            const msg = escapeHtml(e?.message ?? "")
            return (
                `<div class="exc-row">` +
                `<button class="excl-btn on" type="button" ` +
                `data-context-key="${escapeHtml(contextKey)}" ` +
                `data-file="${file}" ` +
                `data-message="${msg}" ` +
                `data-action="remove">Include</button>` +
                `<code class="exc-file">${file}</code>` +
                `<span class="exc-msg">${msg}</span>` +
                `</div>`
            )
        })
        .join("")
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
    // Tag each cell with a stable data-key so the client can poke a
    // single field in place (e.g. the provider switcher updates the
    // PROVIDER value cell without a full refetch).
    const slug = (k) => k.replace(/[^a-z0-9]+/gi, "-").toLowerCase()
    return (
        `<dl class="config">` +
        cells
            .map(
                ([k, v]) =>
                    `<div><dt>${escapeHtml(k)}</dt><dd data-config-key="${slug(k)}">${escapeHtml(String(v))}</dd></div>`
            )
            .join("") +
        `</dl>`
    )
}

// Stable match key (file + message) used both client- and server-side
// to test whether a finding is currently excluded for its context.
// Line is deliberately NOT included so a code shift doesn't break the
// match.
const findingMatchKey = (file, message) => `${file ?? ""}\n${message ?? ""}`

const renderFinding = (f, opts = {}) => {
    const { contextKey = null, excludedKeys = null } = opts
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
    // Exclude/Include toggle (v1.1). Only rendered when we have a
    // resolved context key for this row — ambiguous (repo, branch)
    // pairs leave the button off so a click can't target the wrong
    // store entry.
    let toggle = ""
    if (contextKey) {
        const matchKey = findingMatchKey(f.file, f.message)
        const isExcluded = excludedKeys && excludedKeys.has(matchKey)
        const label = isExcluded ? "Include" : "Exclude"
        toggle =
            `<button class="excl-btn${isExcluded ? " on" : ""}" ` +
            `type="button" ` +
            `data-context-key="${escapeHtml(contextKey)}" ` +
            `data-file="${escapeHtml(f.file ?? "")}" ` +
            `data-message="${escapeHtml(f.message ?? "")}" ` +
            `data-action="${isExcluded ? "remove" : "add"}"` +
            `>${label}</button>`
    }
    return (
        `<li>` +
        toggle +
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
    // data-context-key (v1.0.9) carries the unambiguous store key so
    // the client toggle handler can sync the Reset selector to the
    // exact (repoRoot, branch) — never the visible "repo:branch"
    // label, which is non-unique when two repos share a basename.
    // Attached only when renderDashboard could resolve a single
    // context for this row's (repo, branch).
    const ctxAttr = r._contextKey
        ? ` data-context-key="${escapeHtml(r._contextKey)}"`
        : ""
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
        const opts = {
            contextKey: r._contextKey ?? null,
            excludedKeys: r._excludedKeys ?? null,
        }
        body = `<ul class="findings">${r.findings
            .map((f) => renderFinding(f, opts))
            .join("")}</ul>`
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
    return `<details${idAttr}${ctxAttr}>${summary}${meta}${body}</details>`
}

// Keep the old name as an alias so the public API the tests use
// stays stable. Removed in a follow-up once tests migrate.
const renderSuccessRow = renderReviewRow

const renderFailureRow = (r) => {
    const d = r.failureDetail ?? {}
    const ctxAttr = r._contextKey
        ? ` data-context-key="${escapeHtml(r._contextKey)}"`
        : ""
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
        `<details class="fail"${ctxAttr}>${summary}${meta}` +
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
svg.pie { width: 100%; max-width: 360px; height: auto; display: block; flex: 0 0 auto; }
svg.pie path, svg.pie circle { stroke: var(--panel); stroke-width: 1; }
svg.pie .pie-empty { fill: var(--border); stroke: none; }
svg.pie .callout-label { fill: var(--fg); font-size: 10px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
svg.pie .callout-count { fill: var(--muted); font-size: 10px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
svg.pie .empty { fill: var(--muted); font-size: 11px; font-style: italic; }
/* Active config + in-flight slot (compact, side-by-side). */
section.compact > h2 { margin-bottom: 8px; }
.config-row { display: flex; gap: 24px; align-items: flex-start; }
.config-row .config { flex: 1 1 auto; min-width: 0; }
.inflight-slot { flex: 0 0 300px; min-width: 0; border-left: 2px solid var(--accent);
  padding-left: 16px; }
.inflight-slot .slot-title { color: var(--muted); font-size: 11px;
  text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600;
  margin: 0 0 8px; }
/* Charts row (the two pies, their own section). */
.charts-row { display: flex; gap: 24px; align-items: flex-start;
  flex-wrap: wrap; justify-content: center; }
.charts-row .pie-wrap { display: flex; flex-direction: column;
  align-items: center; gap: 4px; flex: 0 0 360px; min-width: 0; }
.charts-row .pie-wrap .label { color: var(--muted); font-size: 11px;
  text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600;
  text-align: center; }
/* Dashboard controls bar (provider switcher + reset). */
.controls { display: flex; gap: 16px; align-items: center; flex-wrap: wrap;
  margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border); }
.controls .control { display: flex; align-items: center; gap: 6px; }
.controls .ctl-label { color: var(--muted); font-size: 11px;
  text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; }
.controls .select { background: var(--bg); color: var(--fg);
  border: 1px solid var(--border); border-radius: 4px; padding: 3px 8px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px;
  max-width: 320px; }
.controls .btn { background: var(--accent); color: white; border: 0;
  border-radius: 4px; padding: 4px 10px; font-size: 12px; cursor: pointer;
  font-weight: 600; letter-spacing: 0.02em; }
.controls .btn:hover { opacity: 0.9; }
.controls .btn:disabled, .controls .select:disabled { opacity: 0.5;
  cursor: not-allowed; }
.controls .status { font-size: 12px; color: var(--muted); margin-left: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.controls .status.ok { color: #16a34a; }
.controls .status.err { color: #c2410c; }
/* Exclude / Include toggle on each finding (v1.1). */
.excl-btn { float: right; background: var(--bg); color: var(--muted);
  border: 1px solid var(--border); border-radius: 3px;
  padding: 2px 8px; font-size: 11px; font-weight: 600;
  text-transform: uppercase; letter-spacing: 0.04em; cursor: pointer;
  margin-left: 8px; }
.excl-btn:hover { color: var(--fg); border-color: var(--accent); }
.excl-btn.on { background: #fef9c3; color: #a16207; border-color: #a16207; }
.excl-btn:disabled { opacity: 0.5; cursor: not-allowed; }
/* Dedicated exclusions panel below the controls bar. */
.exclusions { margin-top: 12px; padding-top: 12px;
  border-top: 1px solid var(--border); }
.exclusions .exc-title { color: var(--muted); font-size: 11px;
  text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600;
  margin-bottom: 8px; }
.exclusions #exclusions-context { font-family: ui-monospace,
  SFMono-Regular, Menlo, monospace; }
#exclusions-body { display: flex; flex-direction: column; gap: 6px; }
.exc-row { display: flex; align-items: baseline; gap: 8px;
  font-size: 12px; }
.exc-row .exc-file { font-family: ui-monospace, SFMono-Regular, Menlo,
  monospace; font-size: 11px; color: var(--muted); }
.exc-row .exc-msg { flex: 1 1 auto; }
.exclusions .empty { color: var(--muted); font-size: 12px;
  font-style: italic; }
@media (max-width: 720px) {
  .config-row { flex-direction: column; }
  .inflight-slot { border-left: 0; border-top: 2px solid var(--accent);
    padding-left: 0; padding-top: 12px; flex: 0 0 auto; }
  .charts-row .pie-wrap { align-self: center; flex: 0 0 auto; }
}
/* In-flight rows */
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
    contexts = [],
} = {}) => {
    // Assign a stable id per record so chart bars can deep-link to the
    // matching row in the reviews table. Index is the position in the
    // newest-first list — chart reverses for display, but the id is
    // stable.
    //
    // _contextKey (v1.0.10): walk the `contexts` list and try to
    // resolve each record's (repo, branch) to a unique store key.
    // store.list() returns the persisted shape — repoRoot + branch
    // only, no `repo` — so we derive the basename from repoRoot the
    // same way renderControls computes the dropdown label. (Before:
    // c.repo was always undefined, every lookup key collapsed to
    // ":<branch>", and no row ever got a data-context-key.)
    // When two contexts share the same (basename, branch) — e.g.,
    // two different repos with the same basename — the lookup is
    // ambiguous and we emit no key, so the client toggle handler
    // leaves the Reset selector alone instead of guessing wrong.
    const basenameOf = (c) =>
        c?.repo ?? (c?.repoRoot ?? "").split("/").pop() ?? ""
    const contextKeyByRepoBranch = new Map()
    for (const c of contexts ?? []) {
        const lookup = `${basenameOf(c)}:${c.branch ?? ""}`
        if (contextKeyByRepoBranch.has(lookup)) {
            contextKeyByRepoBranch.set(lookup, null) // ambiguous
        } else {
            contextKeyByRepoBranch.set(lookup, c.key ?? null)
        }
    }
    // Per-context exclusion match-key sets (v1.1). Used by the row
    // finding renderer to label each Exclude/Include toggle correctly.
    const excludedKeysByContext = new Map()
    for (const c of contexts ?? []) {
        if (!c?.key) continue
        const set = new Set()
        for (const e of c.exclusions ?? []) {
            if (typeof e?.file === "string" && typeof e?.message === "string") {
                set.add(`${e.file}\n${e.message}`)
            }
        }
        excludedKeysByContext.set(c.key, set)
    }
    const recordsWithIds = records.map((r, i) => {
        const ctxKey =
            contextKeyByRepoBranch.get(`${basenameOf(r)}:${r.branch ?? ""}`) ??
            null
        return {
            ...r,
            _id: `review-${i}`,
            _contextKey: ctxKey,
            _excludedKeys: ctxKey
                ? (excludedKeysByContext.get(ctxKey) ?? new Set())
                : null,
        }
    })
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
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<style>${CSS}</style>
</head>
<body>
<main>
<header>
  <h1>review-orchestrator <span class="version">v${escapeHtml(version)}</span></h1>
  <div class="meta">started ${escapeHtml(startedAtStr)} · uptime ${escapeHtml(fmtUptime(uptimeSeconds))} · ${records.length} record${records.length === 1 ? "" : "s"} (${failures.length} failed)</div>
</header>

<section aria-label="active config" class="compact">
  <h2>active config</h2>
  <div class="config-row">
    ${renderConfigPanel(config)}
    ${renderInFlight(inFlight)}
  </div>
  ${renderControls(config?.provider, contexts)}
  ${renderExclusionsPanel(contexts)}
</section>

<section aria-label="charts">
  <h2>charts</h2>
  <div class="charts-row">
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
// hash changes, AND keep the URL + reset selector in sync as the user
// expands / collapses rows by hand (v1.0.8). Reloading the page after
// a manual collapse used to bring back the old #review-N hash and
// auto-open the wrong row.
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

  // history.replaceState avoids polluting the back stack on every
  // expand/collapse. It does NOT fire hashchange, so it can't loop
  // through openTarget above.
  function setHash(hash) {
    if (!history || typeof history.replaceState !== "function") return
    if (hash) history.replaceState(null, "", "#" + hash)
    else history.replaceState(null, "", location.pathname + location.search)
  }

  // When a row expands, point the Reset selector at the row's
  // unambiguous store key (carried in data-context-key, set by the
  // server when (repo, branch) resolved to a single context). The
  // earlier label-match approach (v1.0.8) could pick the wrong
  // context when two repos share a basename — the option value is
  // the only unique handle.
  function syncResetToKey(key) {
    if (!key) return
    var sel = document.getElementById("reset-context-select")
    if (!sel) return
    for (var i = 0; i < sel.options.length; i++) {
      if (sel.options[i].value === key) {
        sel.value = sel.options[i].value
        return
      }
    }
  }

  // The toggle event does NOT bubble, but capture-phase listeners
  // still see it. Attaching at document level survives section
  // refreshes that replace the inner details elements.
  document.addEventListener("toggle", function (e) {
    var d = e.target
    if (!d || d.tagName !== "DETAILS") return
    if (d.open) {
      if (d.id) setHash(d.id)
      var key = d.getAttribute("data-context-key")
      if (key) syncResetToKey(key)
    } else if (d.id && location.hash === "#" + d.id) {
      setHash("")
    }
  }, true)
})();

// Live dashboard updates (v0.1.37):
//
//   * Tick: every 1s, recompute each in-flight row's elapsed text from
//     its data-started attribute so the timer climbs smoothly between
//     polls.
//   * Poll: every 2s, GET /inflight; render the in-flight rows. If the
//     count DROPPED (a review just finished), trigger a section
//     refresh so the timeline / charts / reviews / failed grids pick
//     up the new archive entry without a full page reload.
//   * Controls: provider switcher PUTs /dashboard/provider and pokes
//     the live PROVIDER value cell in the active-config grid; reset
//     button POSTs /dashboard/reset and refreshes sections afterwards.
//   * Both poll-driven refreshes and reset triggers share the same
//     refreshSections() which fetches GET / and swaps selected
//     sections by aria-label, re-wiring controls after the swap.
(function () {
  /* ---------- helpers ---------- */
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

  /* ---------- in-flight: tick + poll, with completion-triggered refresh ---------- */
  var lastInflightCount = (function () {
    var c = document.getElementById("inflight-count");
    return c ? Number(c.textContent) || 0 : 0;
  })();
  function tick() {
    var now = Date.now();
    document.querySelectorAll(".inflight-row").forEach(function (row) {
      var started = Number(row.getAttribute("data-started")) || 0;
      var el = row.querySelector(".if-elapsed");
      if (started && el) el.textContent = fmtElapsed(now - started);
    });
  }
  function renderInflight(list) {
    var body = document.getElementById("inflight-body");
    var count = document.getElementById("inflight-count");
    if (!body) return;
    var prev = lastInflightCount;
    if (count) count.textContent = list.length;
    body.innerHTML = list.length
      ? list.map(rowHtml).join("")
      : '<div class="empty">no reviews in flight</div>';
    if (list.length < prev) {
      // A review just finished → pull fresh archive / metrics into
      // the timeline, pies, and review lists.
      refreshSections();
    }
    lastInflightCount = list.length;
  }
  function poll() {
    fetch("/inflight", { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { if (j && Array.isArray(j.inFlight)) renderInflight(j.inFlight); })
      .catch(function () {});
  }

  /* ---------- section refresh (fetches / and swaps in-place) ---------- */
  var refreshing = false;
  function refreshSections() {
    if (refreshing) return;
    refreshing = true;
    fetch("/", { cache: "no-store" })
      .then(function (r) { return r.ok ? r.text() : null; })
      .then(function (text) {
        if (!text) return;
        var doc = new DOMParser().parseFromString(text, "text/html");
        // Stable sections that have no JS-attached listeners — swap
        // wholesale by aria-label.
        ["charts", "timeline", "reviews", "failed"].forEach(function (label) {
          var sel = 'section[aria-label="' + label + '"]';
          var fresh = doc.querySelector(sel);
          var cur = document.querySelector(sel);
          if (fresh && cur) cur.replaceWith(fresh);
        });
        // Active config: refresh the config grid (provider/model
        // mirror) and the controls bar (contexts dropdown may have
        // grown). The in-flight slot is NOT touched here — it's
        // driven by the /inflight poll and replacing it would race
        // with whatever the latest tick rendered.
        var freshCfg = doc.querySelector(".config-row .config");
        var curCfg = document.querySelector(".config-row .config");
        if (freshCfg && curCfg) curCfg.replaceWith(freshCfg);
        var freshCtrl = doc.querySelector(".controls");
        var curCtrl = document.querySelector(".controls");
        if (freshCtrl && curCtrl) {
          curCtrl.replaceWith(freshCtrl);
          wireControls();
        }
        var freshExcl = doc.querySelector(".exclusions");
        var curExcl = document.querySelector(".exclusions");
        if (freshExcl && curExcl) curExcl.replaceWith(freshExcl);
        var freshData = doc.getElementById("exclusions-data");
        var curData = document.getElementById("exclusions-data");
        if (freshData && curData) curData.replaceWith(freshData);
      })
      .catch(function () {})
      .finally(function () { refreshing = false; });
  }

  /* ---------- controls: provider switcher + reset button ---------- */
  function setStatus(msg, ok) {
    var el = document.getElementById("controls-status");
    if (!el) return;
    el.textContent = msg;
    el.className = "status " + (ok ? "ok" : "err");
    if (setStatus._t) clearTimeout(setStatus._t);
    setStatus._t = setTimeout(function () {
      var e = document.getElementById("controls-status");
      if (e) { e.textContent = ""; e.className = "status"; }
    }, 4000);
  }
  function bodyToOk(r) {
    return r.json().then(function (j) { return { ok: r.ok, j: j }; });
  }
  function updateProviderCell(p) {
    var cell = document.querySelector('[data-config-key="provider"]');
    if (cell) cell.textContent = p;
  }
  function wireControls() {
    var ps = document.getElementById("provider-select");
    if (ps) {
      ps.addEventListener("change", function () {
        var picked = ps.value;
        fetch("/dashboard/provider", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ provider: picked }),
        })
          .then(bodyToOk)
          .then(function (r) {
            if (r.ok) {
              // Update the PROVIDER value cell in the active-config
              // grid right away so the UI stays consistent without
              // waiting for the next section refresh.
              updateProviderCell(r.j.provider || picked);
              setStatus("provider → " + (r.j.provider || picked) +
                (r.j.persisted ? "" : " (in-memory only)"), true);
            } else {
              setStatus("error: " + (r.j.error || "failed"), false);
            }
          })
          .catch(function (e) { setStatus("error: " + e.message, false); });
      });
    }
    var rb = document.getElementById("reset-button");
    var rs = document.getElementById("reset-context-select");
    if (rb && rs) {
      rb.addEventListener("click", function () {
        var contextKey = rs.value;
        if (!contextKey) { setStatus("no context selected", false); return; }
        rb.disabled = true;
        fetch("/dashboard/reset", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ contextKey: contextKey }),
        })
          .then(bodyToOk)
          .then(function (r) {
            if (r.ok) {
              var c = r.j.context || {};
              setStatus("reset " + (c.repo || "?") + ":" + (c.branch || "?"), true);
              refreshSections();
            } else {
              setStatus("error: " + (r.j.reason || r.j.error || "failed"), false);
            }
          })
          .catch(function (e) { setStatus("error: " + e.message, false); })
          .finally(function () {
            var nb = document.getElementById("reset-button");
            if (nb) nb.disabled = false;
          });
      });
    }
  }

  // Exclusion toggle (v1.1). One delegated listener for every
  // .excl-btn anywhere on the page — survives section refreshes.
  function readExclusionsData() {
    var el = document.getElementById("exclusions-data");
    if (!el) return {};
    try { return JSON.parse(el.textContent || "{}"); }
    catch (e) { return {}; }
  }
  function writeExclusionsData(obj) {
    var el = document.getElementById("exclusions-data");
    if (el) el.textContent = JSON.stringify(obj);
  }
  function renderExclusionRow(contextKey, e) {
    return (
      '<div class="exc-row">' +
      '<button class="excl-btn on" type="button" ' +
      'data-context-key="' + esc(contextKey) + '" ' +
      'data-file="' + esc(e.file) + '" ' +
      'data-message="' + esc(e.message) + '" ' +
      'data-action="remove">Include</button>' +
      '<code class="exc-file">' + esc(e.file) + '</code>' +
      '<span class="exc-msg">' + esc(e.message) + '</span>' +
      '</div>'
    );
  }
  function renderPanelFor(contextKey) {
    var ctxEl = document.getElementById("exclusions-context");
    var body = document.getElementById("exclusions-body");
    if (!body) return;
    if (ctxEl) ctxEl.textContent = contextKey || "(none)";
    if (!contextKey) {
      body.innerHTML = '<div class="empty">no context selected</div>';
      return;
    }
    var data = readExclusionsData();
    var list = data[contextKey] || [];
    body.innerHTML = list.length
      ? list.map(function (e) { return renderExclusionRow(contextKey, e); }).join("")
      : '<div class="empty">no exclusions for this context</div>';
  }
  function applyExclusionsUpdate(contextKey, file, message, action) {
    var data = readExclusionsData();
    var list = (data[contextKey] || []).slice();
    var idx = -1;
    for (var i = 0; i < list.length; i++) {
      if (list[i].file === file && list[i].message === message) { idx = i; break; }
    }
    if (action === "add" && idx === -1) {
      list.push({ file: file, message: message, excludedAt: Date.now() });
    } else if (action === "remove" && idx !== -1) {
      list.splice(idx, 1);
    }
    data[contextKey] = list;
    writeExclusionsData(data);
    // Refresh both the dedicated panel (if it's showing this ctx) AND
    // every inline button currently in the DOM that targets the same
    // (contextKey, file, message) — the row may live in Reviews and/or
    // Failed sections.
    var current = document.getElementById("exclusions-context");
    if (current && current.textContent === contextKey) renderPanelFor(contextKey);
    var nowExcluded = action === "add";
    document.querySelectorAll('.excl-btn[data-context-key="' + cssEsc(contextKey) +
      '"][data-file="' + cssEsc(file) + '"][data-message="' + cssEsc(message) + '"]'
    ).forEach(function (b) {
      // Skip the dedicated-panel buttons (they get rebuilt above) by
      // checking the parent. They always carry the on class anyway.
      if (b.closest("#exclusions-body")) return;
      b.textContent = nowExcluded ? "Include" : "Exclude";
      b.dataset.action = nowExcluded ? "remove" : "add";
      if (nowExcluded) b.classList.add("on"); else b.classList.remove("on");
    });
  }
  function cssEsc(s) {
    return String(s).replace(/(["\\])/g, "\\$1");
  }
  document.addEventListener("click", function (e) {
    var btn = e.target && e.target.closest && e.target.closest(".excl-btn");
    if (!btn) return;
    var contextKey = btn.dataset.contextKey;
    var file = btn.dataset.file;
    var message = btn.dataset.message;
    var action = btn.dataset.action;
    if (!contextKey || !file || !message || (action !== "add" && action !== "remove")) {
      return;
    }
    btn.disabled = true;
    fetch("/dashboard/exclusions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contextKey: contextKey, file: file, message: message, action: action }),
    })
      .then(bodyToOk)
      .then(function (r) {
        if (r.ok) {
          // Re-seed the data island from the server's authoritative list
          // for this context (handles dedupe / race with another tab).
          var data = readExclusionsData();
          data[contextKey] = r.j.exclusions || [];
          writeExclusionsData(data);
          applyExclusionsUpdate(contextKey, file, message, action);
          setStatus(action === "add" ? "excluded" : "included", true);
        } else {
          setStatus("error: " + (r.j.error || "failed"), false);
        }
      })
      .catch(function (err) { setStatus("error: " + err.message, false); })
      .finally(function () { btn.disabled = false; });
  });

  // When the Reset selector changes, swap the exclusions panel to the
  // new context (data is already embedded in the JSON island).
  document.addEventListener("change", function (e) {
    if (e.target && e.target.id === "reset-context-select") {
      renderPanelFor(e.target.value || null);
    }
  });

  wireControls();
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
        store = null,
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
        // Context list feeds the Reset dropdown — we read repoRoot
        // off each so the dashboard can POST { cwd: repoRoot } to
        // /dashboard/reset and the same handleReset that the authed
        // /reset route uses resolves it back to (repoRoot, branch).
        const contexts = store?.list ? store.list() : []
        const html = renderDashboard({
            version,
            config: summary,
            uptimeSeconds,
            startedAt: startedAt ? new Date(startedAt).toISOString() : null,
            records,
            metrics: metrics?.snapshot ? metrics.snapshot() : metrics,
            inFlight:
                typeof inFlight === "function" ? inFlight() : (inFlight ?? []),
            contexts,
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
    renderControls,
    renderConfigPanel,
    renderFinding,
    renderSuccessRow,
    renderFailureRow,
    computeAxisTicks,
    fmtAxisLabel,
}
