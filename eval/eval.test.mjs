/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { jest } from "@jest/globals"
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
    buildCaseRepo,
    caseRepoDir,
    DEFAULT_CASES_DIR,
    formatReport,
    lineOf,
    loadCases,
    main,
    parseArgs,
    resolveRulesText,
    reviewRepo,
    runPool,
    scoreCase,
    SEVERITY_RANK,
    UsageError,
    USAGE,
} from "./eval.mjs"

const CORE_REVIEW = new URL("../server/src/core/review/", import.meta.url)
const RULES_BYTES = readFileSync(new URL("review-rules.md", CORE_REVIEW))
const SCHEMA_BYTES = readFileSync(
    new URL("codex-output.schema.json", CORE_REVIEW)
)

let tmp
beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "review-eval-test-"))
})
afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
})

const write = (rel, text) => {
    const file = path.join(tmp, rel)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, text)
    return file
}

const finding = (over = {}) => ({
    file: "src/a.js",
    line: 5,
    severity: "major",
    category: "bug",
    message: "m",
    suggestion: null,
    ...over,
})

describe("parseArgs", () => {
    test("defaults", () => {
        const o = parseArgs([])
        expect(o.providers).toEqual(["codex", "claude"])
        expect(o.cases).toBeNull()
        expect(o.rules).toBe("bundled")
        expect(o.concurrency).toBe(3)
        expect(o.keep).toBe(false)
        expect(o.help).toBe(false)
    })

    test("every option", () => {
        const o = parseArgs([
            "--providers",
            "claude, gemini",
            "--cases",
            "a,b",
            "--rules",
            "none",
            "--config",
            "/c.json",
            "--concurrency",
            "5",
            "--work",
            "/w",
            "--keep",
            "-h",
        ])
        expect(o).toEqual({
            providers: ["claude", "gemini"],
            cases: ["a", "b"],
            rules: "none",
            config: "/c.json",
            concurrency: 5,
            work: "/w",
            keep: true,
            help: true,
        })
    })

    test("repeated providers and cases run once", () => {
        const o = parseArgs([
            "--providers",
            "codex,claude,codex",
            "--cases",
            "a,b,a",
        ])
        expect(o.providers).toEqual(["codex", "claude"])
        expect(o.cases).toEqual(["a", "b"])
    })

    test.each([
        [["--rules"], /needs a value/],
        [["--rules", "--keep"], /needs a value/],
        [["--bogus"], /unknown option/],
        [["--concurrency", "0"], /positive integer/],
        [["--concurrency", "1.5"], /positive integer/],
        [["--providers", " , "], /empty/],
        [["--cases", " , "], /--cases is empty/],
        [
            ["--providers", "codex,x/../../../important"],
            /unknown provider: x\/\.\.\/\.\.\/\.\.\/important/,
        ],
    ])("rejects %j", (argv, message) => {
        expect(() => parseArgs(argv)).toThrow(UsageError)
        expect(() => parseArgs(argv)).toThrow(message)
    })
})

describe("loadCases", () => {
    const addCase = (id, spec) => {
        write(`cases/${id}/case.json`, JSON.stringify(spec))
        mkdirSync(path.join(tmp, `cases/${id}/base`), { recursive: true })
    }

    test("loads every case in id order and filters by id", () => {
        addCase("b", { expect: "clean" })
        addCase("a", {
            expect: "issues",
            findings: [{ files: ["x.js"], minSeverity: "minor" }],
        })
        write("cases/not-a-dir.txt", "x")
        const all = loadCases(path.join(tmp, "cases"))
        expect(all.map((c) => c.id)).toEqual(["a", "b"])
        expect(all[1].spec.findings).toEqual([])
        expect(all[0].dir).toBe(path.join(tmp, "cases", "a"))
        expect(
            loadCases(path.join(tmp, "cases"), ["b"]).map((c) => c.id)
        ).toEqual(["b"])
    })

    test("an unknown id is a usage error", () => {
        addCase("a", { expect: "clean" })
        expect(() => loadCases(path.join(tmp, "cases"), ["zz"])).toThrow(
            "unknown case: zz"
        )
    })

    test.each([
        [{ expect: "maybe" }, /"expect" must be/],
        [{ expect: "issues" }, /needs "findings"/],
        [{ expect: "issues", findings: [{}] }, /needs "files"/],
        [
            {
                expect: "issues",
                findings: [{ files: ["a"], minSeverity: "x" }],
            },
            /unknown minSeverity x/,
        ],
    ])("rejects spec %j", (spec, message) => {
        addCase("bad", spec)
        expect(() => loadCases(path.join(tmp, "cases"))).toThrow(message)
    })

    test("the shipped cases are all valid", () => {
        const cases = loadCases(DEFAULT_CASES_DIR)
        expect(cases.length).toBeGreaterThanOrEqual(15)
        expect(cases.some((c) => c.spec.expect === "clean")).toBe(true)
        for (const c of cases) {
            expect(existsSync(path.join(c.dir, "base"))).toBe(true)
        }
    })
})

