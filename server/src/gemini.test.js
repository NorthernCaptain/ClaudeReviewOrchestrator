/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { jest } from "@jest/globals"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import {
    buildGeminiArgs,
    parseGeminiOutput,
    runAndParse,
    __defaults__,
} from "./gemini.js"

const validator = __defaults__.defaultValidator()

const baseConfig = (over = {}) => ({
    reviewer: {
        provider: "gemini",
        gemini: {
            binary: "gemini",
            model: "gemini-2.5-pro",
            approvalMode: "plan",
            timeoutSeconds: 30,
            extraArgs: [],
            ...over,
        },
    },
    limits: { codexTimeoutSeconds: 60, maxCodexOutputBytes: 65536 },
})

const makeFakeChild = () => {
    const child = new EventEmitter()
    child.stdin = new PassThrough()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = jest.fn()
    return child
}

const fakeSpawn = (behavior) =>
    jest.fn(() => {
        const child = makeFakeChild()
        process.nextTick(() => behavior(child))
        return child
    })

// Envelope shape captured from gemini-cli 0.43.0's JsonFormatter:
//   { session_id, response, stats, error?, warnings? }
const wrap = (response, extra = {}) =>
    JSON.stringify({
        session_id: "fixed-session",
        response:
            typeof response === "string" ? response : JSON.stringify(response),
        stats: {},
        ...extra,
    })

describe("buildGeminiArgs", () => {
    test("produces the documented argv shape with key flags", () => {
        const args = buildGeminiArgs({
            config: baseConfig(),
            sessionId: "FIXED-UUID",
        })
        // -p carries the reviewer directive; the bulk of the prompt
        // goes over stdin. Verify the directive is there.
        const pIdx = args.indexOf("-p")
        expect(pIdx).toBeGreaterThanOrEqual(0)
        expect(args[pIdx + 1]).toMatch(/EXACTLY ONE JSON object/)
        // Model.
        expect(args[args.indexOf("-m") + 1]).toBe("gemini-2.5-pro")
        // Read-only sandbox.
        expect(args[args.indexOf("--approval-mode") + 1]).toBe("plan")
        // Workspace-trust prompt suppression — required for headless runs.
        expect(args).toContain("--skip-trust")
        // JSON envelope.
        expect(args[args.indexOf("-o") + 1]).toBe("json")
        // Session id passed through verbatim.
        expect(args[args.indexOf("--session-id") + 1]).toBe("FIXED-UUID")
    })

    test("respects an overridden model and approval mode", () => {
        const args = buildGeminiArgs({
            config: baseConfig({
                model: "gemini-3-flash",
                approvalMode: "yolo",
            }),
            sessionId: "u",
        })
        expect(args[args.indexOf("-m") + 1]).toBe("gemini-3-flash")
        expect(args[args.indexOf("--approval-mode") + 1]).toBe("yolo")
    })

    test("appends extraArgs verbatim", () => {
        const args = buildGeminiArgs({
            config: baseConfig({ extraArgs: ["--debug"] }),
            sessionId: "u",
        })
        expect(args).toContain("--debug")
    })

    test("directive includes the strict 'first character must be {' wording", () => {
        expect(__defaults__.REVIEWER_DIRECTIVE).toMatch(
            /FIRST output character MUST be `\{`/
        )
    })
})

