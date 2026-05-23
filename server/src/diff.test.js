/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
    mkdtempSync,
    rmSync,
    writeFileSync,
    mkdirSync,
    realpathSync,
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
    test("skips rename record with missing dest", () => {
        // Truncated input: rename status with only the source path supplied.
        const out = parseNameStatusZ("R100\0only-source.js\0")
        expect(out.renamed).toEqual([])
    })
    test("skips unknown status codes", () => {
        const out = parseNameStatusZ("U\0weird.js\0")
        expect(out.modified).toEqual([])
        expect(out.added).toEqual([])
    })
})

describe("sanitizeFindingPath", () => {
    const { sanitizeFindingPath } = __test__
    const root = "/repo"

    test("accepts a plain repo-relative path", () => {
        expect(sanitizeFindingPath("src/foo.js", root)).toBe("src/foo.js")
    })

    test("normalizes redundant segments", () => {
        expect(sanitizeFindingPath("src/./foo.js", root)).toBe("src/foo.js")
        expect(sanitizeFindingPath("src/bar/../foo.js", root)).toBe(
            "src/foo.js"
        )
    })

    test("rejects absolute paths", () => {
        expect(sanitizeFindingPath("/etc/passwd", root)).toBeNull()
    })

    test("rejects parent-directory escapes", () => {
        expect(sanitizeFindingPath("../secret.txt", root)).toBeNull()
        expect(sanitizeFindingPath("../../secret.txt", root)).toBeNull()
        expect(sanitizeFindingPath("src/../../escape.txt", root)).toBeNull()
    })

    test("rejects backslash traversal", () => {
        expect(sanitizeFindingPath("..\\secret.txt", root)).toBeNull()
        expect(sanitizeFindingPath("src\\foo.js", root)).toBeNull()
    })

    test("rejects null bytes", () => {
        expect(sanitizeFindingPath("src/foo\0.js", root)).toBeNull()
    })

    test("rejects empty / dotty paths", () => {
        expect(sanitizeFindingPath("", root)).toBeNull()
        expect(sanitizeFindingPath(".", root)).toBeNull()
        expect(sanitizeFindingPath("..", root)).toBeNull()
    })

    test("rejects non-string input", () => {
        expect(sanitizeFindingPath(null, root)).toBeNull()
        expect(sanitizeFindingPath(undefined, root)).toBeNull()
        expect(sanitizeFindingPath(123, root)).toBeNull()
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

    test("modified files past maxFiles get header-only entries", () => {
        // Several committed files; modify all of them so they're in `modified`.
        for (let i = 0; i < 4; i++) {
            const file = path.join(dir, `m${i}.txt`)
            writeFileSync(file, "initial\n")
        }
        execFileSync("git", ["-C", dir, "add", "."])
        execFileSync("git", ["-C", dir, "commit", "-qm", "add files"])
        for (let i = 0; i < 4; i++) {
            writeFileSync(path.join(dir, `m${i}.txt`), `changed ${i}\n`)
        }
        const cfg = baseConfig()
        cfg.limits.maxFiles = 2
        const out = buildPayload({ repoRoot: dir, config: cfg })
        expect(out.truncated).toBe(true)
        const matches =
            out.promptText.match(/modified, omitted: maxFiles/g) || []
        expect(matches.length).toBeGreaterThanOrEqual(1)
    })

    test("deleted files past maxFiles get header-only entries", () => {
        for (let i = 0; i < 3; i++) {
            writeFileSync(path.join(dir, `d${i}.txt`), "initial\n")
        }
        execFileSync("git", ["-C", dir, "add", "."])
        execFileSync("git", ["-C", dir, "commit", "-qm", "add"])
        for (let i = 0; i < 3; i++) {
            rmSync(path.join(dir, `d${i}.txt`))
        }
        const cfg = baseConfig()
        cfg.limits.maxFiles = 1
        const out = buildPayload({ repoRoot: dir, config: cfg })
        expect(out.truncated).toBe(true)
        const matches =
            out.promptText.match(/deleted, omitted: maxFiles/g) || []
        expect(matches.length).toBeGreaterThanOrEqual(1)
    })

    test("a large deleted file's diff gets truncated", () => {
        const big = "x".repeat(2000) + "\n"
        const p = path.join(dir, "big-del.txt")
        writeFileSync(p, big)
        execFileSync("git", ["-C", dir, "add", "."])
        execFileSync("git", ["-C", dir, "commit", "-qm", "big"])
        rmSync(p)
        const cfg = baseConfig()
        cfg.limits.maxFileBytes = 200
        const out = buildPayload({ repoRoot: dir, config: cfg })
        expect(out.truncated).toBe(true)
        expect(out.promptText).toMatch(
            /=== FILE: big-del.txt \(deleted, truncated\) ===/
        )
    })

    test("renamed files past maxFiles get header-only entries", () => {
        for (let i = 0; i < 3; i++) {
            writeFileSync(path.join(dir, `r${i}.txt`), "initial\n")
        }
        execFileSync("git", ["-C", dir, "add", "."])
        execFileSync("git", ["-C", dir, "commit", "-qm", "add"])
        for (let i = 0; i < 3; i++) {
            execFileSync("git", ["-C", dir, "mv", `r${i}.txt`, `r${i}-new.txt`])
        }
        const cfg = baseConfig()
        cfg.limits.maxFiles = 1
        const out = buildPayload({ repoRoot: dir, config: cfg })
        expect(out.truncated).toBe(true)
        const matches =
            out.promptText.match(/renamed, omitted: maxFiles/g) || []
        expect(matches.length).toBeGreaterThanOrEqual(1)
    })

    test("Buffer.byteLength(promptText) equals totalBytes", () => {
        writeFileSync(path.join(dir, "ascii.txt"), "hello\n")
        writeFileSync(path.join(dir, "utf8.txt"), "héllo 日本語\n")
        const out = buildPayload({ repoRoot: dir, config: baseConfig() })
        expect(Buffer.byteLength(out.promptText, "utf8")).toBe(out.totalBytes)
    })

    test("multi-byte UTF-8 content keeps promptText byte length at or under maxPayloadBytes", () => {
        // 600 copies of a 3-byte char would be 1800 bytes if emitted in full.
        writeFileSync(path.join(dir, "u.txt"), "あ".repeat(600) + "\n")
        const cfg = baseConfig()
        cfg.limits.maxPayloadBytes = 500
        const out = buildPayload({ repoRoot: dir, config: cfg })
        expect(out.truncated).toBe(true)
        expect(Buffer.byteLength(out.promptText, "utf8")).toBeLessThanOrEqual(
            cfg.limits.maxPayloadBytes
        )
        expect(out.totalBytes).toBe(Buffer.byteLength(out.promptText, "utf8"))
    })

    test("promptHash is sha256 of promptText bytes", () => {
        writeFileSync(path.join(dir, "x.txt"), "hello\n")
        const out = buildPayload({ repoRoot: dir, config: baseConfig() })
        const expected = createHash("sha256")
            .update(out.promptText)
            .digest("hex")
        expect(out.promptHash).toBe(expected)
    })

    test("progressHash equals sha256(promptHash + '|') when there are no prior findings", () => {
        writeFileSync(path.join(dir, "x.txt"), "hello\n")
        const out = buildPayload({ repoRoot: dir, config: baseConfig() })
        const expected = createHash("sha256")
            .update(`${out.promptHash}|`)
            .digest("hex")
        expect(out.progressHash).toBe(expected)
    })

    test("progressHash changes when a prior-finding file is edited", () => {
        const flagged = path.join(dir, "flagged.txt")
        writeFileSync(flagged, "before\n")
        execFileSync("git", ["-C", dir, "add", "."])
        execFileSync("git", ["-C", dir, "commit", "-qm", "add"])

        const priorFindings = [
            { file: "flagged.txt", line: 1, severity: "blocker" },
        ]
        const before = buildPayload({
            repoRoot: dir,
            config: baseConfig(),
            priorFindings,
        })
        writeFileSync(flagged, "after\n")
        const after = buildPayload({
            repoRoot: dir,
            config: baseConfig(),
            priorFindings,
        })
        expect(after.progressHash).not.toBe(before.progressHash)
    })

    test("progressHash flips even when the edit is PAST maxFileBytes truncation", () => {
        // The flagged file is large. We change a byte far past maxFileBytes.
        // promptHash may stay the same (the truncated prompt prefix is
        // identical) but progressHash uses the FULL file content, so it must
        // change.
        const flagged = path.join(dir, "big.txt")
        const initial = "a".repeat(2000) + "X"
        writeFileSync(flagged, initial + "\n")
        execFileSync("git", ["-C", dir, "add", "."])
        execFileSync("git", ["-C", dir, "commit", "-qm", "init"])

        const priorFindings = [
            { file: "big.txt", line: 1, severity: "blocker" },
        ]
        const cfg = baseConfig()
        cfg.limits.maxFileBytes = 200 // truncate well before our edit point.

        const before = buildPayload({
            repoRoot: dir,
            config: cfg,
            priorFindings,
        })

        // Mutate the file far past the prompt's truncation point.
        writeFileSync(flagged, initial.replace(/X$/, "Y") + "\n")

        const after = buildPayload({
            repoRoot: dir,
            config: cfg,
            priorFindings,
        })

        // Sanity: the prompt itself was indeed truncated.
        expect(before.truncated).toBe(true)
        expect(after.truncated).toBe(true)
        // Either promptHash flipped too (because the modified diff also
        // changed) or it stayed identical because we haven't staged the
        // change against HEAD. Either way the progress hash MUST flip.
        expect(after.progressHash).not.toBe(before.progressHash)
    })

    test("progressHash treats a deleted prior-finding file as MISSING", () => {
        const flagged = path.join(dir, "f.txt")
        writeFileSync(flagged, "content\n")
        execFileSync("git", ["-C", dir, "add", "."])
        execFileSync("git", ["-C", dir, "commit", "-qm", "add"])

        const priorFindings = [{ file: "f.txt", line: 1, severity: "blocker" }]
        const before = buildPayload({
            repoRoot: dir,
            config: baseConfig(),
            priorFindings,
        })
        rmSync(flagged)
        const after = buildPayload({
            repoRoot: dir,
            config: baseConfig(),
            priorFindings,
        })
        expect(after.progressHash).not.toBe(before.progressHash)
    })

    test("force-include: prior-finding file in ignorePaths is still in the prompt", () => {
        mkdirSync(path.join(dir, "node_modules"), { recursive: true })
        const flagged = "node_modules/foo.js"
        writeFileSync(path.join(dir, flagged), "x = 1\n")
        const out = buildPayload({
            repoRoot: dir,
            config: baseConfig(),
            priorFindings: [{ file: flagged, line: 1, severity: "blocker" }],
        })
        // Without prior-findings this file would be filtered by ignorePaths.
        expect(out.promptText).toMatch(/node_modules\/foo.js/)
    })

    test("force-include: a prior-finding file that the user hasn't touched gets a 'prior-finding' block", () => {
        const flagged = path.join(dir, "untouched.txt")
        writeFileSync(flagged, "still here\n")
        execFileSync("git", ["-C", dir, "add", "."])
        execFileSync("git", ["-C", dir, "commit", "-qm", "init"])
        const out = buildPayload({
            repoRoot: dir,
            config: baseConfig(),
            priorFindings: [
                { file: "untouched.txt", line: 1, severity: "blocker" },
            ],
        })
        expect(out.promptText).toMatch(
            /=== FILE: untouched.txt \(prior-finding, full content\) ===/
        )
        expect(out.files.priorFindingContext).toContainEqual(
            expect.objectContaining({ path: "untouched.txt", missing: false })
        )
    })

    test("force-include: prior-finding files don't consume the maxFiles budget", () => {
        // 3 untracked files + 1 prior-finding file flagged in node_modules.
        // maxFiles=2: untracked files take both slots; the prior-finding file
        // still gets included.
        for (let i = 0; i < 3; i++) {
            writeFileSync(path.join(dir, `u${i}.txt`), "x\n")
        }
        mkdirSync(path.join(dir, "node_modules"), { recursive: true })
        const flagged = "node_modules/foo.js"
        writeFileSync(path.join(dir, flagged), "y = 2\n")
        const cfg = baseConfig()
        cfg.limits.maxFiles = 2

        const out = buildPayload({
            repoRoot: dir,
            config: cfg,
            priorFindings: [{ file: flagged, line: 1, severity: "blocker" }],
        })
        expect(out.promptText).toMatch(/node_modules\/foo.js/)
    })

    test("a malicious priorFinding path (../../) is silently dropped", () => {
        // Place a file outside the repo. If sanitization were broken,
        // buildPayload would join repoRoot + "../" and read it.
        const parent = path.dirname(dir)
        const secretAbs = path.join(parent, "outside-secret.txt")
        writeFileSync(secretAbs, "SECRET\n")
        try {
            const out = buildPayload({
                repoRoot: dir,
                config: baseConfig(),
                priorFindings: [
                    {
                        file: "../outside-secret.txt",
                        line: 1,
                        severity: "blocker",
                    },
                ],
            })
            // No SECRET content in the prompt.
            expect(out.promptText).not.toMatch(/SECRET/)
            // No prior-finding-context entry for the bad path.
            expect(out.files.priorFindingContext).toEqual([])
            // The path doesn't appear in priorFindingPaths either.
            expect(out.priorFindingPaths).toEqual([])
        } finally {
            rmSync(secretAbs)
        }
    })

    test("force-include: deleted prior-finding file emits a 'deleted on disk' marker", () => {
        // File is in priorFindings but never existed at HEAD or on disk.
        const out = buildPayload({
            repoRoot: dir,
            config: baseConfig(),
            priorFindings: [
                { file: "ghost.txt", line: 1, severity: "blocker" },
            ],
        })
        expect(out.promptText).toMatch(
            /=== FILE: ghost.txt \(prior-finding, deleted on disk\) ===/
        )
        expect(out.files.priorFindingContext).toContainEqual(
            expect.objectContaining({ path: "ghost.txt", missing: true })
        )
    })

    test("headSha is the current HEAD", () => {
        const sha = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], {
            encoding: "utf8",
        }).trim()
        const out = buildPayload({ repoRoot: dir, config: baseConfig() })
        expect(out.headSha).toBe(sha)
    })
})