describe("buildCaseRepo", () => {
    test("commits base, then overlays change and deletes, uncommitted", async () => {
        write("case/base/a.txt", "base a")
        write("case/base/gone.txt", "bye")
        write("case/change/a.txt", "changed a")
        write("case/change/new/b.txt", "new b")
        const calls = []
        const git = jest.fn(async (cwd, args) => {
            calls.push({
                args,
                a: readFileSync(path.join(cwd, "a.txt"), "utf8"),
            })
            return ""
        })
        const repoDir = path.join(tmp, "repo")
        await buildCaseRepo({
            caseDir: path.join(tmp, "case"),
            spec: { delete: ["gone.txt"], baseMessage: "Seed" },
            repoDir,
            git,
        })
        expect(calls.map((c) => c.args[0])).toEqual(["init", "add", "-c"])
        expect(calls[2].args).toContain("Seed")
        // Every git call saw the base content: change came after the commit.
        expect(calls.every((c) => c.a === "base a")).toBe(true)
        expect(readFileSync(path.join(repoDir, "a.txt"), "utf8")).toBe(
            "changed a"
        )
        expect(existsSync(path.join(repoDir, "new/b.txt"))).toBe(true)
        expect(existsSync(path.join(repoDir, "gone.txt"))).toBe(false)
    })

    test("works without a change folder", async () => {
        write("case/base/a.txt", "a")
        const git = jest.fn(async () => "")
        const repoDir = path.join(tmp, "repo")
        await buildCaseRepo({
            caseDir: path.join(tmp, "case"),
            spec: {},
            repoDir,
            git,
        })
        expect(git.mock.calls[2][1]).toContain("Initial version")
        expect(readFileSync(path.join(repoDir, "a.txt"), "utf8")).toBe("a")
    })
})

describe("SEVERITY_RANK", () => {
    test("ranks the server's severities, most severe highest", () => {
        expect(SEVERITY_RANK).toEqual({
            blocker: 3,
            major: 2,
            minor: 1,
            nit: 0,
        })
    })
})

describe("caseRepoDir", () => {
    test("a direct child of <work>/repos", () => {
        expect(caseRepoDir("/w", "bug", "codex")).toBe("/w/repos/bug--codex")
    })

    test("refuses a name that leaves the repos folder", () => {
        expect(() => caseRepoDir("/w", "x", "a/../../../etc")).toThrow(
            /escapes \/w\/repos/
        )
        expect(() => caseRepoDir("/w", "../x", "codex")).toThrow(UsageError)
    })
})

describe("lineOf", () => {
    test("1-based line of the first match, or null", () => {
        expect(lineOf("a\nb x\nc x", "x")).toBe(2)
        expect(lineOf("a", "z")).toBeNull()
    })
})