describe("parseGeminiOutput", () => {
    test("happy path: unwraps envelope, parses response, validates", () => {
        const out = parseGeminiOutput(
            wrap({ status: "GOOD_TO_GO", findings: [] }),
            validator
        )
        expect(out.ok).toBe(true)
        expect(out.value.status).toBe("GOOD_TO_GO")
    })

    test("returns EMPTY_OUTPUT on empty stdout", () => {
        const out = parseGeminiOutput("", validator)
        expect(out.ok).toBe(false)
        expect(out.error.code).toBe("EMPTY_OUTPUT")
    })

    test("returns INVALID_JSON when envelope is not JSON", () => {
        const out = parseGeminiOutput("not json", validator)
        expect(out.ok).toBe(false)
        expect(out.error.code).toBe("INVALID_JSON")
    })

    test("returns GEMINI_ERROR_ENVELOPE when envelope has error", () => {
        // Real shape captured from a failing run (invalid API key):
        //   { session_id, error: { type, message, code } }
        const env = JSON.stringify({
            session_id: "abc",
            error: {
                type: "Error",
                message: "API key not valid",
                code: 400,
            },
        })
        const out = parseGeminiOutput(env, validator)
        expect(out.ok).toBe(false)
        expect(out.error.code).toBe("GEMINI_ERROR_ENVELOPE")
        expect(out.error.message).toMatch(/API key not valid/)
    })

    test("returns EMPTY_RESULT when response is missing or empty", () => {
        const env = JSON.stringify({ session_id: "abc", response: "" })
        const out = parseGeminiOutput(env, validator)
        expect(out.ok).toBe(false)
        expect(out.error.code).toBe("EMPTY_RESULT")
    })

    test("returns INVALID_JSON when inner response is not JSON", () => {
        const out = parseGeminiOutput(wrap("here you go: not-json"), validator)
        expect(out.ok).toBe(false)
        expect(out.error.code).toBe("INVALID_JSON")
    })

    test("returns GEMINI_LOOP_TRUNCATED when warnings has 'Loop detected' and inner JSON is truncated (v1.1.9)", () => {
        // Reproduces the real failure: outer envelope parses, but
        // `response` is cut off mid-string AND warnings says the loop
        // detector fired. We must surface the loop reason instead of
        // the generic INVALID_JSON so the operator can tell at a
        // glance why ESCALATE happened.
        const envelope = wrap(
            '{"status":"ISSUES","findings":[{"file":"a.js","line":1,"severity":"blocker"',
            { warnings: ["Loop detected, stopping execution"] }
        )
        const out = parseGeminiOutput(envelope, validator)
        expect(out.ok).toBe(false)
        expect(out.error.code).toBe("GEMINI_LOOP_TRUNCATED")
        expect(out.error.message).toMatch(/loop detector/i)
        expect(out.error.message).toContain("Loop detected, stopping execution")
    })

    test("GEMINI_LOOP_TRUNCATED also fires when response is missing entirely + loop warning present", () => {
        const envelope = JSON.stringify({
            session_id: "x",
            response: "",
            stats: {},
            warnings: ["Loop detected, stopping execution"],
        })
        const out = parseGeminiOutput(envelope, validator)
        expect(out.ok).toBe(false)
        expect(out.error.code).toBe("GEMINI_LOOP_TRUNCATED")
    })

    test("matches the loop warning case-insensitively", () => {
        const envelope = wrap("not json at all", {
            warnings: ["LOOP DETECTED in agent execution"],
        })
        const out = parseGeminiOutput(envelope, validator)
        expect(out.error.code).toBe("GEMINI_LOOP_TRUNCATED")
    })

    test("GEMINI_LOOP_TRUNCATED beats the salvage path when a complete object precedes the truncation", () => {
        // Codex round 1 catch: a looped response can be `{...}{...`
        // where the FIRST object is a complete, parseable verdict.
        // extractFirstJsonObject would happily return it and we would
        // emit GOOD_TO_GO/ISSUES against a verdict the model never
        // finished. The loop warning must short-circuit salvage so the
        // ESCALATE surfaces the real failure mode.
        const looped =
            '{"status":"ISSUES","findings":[{"file":"a.js","line":1,' +
            '"severity":"blocker","category":"bug","message":"x","suggestion":"y"}]}' +
            '{"status":"ISSUES","findings":[{"file":"a.js","line":1,'
        const envelope = wrap(looped, {
            warnings: ["Loop detected, stopping execution"],
        })
        const out = parseGeminiOutput(envelope, validator)
        expect(out.ok).toBe(false)
        expect(out.error.code).toBe("GEMINI_LOOP_TRUNCATED")
    })

    test("falls back to INVALID_JSON when warnings don't mention a loop", () => {
        const envelope = wrap("not json", {
            warnings: ["Ripgrep is not available."],
        })
        const out = parseGeminiOutput(envelope, validator)
        expect(out.error.code).toBe("INVALID_JSON")
    })

    test("returns SCHEMA_INVALID when inner JSON doesn't satisfy schema", () => {
        const out = parseGeminiOutput(
            wrap({ status: "WAT", findings: 7 }),
            validator
        )
        expect(out.ok).toBe(false)
        expect(out.error.code).toBe("SCHEMA_INVALID")
        expect(Array.isArray(out.error.details)).toBe(true)
    })

    test("salvages JSON when the model prepends a conversational lead-in", () => {
        const envelope = JSON.stringify({
            session_id: "abc",
            response:
                "Looking through the diff for issues.\n\n" +
                JSON.stringify({
                    status: "ISSUES",
                    findings: [
                        {
                            file: "a.js",
                            line: 1,
                            severity: "minor",
                            category: "bug",
                            message: "x",
                        },
                    ],
                }),
        })
        const out = parseGeminiOutput(envelope, validator)
        expect(out.ok).toBe(true)
        expect(out.value.findings).toHaveLength(1)
        expect(out.salvaged).toBe(true)
    })

    test("salvage path does NOT trigger when the strict parse succeeds", () => {
        const out = parseGeminiOutput(
            wrap({ status: "GOOD_TO_GO", findings: [] }),
            validator
        )
        expect(out.ok).toBe(true)
        expect(out.salvaged).toBe(false)
    })

    test("salvage returns INVALID_JSON when there's no balanced object at all", () => {
        const out = parseGeminiOutput(
            wrap("just prose, no JSON here"),
            validator
        )
        expect(out.ok).toBe(false)
        expect(out.error.code).toBe("INVALID_JSON")
    })

    test("salvage ignores braces inside string literals", () => {
        const envelope = JSON.stringify({
            session_id: "abc",
            response:
                "lead-in\n" +
                JSON.stringify({
                    status: "ISSUES",
                    findings: [
                        {
                            file: "a.js",
                            line: 1,
                            severity: "blocker",
                            category: "bug",
                            message: "saw a } in a string",
                        },
                    ],
                }),
        })
        const out = parseGeminiOutput(envelope, validator)
        expect(out.ok).toBe(true)
        expect(out.value.findings[0].message).toBe("saw a } in a string")
    })

    test("normalizes unknown finding.category to 'other' before validation", () => {
        const finding = {
            file: "a.js",
            line: 1,
            severity: "blocker",
            category: "correctness",
            message: "wrong",
        }
        const out = parseGeminiOutput(
            wrap({ status: "ISSUES", findings: [finding] }),
            validator
        )
        expect(out.ok).toBe(true)
        expect(out.value.findings[0].category).toBe("other")
    })

    test("coerces a server-side public status to the schema-valid pair", () => {
        // The schema only allows GOOD_TO_GO/ISSUES. The model occasionally
        // emits a derived status like GOOD_TO_GO_WITH_NOTES (we even
        // wrongly listed it in an earlier directive). Coerce, then
        // validate — the server's derivePublicStatus re-derives the
        // public name afterwards.
        const f = {
            file: "a.js",
            line: 1,
            severity: "minor",
            category: "bug",
            message: "x",
        }
        // Schema requires findings >= 1 when status is ISSUES and 0
        // when status is GOOD_TO_GO; fixtures match the EXPECTED side.
        const cases = [
            ["GOOD_TO_GO_WITH_NOTES", "ISSUES", [f]],
            ["NO_PROGRESS_WITH_OPEN_ISSUES", "ISSUES", [f]],
            ["NO_CHANGES", "GOOD_TO_GO", []],
            ["ESCALATE", "ISSUES", [f]],
        ]
        for (const [input, expected, findings] of cases) {
            const out = parseGeminiOutput(
                wrap({ status: input, findings }),
                validator
            )
            expect(out.ok).toBe(true)
            expect(out.value.status).toBe(expected)
        }
    })

    test("directive lists only GOOD_TO_GO and ISSUES as valid status values", () => {
        // Pin the directive contract — historically we listed 4 statuses
        // and gemini followed our (wrong) directive, blowing up at
        // ajv. This test guards against that regression.
        const directive = __defaults__.REVIEWER_DIRECTIVE
        expect(directive).toMatch(/EXACTLY one of `?GOOD_TO_GO`? or `?ISSUES`?/)
        expect(directive).toMatch(/MUST NOT emit/)
        expect(directive).toMatch(/GOOD_TO_GO_WITH_NOTES/)
    })
})

