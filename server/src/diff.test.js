/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { execFileSync } from "node:child_process"
import {
    mkdtempSync,
    rmSync,
    writeFileSync,
    mkdirSync,
    realpathSync,
    chmodSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { buildPayload, __test__ } from "./diff.js"

const { parseNameStatusZ, filterIgnored, matchesAny, isBinary, truncateText } =
    __test__

const makeRepo = () => {
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "diff-")))
    execFileSync("git", ["init", "-q", "-b", "main", dir])
    execFileSync("git", ["-C", dir, "config", "user.email", "t@t"])
    execFileSync("git", ["-C", dir, "config", "user.name", "t"])
    writeFileSync(path.join(dir, "README.md"), "hi\n")
    execFileSync("git", ["-C", dir, "add", "."])
    execFileSync("git", ["-C", dir, "commit", "-qm", "init"])
    return dir
}

const baseConfig = () => ({
    ignorePaths: ["**/node_modules/**", "**/*.lock", "**/.git/**"],
    limits: {
        maxPayloadBytes: 1024 * 1024,
        maxFileBytes: 256 * 1024,
        maxFiles: 40,
        codexTimeoutSeconds: 240,
    },
})

describe("matchesAny / filterIgnored", () => {
    test("ignores node_modules path", () => {
        expect(
            matchesAny("a/node_modules/b/c.js", ["**/node_modules/**"])
        ).toBe(true)
    })
    test("does not match unrelated path", () => {
        expect(matchesAny("src/foo.js", ["**/node_modules/**"])).toBe(false)
    })
    test("filterIgnored removes matches and keeps the rest", () => {
        const out = filterIgnored(
            ["src/a.js", "node_modules/x.js", "yarn.lock"],
            ["**/node_modules/**", "**/*.lock"]
        )
        expect(out).toEqual(["src/a.js"])
    })
})

describe("parseNameStatusZ", () => {
    test("parses M/A/D entries", () => {
        const input = "M\0a.js\0A\0b.js\0D\0c.js\0"
        const out = parseNameStatusZ(input)
        expect(out.modified).toEqual(["a.js"])
        expect(out.added).toEqual(["b.js"])
        expect(out.deleted).toEqual(["c.js"])
    })
    test("parses rename with source and dest", () => {
        const input = "R100\0old.js\0new.js\0"
        const out = parseNameStatusZ(input)
        expect(out.renamed).toEqual([{ from: "old.js", to: "new.js" }])
    })
    test("returns empty buckets on empty input", () => {
        const out = parseNameStatusZ("")
        expect(out.modified).toEqual([])
    })
})

describe("isBinary", () => {
    test("returns true for buffer containing a null byte in first 8KB", () => {
        expect(isBinary(Buffer.from([1, 2, 0, 3, 4]))).toBe(true)
    })
    test("returns false for plain ASCII", () => {
        expect(isBinary(Buffer.from("hello world\n", "utf8"))).toBe(false)
    })
})

describe("truncateText", () => {
    test("returns text unchanged if under limit", () => {
        const r = truncateText("hi", 10)
        expect(r.text).toBe("hi")
        expect(r.truncated).toBe(false)
    })
    test("truncates and appends marker", () => {
        const r = truncateText("a".repeat(100), 10)
        expect(r.truncated).toBe(true)
        expect(r.text).toMatch(/^a{10}\n\.\.\. \(truncated\)\n$/)
    })
})