describe("scoreCase", () => {
    const blocking = ["blocker", "major"]
    const text = "1\n2\n3\n4\nTARGET\n6\n7\n8\n9\n10\n11\n12\n13\n14"
    const readFile = () => text
    const issues = (expected) => ({ expect: "issues", findings: [expected] })

    test("an escalated review is an error", () => {
        const s = scoreCase({
            spec: issues({ files: ["src/a.js"] }),
            result: { status: "ESCALATE", reason: "timed out" },
            blocking,
            readFile,
        })
        expect(s).toEqual({
            pass: false,
            error: "timed out",
            hits: [],
            blocking: 0,
        })
        expect(
            scoreCase({
                spec: issues({ files: ["a"] }),
                result: { status: "ESCALATE" },
                blocking,
                readFile,
            }).error
        ).toBe("reviewer failed")
    })

    test("clean passes without blocking findings", () => {
        const spec = { expect: "clean", findings: [] }
        expect(
            scoreCase({
                spec,
                result: {
                    status: "ISSUES",
                    findings: [finding({ severity: "nit" })],
                },
                blocking,
                readFile,
            })
        ).toEqual({ pass: true, hits: [], blocking: 0 })
        const fail = scoreCase({
            spec,
            result: { status: "ISSUES", findings: [finding()] },
            blocking,
            readFile,
        })
        expect(fail.pass).toBe(false)
        expect(fail.blocking).toBe(1)
        expect(
            scoreCase({
                spec,
                result: { status: "GOOD_TO_GO" },
                blocking,
                readFile,
            }).pass
        ).toBe(true)
    })

    test("a finding near the expected line at enough severity is a hit", () => {
        const s = scoreCase({
            spec: issues({ files: ["src/a.js"], near: "TARGET" }),
            result: { status: "ISSUES", findings: [finding({ line: 11 })] },
            blocking,
            readFile,
        })
        expect(s.pass).toBe(true)
        expect(s.hits[0].line).toBe(11)
    })

    test.each([
        ["too far from the line", finding({ line: 12 }), {}],
        ["the wrong file", finding({ file: "src/b.js" }), {}],
        ["too low a severity", finding({ severity: "minor" }), {}],
        ["an unknown severity", finding({ severity: "huge" }), {}],
        ["a needle that's not in the file", finding(), { near: "NOPE" }],
    ])("no hit for %s", (_why, f, over) => {
        const s = scoreCase({
            spec: issues({ files: ["src/a.js"], near: "TARGET", ...over }),
            result: { status: "ISSUES", findings: [f] },
            blocking,
            readFile,
        })
        expect(s.pass).toBe(false)
        expect(s.hits).toEqual([null])
    })

    test("minSeverity, slack, file-wide findings and no needle", () => {
        const score = (expected, f) =>
            scoreCase({
                spec: issues(expected),
                result: { status: "ISSUES", findings: [f] },
                blocking,
                readFile,
            }).pass
        expect(
            score(
                { files: ["src/a.js"], near: "TARGET", minSeverity: "minor" },
                finding({ severity: "minor" })
            )
        ).toBe(true)
        expect(
            score(
                { files: ["src/a.js"], near: "TARGET", slack: 10 },
                finding({ line: 14 })
            )
        ).toBe(true)
        expect(
            score({ files: ["src/a.js"], near: "TARGET" }, finding({ line: 0 }))
        ).toBe(true)
        expect(score({ files: ["src/a.js"] }, finding({ line: 99 }))).toBe(true)
    })

    test("an unreadable file is no hit", () => {
        const s = scoreCase({
            spec: issues({ files: ["src/a.js"], near: "TARGET" }),
            result: { status: "ISSUES", findings: [finding()] },
            blocking,
            readFile: () => {
                throw new Error("ENOENT")
            },
        })
        expect(s.pass).toBe(false)
    })
})

