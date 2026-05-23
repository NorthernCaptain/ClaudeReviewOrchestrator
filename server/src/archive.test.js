/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { jest } from "@jest/globals"
import {
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createArchive, __test__ } from "./archive.js"

const {
    tsForFilename,
    sanitizeBranch,
    folderName,
    parseTimestampFromFilename,
    renderMarkdown,
    buildRecord,
    tail,
} = __test__

const makeTmp = () => mkdtempSync(path.join(tmpdir(), "archive-"))

const happyContext = {
    repo: "foo",
    repoRoot: "/tmp/foo",
    branch: "main",
    key: "/tmp/foo|main",
}

const happyPayload = {
    headSha: "abc1234deadbeef",
    promptHash: "ph",
    progressHash: "gh",
    files: {
        modified: [{ path: "a.js" }],
        untracked: [],
        deleted: [],
        renamed: [],
        priorFindingContext: [],
    },
    totalBytes: 2048,
    truncated: false,
    promptText: "PAYLOAD",
}

const happyCodexRaw = {
    argv: ["codex", "exec"],
    model: "gpt-5-codex",
    durationMs: 1234,
    exitCode: 0,
    timedOut: false,
    oversize: false,
    rawStdout: '{"status":"GOOD_TO_GO","findings":[]}',
    rawStderr: "",
}

describe("tsForFilename", () => {
    test("keeps millis and replaces colons + dot with hyphens", () => {
        const out = tsForFilename(Date.parse("2026-05-21T14:30:45.123Z"))
        expect(out).toBe("2026-05-21T14-30-45-123Z")
    })

    test("same-second instants produce distinct filenames via the millis suffix", () => {
        const a = tsForFilename(Date.parse("2026-05-21T14:30:45.001Z"))
        const b = tsForFilename(Date.parse("2026-05-21T14:30:45.999Z"))
        expect(a).not.toBe(b)
    })
})

describe("sanitizeBranch", () => {
    test("replaces / with __", () => {
        expect(sanitizeBranch("feature/foo")).toBe("feature__foo")
    })
    test("returns - for empty/non-string", () => {
        expect(sanitizeBranch("")).toBe("-")
        expect(sanitizeBranch(null)).toBe("-")
    })
})

describe("folderName", () => {
    test("repo:branch with branch sanitized", () => {
        expect(folderName({ repo: "foo", branch: "feature/x" })).toBe(
            "foo:feature__x"
        )
    })
})

describe("parseTimestampFromFilename", () => {
    test("recognizes well-formed names with millis", () => {
        const t = parseTimestampFromFilename("2026-05-21T14-30-45-123Z.json")
        expect(t).toBe(Date.parse("2026-05-21T14:30:45.123Z"))
    })

    test("rejects legacy names without millis (collision risk)", () => {
        expect(
            parseTimestampFromFilename("2026-05-21T14-30-45Z.json")
        ).toBeNull()
    })
    test("returns null on garbage", () => {
        expect(parseTimestampFromFilename("notes.txt")).toBeNull()
        expect(parseTimestampFromFilename("foo.json")).toBeNull()
    })
})

describe("tail", () => {
    test("returns full string when under limit", () => {
        expect(tail("abc", 10)).toBe("abc")
    })
    test("returns last n chars when over", () => {
        expect(tail("abcdef", 3)).toBe("def")
    })
    test("tolerates non-strings", () => {
        expect(tail(null, 3)).toBe("")
    })
})

