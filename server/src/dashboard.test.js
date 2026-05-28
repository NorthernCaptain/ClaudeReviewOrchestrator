/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import {
    renderDashboard,
    mountDashboardRoute,
    escapeHtml,
    __test__,
} from "./dashboard.js"

const {
    fmtMs,
    fmtUptime,
    fmtElapsed,
    renderChart,
    renderRequestPie,
    renderInFlight,
    renderSuccessRow,
    renderFailureRow,
} = __test__

const baseConfig = () => ({
    version: "0.1.3",
    port: 7777,
    bind: "127.0.0.1",
    provider: "gemini",
    model: "auto",
    effortOrMode: "plan",
    reviewerTimeoutSeconds: 600,
    hookFetchTimeoutSeconds: null,
    maxCodexRounds: 5,
    maxBlocks: 6,
    allowedRootsCount: 1,
    blockingSeverities: ["blocker", "major"],
})

const goodRecord = (over = {}) => ({
    ts: "2026-05-22T18:00:00.000Z",
    mtimeMs: 1779000000000,
    context: "review:main",
    repo: "review",
    branch: "main",
    status: "GOOD_TO_GO",
    durationMs: 7400,
    findingsCount: 0,
    blockingCount: 0,
    droppedCount: 0,
    reason: null,
    code: null,
    provider: "gemini",
    model: "auto",
    round: 1,
    blockCount: 0,
    trigger: "stop_hook",
    findings: [],
    failureDetail: null,
    file: "review:main/x.json",
    ...over,
})

const issuesRecord = (over = {}) =>
    goodRecord({
        status: "ISSUES",
        findingsCount: 1,
        blockingCount: 1,
        findings: [
            {
                file: "src/a.js",
                line: 42,
                severity: "blocker",
                category: "bug",
                message: "subtracts instead of adds",
                suggestion: "return a + b",
            },
        ],
        ...over,
    })

const escalateRecord = (over = {}) =>
    goodRecord({
        status: "ESCALATE",
        durationMs: 800,
        findingsCount: 0,
        reason: "gemini exited with code 41",
        code: "CODEX_ERROR",
        failureDetail: {
            exitCode: 41,
            stderrTail: "GEMINI_API_KEY is not set",
            stdoutTail: "",
            schemaError: null,
            argv: ["gemini", "-p", "--bare"],
        },
        ...over,
    })

describe("escapeHtml", () => {
    test("escapes the OWASP-relevant characters", () => {
        expect(escapeHtml(`<script>"x"&y</script>`)).toBe(
            "&lt;script&gt;&quot;x&quot;&amp;y&lt;/script&gt;"
        )
        expect(escapeHtml("don't")).toBe("don&#39;t")
        expect(escapeHtml("`code`")).toBe("&#96;code&#96;")
    })
    test("returns empty string for null/undefined", () => {
        expect(escapeHtml(null)).toBe("")
        expect(escapeHtml(undefined)).toBe("")
    })
    test("coerces non-strings", () => {
        expect(escapeHtml(42)).toBe("42")
        expect(escapeHtml(true)).toBe("true")
    })
})

describe("formatters", () => {
    test("fmtMs renders ms/s/m bands", () => {
        expect(fmtMs(123)).toBe("123 ms")
        expect(fmtMs(1500)).toBe("1.5s")
        expect(fmtMs(90_000)).toMatch(/^1m 30s$/)
        expect(fmtMs(NaN)).toBe("—")
        expect(fmtMs("bad")).toBe("—")
    })
    test("fmtUptime renders d/h/m/s", () => {
        expect(fmtUptime(45)).toBe("45s")
        expect(fmtUptime(125)).toBe("2m 5s")
        expect(fmtUptime(3725)).toBe("1h 2m 5s")
        expect(fmtUptime(90_061)).toBe("1d 1h 1m 1s")
        expect(fmtUptime(-1)).toBe("—")
    })
})

