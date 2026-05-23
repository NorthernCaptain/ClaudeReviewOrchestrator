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

const { fmtMs, fmtUptime, renderChart, renderSuccessRow, renderFailureRow } =
    __test__

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
        expect(html.match(/<a href="#review-\d+" class="bar-link">/g)).toHaveLength(2)
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
})
