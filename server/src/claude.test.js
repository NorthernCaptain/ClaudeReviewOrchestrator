/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { jest } from "@jest/globals"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import {
    buildClaudeArgs,
    parseClaudeOutput,
    runAndParse,
    __defaults__,
} from "./claude.js"

const validator = __defaults__.defaultValidator()

const baseConfig = (over = {}) => ({
    reviewer: {
        provider: "claude",
        claude: {
            binary: "claude",
            model: "claude-opus-4-7",
            effort: "high",
            permissionMode: "bypassPermissions",
            disallowedTools: ["Bash", "Edit", "Write"],
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

describe("buildClaudeArgs", () => {
    test("produces the documented argv shape with key flags", () => {
        const args = buildClaudeArgs({
            repoRoot: "/repo",
            config: baseConfig(),
            sessionId: "FIXED-UUID",
        })
        expect(args).toContain("-p")
        // --bare is deliberately NOT included; see claude.js for the
        // reason (it disables OAuth/keychain auth).
        expect(args).not.toContain("--bare")
        expect(args).toContain("--no-session-persistence")
        // --session-id is followed by the UUID we passed.
        const sidIdx = args.indexOf("--session-id")
        expect(args[sidIdx + 1]).toBe("FIXED-UUID")
        // --model + --effort
        expect(args[args.indexOf("--model") + 1]).toBe("claude-opus-4-7")
        expect(args[args.indexOf("--effort") + 1]).toBe("high")
        // Sandboxing
        expect(args[args.indexOf("--permission-mode") + 1]).toBe(
            "bypassPermissions"
        )
        // Repo root made readable via --add-dir.
        expect(args[args.indexOf("--add-dir") + 1]).toBe("/repo")
        // Output format JSON + schema inlined.
        expect(args[args.indexOf("--output-format") + 1]).toBe("json")
        const schemaIdx = args.indexOf("--json-schema")
        expect(schemaIdx).toBeGreaterThan(0)
        // The inlined schema is a JSON document — at minimum, parses.
        expect(() => JSON.parse(args[schemaIdx + 1])).not.toThrow()
        // The disallowed tools are joined with commas.
        expect(args[args.indexOf("--disallowed-tools") + 1]).toBe(
            "Bash,Edit,Write"
        )
    })

    test("omits --disallowed-tools when the list is empty", () => {
        const cfg = baseConfig({ disallowedTools: [] })
        const args = buildClaudeArgs({
            repoRoot: "/r",
            config: cfg,
            sessionId: "u",
        })
        expect(args).not.toContain("--disallowed-tools")
    })

    test("appends extraArgs verbatim", () => {
        const cfg = baseConfig({ extraArgs: ["--verbose"] })
        const args = buildClaudeArgs({
            repoRoot: "/r",
            config: cfg,
            sessionId: "u",
        })
        expect(args).toContain("--verbose")
    })

    test("appends the reviewer hardening directive to the system prompt", () => {
        const args = buildClaudeArgs({
            repoRoot: "/r",
            config: baseConfig(),
            sessionId: "u",
        })
        const idx = args.indexOf("--append-system-prompt")
        expect(idx).toBeGreaterThan(0)
        expect(args[idx + 1]).toMatch(/EXACTLY ONE JSON object/)
    })
})

// Real-world envelope captured from `claude --version 2.1.148` on
// 2026-05-22 when the orchestrator reviewed a sandbox repo containing a
// genuine bug. Trimmed for fixture size; the shape is verbatim. If a
// future Claude release changes this contract, this test will break
// and force a deliberate update to parseClaudeOutput.
const CLAUDE_ENVELOPE_FIXTURE = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    api_error_status: null,
    duration_ms: 5691,
    duration_api_ms: 3481,
    ttft_ms: 4504,
    num_turns: 1,
    result: JSON.stringify({
        status: "ISSUES",
        findings: [
            {
                file: "add.js",
                line: 1,
                severity: "blocker",
                category: "bug",
                message: "The add function returns a - b instead of a + b.",
                suggestion: "Restore the addition operator.",
            },
        ],
    }),
    stop_reason: "end_turn",
    session_id: "dd290e04-c646-4150-9ca6-8fdd746553f7",
    total_cost_usd: 0.11270875,
    usage: {
        input_tokens: 5,
        output_tokens: 148,
        cache_read_input_tokens: 10555,
        cache_creation_input_tokens: 16593,
    },
    permission_denials: [],
    terminal_reason: "completed",
})

describe("parseClaudeOutput", () => {
    const wrap = (result, extra = {}) =>
        JSON.stringify({
            type: "result",
            subtype: "success",
            result:
                typeof result === "string" ? result : JSON.stringify(result),
            is_error: false,
            ...extra,
        })

    test("[fixture] real-world Claude --output-format json envelope parses cleanly", () => {
        // This test pins the contract — if Claude's CLI envelope ever
        // changes shape, this fails first, before the failure
        // propagates to every review the orchestrator runs.
        const out = parseClaudeOutput(CLAUDE_ENVELOPE_FIXTURE, validator)
        expect(out.ok).toBe(true)
        expect(out.value.status).toBe("ISSUES")
        expect(out.value.findings).toHaveLength(1)
        expect(out.value.findings[0].file).toBe("add.js")
        expect(out.value.findings[0].severity).toBe("blocker")
        expect(out.value.findings[0].category).toBe("bug")
    })

    test("happy path: unwraps envelope, parses inner JSON, validates", () => {
        const out = parseClaudeOutput(
            wrap({ status: "GOOD_TO_GO", findings: [] }),
            validator
        )
        expect(out.ok).toBe(true)
        expect(out.value.status).toBe("GOOD_TO_GO")
    })

    test("returns EMPTY_OUTPUT on empty stdout", () => {
        const out = parseClaudeOutput("", validator)
        expect(out.ok).toBe(false)
        expect(out.error.code).toBe("EMPTY_OUTPUT")
    })

    test("returns INVALID_JSON when envelope is not JSON", () => {
        const out = parseClaudeOutput("not json", validator)
        expect(out.ok).toBe(false)
        expect(out.error.code).toBe("INVALID_JSON")
    })

    test("returns CLAUDE_ERROR_ENVELOPE on is_error=true", () => {
        const env = JSON.stringify({
            type: "result",
            subtype: "error_during_execution",
            result: "auth failed",
            is_error: true,
        })
        const out = parseClaudeOutput(env, validator)
        expect(out.ok).toBe(false)
        expect(out.error.code).toBe("CLAUDE_ERROR_ENVELOPE")
        expect(out.error.message).toMatch(/auth failed/)
    })

    test("returns EMPTY_RESULT when result is not a non-empty string", () => {
        const env = JSON.stringify({
            type: "result",
            subtype: "success",
            result: "",
            is_error: false,
        })
        const out = parseClaudeOutput(env, validator)
        expect(out.ok).toBe(false)
        expect(out.error.code).toBe("EMPTY_RESULT")
    })

    test("returns INVALID_JSON when inner result is not JSON", () => {
        const out = parseClaudeOutput(wrap("here you go: not-json"), validator)
        expect(out.ok).toBe(false)
        expect(out.error.code).toBe("INVALID_JSON")
    })

    test("returns SCHEMA_INVALID when inner JSON doesn't satisfy schema", () => {
        const out = parseClaudeOutput(
            wrap({ status: "WAT", findings: 7 }),
            validator
        )
        expect(out.ok).toBe(false)
        expect(out.error.code).toBe("SCHEMA_INVALID")
        expect(Array.isArray(out.error.details)).toBe(true)
    })

    test("salvages JSON when Claude prepends a conversational lead-in", () => {
        // This is the exact failure pattern we observed in production:
        // Claude added "Looking through the diff..." before the JSON.
        const envelope = JSON.stringify({
            type: "result",
            subtype: "success",
            is_error: false,
            result:
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
        const out = parseClaudeOutput(envelope, validator)
        expect(out.ok).toBe(true)
        expect(out.value.status).toBe("ISSUES")
        expect(out.value.findings).toHaveLength(1)
        // Salvage flag is set so the pipeline can audit-log it.
        expect(out.salvaged).toBe(true)
    })

    test("salvage path does NOT trigger when the strict parse succeeds", () => {
        const envelope = JSON.stringify({
            type: "result",
            subtype: "success",
            is_error: false,
            result: JSON.stringify({ status: "GOOD_TO_GO", findings: [] }),
        })
        const out = parseClaudeOutput(envelope, validator)
        expect(out.ok).toBe(true)
        expect(out.salvaged).toBe(false)
    })

    test("salvage returns INVALID_JSON when there's no balanced object at all", () => {
        const envelope = JSON.stringify({
            type: "result",
            subtype: "success",
            is_error: false,
            result: "just prose, no JSON here",
        })
        const out = parseClaudeOutput(envelope, validator)
        expect(out.ok).toBe(false)
        expect(out.error.code).toBe("INVALID_JSON")
    })

    test("salvage ignores braces inside string literals", () => {
        // The string literal "} not a closer" must NOT terminate the
        // brace tracker — otherwise we'd extract a truncated object.
        const envelope = JSON.stringify({
            type: "result",
            subtype: "success",
            is_error: false,
            result:
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
        const out = parseClaudeOutput(envelope, validator)
        expect(out.ok).toBe(true)
        expect(out.value.findings[0].message).toBe("saw a } in a string")
    })

    test("directive includes the strict 'first character must be {' wording", () => {
        expect(__defaults__.REVIEWER_DIRECTIVE).toMatch(
            /FIRST output character MUST be `\{`/
        )
    })

    test("normalizes unknown finding.category to 'other' before validation", () => {
        // Claude sometimes uses creative category names like "correctness"
        // that aren't in our schema enum. We coerce those to "other"
        // rather than rejecting an otherwise-valid review.
        const finding = {
            file: "a.js",
            line: 1,
            severity: "blocker",
            category: "correctness",
            message: "wrong",
        }
        const out = parseClaudeOutput(
            wrap({ status: "ISSUES", findings: [finding] }),
            validator
        )
        expect(out.ok).toBe(true)
        expect(out.value.findings[0].category).toBe("other")
    })

    test("coerces a server-side public status to the schema-valid pair (defense in depth)", () => {
        const f = {
            file: "a.js",
            line: 1,
            severity: "minor",
            category: "bug",
            message: "x",
        }
        // Schema requires findings >= 1 when status === ISSUES, 0 when
        // GOOD_TO_GO — so fixtures match the EXPECTED side.
        const cases = [
            ["GOOD_TO_GO_WITH_NOTES", "ISSUES", [f]],
            ["NO_PROGRESS_WITH_OPEN_ISSUES", "ISSUES", [f]],
            ["NO_CHANGES", "GOOD_TO_GO", []],
            ["ESCALATE", "ISSUES", [f]],
        ]
        for (const [input, expected, findings] of cases) {
            const out = parseClaudeOutput(
                wrap({ status: input, findings }),
                validator
            )
            expect(out.ok).toBe(true)
            expect(out.value.status).toBe(expected)
        }
    })
})

describe("runAndParse", () => {
    test("maps a clean GOOD_TO_GO envelope to {status, findings, raw}", async () => {
        const result = await runAndParse({
            repoRoot: "/r",
            prompt: "ignored",
            config: baseConfig(),
            spawn: fakeSpawn((child) => {
                child.stdout.write(
                    JSON.stringify({
                        type: "result",
                        subtype: "success",
                        result: JSON.stringify({
                            status: "GOOD_TO_GO",
                            findings: [],
                        }),
                        is_error: false,
                    })
                )
                child.stdout.end()
                child.stderr.end()
                child.emit("close", 0, null)
            }),
        })
        expect(result.status).toBe("GOOD_TO_GO")
        expect(result.findings).toEqual([])
        expect(result.raw.exitCode).toBe(0)
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
                // Way more than the cap on STDERR (tool chatter).
                child.stderr.write("E".repeat(200000))
                child.stdout.write(
                    JSON.stringify({
                        type: "result",
                        subtype: "success",
                        result: JSON.stringify({
                            status: "GOOD_TO_GO",
                            findings: [],
                        }),
                        is_error: false,
                    })
                )
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

    test("non-zero exit with VALID envelope is treated as success — Claude often soft-fails the process while returning a good review", async () => {
        const result = await runAndParse({
            repoRoot: "/r",
            prompt: "ignored",
            config: baseConfig(),
            spawn: fakeSpawn((child) => {
                child.stdout.write(
                    JSON.stringify({
                        type: "result",
                        subtype: "success",
                        result: JSON.stringify({
                            status: "GOOD_TO_GO",
                            findings: [],
                        }),
                        is_error: false,
                    })
                )
                child.stdout.end()
                child.stderr.end()
                child.emit("close", 1, null) // soft-fail exit
            }),
        })
        expect(result.status).toBe("GOOD_TO_GO")
        expect(result.findings).toEqual([])
    })

    test("ESCALATE when stdout is not a Claude envelope", async () => {
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

    test("ESCALATE when envelope is_error true", async () => {
        const result = await runAndParse({
            repoRoot: "/r",
            prompt: "ignored",
            config: baseConfig(),
            spawn: fakeSpawn((child) => {
                child.stdout.write(
                    JSON.stringify({
                        type: "result",
                        subtype: "error_max_turns",
                        result: "too many turns",
                        is_error: true,
                    })
                )
                child.stdout.end()
                child.stderr.end()
                child.emit("close", 0, null)
            }),
        })
        expect(result.status).toBe("ESCALATE")
        expect(result.reason).toMatch(/CLAUDE_ERROR_ENVELOPE/)
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

    test("timeout kills the child and ESCALATES", async () => {
        // Tight timeout so the test finishes quickly. The child never
        // emits close on its own — the runner's setTimeout fires.
        const cfg = {
            ...baseConfig({ timeoutSeconds: 0.05 }),
            limits: { codexTimeoutSeconds: 60, maxCodexOutputBytes: 65536 },
        }
        cfg.reviewer.claude.timeoutSeconds = 0.05
        const result = await runAndParse({
            repoRoot: "/r",
            prompt: "ignored",
            config: cfg,
            spawn: fakeSpawn((child) => {
                // Hold the streams open; emit close only when killed.
                child.kill = jest.fn(() => {
                    process.nextTick(() => child.emit("close", null, "SIGTERM"))
                })
            }),
        })
        expect(result.status).toBe("ESCALATE")
        expect(result.reason).toMatch(/timed out/)
    })
})