describe("reviewRepo", () => {
    const payload = {
        promptText: "=== FILE: a.js ===\ndiff",
        omittedFiles: [],
        diffRef: "HEAD",
        files: { modified: [{ path: "src/a.js" }] },
    }
    const config = { extraReviewerInstructions: "be strict" }

    test("wraps the payload with the rules and runs the provider through spawnTool", async () => {
        const spawnTool = jest.fn(() => "child")
        const runAndParse = jest.fn(async ({ spawn }) => {
            expect(spawn("ignored", ["-x"], { cwd: "/r" })).toBe("child")
            return {
                status: "ISSUES",
                findings: [finding()],
                raw: { durationMs: 42 },
            }
        })
        const pickReviewer = jest.fn(() => ({ runAndParse }))
        const buildPayload = jest.fn(async () => payload)
        const tools = { git: jest.fn(), spawnTool }
        const out = await reviewRepo({
            repoDir: "/r",
            config,
            provider: "claude",
            rulesText: "# R",
            schema: "S",
            tools,
            deps: { buildPayload, pickReviewer },
        })
        expect(out).toEqual({
            status: "ISSUES",
            findings: [finding()],
            droppedFindings: [],
            reason: null,
            durationMs: 42,
        })
        expect(buildPayload).toHaveBeenCalledWith({
            repoRoot: "/r",
            config,
            git: tools.git,
        })
        expect(pickReviewer).toHaveBeenCalledWith(config, "claude")
        const { prompt, schema } = runAndParse.mock.calls[0][0]
        expect(schema).toBe("S")
        expect(prompt).toContain("<<<REVIEW_RULES>>>")
        expect(prompt).toContain("# R")
        expect(prompt).toContain("be strict")
        expect(spawnTool).toHaveBeenCalledWith("claude", ["-x"], {
            cwd: "/r",
            config,
        })
    })

    test("findings on files outside the change are dropped, as the server does", async () => {
        const outside = finding({ file: "README.md" })
        const escaping = finding({ file: "../etc/passwd" })
        const out = await reviewRepo({
            repoDir: "/r",
            config: {},
            provider: "codex",
            rulesText: null,
            schema: null,
            tools: { git: jest.fn() },
            deps: {
                buildPayload: async () => payload,
                pickReviewer: () => ({
                    runAndParse: async () => ({
                        status: "ISSUES",
                        findings: [
                            outside,
                            finding({ file: "./src/a.js" }),
                            escaping,
                        ],
                    }),
                }),
            },
        })
        expect(out.findings).toEqual([finding()])
        expect(out.droppedFindings).toEqual([outside, escaping])
        const spec = {
            expect: "issues",
            findings: [{ files: ["README.md"] }],
        }
        expect(
            scoreCase({
                spec,
                result: out,
                blocking: ["major"],
                readFile: () => "",
            }).pass
        ).toBe(false)
    })

    test("a result without raw or findings still reports", async () => {
        const out = await reviewRepo({
            repoDir: "/r",
            config: {},
            provider: "codex",
            rulesText: null,
            schema: null,
            tools: { git: jest.fn() },
            deps: {
                buildPayload: async () => ({ promptText: "d" }),
                pickReviewer: () => ({
                    runAndParse: async () => ({
                        status: "ESCALATE",
                        reason: "bad",
                    }),
                }),
            },
        })
        expect(out.status).toBe("ESCALATE")
        expect(out.findings).toEqual([])
        expect(out.droppedFindings).toEqual([])
        expect(out.reason).toBe("bad")
        expect(typeof out.durationMs).toBe("number")
    })

    test("a thrown reviewer becomes an ESCALATE result", async () => {
        const out = await reviewRepo({
            repoDir: "/r",
            config: {},
            provider: "gemini",
            rulesText: null,
            schema: null,
            tools: { git: jest.fn() },
            deps: {
                buildPayload: async () => payload,
                pickReviewer: () => ({
                    runAndParse: async () => {
                        throw new Error("spawn gemini ENOENT")
                    },
                }),
            },
        })
        expect(out.status).toBe("ESCALATE")
        expect(out.reason).toBe("spawn gemini ENOENT")
        const odd = await reviewRepo({
            repoDir: "/r",
            config: {},
            provider: "gemini",
            rulesText: null,
            schema: null,
            tools: { git: jest.fn() },
            deps: {
                buildPayload: async () => payload,
                pickReviewer: () => ({
                    runAndParse: async () => {
                        throw "plain"
                    },
                }),
            },
        })
        expect(odd.reason).toBe("plain")
    })
})

describe("runPool", () => {
    test("keeps order and never exceeds the concurrency", async () => {
        let running = 0
        let peak = 0
        const out = await runPool([30, 10, 20, 5], 2, async (ms, i) => {
            running++
            peak = Math.max(peak, running)
            await new Promise((r) => setTimeout(r, ms))
            running--
            return i
        })
        expect(out).toEqual([0, 1, 2, 3])
        expect(peak).toBe(2)
        expect(await runPool([], 3, async () => 1)).toEqual([])
    })
})