describe("buildPayload — head-fallback (clean working tree)", () => {
    let dir
    beforeEach(() => {
        dir = makeRepo()
        // Add a second commit so HEAD~1 exists and the fallback has
        // something to diff against.
        writeFileSync(path.join(dir, "feature.js"), "function f(){return 1}\n")
        execFileSync("git", ["-C", dir, "add", "."])
        execFileSync("git", ["-C", dir, "commit", "-qm", "add feature"])
    })
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true })
    })

    const fallbackOnConfig = () => ({
        ...baseConfig(),
        payload: { fallbackToHead: true },
    })

    test("clean tree + fallback off → empty payload (existing behavior)", () => {
        const out = buildPayload({ repoRoot: dir, config: baseConfig() })
        expect(out.empty).toBe(true)
        expect(out.source).toBe("working-tree")
        expect(out.baseSha).toBeNull()
    })

    test("clean tree + fallback ON → emits the HEAD~1..HEAD diff with source tag", () => {
        const out = buildPayload({ repoRoot: dir, config: fallbackOnConfig() })
        expect(out.empty).toBe(false)
        expect(out.source).toBe("head-fallback")
        expect(out.baseSha).toBeTruthy()
        // The latest commit added feature.js — that's what the
        // reviewer should see.
        expect(out.promptText).toMatch(/=== FILE: feature.js \(modified\) ===/)
        expect(out.files.modified.map((f) => f.path)).toContain("feature.js")
    })

    test("uncommitted working-tree change suppresses the fallback", () => {
        // Working tree is not clean → working-tree path wins even
        // when fallbackToHead is on.
        writeFileSync(path.join(dir, "scratch.txt"), "wip\n")
        const out = buildPayload({ repoRoot: dir, config: fallbackOnConfig() })
        expect(out.source).toBe("working-tree")
        expect(out.baseSha).toBeNull()
        // The untracked file is what's reviewed, not the commit range.
        expect(out.files.untracked.map((u) => u.path)).toContain("scratch.txt")
        expect(out.files.modified.map((f) => f.path)).not.toContain(
            "feature.js"
        )
    })

    test("two fallback runs at the same HEAD produce identical progressHash (cache stability)", () => {
        // The whole point: a Stop hook firing repeatedly at the same
        // HEAD must hit the existing NO_CHANGES cache. That requires
        // buildPayload to be deterministic for the same git state.
        const a = buildPayload({ repoRoot: dir, config: fallbackOnConfig() })
        const b = buildPayload({ repoRoot: dir, config: fallbackOnConfig() })
        expect(a.progressHash).toBe(b.progressHash)
        expect(a.promptHash).toBe(b.promptHash)
        expect(a.headSha).toBe(b.headSha)
        expect(a.baseSha).toBe(b.baseSha)
    })

    test("a new commit changes the headSha AND the progressHash (cache busts)", () => {
        const before = buildPayload({
            repoRoot: dir,
            config: fallbackOnConfig(),
        })
        // New commit — same fallback path, different content.
        writeFileSync(path.join(dir, "feature.js"), "function f(){return 2}\n")
        execFileSync("git", ["-C", dir, "add", "."])
        execFileSync("git", ["-C", dir, "commit", "-qm", "tweak"])
        const after = buildPayload({
            repoRoot: dir,
            config: fallbackOnConfig(),
        })
        expect(after.headSha).not.toBe(before.headSha)
        expect(after.progressHash).not.toBe(before.progressHash)
    })

    test("returns empty when working tree is clean AND no parent exists (initial commit)", () => {
        // Initialize a one-commit repo so HEAD~1 fails.
        const empty = realpathSync(mkdtempSync(path.join(tmpdir(), "fb-init-")))
        try {
            execFileSync("git", ["init", "-q", "-b", "main", empty])
            execFileSync("git", ["-C", empty, "config", "user.email", "t@t"])
            execFileSync("git", ["-C", empty, "config", "user.name", "t"])
            writeFileSync(path.join(empty, "a.txt"), "hi\n")
            execFileSync("git", ["-C", empty, "add", "."])
            execFileSync("git", ["-C", empty, "commit", "-qm", "first"])
            const out = buildPayload({
                repoRoot: empty,
                config: fallbackOnConfig(),
            })
            // No parent → no fallback possible → empty.
            expect(out.empty).toBe(true)
            expect(out.source).toBe("working-tree")
            expect(out.baseSha).toBeNull()
        } finally {
            rmSync(empty, { recursive: true, force: true })
        }
    })
})
