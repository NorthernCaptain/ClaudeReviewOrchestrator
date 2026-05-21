/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { jest } from "@jest/globals"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Readable } from "node:stream"
import {
    decideStopHookResponse,
    formatBlockingFindings,
    readToken,
    main,
    appendLogLine,
} from "./stop-review.mjs"

const makeTmpDir = () => mkdtempSync(path.join(tmpdir(), "stop-hook-"))

const mkWritable = () => {
    const chunks = []
    return {
        write: (chunk) => {
            chunks.push(
                typeof chunk === "string" ? chunk : chunk.toString("utf8")
            )
            return true
        },
        text: () => chunks.join(""),
    }
}

const stdinFromJSON = (obj) => Readable.from([JSON.stringify(obj)])
const stdinEmpty = () => Readable.from([""])
const stdinFromString = (s) => Readable.from([s])

describe("readToken", () => {
    let dir
    beforeEach(() => {
        dir = makeTmpDir()
    })
    afterEach(() => rmSync(dir, { recursive: true, force: true }))

    test("returns null when file is missing", () => {
        expect(
            readToken({ configPath: path.join(dir, "absent.json") })
        ).toBeNull()
    })

    test("returns null when JSON is malformed", () => {
        const p = path.join(dir, "bad.json")
        writeFileSync(p, "{ not json")
        expect(readToken({ configPath: p })).toBeNull()
    })

    test("returns null when authToken is missing or empty", () => {
        const p = path.join(dir, "c.json")
        writeFileSync(p, JSON.stringify({ other: "value" }))
        expect(readToken({ configPath: p })).toBeNull()
        writeFileSync(p, JSON.stringify({ authToken: "" }))
        expect(readToken({ configPath: p })).toBeNull()
    })

    test("returns { token, url } when authToken is present", () => {
        const p = path.join(dir, "c.json")
        writeFileSync(p, JSON.stringify({ authToken: "abc123" }))
        expect(readToken({ configPath: p })).toEqual({
            token: "abc123",
            url: "http://127.0.0.1:7777/review",
        })
    })

    test("derives url from config.port and config.bind", () => {
        const p = path.join(dir, "c.json")
        writeFileSync(
            p,
            JSON.stringify({
                authToken: "abc",
                port: 17999,
                bind: "127.0.0.1",
            })
        )
        const result = readToken({ configPath: p })
        expect(result.url).toBe("http://127.0.0.1:17999/review")
    })

    test("falls back to default port/bind when config omits them", () => {
        const p = path.join(dir, "c.json")
        writeFileSync(p, JSON.stringify({ authToken: "abc" }))
        const result = readToken({ configPath: p })
        expect(result.url).toBe("http://127.0.0.1:7777/review")
    })
})

describe("appendLogLine", () => {
    let dir
    beforeEach(() => {
        dir = makeTmpDir()
    })
    afterEach(() => rmSync(dir, { recursive: true, force: true }))

    test("writes a JSON line with ts to the configured file", () => {
        const file = path.join(dir, "deep", "review-hook.log")
        appendLogLine(
            { event: "test", foo: 1 },
            { logFile: file, now: () => Date.parse("2026-05-21T14:30:45Z") }
        )
        const content = readFileSync(file, "utf8")
        const entry = JSON.parse(content.trim())
        expect(entry.ts).toBe("2026-05-21T14:30:45.000Z")
        expect(entry.event).toBe("test")
        expect(entry.foo).toBe(1)
    })

    test("appends successive invocations", () => {
        const file = path.join(dir, "review-hook.log")
        appendLogLine({ event: "a" }, { logFile: file, now: () => 0 })
        appendLogLine({ event: "b" }, { logFile: file, now: () => 0 })
        const lines = readFileSync(file, "utf8").trim().split("\n")
        expect(lines).toHaveLength(2)
        expect(JSON.parse(lines[0]).event).toBe("a")
        expect(JSON.parse(lines[1]).event).toBe("b")
    })

    test("never throws on a bad logFile (e.g. parent dir is a file)", () => {
        const file = path.join(dir, "f")
        writeFileSync(file, "blocker")
        expect(() =>
            appendLogLine(
                { event: "x" },
                { logFile: path.join(file, "sub.log"), now: () => 0 }
            )
        ).not.toThrow()
    })
})

