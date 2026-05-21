/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { jest } from "@jest/globals"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import {
    runCodex,
    parseCodexOutput,
    buildCodexArgs,
    runAndParse,
    wrapPrompt,
    SYSTEM_PREAMBLE,
    __defaults__,
} from "./codex.js"

const validator = __defaults__.defaultValidator()

const baseConfig = () => ({
    codex: {
        binary: "codex",
        model: "gpt-5-codex",
        ignoreProjectRules: true,
        extraArgs: [],
    },
    limits: {
        codexTimeoutSeconds: 1,
    },
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

const collectStdin = (child) =>
    new Promise((resolve) => {
        const chunks = []
        child.stdin.on("data", (c) => chunks.push(c))
        child.stdin.on("end", () =>
            resolve(Buffer.concat(chunks).toString("utf8"))
        )
    })

describe("wrapPrompt", () => {
    test("always includes the REVIEW_SYSTEM preamble and REVIEW_INPUT markers", () => {
        const out = wrapPrompt({ payloadText: "DIFF" })
        expect(out).toContain("<<<REVIEW_SYSTEM>>>")
        expect(out).toContain(SYSTEM_PREAMBLE)
        expect(out).toContain("<<<END_REVIEW_SYSTEM>>>")
        expect(out).toMatch(/<<<REVIEW_INPUT>>>\nDIFF\n<<<END_REVIEW_INPUT>>>/)
    })

    test("omits PRIOR_FINDINGS section when none supplied", () => {
        // The preamble itself mentions the marker name; check for the end
        // tag which only appears when the section is emitted.
        const out = wrapPrompt({ payloadText: "x" })
        expect(out).not.toContain("<<<END_PRIOR_FINDINGS>>>")
    })

    test("includes PRIOR_FINDINGS as JSON when supplied", () => {
        const findings = [
            {
                file: "a.js",
                line: 1,
                severity: "blocker",
                category: "bug",
                message: "boom",
            },
        ]
        const out = wrapPrompt({ payloadText: "x", priorFindings: findings })
        expect(out).toContain("<<<PRIOR_FINDINGS>>>")
        expect(out).toContain('"file": "a.js"')
        expect(out).toContain("<<<END_PRIOR_FINDINGS>>>")
    })

    test("omits EXTRA_INSTRUCTIONS section when null/empty", () => {
        expect(wrapPrompt({ payloadText: "x" })).not.toContain(
            "<<<END_EXTRA_INSTRUCTIONS>>>"
        )
        expect(
            wrapPrompt({ payloadText: "x", extraInstructions: "" })
        ).not.toContain("<<<END_EXTRA_INSTRUCTIONS>>>")
    })

    test("includes EXTRA_INSTRUCTIONS verbatim when supplied", () => {
        const out = wrapPrompt({
            payloadText: "x",
            extraInstructions: "Pay extra attention to auth.",
        })
        expect(out).toContain("<<<EXTRA_INSTRUCTIONS>>>")
        expect(out).toContain("Pay extra attention to auth.")
        expect(out).toContain("<<<END_EXTRA_INSTRUCTIONS>>>")
    })

    test("section order is SYSTEM → INPUT → PRIOR_FINDINGS → EXTRA", () => {
        const out = wrapPrompt({
            payloadText: "x",
            priorFindings: [
                {
                    file: "a.js",
                    line: 1,
                    severity: "blocker",
                    category: "bug",
                    message: "y",
                },
            ],
            extraInstructions: "z",
        })
        const sys = out.indexOf("<<<REVIEW_SYSTEM>>>")
        const input = out.indexOf("<<<REVIEW_INPUT>>>")
        const prior = out.indexOf("<<<PRIOR_FINDINGS>>>")
        const extra = out.indexOf("<<<EXTRA_INSTRUCTIONS>>>")
        expect(sys).toBeLessThan(input)
        expect(input).toBeLessThan(prior)
        expect(prior).toBeLessThan(extra)
    })

    test("preamble explicitly labels REVIEW_INPUT and disk reads as UNTRUSTED DATA", () => {
        expect(SYSTEM_PREAMBLE).toMatch(/UNTRUSTED DATA/)
        expect(SYSTEM_PREAMBLE).toMatch(/REVIEW_INPUT/)
        expect(SYSTEM_PREAMBLE).toMatch(/disk/)
    })

    test("preamble flags PRIOR_FINDINGS and EXTRA_INSTRUCTIONS as trusted (not untrusted)", () => {
        // Both should be described in the trust model section but not as
        // "untrusted data" — they're server-generated / caller-supplied.
        expect(SYSTEM_PREAMBLE).toMatch(/PRIOR_FINDINGS/)
        expect(SYSTEM_PREAMBLE).toMatch(/EXTRA_INSTRUCTIONS/)
        expect(SYSTEM_PREAMBLE).toMatch(/trusted/i)
    })

    test("PRIOR_FINDINGS block carries a trusted verify-each directive", () => {
        const out = wrapPrompt({
            payloadText: "x",
            priorFindings: [
                {
                    file: "a.js",
                    line: 1,
                    severity: "blocker",
                    category: "bug",
                    message: "y",
                },
            ],
        })
        // The directive precedes the JSON array.
        expect(out).toMatch(/Trusted directive[\s\S]+blocker or major/)
        // And it appears between the begin/end markers.
        const start = out.indexOf("<<<PRIOR_FINDINGS>>>")
        const end = out.indexOf("<<<END_PRIOR_FINDINGS>>>")
        expect(out.slice(start, end)).toMatch(/Trusted directive/)
    })

    test("EXTRA_INSTRUCTIONS block carries a trusted-guidance directive", () => {
        const out = wrapPrompt({
            payloadText: "x",
            extraInstructions: "Check the auth flow.",
        })
        const start = out.indexOf("<<<EXTRA_INSTRUCTIONS>>>")
        const end = out.indexOf("<<<END_EXTRA_INSTRUCTIONS>>>")
        expect(out.slice(start, end)).toMatch(/Trusted directive/)
        expect(out.slice(start, end)).toMatch(/Check the auth flow\./)
    })
})

describe("buildCodexArgs", () => {
    test("constructs the documented argv shape", () => {
        const args = buildCodexArgs({
            repoRoot: "/repo",
            config: baseConfig(),
            schemaPath: "/sch.json",
        })
        expect(args).toEqual([
            "exec",
            "--cd",
            "/repo",
            "--ephemeral",
            "--sandbox",
            "read-only",
            "--model",
            "gpt-5-codex",
            "--output-schema",
            "/sch.json",
            "--ignore-rules",
            "-",
        ])
    })
    test("omits --ignore-rules when ignoreProjectRules is false", () => {
        const cfg = baseConfig()
        cfg.codex.ignoreProjectRules = false
        const args = buildCodexArgs({
            repoRoot: "/r",
            config: cfg,
            schemaPath: "/s",
        })
        expect(args).not.toContain("--ignore-rules")
    })
    test("includes extraArgs verbatim before the - stdin marker", () => {
        const cfg = baseConfig()
        cfg.codex.extraArgs = ["--foo", "bar"]
        const args = buildCodexArgs({
            repoRoot: "/r",
            config: cfg,
            schemaPath: "/s",
        })
        const idx = args.indexOf("--foo")
        expect(idx).toBeGreaterThan(0)
        expect(args[idx + 1]).toBe("bar")
        expect(args.at(-1)).toBe("-")
    })
})

describe("parseCodexOutput", () => {
    test("accepts a schema-valid GOOD_TO_GO object", () => {
        const out = parseCodexOutput(
            JSON.stringify({ status: "GOOD_TO_GO", findings: [] }),
            validator
        )
        expect(out.ok).toBe(true)
        expect(out.value.status).toBe("GOOD_TO_GO")
    })

    test("accepts a schema-valid ISSUES object", () => {
        const obj = {
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
        }
        const out = parseCodexOutput(JSON.stringify(obj), validator)
        expect(out.ok).toBe(true)
        expect(out.value.findings).toHaveLength(1)
    })

    test("rejects fenced JSON (contract is direct JSON only)", () => {
        const fenced =
            "preamble\n```json\n" +
            JSON.stringify({ status: "GOOD_TO_GO", findings: [] }) +
            "\n```\ntrailing"
        const out = parseCodexOutput(fenced, validator)
        expect(out.ok).toBe(false)
        expect(out.error.code).toBe("INVALID_JSON")
    })

    test("returns SCHEMA_INVALID when status is wrong", () => {
        const out = parseCodexOutput(
            JSON.stringify({ status: "WHATEVER", findings: [] }),
            validator
        )
        expect(out.ok).toBe(false)
        expect(out.error.code).toBe("SCHEMA_INVALID")
    })

    test("returns SCHEMA_INVALID when ISSUES has empty findings", () => {
        const out = parseCodexOutput(
            JSON.stringify({ status: "ISSUES", findings: [] }),
            validator
        )
        expect(out.ok).toBe(false)
        expect(out.error.code).toBe("SCHEMA_INVALID")
    })

    test("returns INVALID_JSON for non-JSON output", () => {
        const out = parseCodexOutput("this is just text", validator)
        expect(out.ok).toBe(false)
        expect(out.error.code).toBe("INVALID_JSON")
    })

    test("returns EMPTY_OUTPUT for empty string", () => {
        const out = parseCodexOutput("", validator)
        expect(out.ok).toBe(false)
        expect(out.error.code).toBe("EMPTY_OUTPUT")
    })

    test("schema rejects findings arrays larger than maxItems", () => {
        const findings = []
        for (let i = 0; i < 201; i++) {
            findings.push({
                file: "a.js",
                line: i + 1,
                severity: "blocker",
                category: "bug",
                message: "x",
            })
        }
        const out = parseCodexOutput(
            JSON.stringify({ status: "ISSUES", findings }),
            validator
        )
        expect(out.ok).toBe(false)
        expect(out.error.code).toBe("SCHEMA_INVALID")
    })

    test("schema rejects message strings longer than 2000 chars", () => {
        const out = parseCodexOutput(
            JSON.stringify({
                status: "ISSUES",
                findings: [
                    {
                        file: "a.js",
                        line: 1,
                        severity: "blocker",
                        category: "bug",
                        message: "x".repeat(2001),
                    },
                ],
            }),
            validator
        )
        expect(out.ok).toBe(false)
        expect(out.error.code).toBe("SCHEMA_INVALID")
    })

    test("schema rejects file paths longer than 1024 chars", () => {
        const out = parseCodexOutput(
            JSON.stringify({
                status: "ISSUES",
                findings: [
                    {
                        file: "a".repeat(1025),
                        line: 1,
                        severity: "blocker",
                        category: "bug",
                        message: "x",
                    },
                ],
            }),
            validator
        )
        expect(out.ok).toBe(false)
        expect(out.error.code).toBe("SCHEMA_INVALID")
    })
})

describe("runCodex (mocked spawn)", () => {
    test("forwards prompt on stdin and resolves with stdout/stderr", async () => {
        let receivedStdin = ""
        const spawn = fakeSpawn(async (child) => {
            receivedStdin = await collectStdin(child)
            child.stdout.write(
                JSON.stringify({ status: "GOOD_TO_GO", findings: [] })
            )
            child.stdout.end()
            child.stderr.end()
            child.emit("close", 0, null)
        })
        const out = await runCodex({
            repoRoot: "/r",
            prompt: "PROMPT-PAYLOAD",
            config: baseConfig(),
            spawn,
        })
        expect(receivedStdin).toBe("PROMPT-PAYLOAD")
        expect(out.exitCode).toBe(0)
        expect(out.rawStdout).toMatch(/GOOD_TO_GO/)
        expect(out.timedOut).toBe(false)
        expect(out.argv[0]).toBe("codex")
    })

    test("returns timedOut=true when child exceeds timeout", async () => {
        const spawn = fakeSpawn(() => {
            /* never close */
        })
        const cfg = baseConfig()
        cfg.limits.codexTimeoutSeconds = 0.05 // 50ms
        const promise = runCodex({
            repoRoot: "/r",
            prompt: "x",
            config: cfg,
            spawn,
        })
        // Give the timer a chance to fire, then simulate kill emitting close.
        setTimeout(() => {
            // The child mock won't auto-close on SIGTERM; simulate it.
            const child = spawn.mock.results[0].value
            child.stdout.end()
            child.stderr.end()
            child.emit("close", null, "SIGTERM")
        }, 80)
        const out = await promise
        expect(out.timedOut).toBe(true)
    })

    test("rejects when spawn throws synchronously", async () => {
        const spawn = jest.fn(() => {
            throw new Error("ENOENT")
        })
        await expect(
            runCodex({
                repoRoot: "/r",
                prompt: "x",
                config: baseConfig(),
                spawn,
            })
        ).rejects.toThrow("ENOENT")
    })

    test("kills child + reports oversize=true when stdout exceeds the byte cap", async () => {
        const cfg = baseConfig()
        cfg.limits.maxCodexOutputBytes = 100
        let killed = false
        const spawn = fakeSpawn((child) => {
            child.kill = () => {
                killed = true
                setImmediate(() => {
                    child.stdout.end()
                    child.stderr.end()
                    child.emit("close", null, "SIGTERM")
                })
            }
            // Push more than the cap.
            child.stdout.write("x".repeat(200))
        })
        const out = await runCodex({
            repoRoot: "/r",
            prompt: "p",
            config: cfg,
            spawn,
        })
        expect(out.oversize).toBe(true)
        expect(killed).toBe(true)
    })

    test("runAndParse maps oversize → ESCALATE with the byte cap in the reason", async () => {
        const cfg = baseConfig()
        cfg.limits.maxCodexOutputBytes = 100
        const spawn = fakeSpawn((child) => {
            child.kill = () => {
                setImmediate(() => {
                    child.stdout.end()
                    child.stderr.end()
                    child.emit("close", null, "SIGTERM")
                })
            }
            child.stdout.write("x".repeat(200))
        })
        const r = await runAndParse({
            repoRoot: "/r",
            prompt: "p",
            config: cfg,
            spawn,
        })
        expect(r.status).toBe("ESCALATE")
        expect(r.reason).toMatch(/exceeded 100 bytes/)
    })

    test("rejects when child emits error", async () => {
        const spawn = fakeSpawn((child) => {
            child.emit("error", new Error("nope"))
        })
        await expect(
            runCodex({
                repoRoot: "/r",
                prompt: "x",
                config: baseConfig(),
                spawn,
            })
        ).rejects.toThrow("nope")
    })
})

describe("runAndParse — timeout path", () => {
    test("returns ESCALATE when the child times out", async () => {
        const spawn = fakeSpawn((child) => {
            // Never close; the timeout kill simulates SIGTERM via re-emit.
            child.kill = () => {
                setImmediate(() => {
                    child.stdout.end()
                    child.stderr.end()
                    child.emit("close", null, "SIGTERM")
                })
            }
        })
        const cfg = baseConfig()
        cfg.limits.codexTimeoutSeconds = 0.05
        const r = await runAndParse({
            repoRoot: "/r",
            prompt: "x",
            config: cfg,
            spawn,
        })
        expect(r.status).toBe("ESCALATE")
        expect(r.reason).toMatch(/timed out/)
    })
})

describe("runAndParse (mocked spawn)", () => {
    test("returns GOOD_TO_GO when codex emits valid GOOD_TO_GO", async () => {
        const spawn = fakeSpawn(async (child) => {
            await collectStdin(child)
            child.stdout.write(
                JSON.stringify({ status: "GOOD_TO_GO", findings: [] })
            )
            child.stdout.end()
            child.stderr.end()
            child.emit("close", 0, null)
        })
        const r = await runAndParse({
            repoRoot: "/r",
            prompt: "x",
            config: baseConfig(),
            spawn,
        })
        expect(r.status).toBe("GOOD_TO_GO")
        expect(r.findings).toEqual([])
    })

    test("returns ISSUES when codex emits valid ISSUES", async () => {
        const out = {
            status: "ISSUES",
            findings: [
                {
                    file: "a.js",
                    line: 2,
                    severity: "major",
                    category: "perf",
                    message: "slow",
                },
            ],
        }
        const spawn = fakeSpawn(async (child) => {
            await collectStdin(child)
            child.stdout.write(JSON.stringify(out))
            child.stdout.end()
            child.stderr.end()
            child.emit("close", 0, null)
        })
        const r = await runAndParse({
            repoRoot: "/r",
            prompt: "x",
            config: baseConfig(),
            spawn,
        })
        expect(r.status).toBe("ISSUES")
        expect(r.findings).toHaveLength(1)
    })

    test("returns ESCALATE when codex exits non-zero", async () => {
        const spawn = fakeSpawn(async (child) => {
            await collectStdin(child)
            child.stderr.write("kaboom")
            child.stdout.end()
            child.stderr.end()
            child.emit("close", 1, null)
        })
        const r = await runAndParse({
            repoRoot: "/r",
            prompt: "x",
            config: baseConfig(),
            spawn,
        })
        expect(r.status).toBe("ESCALATE")
        expect(r.reason).toMatch(/exited with code 1/)
    })

    test("returns ESCALATE when codex output fails schema", async () => {
        const spawn = fakeSpawn(async (child) => {
            await collectStdin(child)
            child.stdout.write(JSON.stringify({ nope: true }))
            child.stdout.end()
            child.stderr.end()
            child.emit("close", 0, null)
        })
        const r = await runAndParse({
            repoRoot: "/r",
            prompt: "x",
            config: baseConfig(),
            spawn,
        })
        expect(r.status).toBe("ESCALATE")
        expect(r.schemaError.code).toBe("SCHEMA_INVALID")
    })
})
