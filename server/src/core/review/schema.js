/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

// The reviewer output schema, built once per core from the bytes the
// shell captured when it loaded the core (staging.resources). Adapters
// never read the source tree for it, so what a core validates against is
// exactly what it was loaded with.

import { createHash, randomBytes } from "node:crypto"
import {
    mkdirSync as nodeMkdirSync,
    readFileSync as nodeReadFileSync,
    renameSync as nodeRenameSync,
    writeFileSync as nodeWriteFileSync,
} from "node:fs"
import path from "node:path"
import Ajv from "ajv/dist/2020.js"

export const OUTPUT_SCHEMA_RESOURCE = "review/codex-output.schema.json"

// Codex passes --output-schema to the OpenAI API as a strict
// `response_format`. Strict mode rejects several JSON Schema keywords
// that ajv (and our richer canonical schema) rely on — notably `allOf`
// and the `if`/`then`/`else` conditionals we use to enforce the
// GOOD_TO_GO⇔empty / ISSUES⇔non-empty invariant. We therefore hand
// codex a STRIPPED copy: same shape, types, enums, required, and
// additionalProperties:false (which strict mode needs), minus the
// unsupported conditional keywords. ajv keeps validating codex's actual
// output against the full canonical schema, so the invariant is still
// enforced server-side — codex just isn't asked to encode it in its
// response_format.
const STRICT_UNSUPPORTED_KEYS = new Set([
    "allOf",
    "anyOf",
    "if",
    "then",
    "else",
])

export const toStrictSchema = (node) => {
    if (Array.isArray(node)) return node.map(toStrictSchema)
    if (!node || typeof node !== "object") return node
    const out = {}
    for (const [key, value] of Object.entries(node)) {
        if (STRICT_UNSUPPORTED_KEYS.has(key)) continue
        out[key] = toStrictSchema(value)
    }
    return out
}

// The bundled schema can't go over claude's --json-schema verbatim. The
// CLI compiles it with its own draft-07 ajv instance and then forwards it
// to the API as a strict tool input_schema, and each stage rejects
// something we declare:
//   * "$schema": the 2020-12 meta-schema isn't registered in the CLI's ajv,
//     so the whole run dies before spawning with
//     `--json-schema is not a valid JSON Schema: no schema with key or ref
//     "https://json-schema.org/draft/2020-12/schema"` (claude 2.1.220).
//   * top-level "allOf": the API rejects oneOf/allOf/anyOf at the top level
//     of a tool input_schema (`400 ... input_schema does not support oneOf,
//     allOf, or anyOf at the top level`).
// "$id" goes too — it names a document we're inlining, so it buys nothing
// and risks a duplicate-key collision inside the CLI's ajv. $defs/$ref and
// the ["string", "null"] union survive both stages, so the finding shape is
// still enforced end-to-end.
//
// Dropping allOf loses the status<->findings conditional; parseClaudeOutput
// re-derives status from the findings instead, and the server derives the
// public status from the findings regardless.
const CLAUDE_DROPPED_KEYS = new Set(["$schema", "$id", "allOf"])

export const toClaudeSchema = (schema) =>
    Object.fromEntries(
        Object.entries(schema).filter(([key]) => !CLAUDE_DROPPED_KEYS.has(key))
    )

const sha256 = (data) => createHash("sha256").update(data).digest("hex")

// `strictPath` is where codex's strict copy lives (shell-chosen, one per
// core). The file is checked against the in-memory bytes before every
// run and rewritten atomically when missing or different, so a reaped,
// edited or truncated file can never reach codex.
export const createOutputSchema = (
    bytes,
    {
        strictPath = null,
        fs = {},
        nonce = () => randomBytes(6).toString("hex"),
    } = {}
) => {
    const readFileSync = fs.readFileSync ?? nodeReadFileSync
    const writeFileSync = fs.writeFileSync ?? nodeWriteFileSync
    const mkdirSync = fs.mkdirSync ?? nodeMkdirSync
    const renameSync = fs.renameSync ?? nodeRenameSync

    const canonical = JSON.parse(Buffer.from(bytes).toString("utf8"))
    const strictText = JSON.stringify(toStrictSchema(canonical), null, 2) + "\n"
    const strictHash = sha256(strictText)
    const claudeText = JSON.stringify(toClaudeSchema(canonical))
    let compiled = null

    const validator = () => {
        if (!compiled) {
            const ajv = new Ajv({ allErrors: true, strict: false })
            compiled = ajv.compile(canonical)
        }
        return compiled
    }

    const codexStrictPath = () => {
        if (!strictPath) {
            throw new Error("no codex schema path was given to this core")
        }
        try {
            if (sha256(readFileSync(strictPath)) === strictHash) {
                return strictPath
            }
        } catch {
            // missing or unreadable: rewrite below
        }
        mkdirSync(path.dirname(strictPath), { recursive: true, mode: 0o700 })
        const tmp = `${strictPath}.${nonce()}.tmp`
        writeFileSync(tmp, strictText, { mode: 0o600 })
        renameSync(tmp, strictPath)
        return strictPath
    }

    return { canonical, claudeText, strictText, validator, codexStrictPath }
}
