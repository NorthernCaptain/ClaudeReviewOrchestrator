/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { jest } from "@jest/globals"
import { createHash } from "node:crypto"
import {
    mkdirSync,
    mkdtempSync,
    openSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
    createReviewRules,
    MAX_RULES_BYTES,
    readRulesFile,
    REVIEW_RULES_RESOURCE,
    RulesError,
} from "./rules.js"

const sha = (s) => createHash("sha256").update(s).digest("hex")

describe("createReviewRules", () => {
    test("refuses a core without bundled rules", () => {
        expect(() => createReviewRules(undefined)).toThrow(
            `core resource missing: ${REVIEW_RULES_RESOURCE}`
        )
    })

    test("refuses empty bundled rules", () => {
        expect(() => createReviewRules(Buffer.from("  \n\t\n"))).toThrow(
            RulesError
        )
    })

    test("refuses oversized bundled rules", () => {
        const big = Buffer.alloc(MAX_RULES_BYTES + 1, "a")
        expect(() => createReviewRules(big)).toThrow(/larger than/)
    })

    test("without rulesFile every review gets the bundled rules", () => {
        const readFile = jest.fn()
        const rules = createReviewRules(Buffer.from("\n# Rules\nCheck.\n"), {
            readFile,
        })
        const expected = {
            text: "# Rules\nCheck.",
            source: "bundled",
            hash: sha("# Rules\nCheck."),
        }
        expect(rules.bundled).toEqual(expected)
        expect(rules.resolve({})).toBe(rules.bundled)
        expect(rules.resolve({ reviewer: { rulesFile: null } })).toBe(
            rules.bundled
        )
        expect(rules.resolve(undefined)).toBe(rules.bundled)
        expect(readFile).not.toHaveBeenCalled()
        expect(Object.isFrozen(rules.bundled)).toBe(true)
    })

    test("rulesFile is read on every resolve", () => {
        let text = "first"
        const readFile = jest.fn(() => Buffer.from(text))
        const rules = createReviewRules(Buffer.from("bundled"), { readFile })
        const config = { reviewer: { rulesFile: "/r/rules.md" } }
        expect(rules.resolve(config)).toEqual({
            text: "first",
            source: "/r/rules.md",
            hash: sha("first"),
        })
        text = "second"
        expect(rules.resolve(config).hash).toBe(sha("second"))
        expect(readFile).toHaveBeenCalledTimes(2)
        expect(readFile).toHaveBeenCalledWith("/r/rules.md")
    })

    test("an empty or oversized rulesFile is a RulesError", () => {
        const config = { reviewer: { rulesFile: "/r/rules.md" } }
        const empty = createReviewRules(Buffer.from("b"), {
            readFile: () => Buffer.from(""),
        })
        expect(() => empty.resolve(config)).toThrow(
            "review rules are empty: /r/rules.md"
        )
        const big = createReviewRules(Buffer.from("b"), {
            readFile: () => Buffer.alloc(MAX_RULES_BYTES + 1, "x"),
        })
        try {
            big.resolve(config)
            throw new Error("expected a throw")
        } catch (err) {
            expect(err).toBeInstanceOf(RulesError)
            expect(err.code).toBe("REVIEW_RULES_UNREADABLE")
        }
    })
})

describe("readRulesFile", () => {
    let dir
    beforeEach(() => {
        dir = mkdtempSync(path.join(tmpdir(), "rules-test-"))
    })
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true })
    })

    test("reads a regular file", () => {
        const file = path.join(dir, "rules.md")
        writeFileSync(file, "# Mine\n")
        expect(readRulesFile(file).toString("utf8")).toBe("# Mine\n")
    })

    test("reads no more than one byte past the cap", () => {
        const file = path.join(dir, "big.md")
        writeFileSync(file, Buffer.alloc(MAX_RULES_BYTES + 100, "y"))
        expect(readRulesFile(file).length).toBe(MAX_RULES_BYTES + 1)
    })

    test("an oversized file is refused even when its kept prefix ends in whitespace", () => {
        const file = path.join(dir, "padded.md")
        const head = Buffer.alloc(MAX_RULES_BYTES - 10, "r")
        const pad = Buffer.alloc(20, " ")
        writeFileSync(file, Buffer.concat([head, pad, Buffer.from("TAIL")]))
        const rules = createReviewRules(Buffer.from("b"))
        expect(() => rules.resolve({ reviewer: { rulesFile: file } })).toThrow(
            /larger than/
        )
    })

    test("a missing file is a RulesError naming the path", () => {
        const file = path.join(dir, "nope.md")
        expect(() => readRulesFile(file)).toThrow(RulesError)
        expect(() => readRulesFile(file)).toThrow(
            `can't open review rules ${file}`
        )
    })

    test("a read failure after opening is a RulesError", () => {
        // A directory's fd opens fine but can't be read (EISDIR).
        const sub = path.join(dir, "sub")
        mkdirSync(sub)
        const file = path.join(dir, "rules.md")
        expect(() =>
            readRulesFile(file, { open: () => openSync(sub) })
        ).toThrow(`can't read review rules ${file}`)
    })

    test("a directory is not a rules file", () => {
        const sub = path.join(dir, "sub")
        mkdirSync(sub)
        expect(() => readRulesFile(sub)).toThrow(
            `review rules are not a file: ${sub}`
        )
    })

    test("the bundled rules file is within the cap and non-empty", () => {
        const bytes = readFileSync(
            new URL("./review-rules.md", import.meta.url)
        )
        const rules = createReviewRules(bytes)
        expect(rules.bundled.text.length).toBeGreaterThan(0)
        expect(rules.bundled.text).toContain("## Repository guidance")
        expect(rules.bundled.text).toContain("## Severity")
    })
})