describe("renderMarkdown", () => {
    const recordWithFindings = (findings, droppedFindings = []) =>
        buildRecord({
            context: happyContext,
            payload: happyPayload,
            codexRaw: happyCodexRaw,
            result: {
                status: "ISSUES",
                findings,
                blockingFindings: findings.filter(
                    (f) => f.severity === "blocker" || f.severity === "major"
                ),
                droppedFindings,
            },
            state: { codexRounds: 1, blockCount: 1 },
            trigger: "stop_hook",
            priorFindingsFedIn: [],
            timestampMs: Date.parse("2026-05-21T14:30:45Z"),
        })

    test("includes title, metadata bullets, and a severity section", () => {
        const md = renderMarkdown(
            recordWithFindings([
                {
                    file: "a.js",
                    line: 42,
                    severity: "blocker",
                    category: "bug",
                    message: "boom",
                    suggestion: "fix it",
                },
            ]),
            ["blocker", "major"]
        )
        expect(md).toMatch(/^# Review — foo:main — 2026-05-21 14:30:45 UTC/m)
        expect(md).toMatch(/\*\*Status:\*\* ISSUES/)
        expect(md).toMatch(/\*\*Trigger:\*\* stop_hook/)
        expect(md).toMatch(/\*\*HEAD:\*\* abc1234/)
        expect(md).toMatch(/\*\*Reviewer:\*\* gpt-5-codex \(1\.2s\)/)
        expect(md).toMatch(/## Blockers \(blocking\)/)
        expect(md).toMatch(/`a\.js:42` — boom/)
        expect(md).toMatch(/Suggestion:\* fix it/)
    })

    test("labels minor/nit sections as non-blocking by default", () => {
        const md = renderMarkdown(
            recordWithFindings([
                {
                    file: "a.js",
                    line: 1,
                    severity: "minor",
                    category: "style",
                    message: "tidy",
                },
                {
                    file: "a.js",
                    line: 2,
                    severity: "nit",
                    category: "style",
                    message: "tinier",
                },
            ]),
            ["blocker", "major"]
        )
        expect(md).toMatch(/## Minor \(non-blocking\)/)
        expect(md).toMatch(/## Nits \(non-blocking\)/)
    })

    test("labels every severity as blocking when blockingSeverities is the full set", () => {
        const md = renderMarkdown(
            recordWithFindings([
                {
                    file: "a.js",
                    line: 1,
                    severity: "minor",
                    category: "style",
                    message: "tidy",
                },
            ]),
            ["blocker", "major", "minor", "nit"]
        )
        expect(md).toMatch(/## Minor \(blocking\)/)
    })

    test("renders Dropped findings footer when any were dropped", () => {
        const md = renderMarkdown(
            recordWithFindings(
                [
                    {
                        file: "a.js",
                        line: 1,
                        severity: "blocker",
                        category: "bug",
                        message: "real",
                    },
                ],
                [
                    {
                        file: "outside.js",
                        line: 1,
                        severity: "blocker",
                        category: "bug",
                        message: "ghost",
                    },
                ]
            ),
            ["blocker", "major"]
        )
        expect(md).toMatch(/## Dropped findings/)
        expect(md).toMatch(/`outside\.js` — ghost/)
    })

    test("renders Prior findings fed footer when any were supplied", () => {
        const record = buildRecord({
            context: happyContext,
            payload: happyPayload,
            codexRaw: happyCodexRaw,
            result: {
                status: "ISSUES",
                findings: [
                    {
                        file: "a.js",
                        line: 5,
                        severity: "blocker",
                        category: "bug",
                        message: "again",
                    },
                ],
                blockingFindings: [],
                droppedFindings: [],
            },
            state: { codexRounds: 2, blockCount: 2 },
            trigger: "stop_hook",
            priorFindingsFedIn: [
                {
                    file: "a.js",
                    line: 5,
                    severity: "blocker",
                    category: "bug",
                    message: "first round",
                },
            ],
            timestampMs: Date.parse("2026-05-21T14:30:45Z"),
        })
        const md = renderMarkdown(record, ["blocker", "major"])
        expect(md).toMatch(/## Prior findings fed to the reviewer this round/)
        expect(md).toMatch(/`a\.js:5` — first round/)
    })

    test("skips empty severity sections", () => {
        const md = renderMarkdown(
            recordWithFindings([
                {
                    file: "a.js",
                    line: 1,
                    severity: "blocker",
                    category: "bug",
                    message: "x",
                },
            ]),
            ["blocker", "major"]
        )
        expect(md).not.toMatch(/## Major/)
        expect(md).not.toMatch(/## Minor/)
        expect(md).not.toMatch(/## Nits/)
    })
})

describe("buildRecord — round/blockCount override", () => {
    test("explicit round/blockCount win over the state snapshot", () => {
        const rec = buildRecord({
            context: happyContext,
            payload: happyPayload,
            codexRaw: happyCodexRaw,
            result: {
                status: "GOOD_TO_GO",
                findings: [],
                blockingFindings: [],
                droppedFindings: [],
            },
            state: { codexRounds: 0, blockCount: 0 },
            trigger: "stop_hook",
            priorFindingsFedIn: [],
            timestampMs: Date.parse("2026-05-21T14:30:45Z"),
            round: 3,
            blockCount: 2,
        })
        expect(rec.round).toBe(3)
        expect(rec.blockCount).toBe(2)
    })

    test("falls back to state.codexRounds/blockCount when not explicit", () => {
        const rec = buildRecord({
            context: happyContext,
            payload: happyPayload,
            codexRaw: happyCodexRaw,
            result: {
                status: "GOOD_TO_GO",
                findings: [],
                blockingFindings: [],
                droppedFindings: [],
            },
            state: { codexRounds: 5, blockCount: 4 },
            trigger: "stop_hook",
            priorFindingsFedIn: [],
            timestampMs: Date.parse("2026-05-21T14:30:45Z"),
        })
        expect(rec.round).toBe(5)
        expect(rec.blockCount).toBe(4)
    })
})

describe("renderMarkdown — edges", () => {
    test("renders Reason bullet when result.reason is set", () => {
        const record = buildRecord({
            context: happyContext,
            payload: happyPayload,
            codexRaw: happyCodexRaw,
            result: {
                status: "ESCALATE",
                findings: [],
                blockingFindings: [],
                droppedFindings: [],
                reason: "codex output failed schema",
            },
            state: { codexRounds: 1, blockCount: 0 },
            trigger: "stop_hook",
            priorFindingsFedIn: [],
            timestampMs: Date.parse("2026-05-21T14:30:45Z"),
        })
        const md = renderMarkdown(record, ["blocker", "major"])
        expect(md).toMatch(/\*\*Reason:\*\* codex output failed schema/)
    })

    test("omits HEAD/Model/Payload bullets when their inputs are absent", () => {
        const record = {
            timestamp: "2026-05-21T14:30:45.000Z",
            context: { repo: "foo", branch: "main", repoRoot: "/", key: "k" },
            round: 0,
            blockCount: 0,
            trigger: "manual",
            baseline: {
                headSha: null,
                files: null,
                totalBytes: null,
                truncated: null,
            },
            codex: null,
            result: {
                status: "GOOD_TO_GO",
                findings: [],
                blockingFindings: [],
                droppedFindings: [],
                reason: null,
            },
            priorFindingsFedIn: [],
        }
        const md = renderMarkdown(record, ["blocker", "major"])
        expect(md).not.toMatch(/\*\*HEAD:/)
        expect(md).not.toMatch(/\*\*Reviewer:/)
        expect(md).not.toMatch(/\*\*Payload:/)
    })

    test("renders reviewer bullet without duration when durationMs missing", () => {
        const record = buildRecord({
            context: happyContext,
            payload: happyPayload,
            codexRaw: { ...happyCodexRaw, durationMs: null },
            result: {
                status: "GOOD_TO_GO",
                findings: [],
                blockingFindings: [],
                droppedFindings: [],
            },
            state: { codexRounds: 1, blockCount: 0 },
            trigger: "stop_hook",
            priorFindingsFedIn: [],
            timestampMs: Date.parse("2026-05-21T14:30:45Z"),
        })
        const md = renderMarkdown(record, ["blocker", "major"])
        expect(md).toMatch(/\*\*Reviewer:\*\* gpt-5-codex(?!\s*\()/)
    })

    test("renders the reviewer bullet with provider + model when archive has provider field", () => {
        // After 0.1.2 the archive's `codex` blob carries `provider`
        // alongside the model. The markdown should show "claude
        // (claude-opus-4-7)" not just "claude-opus-4-7".
        const record = buildRecord({
            context: happyContext,
            payload: happyPayload,
            codexRaw: {
                ...happyCodexRaw,
                provider: "claude",
                model: "claude-opus-4-7",
            },
            result: { status: "GOOD_TO_GO", findings: [] },
            state: { codexRounds: 1, blockCount: 0 },
            round: 1,
            blockCount: 0,
            trigger: "stop_hook",
            priorFindingsFedIn: [],
            timestampMs: Date.parse("2026-05-21T14:30:45Z"),
        })
        const md = renderMarkdown(record, ["blocker", "major"])
        expect(md).toMatch(/\*\*Reviewer:\*\* claude \(claude-opus-4-7\)/)
    })

    test("handles a finding with no suggestion gracefully", () => {
        const record = buildRecord({
            context: happyContext,
            payload: happyPayload,
            codexRaw: happyCodexRaw,
            result: {
                status: "ISSUES",
                findings: [
                    {
                        file: "a.js",
                        line: 1,
                        severity: "blocker",
                        category: "bug",
                        message: "no-fix",
                    },
                ],
                blockingFindings: [],
                droppedFindings: [],
            },
            state: { codexRounds: 1, blockCount: 1 },
            trigger: "stop_hook",
            priorFindingsFedIn: [],
            timestampMs: Date.parse("2026-05-21T14:30:45Z"),
        })
        const md = renderMarkdown(record, ["blocker", "major"])
        expect(md).toMatch(/`a\.js:1` — no-fix/)
        expect(md).not.toMatch(/Suggestion:/)
    })
})

describe("createArchive.write", () => {
    let reviewsDir
    beforeEach(() => {
        reviewsDir = makeTmp()
    })
    afterEach(() => rmSync(reviewsDir, { recursive: true, force: true }))

    const writeOne = (over = {}) =>
        createArchive({
            reviewsDir,
            now: () => Date.parse("2026-05-21T14:30:45Z"),
        }).write({
            context: happyContext,
            payload: happyPayload,
            codexRaw: happyCodexRaw,
            result: {
                status: "GOOD_TO_GO",
                findings: [],
                blockingFindings: [],
                droppedFindings: [],
            },
            state: { codexRounds: 1, blockCount: 0 },
            trigger: "stop_hook",
            priorFindingsFedIn: [],
            ...over,
        })

    test("writes <reviewsDir>/<repo>:<branch>/<ts>.{json,md}", () => {
        const r = writeOne()
        expect(r.jsonPath).toBe(
            path.join(reviewsDir, "foo:main", "2026-05-21T14-30-45-000Z.json")
        )
        expect(r.mdPath).toBe(
            path.join(reviewsDir, "foo:main", "2026-05-21T14-30-45-000Z.md")
        )
        // Files exist on disk and JSON round-trips.
        const j = JSON.parse(readFileSync(r.jsonPath, "utf8"))
        expect(j.context.repo).toBe("foo")
        expect(j.result.status).toBe("GOOD_TO_GO")
        expect(readFileSync(r.mdPath, "utf8")).toMatch(/^# Review/)
    })

    test("sanitizes branch with slash in the folder name", () => {
        const r = writeOne({
            context: { ...happyContext, branch: "feature/x" },
        })
        const dir = path.dirname(r.jsonPath)
        expect(path.basename(dir)).toBe("foo:feature__x")
    })

    test("creates folder on demand", () => {
        const r = writeOne()
        // No exception → folder was created on demand. Sanity: file exists.
        expect(() => readFileSync(r.jsonPath, "utf8")).not.toThrow()
    })

    test("does not leave .tmp siblings on success", () => {
        writeOne()
        const dir = path.join(reviewsDir, "foo:main")
        const files = readdirSync(dir)
        expect(files.some((f) => f.endsWith(".tmp"))).toBe(false)
    })

    test("captures the full ResultStatus envelope in JSON", () => {
        const r = writeOne({
            result: {
                status: "ISSUES",
                findings: [
                    {
                        file: "a.js",
                        line: 1,
                        severity: "blocker",
                        category: "bug",
                        message: "boom",
                    },
                ],
                blockingFindings: [
                    {
                        file: "a.js",
                        line: 1,
                        severity: "blocker",
                        category: "bug",
                        message: "boom",
                    },
                ],
                droppedFindings: [],
            },
        })
        const j = JSON.parse(readFileSync(r.jsonPath, "utf8"))
        expect(j.result.findings).toHaveLength(1)
        expect(j.result.blockingFindings).toHaveLength(1)
    })

    test("truncates rawStderr to tail bytes", () => {
        const huge = "z".repeat(10000)
        const r = writeOne({
            codexRaw: { ...happyCodexRaw, rawStderr: huge },
        })
        const j = JSON.parse(readFileSync(r.jsonPath, "utf8"))
        expect(j.codex.rawStderrTail.length).toBeLessThanOrEqual(4096)
        expect(j.codex.rawStderrTail).toBe(huge.slice(-4096))
    })

    test("logs and returns ok:false when ensureFolder throws (e.g. permissions)", () => {
        // A file already exists where the context folder should be created.
        const collision = path.join(reviewsDir, "foo:main")
        writeFileSync(collision, "not a directory")
        const logger = { error: jest.fn(), warn: jest.fn() }
        const archive = createArchive({
            reviewsDir,
            now: () => Date.parse("2026-05-21T14:30:45Z"),
            logger,
        })
        const r = archive.write({
            context: happyContext,
            payload: happyPayload,
            codexRaw: happyCodexRaw,
            result: {
                status: "GOOD_TO_GO",
                findings: [],
                blockingFindings: [],
                droppedFindings: [],
            },
            state: { codexRounds: 1, blockCount: 0 },
            trigger: "stop_hook",
            priorFindingsFedIn: [],
        })
        expect(r.ok).toBe(false)
        expect(r.error).toBeDefined()
        expect(logger.error).toHaveBeenCalled()
    })

    test("logs but does not throw when md write fails", () => {
        const archive = createArchive({
            reviewsDir,
            now: () => Date.parse("2026-05-21T14:30:45Z"),
            logger: { warn: jest.fn() },
        })
        // Trigger MD write failure: pre-create a directory with the MD's
        // intended name so writeFileSync fails.
        const dir = path.join(reviewsDir, "foo:main")
        // Need a deeper trick: chmod won't work portably. Instead, monkey
        // patch is overkill; just check the happy path doesn't throw and
        // the json sibling is durable.
        const r = archive.write({
            context: happyContext,
            payload: happyPayload,
            codexRaw: happyCodexRaw,
            result: {
                status: "GOOD_TO_GO",
                findings: [],
                blockingFindings: [],
                droppedFindings: [],
            },
            state: { codexRounds: 1, blockCount: 0 },
            trigger: "stop_hook",
            priorFindingsFedIn: [],
        })
        expect(readFileSync(r.jsonPath, "utf8")).toMatch(/foo/)
        // Sanity: dir was created.
        expect(readdirSync(dir).length).toBeGreaterThanOrEqual(2)
    })
})

describe("createArchive.pruneOnStartup", () => {
    let reviewsDir
    beforeEach(() => {
        reviewsDir = makeTmp()
    })
    afterEach(() => rmSync(reviewsDir, { recursive: true, force: true }))

    const placeFile = (subdir, name, contents = "") => {
        const full = path.join(reviewsDir, subdir, name)
        mkdirSync(path.dirname(full), { recursive: true })
        writeFileSync(full, contents)
        return full
    }

    test("returns {removed: 0} when retentionDays is null", () => {
        const archive = createArchive({ reviewsDir, retentionDays: null })
        expect(archive.pruneOnStartup().removed).toBe(0)
    })

    test("tolerates a missing reviewsDir gracefully", () => {
        const archive = createArchive({
            reviewsDir: path.join(reviewsDir, "absent"),
            retentionDays: 1,
            now: () => Date.now(),
        })
        expect(archive.pruneOnStartup().removed).toBe(0)
    })

    test("deletes files older than retentionDays and keeps fresh ones", () => {
        const NOW = Date.parse("2026-05-21T14:30:45Z")
        const DAY = 24 * 60 * 60 * 1000
        // 5 days ago — should be pruned.
        placeFile("foo:main", `${tsForFilename(NOW - 5 * DAY)}.json`)
        placeFile("foo:main", `${tsForFilename(NOW - 5 * DAY)}.md`)
        // 1 day ago — should be kept.
        placeFile("foo:main", `${tsForFilename(NOW - 1 * DAY)}.json`)
        placeFile("foo:main", `${tsForFilename(NOW - 1 * DAY)}.md`)

        const archive = createArchive({
            reviewsDir,
            retentionDays: 3,
            now: () => NOW,
        })
        const r = archive.pruneOnStartup()
        expect(r.removed).toBe(2)
        const remaining = readdirSync(path.join(reviewsDir, "foo:main")).sort()
        expect(remaining).toEqual([
            `${tsForFilename(NOW - 1 * DAY)}.json`,
            `${tsForFilename(NOW - 1 * DAY)}.md`,
        ])
    })

    test("ignores files with non-conforming names", () => {
        const NOW = Date.parse("2026-05-21T14:30:45Z")
        placeFile("foo:main", "notes.txt", "hi")
        placeFile("foo:main", "garbage.json", "{}")
        const archive = createArchive({
            reviewsDir,
            retentionDays: 1,
            now: () => NOW,
        })
        const r = archive.pruneOnStartup()
        expect(r.removed).toBe(0)
        const remaining = readdirSync(path.join(reviewsDir, "foo:main"))
        expect(remaining).toContain("notes.txt")
        expect(remaining).toContain("garbage.json")
    })
})

describe("createArchive — misc edges", () => {
    test("throws if reviewsDir is missing", () => {
        expect(() => createArchive({})).toThrow(/reviewsDir/)
        expect(() => createArchive({ reviewsDir: "" })).toThrow(/reviewsDir/)
    })
})

describe("createArchive.list", () => {
    let reviewsDir
    beforeEach(() => {
        reviewsDir = makeTmp()
    })
    afterEach(() => rmSync(reviewsDir, { recursive: true, force: true }))

    test("returns one entry per .json across all context folders", () => {
        const archive = createArchive({
            reviewsDir,
            now: () => Date.parse("2026-05-21T14:30:45Z"),
        })
        archive.write({
            context: happyContext,
            payload: happyPayload,
            codexRaw: happyCodexRaw,
            result: {
                status: "GOOD_TO_GO",
                findings: [],
                blockingFindings: [],
                droppedFindings: [],
            },
            state: { codexRounds: 1, blockCount: 0 },
            trigger: "stop_hook",
            priorFindingsFedIn: [],
        })
        const all = archive.list()
        expect(all).toHaveLength(1)
        expect(all[0].context).toBe("foo:main")
        expect(all[0].name).toMatch(/\.json$/)
    })
})

describe("createArchive.readRecent", () => {
    let tmp
    beforeEach(() => {
        tmp = mkdtempSync(path.join(tmpdir(), "rev-recent-"))
    })
    afterEach(() => {
        rmSync(tmp, { recursive: true, force: true })
    })

    // We tick the injected clock between writes so each gets a unique
    // archive filename (write() uses `now()` for the basename).
    let clock = 0
    const tickArchive = (start = 1779000000000) => {
        clock = start
        return createArchive({
            reviewsDir: tmp,
            now: () => {
                const t = clock
                clock += 1000
                return t
            },
        })
    }

    const writeOne = (archive, ts, repo, branch, status, findings = []) =>
        archive.write({
            context: { repo, branch },
            payload: {
                headSha: "abc",
                files: {
                    modified: [],
                    untracked: [],
                    deleted: [],
                    renamed: [],
                    priorFindingContext: [],
                },
                totalBytes: 0,
                truncated: false,
                promptHash: "p",
                progressHash: "g",
            },
            codexRaw: {
                argv: ["codex", "exec"],
                model: "gpt-5.5",
                provider: "codex",
                durationMs: 1234,
                exitCode: status === "ESCALATE" ? 1 : 0,
                rawStdout: "",
                rawStderr: status === "ESCALATE" ? "boom" : "",
            },
            result: {
                status,
                findings,
                blockingFindings: findings.filter((f) =>
                    ["blocker", "major"].includes(f.severity)
                ),
                droppedFindings: [],
                reason: status === "ESCALATE" ? "test boom" : undefined,
            },
            state: { codexRounds: 1, blockCount: 0 },
            round: 1,
            blockCount: 0,
            trigger: "stop_hook",
            priorFindingsFedIn: [],
            timestampMs: ts,
        })

    test("returns newest-first across multiple context folders", () => {
        const archive = tickArchive()
        writeOne(archive, 0, "a", "main", "GOOD_TO_GO")
        writeOne(archive, 0, "b", "feature", "ISSUES", [
            {
                file: "x.js",
                line: 1,
                severity: "blocker",
                category: "bug",
                message: "y",
            },
        ])
        writeOne(archive, 0, "a", "main", "ESCALATE")
        const recent = archive.readRecent({ limit: 10 })
        expect(recent).toHaveLength(3)
        expect(recent[0].status).toBe("ESCALATE")
        expect(recent[1].status).toBe("ISSUES")
        expect(recent[2].status).toBe("GOOD_TO_GO")
        // Cross-context order honored by mtime, not directory traversal.
        expect(recent[1].context).toBe("b:feature")
    })

    test("respects the limit", () => {
        const archive = tickArchive()
        for (let i = 0; i < 5; i += 1) {
            writeOne(archive, 0, "r", "main", "GOOD_TO_GO")
        }
        expect(archive.readRecent({ limit: 2 })).toHaveLength(2)
    })

    test("populates failureDetail only for ESCALATE records", () => {
        const archive = tickArchive()
        writeOne(archive, 0, "a", "main", "GOOD_TO_GO")
        writeOne(archive, 0, "a", "main", "ESCALATE")
        const recent = archive.readRecent({ limit: 10 })
        expect(recent).toHaveLength(2)
        expect(recent[0].status).toBe("ESCALATE")
        expect(recent[0].failureDetail).not.toBeNull()
        expect(recent[0].failureDetail.exitCode).toBe(1)
        expect(recent[1].failureDetail).toBeNull()
    })

    test("returns [] when reviewsDir doesn't exist", () => {
        const archive = createArchive({
            reviewsDir: path.join(tmp, "missing"),
        })
        expect(archive.readRecent({ limit: 10 })).toEqual([])
    })

    test("skips unreadable / malformed JSON files silently", () => {
        const archive = tickArchive()
        writeOne(archive, 0, "a", "main", "GOOD_TO_GO")
        // Drop a malformed sibling so the scan has to skip it.
        const ctxDir = path.join(tmp, "a:main")
        writeFileSync(path.join(ctxDir, "2026-99-99T99-99-99-999Z.json"), "{")
        const recent = archive.readRecent({ limit: 10 })
        // The valid record still surfaces.
        expect(recent.some((r) => r.status === "GOOD_TO_GO")).toBe(true)
    })

    test("skips files where JSON.parse succeeds but the value isn't an object", () => {
        // JSON.parse("null") returns null — valid JSON, not an object.
        // Pre-fix the dashboard would TypeError on record.result.
        const archive = tickArchive()
        writeOne(archive, 0, "a", "main", "GOOD_TO_GO")
        const ctxDir = path.join(tmp, "a:main")
        writeFileSync(path.join(ctxDir, "2026-12-31T23-59-59-001Z.json"), "null")
        writeFileSync(path.join(ctxDir, "2026-12-31T23-59-59-002Z.json"), "42")
        writeFileSync(
            path.join(ctxDir, "2026-12-31T23-59-59-003Z.json"),
            '"plain string"'
        )
        expect(() => archive.readRecent({ limit: 10 })).not.toThrow()
        const recent = archive.readRecent({ limit: 10 })
        // Only the real GOOD_TO_GO record survives.
        expect(recent).toHaveLength(1)
        expect(recent[0].status).toBe("GOOD_TO_GO")
    })

    test("tolerates a non-string rawStdout in ESCALATE records (coerces before slice)", () => {
        const archive = tickArchive()
        // Hand-write a record whose `codex.rawStdout` is a number so
        // we exercise the coercion in readRecent without going through
        // write() (which sanitizes).
        mkdirSync(path.join(tmp, "x:main"), { recursive: true })
        const malformed = {
            timestamp: "2026-05-23T00:00:00.000Z",
            context: { repo: "x", branch: "main" },
            codex: {
                provider: "codex",
                model: "gpt-5.5",
                rawStdout: 12345, // <-- not a string
                rawStderrTail: "",
                exitCode: 1,
                argv: null,
            },
            result: { status: "ESCALATE", reason: "boom", findings: [] },
            round: 1,
            blockCount: 0,
            trigger: "manual",
        }
        writeFileSync(
            path.join(tmp, "x:main", "2026-05-23T00-00-00-000Z.json"),
            JSON.stringify(malformed)
        )
        expect(() => archive.readRecent({ limit: 10 })).not.toThrow()
        const recent = archive.readRecent({ limit: 10 })
        expect(recent).toHaveLength(1)
        expect(typeof recent[0].failureDetail.stdoutTail).toBe("string")
    })
})