describe("runAndParse", () => {
    test("maps a clean GOOD_TO_GO envelope to {status, findings, raw}", async () => {
        const result = await runAndParse({
            repoRoot: "/r",
            prompt: "ignored",
            config: baseConfig(),
            spawn: fakeSpawn((child) => {
                child.stdout.write(wrap({ status: "GOOD_TO_GO", findings: [] }))
                child.stdout.end()
                child.stderr.end()
                child.emit("close", 0, null)
            }),
        })
        expect(result.status).toBe("GOOD_TO_GO")
        expect(result.findings).toEqual([])
        expect(result.raw.exitCode).toBe(0)
    })

    test("non-zero exit with unparseable stdout maps to ESCALATE with the exit code", async () => {
        const result = await runAndParse({
            repoRoot: "/r",
            prompt: "ignored",
            config: baseConfig(),
            spawn: fakeSpawn((child) => {
                child.stderr.write("network unreachable\n")
                child.stdout.end()
                child.stderr.end()
                child.emit("close", 17, null)
            }),
        })
        expect(result.status).toBe("ESCALATE")
        expect(result.reason).toMatch(/exited with code 17/)
    })

    test("non-zero exit with VALID envelope is treated as success", async () => {
        const result = await runAndParse({
            repoRoot: "/r",
            prompt: "ignored",
            config: baseConfig(),
            spawn: fakeSpawn((child) => {
                child.stdout.write(wrap({ status: "GOOD_TO_GO", findings: [] }))
                child.stdout.end()
                child.stderr.end()
                child.emit("close", 1, null) // soft-fail exit
            }),
        })
        expect(result.status).toBe("GOOD_TO_GO")
    })

    test("ESCALATE when stdout is not a gemini envelope", async () => {
        const result = await runAndParse({
            repoRoot: "/r",
            prompt: "ignored",
            config: baseConfig(),
            spawn: fakeSpawn((child) => {
                child.stdout.write("hello world")
                child.stdout.end()
                child.stderr.end()
                child.emit("close", 0, null)
            }),
        })
        expect(result.status).toBe("ESCALATE")
        expect(result.reason).toMatch(/INVALID_JSON/)
        expect(result.schemaError?.code).toBe("INVALID_JSON")
    })

    test("ESCALATE when envelope has error", async () => {
        const result = await runAndParse({
            repoRoot: "/r",
            prompt: "ignored",
            config: baseConfig(),
            spawn: fakeSpawn((child) => {
                child.stdout.write(
                    JSON.stringify({
                        session_id: "abc",
                        error: {
                            type: "Error",
                            message: "model unavailable",
                            code: 503,
                        },
                    })
                )
                child.stdout.end()
                child.stderr.end()
                child.emit("close", 0, null)
            }),
        })
        expect(result.status).toBe("ESCALATE")
        expect(result.reason).toMatch(/GEMINI_ERROR_ENVELOPE/)
    })

    test("oversize stdout kills the child and ESCALATES", async () => {
        const cfg = {
            ...baseConfig(),
            limits: { codexTimeoutSeconds: 60, maxCodexOutputBytes: 64 },
        }
        const result = await runAndParse({
            repoRoot: "/r",
            prompt: "ignored",
            config: cfg,
            spawn: fakeSpawn((child) => {
                child.stdout.write("x".repeat(200))
                child.stdout.end()
                child.stderr.end()
                child.emit("close", null, "SIGTERM")
            }),
        })
        expect(result.status).toBe("ESCALATE")
        expect(result.reason).toMatch(/exceeded/i)
    })

    test("verbose stderr does not trigger oversize; succeeds with a valid envelope", async () => {
        const cfg = {
            ...baseConfig(),
            // Cap comfortably fits the tiny envelope but is ≪ the 200 KB
            // of stderr chatter below — proving stderr is not counted.
            limits: { codexTimeoutSeconds: 60, maxCodexOutputBytes: 4096 },
        }
        const result = await runAndParse({
            repoRoot: "/r",
            prompt: "ignored",
            config: cfg,
            spawn: fakeSpawn((child) => {
                child.stderr.write("E".repeat(200000)) // tool chatter ≫ cap
                child.stdout.write(wrap({ status: "GOOD_TO_GO", findings: [] }))
                setImmediate(() => {
                    child.stdout.end()
                    child.stderr.end()
                    child.emit("close", 0, null)
                })
            }),
        })
        expect(result.status).toBe("GOOD_TO_GO")
        expect(result.raw.oversize).toBe(false)
        expect(result.raw.rawStderr.length).toBeLessThanOrEqual(64 * 1024)
    })

    test("timeout kills the child and ESCALATES", async () => {
        const cfg = {
            ...baseConfig({ timeoutSeconds: 0.05 }),
            limits: { codexTimeoutSeconds: 60, maxCodexOutputBytes: 65536 },
        }
        cfg.reviewer.gemini.timeoutSeconds = 0.05
        const result = await runAndParse({
            repoRoot: "/r",
            prompt: "ignored",
            config: cfg,
            spawn: fakeSpawn((child) => {
                child.kill = jest.fn(() => {
                    process.nextTick(() => child.emit("close", null, "SIGTERM"))
                })
            }),
        })
        expect(result.status).toBe("ESCALATE")
        expect(result.reason).toMatch(/timed out/)
    })
})
