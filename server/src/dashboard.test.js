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

    test("renders successful and failed records into their respective sections", () => {
        const html = renderDashboard({
            version: "0.1.3",
            config: baseConfig(),
            records: [issuesRecord(), goodRecord(), escalateRecord()],
        })
        expect(html).toContain("reviews · 2")
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
        expect(html).toContain("no successful reviews recorded yet")
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