describe("renderDashboard", () => {
    test("emits a valid doctype + html shell with version in the header", () => {
        const html = renderDashboard({
            version: "0.1.3",
            config: baseConfig(),
            uptimeSeconds: 120,
            startedAt: "2026-05-22T17:58:00.000Z",
            records: [],
        })
        expect(html).toMatch(/^<!doctype html>/)
        expect(html).toContain("<html")
        expect(html).toContain("<title>review-orchestrator</title>")
        expect(html).toContain("v0.1.3")
        expect(html).toContain("provider")
        // No external assets — CSS lives inline.
        expect(html).not.toMatch(/href="https?:/)
        expect(html).not.toMatch(/src="https?:/)
    })

    test("renders all records in reviews; failures also appear in the Failed quick-view", () => {
        const html = renderDashboard({
            version: "0.1.3",
            config: baseConfig(),
            records: [issuesRecord(), goodRecord(), escalateRecord()],
        })
        // Reviews section now includes EVERY record (success + failed).
        expect(html).toContain("reviews · 3")
        expect(html).toContain("failed · 1")
        expect(html).toContain("ISSUES")
        expect(html).toContain("GOOD_TO_GO")
        expect(html).toContain("CODEX_ERROR")
        expect(html).toContain("gemini exited with code 41")
    })

    test("empty state shows placeholders for both sections", () => {
        const html = renderDashboard({
            version: "0.1.3",
            config: baseConfig(),
            records: [],
        })
        expect(html).toContain("no reviews recorded yet")
        expect(html).toContain("no failed reviews recorded yet")
        expect(html).toContain("no reviews yet")
    })

    test("HTML-escapes finding messages (XSS guard)", () => {
        const hostile = issuesRecord({
            findings: [
                {
                    file: "<img src=x onerror=alert(1)>",
                    line: 1,
                    severity: "blocker",
                    category: "bug",
                    message: "<script>alert('x')</script>",
                    suggestion: "</textarea><script>steal()</script>",
                },
            ],
        })
        const html = renderDashboard({
            version: "0.1.3",
            config: baseConfig(),
            records: [hostile],
        })
        // No raw <script> tag from finding content can reach the DOM —
        // both the literal tag and the bare-attribute injection vector
        // are escaped to entities.
        expect(html).not.toMatch(/<script>alert/)
        // The attribute-injection text "<img ... onerror=..." would only
        // be dangerous as an unescaped HTML tag. We assert the opening
        // angle bracket is escaped — the literal text "onerror=alert"
        // appears in the output (inside escaped content) but cannot
        // execute because the surrounding < and > are entities.
        expect(html).not.toMatch(/<img src=x onerror/)
        // Escaped versions present.
        expect(html).toContain("&lt;script&gt;alert")
        expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;")
    })

    test("escalate row exposes argv and stderr tail when expanded", () => {
        const html = renderDashboard({
            version: "0.1.3",
            config: baseConfig(),
            records: [escalateRecord()],
        })
        expect(html).toContain("GEMINI_API_KEY is not set")
        expect(html).toContain("gemini -p --bare")
    })

    test("chart returns an empty placeholder svg when there are no records", () => {
        const svg = renderChart([])
        expect(svg).toContain("<svg")
        expect(svg).toContain("no reviews yet")
    })

    test("chart renders one bar per record, ESCALATE colored red", () => {
        const records = [goodRecord(), escalateRecord(), issuesRecord()]
        const svg = renderChart(records)
        const barCount = (svg.match(/<rect /g) ?? []).length
        expect(barCount).toBe(3)
        // ESCALATE color (#ef4444) must be present.
        expect(svg).toContain("#ef4444")
        // First/last tooltip-style title attributes present (one per bar).
        expect((svg.match(/<title>/g) ?? []).length).toBe(3)
    })

    test("config panel surfaces every documented row", () => {
        const html = renderDashboard({
            version: "0.1.3",
            config: baseConfig(),
            records: [],
        })
        for (const key of [
            "provider",
            "model",
            "effort / mode",
            "reviewer timeout",
            "hook fetch timeout",
            "max rounds",
            "max blocks",
            "blocking severities",
            "allowed roots",
            "port / bind",
        ]) {
            expect(html).toContain(key)
        }
    })

    test("hook fetch timeout shows 'auto' when config value is null", () => {
        const html = renderDashboard({
            version: "0.1.3",
            config: baseConfig(),
            records: [],
        })
        expect(html).toMatch(/hook fetch timeout<\/dt><dd>auto/)
    })

    test("successful row with findings renders each as a <li> with severity badge", () => {
        const html = renderSuccessRow(issuesRecord())
        expect(html).toContain("<li>")
        expect(html).toContain("blocker")
        expect(html).toContain("src/a.js:42")
    })

    test("successful row with no findings renders a 'clean review' note", () => {
        const html = renderSuccessRow(goodRecord())
        expect(html).toContain("no findings — clean review")
    })

    test("failure row schema-error block is rendered when present", () => {
        const r = escalateRecord({
            failureDetail: {
                exitCode: 1,
                stderrTail: "",
                stdoutTail: "",
                schemaError: { code: "SCHEMA_INVALID", message: "bad enum" },
                argv: null,
            },
        })
        const html = renderFailureRow(r)
        expect(html).toContain("SCHEMA_INVALID")
        expect(html).toContain("bad enum")
    })

    test("failure row tolerates a non-string r.reason (coerces before slice)", () => {
        // Defensive: archive blobs come from disk; a hand-edited file
        // could leave reason as e.g. a number. The renderer must not
        // TypeError on `.slice` / `.length`.
        const evil = escalateRecord({ reason: 12345 })
        expect(() => renderFailureRow(evil)).not.toThrow()
        const html = renderFailureRow(evil)
        expect(html).toContain("12345")
    })

    test("failure row tolerates a null r.reason (falls back to em-dash)", () => {
        const evil = escalateRecord({ reason: null })
        expect(() => renderFailureRow(evil)).not.toThrow()
        const html = renderFailureRow(evil)
        // The short-reason cell shows the em-dash placeholder.
        expect(html).toContain("—")
    })

    test("long status names use the shortened label in the summary row, full name in the title attribute", () => {
        const r = issuesRecord({ status: "GOOD_TO_GO_WITH_NOTES" })
        const html = renderSuccessRow(r)
        // Shortened label shows in the cramped summary cell.
        expect(html).toContain("GO_WITH_NOTES")
        // Full canonical name preserved in the hover title.
        expect(html).toContain('title="GOOD_TO_GO_WITH_NOTES"')
        // No raw "WITH_NOTES" without the GO_ prefix.
        expect(html).not.toMatch(/>GOOD_TO_GO_WITH_NOTES</)
    })

    test("ESCALATE rows now render inside the reviews list with the failure reason in the body", () => {
        const r = escalateRecord()
        const html = renderSuccessRow(r)
        expect(html).toContain("ESCALATE")
        // Body shows the (truncated) reason, NOT "clean review".
        expect(html).toContain("gemini exited with code 41")
        expect(html).not.toContain("clean review")
    })

    test("reviews rows carry an id derived from the record's _id (for chart deep-linking)", () => {
        const html = renderSuccessRow({ ...goodRecord(), _id: "review-7" })
        expect(html).toMatch(/<details id="review-7">/)
    })

    test("chart wraps each bar in <a href='#review-N'> so clicks deep-link to rows", () => {
        // Two records, both tagged with _id by renderDashboard.
        const html = renderDashboard({
            version: "0.1.7",
            config: baseConfig(),
            records: [goodRecord(), issuesRecord()],
        })
        // Two anchors, one per record.
        expect(
            html.match(/<a href="#review-\d+" class="bar-link">/g)
        ).toHaveLength(2)
        // The matching rows carry the same ids.
        expect(html).toContain('<details id="review-0">')
        expect(html).toContain('<details id="review-1">')
    })

    test("failed section heading is rendered in red (matches ESCALATE bar color)", () => {
        const html = renderDashboard({
            version: "0.1.7",
            config: baseConfig(),
            records: [escalateRecord()],
        })
        // The CSS color value the chart uses for ESCALATE bars.
        expect(html).toMatch(/<h2 style="color:#ef4444">failed · 1<\/h2>/)
    })

    test("chart uses a linear scale: a 5s bar is ~5x taller than a 1s bar", () => {
        // Construct two records, one at maxDur and one at 1/5 of it.
        const fast = goodRecord({ durationMs: 1000 })
        const slow = goodRecord({ durationMs: 5000 })
        const svg = renderChart([fast, slow])
        // Pull the height attributes from the two <rect> elements.
        const heights = [...svg.matchAll(/height="([\d.]+)"/g)].map((m) =>
            parseFloat(m[1])
        )
        expect(heights).toHaveLength(2)
        // Linear: 1000/5000 = 0.2 ratio. Allow ±0.05 for the min-px floor.
        const ratio = Math.min(...heights) / Math.max(...heights)
        expect(ratio).toBeGreaterThan(0.15)
        expect(ratio).toBeLessThan(0.25)
    })

    test("chart enforces a minimum bar height so sub-1% durations stay visible", () => {
        // A 10ms bar next to a 300s bar would be a hairline in a pure
        // linear scale; we floor at 2px so it stays clickable.
        const tiny = goodRecord({ durationMs: 10 })
        const huge = goodRecord({ durationMs: 300_000 })
        const svg = renderChart([huge, tiny])
        const heights = [...svg.matchAll(/height="([\d.]+)"/g)].map((m) =>
            parseFloat(m[1])
        )
        // Smallest height >= 2 (the MIN_BAR_PX floor).
        expect(Math.min(...heights)).toBeGreaterThanOrEqual(2)
    })

    test("hash-target JS is inlined at the bottom of the document", () => {
        const html = renderDashboard({
            version: "0.1.7",
            config: baseConfig(),
            records: [],
        })
        expect(html).toContain("<script>")
        expect(html).toContain("hashchange")
        expect(html).toContain("scrollIntoView")
        // No external script source — keep the dashboard a single file.
        expect(html).not.toMatch(/<script[^>]+src=/)
    })
})

describe("mountDashboardRoute", () => {
    const mkRouteRecorder = () => {
        const routes = {}
        const app = {
            get(path, handler) {
                routes[`GET ${path}`] = handler
            },
        }
        return { app, routes }
    }

    const mkRes = () => {
        const r = {
            headers: {},
            statusCode: 200,
            body: "",
            setHeader(k, v) {
                this.headers[k.toLowerCase()] = v
            },
            status(c) {
                this.statusCode = c
                return this
            },
            send(b) {
                this.body = b
                return this
            },
        }
        return r
    }

    test("registers a GET / handler that returns text/html with no-store", () => {
        const { app, routes } = mkRouteRecorder()
        mountDashboardRoute(app, {
            archive: { readRecent: () => [] },
            config: { reviewer: { provider: "codex" } },
            summarize: (c) => ({ provider: c?.reviewer?.provider ?? "codex" }),
            version: "0.1.3",
            startedAt: Date.now() - 5000,
        })
        const handler = routes["GET /"]
        expect(typeof handler).toBe("function")
        const res = mkRes()
        handler({}, res)
        expect(res.statusCode).toBe(200)
        expect(res.headers["content-type"]).toMatch(/text\/html/)
        expect(res.headers["cache-control"]).toBe("no-store")
        expect(res.body).toMatch(/^<!doctype html>/)
        expect(res.body).toContain("v0.1.3")
    })

    test("tolerates an archive without readRecent (renders empty dashboard)", () => {
        const { app, routes } = mkRouteRecorder()
        mountDashboardRoute(app, {
            archive: null,
            config: null,
            summarize: () => null,
            version: "0.1.3",
            startedAt: 0,
        })
        const res = mkRes()
        routes["GET /"]({}, res)
        expect(res.statusCode).toBe(200)
        expect(res.body).toContain("no reviews yet")
    })

    test("uses metrics.snapshot() if provided as a live object", () => {
        const snapshots = []
        const fakeMetrics = {
            snapshot: () => {
                snapshots.push("called")
                return { reviewed: 4, shortCircuit: 1, errors: 2 }
            },
        }
        const { app, routes } = mkRouteRecorder()
        mountDashboardRoute(app, {
            archive: null,
            config: null,
            summarize: () => null,
            version: "0.1.3",
            startedAt: 0,
            metrics: fakeMetrics,
        })
        const res = mkRes()
        routes["GET /"]({}, res)
        expect(snapshots).toHaveLength(1)
        expect(res.body).toContain("request mix")
        // 4+1+2 = 7 total; reviewed = 4/7 = 57.1%
        expect(res.body).toContain("57.1%")
    })
})

describe("renderRequestPie", () => {
    test("renders the empty-state circle when no requests have been recorded", () => {
        const svg = renderRequestPie({
            reviewed: 0,
            shortCircuit: 0,
            errors: 0,
        })
        expect(svg).toContain("no requests")
        expect(svg).toContain("pie-empty")
    })

    test("renders one slice per non-zero bucket with the right colors", () => {
        const svg = renderRequestPie({
            reviewed: 5,
            shortCircuit: 3,
            errors: 2,
        })
        // STATUS_COLORS.GOOD_TO_GO = #4ade80 (reviewed)
        expect(svg).toContain("#4ade80")
        // STATUS_COLORS.NO_PROGRESS_WITH_OPEN_ISSUES = #6366f1 (shortCircuit)
        expect(svg).toContain("#6366f1")
        // STATUS_COLORS.ESCALATE = #ef4444 (errors)
        expect(svg).toContain("#ef4444")
        // 3 paths, one per slice.
        expect(svg.match(/<path /g)?.length).toBe(3)
    })

    test("draws a full circle when only one bucket is non-zero (avoids degenerate 360° arc)", () => {
        const svg = renderRequestPie({
            reviewed: 7,
            shortCircuit: 0,
            errors: 0,
        })
        // Pie shape is a <circle>, not an SVG path arc.
        expect(svg).toMatch(/<circle [^>]*fill="#4ade80"/)
        expect(svg).not.toMatch(/<path /)
    })

    test("callouts only render for non-zero buckets (no clutter for empty slices)", () => {
        const svg = renderRequestPie({
            reviewed: 1,
            shortCircuit: 0,
            errors: 0,
        })
        expect(svg).toContain("reviewed")
        expect(svg).toContain("100.0%")
        // Empty buckets do NOT get a callout label.
        expect(svg).not.toContain("short-circuit")
        expect(svg).not.toContain("errors")
    })

    test("each visible slice has a callout with label, count, percentage", () => {
        const svg = renderRequestPie({
            reviewed: 2,
            shortCircuit: 1,
            errors: 1,
        })
        expect(svg).toContain("reviewed")
        expect(svg).toContain("short-circuit")
        expect(svg).toContain("errors")
        expect(svg).toContain("2 · 50.0%")
        expect(svg).toContain("1 · 25.0%")
        // Three callout groups for three visible slices.
        expect(svg.match(/<g class="callout">/g)?.length).toBe(3)
    })

    test("hover title carries label, count, and percentage", () => {
        const svg = renderRequestPie({
            reviewed: 1,
            shortCircuit: 1,
            errors: 0,
        })
        expect(svg).toMatch(/<title>reviewed · 1 · 50\.0%<\/title>/)
        expect(svg).toMatch(/<title>short-circuit · 1 · 50\.0%<\/title>/)
    })

    test("defends against null/undefined metrics", () => {
        const a = renderRequestPie(null)
        const b = renderRequestPie(undefined)
        expect(a).toContain("no requests")
        expect(b).toContain("no requests")
    })
})

describe("computeAxisTicks", () => {
    const { computeAxisTicks, fmtAxisLabel } = __test__

    test("returns percent ticks when max is below 1 minute", () => {
        // 30s max → 0.25/0.5/0.75/1× ticks.
        expect(computeAxisTicks(30000)).toEqual([7500, 15000, 22500, 30000])
    })

    test("returns whole-minute ticks when max is at least 1 minute", () => {
        // 5m 50s → ticks at 1m, 2m, 3m, 4m, 5m.
        expect(computeAxisTicks(350000)).toEqual([
            60000, 120000, 180000, 240000, 300000,
        ])
    })

    test("steps up to keep tick count bounded for very long maxes", () => {
        // 30m max → step would be 5m (ceil(30/6)) so ticks at 5,10,15,20,25,30 min.
        expect(computeAxisTicks(30 * 60000)).toEqual([
            5 * 60000,
            10 * 60000,
            15 * 60000,
            20 * 60000,
            25 * 60000,
            30 * 60000,
        ])
    })

    test("returns [] for non-positive or non-numeric input", () => {
        expect(computeAxisTicks(0)).toEqual([])
        expect(computeAxisTicks(-5)).toEqual([])
        expect(computeAxisTicks(null)).toEqual([])
        expect(computeAxisTicks(undefined)).toEqual([])
    })

    test("fmtAxisLabel formats whole minutes as 'Nm'", () => {
        expect(fmtAxisLabel(60000)).toBe("1m")
        expect(fmtAxisLabel(180000)).toBe("3m")
        // Sub-minute falls through to fmtMs.
        expect(fmtAxisLabel(30000)).toBe("30.0s")
        // Non-whole minute also falls through.
        expect(fmtAxisLabel(75000)).toBe("1m 15s")
    })

    test("chart Y-axis labels use whole-minute notation for >1m maxes", () => {
        const records = [
            {
                ts: "2026-05-24T10:00:00Z",
                durationMs: 350000,
                status: "GOOD_TO_GO",
                findingsCount: 0,
                context: "x",
            },
        ]
        const svg = renderChart(records)
        expect(svg).toContain(">1m<")
        expect(svg).toContain(">5m<")
        // No "1m 28s" style mid-fraction labels.
        expect(svg).not.toMatch(/>1m \d+s</)
    })
})

describe("fmtElapsed", () => {
    test("seconds under a minute", () => {
        expect(fmtElapsed(0)).toBe("0s")
        expect(fmtElapsed(12000)).toBe("12s")
        expect(fmtElapsed(59000)).toBe("59s")
    })
    test("minutes with zero-padded seconds", () => {
        expect(fmtElapsed(60000)).toBe("1m 00s")
        expect(fmtElapsed(185000)).toBe("3m 05s")
    })
    test("hours with zero-padded minutes", () => {
        expect(fmtElapsed(3600000)).toBe("1h 00m")
        expect(fmtElapsed(3720000)).toBe("1h 02m")
    })
    test("guards non-numbers and negatives", () => {
        expect(fmtElapsed(undefined)).toBe("0s")
        expect(fmtElapsed(-5)).toBe("0s")
    })
})

describe("renderInFlight", () => {
    test("empty state shows 'no reviews in flight' and zero count", () => {
        const html = renderInFlight([])
        expect(html).toContain("no reviews in flight")
        expect(html).toContain('id="inflight-count">0<')
        // No blinking dots when idle.
        expect(html).not.toContain('class="dot"')
    })

    test("renders a blinking dot, repo:branch, elapsed, and data-started per row", () => {
        const html = renderInFlight([
            {
                repo: "mobile",
                branch: "tmi",
                provider: "codex",
                force: false,
                startedAt: 1000,
                elapsedMs: 42000,
            },
        ])
        expect(html).toContain('id="inflight-count">1<')
        expect(html).toContain('class="dot"')
        expect(html).toContain("mobile:tmi")
        expect(html).toContain('data-started="1000"')
        expect(html).toContain("42s")
        expect(html).toContain("codex")
    })

    test("marks force requests and escapes context", () => {
        const html = renderInFlight([
            {
                repo: "<x>",
                branch: "b",
                provider: "gemini",
                force: true,
                startedAt: 5,
                elapsedMs: 1000,
            },
        ])
        expect(html).toContain('if-tag force">force')
        expect(html).toContain("&lt;x&gt;:b")
        expect(html).not.toContain("<x>:b")
    })
})