describe("buildPayload (integration)", () => {
    let dir
    beforeEach(() => {
        dir = makeRepo()
    })
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true })
    })

    test("captures a modified file in promptText", () => {
        writeFileSync(path.join(dir, "README.md"), "hi\nmore\n")
        const out = buildPayload({ repoRoot: dir, config: baseConfig() })
        expect(out.empty).toBe(false)
        expect(out.files.modified.map((f) => f.path)).toContain("README.md")
        expect(out.promptText).toMatch(/=== FILE: README.md \(modified\) ===/)
    })

    test("captures an untracked text file", () => {
        writeFileSync(path.join(dir, "new.txt"), "new content\n")
        const out = buildPayload({ repoRoot: dir, config: baseConfig() })
        expect(
            out.files.untracked.find((u) => u.path === "new.txt")
        ).toBeDefined()
        expect(out.promptText).toMatch(/new content/)
    })

    test("marks untracked binary file as header-only", () => {
        writeFileSync(
            path.join(dir, "blob.bin"),
            Buffer.from([0, 1, 2, 0, 4, 5])
        )
        const out = buildPayload({ repoRoot: dir, config: baseConfig() })
        const u = out.files.untracked.find((x) => x.path === "blob.bin")
        expect(u.binary).toBe(true)
        expect(out.promptText).toMatch(/blob.bin .*binary.*omitted/)
        expect(out.promptText).not.toMatch(//)
    })

    test("captures a deleted tracked file", () => {
        rmSync(path.join(dir, "README.md"))
        const out = buildPayload({ repoRoot: dir, config: baseConfig() })
        expect(out.files.deleted).toContain("README.md")
        expect(out.promptText).toMatch(/=== FILE: README.md \(deleted\) ===/)
    })

    test("captures a rename", () => {
        execFileSync("git", ["-C", dir, "mv", "README.md", "README2.md"])
        const out = buildPayload({ repoRoot: dir, config: baseConfig() })
        expect(out.files.renamed).toContainEqual({
            from: "README.md",
            to: "README2.md",
        })
        expect(out.promptText).toMatch(/README.md -> README2.md/)
    })

    test("applies ignorePaths to untracked files", () => {
        mkdirSync(path.join(dir, "node_modules"), { recursive: true })
        writeFileSync(path.join(dir, "node_modules", "x.js"), "ignored\n")
        writeFileSync(path.join(dir, "src.js"), "kept\n")
        const out = buildPayload({ repoRoot: dir, config: baseConfig() })
        expect(out.files.untracked.map((u) => u.path)).not.toContain(
            "node_modules/x.js"
        )
        expect(out.files.untracked.map((u) => u.path)).toContain("src.js")
    })

    test("returns empty=true when there are no changes", () => {
        const out = buildPayload({ repoRoot: dir, config: baseConfig() })
        expect(out.empty).toBe(true)
        expect(out.totalBytes).toBe(0)
        expect(out.promptText).toBe("")
    })

    test("truncates a file that exceeds maxFileBytes", () => {
        const big = "x".repeat(2000) + "\n"
        writeFileSync(path.join(dir, "big.txt"), big)
        const cfg = baseConfig()
        cfg.limits.maxFileBytes = 100
        const out = buildPayload({ repoRoot: dir, config: cfg })
        expect(out.truncated).toBe(true)
        expect(out.promptText).toMatch(
            /=== FILE: big.txt \(untracked, truncated\) ===/
        )
        expect(out.promptText.length).toBeLessThan(big.length)
    })

    test("limits files to maxFiles, emitting header-only for extras", () => {
        for (let i = 0; i < 5; i++) {
            writeFileSync(path.join(dir, `f${i}.txt`), `content ${i}\n`)
        }
        const cfg = baseConfig()
        cfg.limits.maxFiles = 2
        const out = buildPayload({ repoRoot: dir, config: cfg })
        expect(out.truncated).toBe(true)
        const matches = out.promptText.match(/omitted: maxFiles/g) || []
        expect(matches.length).toBeGreaterThanOrEqual(3)
    })

    test("respects maxPayloadBytes by replacing oversized blocks with header-only", () => {
        for (let i = 0; i < 5; i++) {
            writeFileSync(path.join(dir, `f${i}.txt`), "x".repeat(500))
        }
        const cfg = baseConfig()
        cfg.limits.maxPayloadBytes = 600
        const out = buildPayload({ repoRoot: dir, config: cfg })
        expect(out.truncated).toBe(true)
        expect(out.totalBytes).toBeLessThanOrEqual(cfg.limits.maxPayloadBytes)
    })

    test("headSha is the current HEAD", () => {
        const sha = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], {
            encoding: "utf8",
        }).trim()
        const out = buildPayload({ repoRoot: dir, config: baseConfig() })
        expect(out.headSha).toBe(sha)
    })
})
