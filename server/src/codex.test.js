/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { jest } from "@jest/globals"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { readFileSync } from "node:fs"
import {
    runCodex,
    parseCodexOutput,
    buildCodexArgs,
    runAndParse,
    wrapPrompt,
    SYSTEM_PREAMBLE,
    normalizeFindings,
    toStrictSchema,
    __defaults__,
} from "./codex.js"

const validator = __defaults__.defaultValidator()

const baseConfig = () => ({
    codex: {
        binary: "codex",
        model: "gpt-5-codex",
        reasoningEffort: "high",
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
            "-c",
            "model_reasoning_effort=high",
            "--ignore-rules",
            "-",
        ])
    })
    test("passes the configured reasoning effort verbatim through -c", () => {
        const cfg = baseConfig()
        cfg.codex.reasoningEffort = "medium"
        const args = buildCodexArgs({
            repoRoot: "/r",
            config: cfg,
            schemaPath: "/s",
        })
        const idx = args.indexOf("-c")
        expect(idx).toBeGreaterThan(0)
        expect(args[idx + 1]).toBe("model_reasoning_effort=medium")
    })
    test("skips the -c flag when reasoningEffort is missing or unknown", () => {
        const cfg = baseConfig()
        delete cfg.codex.reasoningEffort
        const a1 = buildCodexArgs({
            repoRoot: "/r",
            config: cfg,
            schemaPath: "/s",
        })
        expect(a1).not.toContain("-c")

        cfg.codex.reasoningEffort = "WAT"
        const a2 = buildCodexArgs({
            repoRoot: "/r",
            config: cfg,
            schemaPath: "/s",
        })
        expect(a2).not.toContain("-c")
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

    test("a finding without `suggestion` is normalized to null and still validates", () => {
        const obj = {
            status: "ISSUES",
            findings: [
                {
                    file: "a.js",
                    line: 1,
                    severity: "minor",
                    category: "style",
                    message: "no suggestion field here",
                },
            ],
        }
        const out = parseCodexOutput(JSON.stringify(obj), validator)
        expect(out.ok).toBe(true)
        expect(out.value.findings[0].suggestion).toBeNull()
    })

    test("an explicit null suggestion is accepted (codex strict mode emits null)", () => {
        const obj = {
            status: "ISSUES",
            findings: [
                {
                    file: "a.js",
                    line: 1,
                    severity: "minor",
                    category: "style",
                    message: "m",
                    suggestion: null,
                },
            ],
        }
        const out = parseCodexOutput(JSON.stringify(obj), validator)
        expect(out.ok).toBe(true)
        expect(out.value.findings[0].suggestion).toBeNull()
    })
})

describe("normalizeFindings", () => {
    test("fills missing suggestion with null, leaves present ones untouched", () => {
        const r = normalizeFindings({
            status: "ISSUES",
            findings: [
                {
                    file: "a",
                    line: 1,
                    severity: "nit",
                    category: "style",
                    message: "m",
                },
                {
                    file: "b",
                    line: 2,
                    severity: "nit",
                    category: "style",
                    message: "m",
                    suggestion: "fix it",
                },
            ],
        })
        expect(r.findings[0].suggestion).toBeNull()
        expect(r.findings[1].suggestion).toBe("fix it")
    })

    test("is a no-op when findings is missing or not an array", () => {
        expect(normalizeFindings({ status: "GOOD_TO_GO" })).toEqual({
            status: "GOOD_TO_GO",
        })
        expect(normalizeFindings(null)).toBeNull()
        expect(normalizeFindings({ findings: "nope" })).toEqual({
            findings: "nope",
        })
    })
})

// Regression guard: codex sends a schema to the OpenAI API as a strict
// response_format. OpenAI requires every key in `properties` to also
// appear in `required` AND forbids `allOf`/`if`/`then`. We hand codex a
// stripped copy (toStrictSchema) while ajv keeps the rich canonical
// schema. These tests fail loudly if either contract regresses.
describe("toStrictSchema — OpenAI strict compliance", () => {
    const richSchema = () =>
        JSON.parse(readFileSync(__defaults__.DEFAULT_SCHEMA_PATH, "utf8"))

    const assertStrict = (schema) => {
        const violations = []
        const walk = (node, where) => {
            if (!node || typeof node !== "object") return
            for (const forbidden of ["allOf", "anyOf", "if", "then", "else"]) {
                if (forbidden in node) {
                    violations.push(
                        `${where}: forbidden keyword '${forbidden}'`
                    )
                }
            }
            if (node.type === "object" && node.properties) {
                const props = Object.keys(node.properties)
                const required = Array.isArray(node.required)
                    ? node.required
                    : []
                for (const p of props) {
                    if (!required.includes(p)) {
                        violations.push(`${where}.${p}: not in required`)
                    }
                }
            }
            for (const [k, v] of Object.entries(node)) {
                if (v && typeof v === "object") walk(v, `${where}.${k}`)
            }
        }
        walk(schema, "$")
        return violations
    }

    test("the canonical schema itself uses allOf (the thing we must strip)", () => {
        // Sanity: if this ever stops being true the strip is pointless
        // and we should simplify.
        expect("allOf" in richSchema()).toBe(true)
    })

    test("toStrictSchema removes allOf/if/then and keeps every property required", () => {
        const strict = toStrictSchema(richSchema())
        expect(assertStrict(strict)).toEqual([])
        expect("allOf" in strict).toBe(false)
    })

    test("toStrictSchema preserves structure (types, enums, $defs, required)", () => {
        const strict = toStrictSchema(richSchema())
        expect(strict.type).toBe("object")
        expect(strict.required).toEqual(["status", "findings"])
        expect(strict.$defs.finding.properties.severity.enum).toEqual([
            "blocker",
            "major",
            "minor",
            "nit",
        ])
        expect(strict.$defs.finding.required).toContain("suggestion")
    })

    test("toStrictSchema is pure (leaves arrays/primitives intact)", () => {
        expect(toStrictSchema(5)).toBe(5)
        expect(toStrictSchema(null)).toBeNull()
        expect(toStrictSchema(["a", "b"])).toEqual(["a", "b"])
    })

    test("strictSchemaPathFor passes a custom path through unchanged", () => {
        expect(__defaults__.strictSchemaPathFor("/custom/x.json")).toBe(
            "/custom/x.json"
        )
    })

    test("strictSchemaPathFor materializes a strict file for the default path", () => {
        __defaults__.resetStrictSchemaCache()
        const writes = []
        const deps = {
            readFileSync: () =>
                readFileSync(__defaults__.DEFAULT_SCHEMA_PATH, "utf8"),
            writeFileSync: (p, data) => writes.push({ p, data }),
        }
        const outPath = __defaults__.strictSchemaPathFor(
            __defaults__.DEFAULT_SCHEMA_PATH,
            deps
        )
        expect(outPath).toMatch(/codex-strict\.schema\.json$/)
        expect(writes).toHaveLength(1)
        const written = JSON.parse(writes[0].data)
        expect("allOf" in written).toBe(false)
        __defaults__.resetStrictSchemaCache()
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