describe("resolveRulesText", () => {
    test("none, bundled, the config's rulesFile, or a path", () => {
        expect(
            resolveRulesText({
                which: "none",
                config: {},
                bundledBytes: RULES_BYTES,
            })
        ).toEqual({ text: null, source: "none" })
        const bundled = resolveRulesText({
            which: "bundled",
            config: {},
            bundledBytes: RULES_BYTES,
        })
        expect(bundled.source).toBe("bundled")
        expect(bundled.text).toContain("# Review rules")
        const file = write("mine.md", "# Mine\n")
        expect(
            resolveRulesText({
                which: "bundled",
                config: { reviewer: { rulesFile: file } },
                bundledBytes: RULES_BYTES,
            })
        ).toEqual({ text: "# Mine", source: file })
        expect(
            resolveRulesText({
                which: "/x/other.md",
                config: {},
                bundledBytes: RULES_BYTES,
                readFile: () => Buffer.from("# Other"),
            })
        ).toEqual({ text: "# Other", source: "/x/other.md" })
    })
})

describe("formatReport", () => {
    const cases = [
        { id: "bug", spec: { expect: "issues" } },
        { id: "ok", spec: { expect: "clean" } },
    ]
    test("a table per case and provider, a summary, and what didn't pass", () => {
        const runs = [
            {
                caseId: "bug",
                provider: "codex",
                spec: cases[0].spec,
                result: { durationMs: 61000, findings: [finding()] },
                score: { pass: true, blocking: 1 },
            },
            {
                caseId: "ok",
                provider: "codex",
                spec: cases[1].spec,
                result: {
                    durationMs: 2000,
                    findings: [finding({ message: "x".repeat(300) })],
                    droppedFindings: [finding({ file: "README.md" })],
                },
                score: { pass: false, blocking: 1 },
            },
            {
                caseId: "bug",
                provider: "claude",
                spec: cases[0].spec,
                result: { durationMs: 1000, findings: [] },
                score: { pass: false, error: "boom", blocking: 0 },
            },
        ]
        const out = formatReport({
            cases,
            providers: ["codex", "claude"],
            runs,
            rulesSource: "bundled",
        })
        expect(out).toContain("Rules: bundled")
        expect(out).toMatch(/bug\s+issues\s+pass b=1 61s\s+ERROR b=0 1s/)
        expect(out).toMatch(/ok\s+clean\s+FAIL b=1 2s\s+-/)
        expect(out).toContain(
            "codex: caught 1/1 planted, clean 0/1, false blocking on clean 1, errors 0"
        )
        expect(out).toContain(
            "claude: caught 0/1 planted, clean 0/0, false blocking on clean 0, errors 1"
        )
        expect(out).toContain("bug [claude] error: boom")
        expect(out).toContain(`major src/a.js:5 ${"x".repeat(160)}\n`)
        expect(out).toContain("dropped (not in the change) major README.md:5 m")
    })

    test("no not-passed section when everything passed", () => {
        const out = formatReport({
            cases: [cases[1]],
            providers: ["codex"],
            runs: [
                {
                    caseId: "ok",
                    provider: "codex",
                    spec: cases[1].spec,
                    result: { durationMs: 0, findings: [] },
                    score: { pass: true, blocking: 0 },
                },
            ],
            rulesSource: "none",
        })
        expect(out).not.toContain("Not passed")
    })
})