describe("formatBlockingFindings", () => {
    test("returns empty string when no blocking findings", () => {
        expect(formatBlockingFindings({ blockingFindings: [] })).toBe("")
        expect(formatBlockingFindings({})).toBe("")
    })

    test("groups by severity in fixed order with suggestions", () => {
        const out = formatBlockingFindings({
            blockingFindings: [
                {
                    file: "src/auth.js",
                    line: 42,
                    severity: "blocker",
                    message: "==",
                    suggestion: "use timingSafeEqual",
                },
                {
                    file: "src/foo.js",
                    line: 7,
                    severity: "major",
                    message: "slow",
                },
                {
                    file: "src/bar.js",
                    line: 1,
                    severity: "blocker",
                    message: "race",
                },
            ],
        })
        // BLOCKER section comes before MAJOR.
        expect(out.indexOf("BLOCKER")).toBeLessThan(out.indexOf("MAJOR"))
        // Both blockers are in BLOCKER section before MAJOR.
        const blockerSection = out.slice(0, out.indexOf("MAJOR"))
        expect(blockerSection).toMatch(/src\/auth\.js:42/)
        expect(blockerSection).toMatch(/src\/bar\.js:1/)
        // MAJOR section has the major finding.
        expect(out.slice(out.indexOf("MAJOR"))).toMatch(/src\/foo\.js:7/)
        expect(out).toMatch(/Suggestion: use timingSafeEqual/)
    })
})

