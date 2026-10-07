/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { jest } from "@jest/globals"
import {
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
    createOutputSchema,
    OUTPUT_SCHEMA_RESOURCE,
    toClaudeSchema,
    toStrictSchema,
} from "./schema.js"

const SCHEMA_BYTES = readFileSync(
    new URL("./codex-output.schema.json", import.meta.url)
)

let dir
beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "schema-"))
})
afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
})

// Regression guard: codex sends a schema to the OpenAI API as a strict
// response_format. OpenAI requires every key in `properties` to also
// appear in `required` AND forbids `allOf`/`if`/`then`. We hand codex a
// stripped copy (toStrictSchema) while ajv keeps the rich canonical
// schema. These tests fail loudly if either contract regresses.
describe("toStrictSchema — OpenAI strict compliance", () => {
    const richSchema = () => JSON.parse(SCHEMA_BYTES.toString("utf8"))

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
})

describe("toClaudeSchema", () => {
    test("drops $schema, $id and the top-level allOf, keeping the rest", () => {
        const out = toClaudeSchema(JSON.parse(SCHEMA_BYTES.toString("utf8")))
        expect(out.$schema).toBeUndefined()
        expect(out.$id).toBeUndefined()
        expect(out.allOf).toBeUndefined()
        expect(out.$defs.finding).toBeDefined()
        expect(out.required).toEqual(["status", "findings"])
    })
})

describe("createOutputSchema", () => {
    test("the resource key names the schema under core/review/", () => {
        expect(OUTPUT_SCHEMA_RESOURCE).toBe("review/codex-output.schema.json")
    })

    test("compiles the canonical validator once", () => {
        const schema = createOutputSchema(SCHEMA_BYTES)
        const v = schema.validator()
        expect(schema.validator()).toBe(v)
        expect(v({ status: "GOOD_TO_GO", findings: [] })).toBe(true)
        expect(v({ status: "ISSUES", findings: [] })).toBe(false)
    })

    test("claudeText is the sanitized schema, inline", () => {
        const schema = createOutputSchema(SCHEMA_BYTES)
        expect(JSON.parse(schema.claudeText).allOf).toBeUndefined()
    })

    test("codexStrictPath writes the strict copy (0600) under a fresh folder", () => {
        const strictPath = path.join(dir, "nested", "strict.json")
        const schema = createOutputSchema(SCHEMA_BYTES, { strictPath })
        expect(schema.codexStrictPath()).toBe(strictPath)
        expect(readFileSync(strictPath, "utf8")).toBe(schema.strictText)
        expect(statSync(strictPath).mode & 0o777).toBe(0o600)
    })

    test("codexStrictPath leaves a matching file alone", () => {
        const strictPath = path.join(dir, "strict.json")
        const writeFileSyncSpy = jest.fn(writeFileSync)
        const schema = createOutputSchema(SCHEMA_BYTES, {
            strictPath,
            fs: { writeFileSync: writeFileSyncSpy },
        })
        schema.codexStrictPath()
        schema.codexStrictPath()
        expect(writeFileSyncSpy).toHaveBeenCalledTimes(1)
    })

    test.each([
        ["edited", (p) => writeFileSync(p, "{}")],
        ["truncated", (p) => writeFileSync(p, "")],
        ["deleted", (p) => rmSync(p)],
    ])("codexStrictPath rewrites a file that was %s", (_label, damage) => {
        const strictPath = path.join(dir, "strict.json")
        const schema = createOutputSchema(SCHEMA_BYTES, { strictPath })
        schema.codexStrictPath()
        damage(strictPath)
        schema.codexStrictPath()
        expect(readFileSync(strictPath, "utf8")).toBe(schema.strictText)
    })

    test("codexStrictPath without a path is an error", () => {
        expect(() =>
            createOutputSchema(SCHEMA_BYTES).codexStrictPath()
        ).toThrow(/no codex schema path/)
    })
})