describe("main", () => {
    const setup = () => {
        write(
            "cases/bug/case.json",
            JSON.stringify({
                expect: "issues",
                findings: [{ files: ["a.js"], near: "BUG" }],
            })
        )
        write("cases/bug/base/a.js", "ok\n")
        write("cases/bug/change/a.js", "ok\nBUG\n")
        write("cases/fine/case.json", JSON.stringify({ expect: "clean" }))
        write("cases/fine/base/a.js", "ok\n")
        const configPath = write(
            "config.json",
            JSON.stringify({ authToken: "t" })
        )
        const coreDir = path.join(tmp, "core")
        write("core/review-rules.md", RULES_BYTES)
        write("core/codex-output.schema.json", SCHEMA_BYTES)
        return { configPath, coreDir }
    }

    const fakeTools = () => ({
        git: jest.fn(async () => ""),
        spawnTool: jest.fn(),
    })

    test("an empty cases folder is a usage error, not a pass", async () => {
        const configPath = write(
            "config.json",
            JSON.stringify({ authToken: "t" })
        )
        mkdirSync(path.join(tmp, "empty"))
        await expect(
            main(["--config", configPath, "--work", path.join(tmp, "w")], {
                log: () => {},
                casesDir: path.join(tmp, "empty"),
                tools: fakeTools(),
                reviewRepo: jest.fn(),
            })
        ).rejects.toThrow("no cases to run")
    })

    test("a case whose setup fails is an error result; the other cases still run", async () => {
        const { configPath, coreDir } = setup()
        const work = path.join(tmp, "work")
        const tools = fakeTools()
        tools.git = jest.fn(async (cwd) => {
            if (cwd.includes("bug--")) throw new Error("git init failed")
            return ""
        })
        const reviewRepoFake = jest.fn(async () => ({
            status: "GOOD_TO_GO",
            findings: [],
            reason: null,
            durationMs: 1,
        }))
        const code = await main(
            ["--config", configPath, "--work", work, "--providers", "codex"],
            {
                log: () => {},
                casesDir: path.join(tmp, "cases"),
                coreReviewDir: coreDir,
                tools,
                reviewRepo: reviewRepoFake,
            }
        )
        expect(code).toBe(1)
        expect(reviewRepoFake).toHaveBeenCalledTimes(1)
        const { runs } = JSON.parse(
            readFileSync(path.join(work, "results.json"), "utf8")
        )
        const bug = runs.find((r) => r.caseId === "bug")
        expect(bug.result.status).toBe("ESCALATE")
        expect(bug.result.reason).toBe(
            "case setup or payload failed: git init failed"
        )
        expect(bug.score.error).toContain("git init failed")
        expect(runs.find((r) => r.caseId === "fine").score.pass).toBe(true)
    })

    test("--help prints usage and runs nothing", async () => {
        const log = jest.fn()
        expect(await main(["--help"], { log })).toBe(0)
        expect(log).toHaveBeenCalledWith(USAGE)
    })

    test("reviews every case per provider, scores, writes results, cleans repos", async () => {
        const { configPath, coreDir } = setup()
        const work = path.join(tmp, "work")
        const lines = []
        const reviewRepoFake = jest.fn(async ({ repoDir, provider }) => ({
            status: "ISSUES",
            findings: repoDir.includes("bug--")
                ? [finding({ file: "a.js", line: 2 })]
                : [],
            reason: null,
            durationMs: provider === "codex" ? 1000 : 2000,
        }))
        const code = await main(
            [
                "--config",
                configPath,
                "--work",
                work,
                "--providers",
                "codex,claude",
            ],
            {
                log: (l) => lines.push(l),
                casesDir: path.join(tmp, "cases"),
                coreReviewDir: coreDir,
                tools: fakeTools(),
                reviewRepo: reviewRepoFake,
            }
        )
        expect(code).toBe(0)
        expect(reviewRepoFake).toHaveBeenCalledTimes(4)
        const call = reviewRepoFake.mock.calls[0][0]
        expect(call.rulesText).toContain("# Review rules")
        expect(call.config.blockingSeverities).toEqual(["blocker", "major"])
        const results = JSON.parse(
            readFileSync(path.join(work, "results.json"), "utf8")
        )
        expect(results.rules).toBe("bundled")
        expect(results.runs).toHaveLength(4)
        expect(existsSync(path.join(work, "repos"))).toBe(false)
        expect(lines.join("\n")).toContain("caught 1/1 planted")
    })

    test("a miss fails the run; --keep keeps the repos; --rules none", async () => {
        const { configPath, coreDir } = setup()
        const work = path.join(tmp, "work")
        const reviewRepoFake = jest.fn(async () => ({
            status: "GOOD_TO_GO",
            findings: [],
            reason: null,
            durationMs: 1,
        }))
        const code = await main(
            [
                "--config",
                configPath,
                "--work",
                work,
                "--providers",
                "codex",
                "--cases",
                "bug",
                "--rules",
                "none",
                "--keep",
            ],
            {
                log: () => {},
                casesDir: path.join(tmp, "cases"),
                coreReviewDir: coreDir,
                tools: fakeTools(),
                reviewRepo: reviewRepoFake,
            }
        )
        expect(code).toBe(1)
        expect(reviewRepoFake.mock.calls[0][0].rulesText).toBeNull()
        expect(existsSync(path.join(work, "repos", "bug--codex", "a.js"))).toBe(
            true
        )
    })
})