describe("decideStopHookResponse", () => {
    test("fetchError → fail-open, no decision JSON", () => {
        const r = decideStopHookResponse({ fetchError: "ECONNREFUSED" })
        expect(r.stdoutJson).toBeNull()
        expect(r.stderrLines.join("\n")).toMatch(/ECONNREFUSED/)
        expect(r.logEntry.event).toBe("fetch_error")
    })

    test("HTTP 5xx → fail-open", () => {
        const r = decideStopHookResponse({
            fetchHttpStatus: 503,
            reviewResponse: { error: "down" },
        })
        expect(r.stdoutJson).toBeNull()
        expect(r.stderrLines.join("\n")).toMatch(/HTTP 503/)
        expect(r.logEntry.event).toBe("http_error")
    })

    test("HTTP 401 → fail-open (no decision JSON)", () => {
        const r = decideStopHookResponse({ fetchHttpStatus: 401 })
        expect(r.stdoutJson).toBeNull()
        expect(r.stderrLines.join("\n")).toMatch(/HTTP 401/)
    })

    test("empty body → fail-open", () => {
        const r = decideStopHookResponse({
            fetchHttpStatus: 200,
            reviewResponse: null,
        })
        expect(r.stdoutJson).toBeNull()
        expect(r.logEntry.event).toBe("empty_response")
    })

    test("GOOD_TO_GO → exit 0 with status line on stderr", () => {
        const r = decideStopHookResponse({
            fetchHttpStatus: 200,
            reviewResponse: {
                status: "GOOD_TO_GO",
                findings: [],
                blockingFindings: [],
            },
        })
        expect(r.stdoutJson).toBeNull()
        expect(r.stderrLines.join("\n")).toMatch(/GOOD_TO_GO/)
        expect(r.logEntry.event).toBe("pass")
    })

    test("NO_CHANGES → exit 0 with status line", () => {
        const r = decideStopHookResponse({
            fetchHttpStatus: 200,
            reviewResponse: { status: "NO_CHANGES" },
        })
        expect(r.stdoutJson).toBeNull()
        expect(r.stderrLines.join("\n")).toMatch(/NO_CHANGES/)
    })

    test("GOOD_TO_GO_WITH_NOTES → exit 0 with notes summary on stderr", () => {
        const r = decideStopHookResponse({
            fetchHttpStatus: 200,
            reviewResponse: {
                status: "GOOD_TO_GO_WITH_NOTES",
                findings: [
                    {
                        file: "a.js",
                        line: 1,
                        severity: "minor",
                        message: "tidy",
                    },
                ],
                blockingFindings: [],
            },
        })
        expect(r.stdoutJson).toBeNull()
        const out = r.stderrLines.join("\n")
        expect(out).toMatch(/GOOD_TO_GO_WITH_NOTES/)
        expect(out).toMatch(/a\.js:1/)
        expect(r.logEntry.event).toBe("pass_with_notes")
    })

    test("GOOD_TO_GO_WITH_NOTES caps the per-call summary at 5 notes + overflow line", () => {
        const findings = Array.from({ length: 8 }, (_, i) => ({
            file: `f${i}.js`,
            line: i + 1,
            severity: "minor",
            message: `m${i}`,
        }))
        const r = decideStopHookResponse({
            fetchHttpStatus: 200,
            reviewResponse: {
                status: "GOOD_TO_GO_WITH_NOTES",
                findings,
                blockingFindings: [],
            },
        })
        const out = r.stderrLines.join("\n")
        expect(out).toMatch(/and 3 more/)
        // First 5 appear by file name, the rest do not.
        expect(out).toMatch(/f0\.js/)
        expect(out).toMatch(/f4\.js/)
        expect(out).not.toMatch(/f5\.js/)
    })

    test("ESCALATE → exit 0 with banner including code + reason", () => {
        const r = decideStopHookResponse({
            fetchHttpStatus: 200,
            reviewResponse: {
                status: "ESCALATE",
                code: "MAX_BLOCKS",
                reason: "block cap reached",
            },
        })
        expect(r.stdoutJson).toBeNull()
        expect(r.stderrLines.join("\n")).toMatch(/MAX_BLOCKS.*block cap/)
        expect(r.logEntry.event).toBe("escalate")
    })

    test("ISSUES → decision:block JSON with formatted blocking findings", () => {
        const r = decideStopHookResponse({
            fetchHttpStatus: 200,
            reviewResponse: {
                status: "ISSUES",
                findings: [
                    {
                        file: "a.js",
                        line: 1,
                        severity: "blocker",
                        message: "boom",
                    },
                    {
                        file: "a.js",
                        line: 2,
                        severity: "nit",
                        message: "tidy",
                    },
                ],
                blockingFindings: [
                    {
                        file: "a.js",
                        line: 1,
                        severity: "blocker",
                        message: "boom",
                    },
                ],
                state: { codexRounds: 2, blockCount: 1 },
            },
        })
        expect(r.stdoutJson).not.toBeNull()
        expect(r.stdoutJson.decision).toBe("block")
        expect(r.stdoutJson.reason).toMatch(/round 2, block 1/)
        expect(r.stdoutJson.reason).toMatch(/### BLOCKER/)
        expect(r.stdoutJson.reason).toMatch(/`a\.js:1`/)
        expect(r.stdoutJson.reason).toMatch(/Address every BLOCKING point/)
        // Non-blocking nit MUST NOT appear in the block reason.
        expect(r.stdoutJson.reason).not.toMatch(/`a\.js:2`/)
        expect(r.logEntry.event).toBe("block")
    })

    test("NO_PROGRESS_WITH_OPEN_ISSUES → decision:block with different trailer", () => {
        const r = decideStopHookResponse({
            fetchHttpStatus: 200,
            reviewResponse: {
                status: "NO_PROGRESS_WITH_OPEN_ISSUES",
                findings: [],
                blockingFindings: [
                    {
                        file: "a.js",
                        line: 1,
                        severity: "blocker",
                        message: "still here",
                    },
                ],
                state: { codexRounds: 2, blockCount: 3 },
            },
        })
        expect(r.stdoutJson.decision).toBe("block")
        expect(r.stdoutJson.reason).toMatch(/No on-disk progress/)
    })

    test("unknown status → exit 0 with a diagnostic line", () => {
        const r = decideStopHookResponse({
            fetchHttpStatus: 200,
            reviewResponse: { status: "MARS" },
        })
        expect(r.stdoutJson).toBeNull()
        expect(r.stderrLines.join("\n")).toMatch(/unknown status MARS/)
    })
})

describe("main (integration with injected I/O)", () => {
    const cwd = "/repo"

    const fakeFetch = (response) => async () => ({
        status: 200,
        json: async () => response,
    })

    const fakeFetchThrowing = (err) => async () => {
        throw err
    }

    test("happy path GOOD_TO_GO writes only stderr, no decision JSON", async () => {
        const stdout = mkWritable()
        const stderr = mkWritable()
        const logSpy = jest.fn()
        const code = await main({
            stdin: stdinFromJSON({ cwd, session_id: "s" }),
            stdout,
            stderr,
            fetchFn: fakeFetch({
                status: "GOOD_TO_GO",
                findings: [],
                blockingFindings: [],
            }),
            tokenReader: () => ({
                token: "tok",
                url: "http://127.0.0.1:9999/review",
            }),
            log: logSpy,
        })
        expect(code).toBe(0)
        expect(stdout.text()).toBe("")
        expect(stderr.text()).toMatch(/reviewing changes/)
        expect(stderr.text()).toMatch(/GOOD_TO_GO/)
        expect(logSpy).toHaveBeenCalledWith(
            expect.objectContaining({ event: "pass" }),
            expect.any(Object)
        )
    })

    test("ISSUES writes a single decision:block JSON line to stdout", async () => {
        const stdout = mkWritable()
        const stderr = mkWritable()
        const code = await main({
            stdin: stdinFromJSON({ cwd, session_id: "s" }),
            stdout,
            stderr,
            fetchFn: fakeFetch({
                status: "ISSUES",
                findings: [
                    {
                        file: "a.js",
                        line: 1,
                        severity: "blocker",
                        message: "boom",
                    },
                ],
                blockingFindings: [
                    {
                        file: "a.js",
                        line: 1,
                        severity: "blocker",
                        message: "boom",
                    },
                ],
                state: { codexRounds: 1, blockCount: 1 },
            }),
            tokenReader: () => ({
                token: "tok",
                url: "http://127.0.0.1:9999/review",
            }),
            log: () => {},
        })
        expect(code).toBe(0)
        const out = stdout.text().trim()
        const parsed = JSON.parse(out)
        expect(parsed.decision).toBe("block")
        expect(parsed.reason).toMatch(/BLOCKER/)
    })

    test("network error → fail open (exit 0, no stdout JSON)", async () => {
        const stdout = mkWritable()
        const stderr = mkWritable()
        const logSpy = jest.fn()
        const code = await main({
            stdin: stdinFromJSON({ cwd, session_id: "s" }),
            stdout,
            stderr,
            fetchFn: fakeFetchThrowing(new Error("ECONNREFUSED")),
            tokenReader: () => ({
                token: "tok",
                url: "http://127.0.0.1:9999/review",
            }),
            log: logSpy,
        })
        expect(code).toBe(0)
        expect(stdout.text()).toBe("")
        expect(stderr.text()).toMatch(/ECONNREFUSED/)
        expect(logSpy).toHaveBeenCalledWith(
            expect.objectContaining({ event: "fetch_error" }),
            expect.any(Object)
        )
    })

    test("HTTP 500 → fail open", async () => {
        const stdout = mkWritable()
        const stderr = mkWritable()
        const code = await main({
            stdin: stdinFromJSON({ cwd, session_id: "s" }),
            stdout,
            stderr,
            fetchFn: async () => ({
                status: 500,
                json: async () => ({}),
            }),
            tokenReader: () => ({
                token: "tok",
                url: "http://127.0.0.1:9999/review",
            }),
            log: () => {},
        })
        expect(code).toBe(0)
        expect(stdout.text()).toBe("")
        expect(stderr.text()).toMatch(/HTTP 500/)
    })

    test("missing token → fail open, no fetch", async () => {
        const stdout = mkWritable()
        const stderr = mkWritable()
        const fetchSpy = jest.fn()
        const code = await main({
            stdin: stdinFromJSON({ cwd, session_id: "s" }),
            stdout,
            stderr,
            fetchFn: fetchSpy,
            tokenReader: () => null,
            log: () => {},
        })
        expect(code).toBe(0)
        expect(fetchSpy).not.toHaveBeenCalled()
        expect(stderr.text()).toMatch(/no auth token/)
    })

    test("missing cwd in payload → fail open silently", async () => {
        const stdout = mkWritable()
        const stderr = mkWritable()
        const fetchSpy = jest.fn()
        const code = await main({
            stdin: stdinFromJSON({ session_id: "s" }),
            stdout,
            stderr,
            fetchFn: fetchSpy,
            tokenReader: () => ({
                token: "tok",
                url: "http://127.0.0.1:9999/review",
            }),
            log: () => {},
        })
        expect(code).toBe(0)
        expect(fetchSpy).not.toHaveBeenCalled()
        expect(stdout.text()).toBe("")
    })

    test("malformed stdin → fail open with a parse error line", async () => {
        const stdout = mkWritable()
        const stderr = mkWritable()
        const code = await main({
            stdin: stdinFromString("{ not json"),
            stdout,
            stderr,
            fetchFn: async () => ({ status: 200, json: async () => ({}) }),
            tokenReader: () => ({
                token: "tok",
                url: "http://127.0.0.1:9999/review",
            }),
            log: () => {},
        })
        expect(code).toBe(0)
        expect(stderr.text()).toMatch(/failed to parse Stop payload/)
    })

    test("empty stdin → fail open silently (no cwd)", async () => {
        const stdout = mkWritable()
        const stderr = mkWritable()
        const fetchSpy = jest.fn()
        const code = await main({
            stdin: stdinEmpty(),
            stdout,
            stderr,
            fetchFn: fetchSpy,
            tokenReader: () => ({
                token: "tok",
                url: "http://127.0.0.1:9999/review",
            }),
            log: () => {},
        })
        expect(code).toBe(0)
        expect(fetchSpy).not.toHaveBeenCalled()
    })

    test("sends trigger:stop_hook and the X-Review-Token header", async () => {
        const stdout = mkWritable()
        const stderr = mkWritable()
        let seenInit = null
        const fetchSpy = async (url, init) => {
            seenInit = { url, init }
            return {
                status: 200,
                json: async () => ({
                    status: "GOOD_TO_GO",
                    findings: [],
                    blockingFindings: [],
                }),
            }
        }
        await main({
            stdin: stdinFromJSON({ cwd, session_id: "abc" }),
            stdout,
            stderr,
            fetchFn: fetchSpy,
            tokenReader: () => ({
                token: "tok-xyz",
                url: "http://127.0.0.1:9999/review",
            }),
            log: () => {},
        })
        expect(seenInit.url).toMatch(/\/review$/)
        expect(seenInit.init.method).toBe("POST")
        expect(seenInit.init.headers["x-review-token"]).toBe("tok-xyz")
        const body = JSON.parse(seenInit.init.body)
        expect(body).toEqual({
            cwd,
            session_id: "abc",
            trigger: "stop_hook",
        })
    })
})
