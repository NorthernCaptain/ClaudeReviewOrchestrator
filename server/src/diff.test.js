/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { jest } from "@jest/globals"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
    chmodSync,
    readFileSync,
    mkdtempSync,
    rmSync,
    symlinkSync,
    writeFileSync,
    mkdirSync,
    realpathSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
    buildPayload,
    currentHeadSha,
    isWorkingTreeClean,
    resolveFallbackBase,
    __test__,
} from "./diff.js"

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

describe("readRegularFile", () => {
    const { readRegularFile } = __test__
    let dir
    beforeEach(() => {
        dir = realpathSync(mkdtempSync(path.join(tmpdir(), "read-")))
    })
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true })
    })

    test("reads a regular file directly and through a symlink", () => {
        writeFileSync(path.join(dir, "f.txt"), "hello\n")
        symlinkSync("f.txt", path.join(dir, "l"))
        expect(readRegularFile(path.join(dir, "f.txt")).toString()).toBe(
            "hello\n"
        )
        expect(readRegularFile(path.join(dir, "l")).toString()).toBe("hello\n")
    })

    test("refuses a FIFO, directly or behind a symlink, without blocking", () => {
        const fifo = path.join(dir, "pipe")
        execFileSync("mkfifo", [fifo])
        symlinkSync("pipe", path.join(dir, "l"))
        expect(() => readRegularFile(fifo)).toThrow(/not a regular file/)
        expect(() => readRegularFile(path.join(dir, "l"))).toThrow(
            /not a regular file/
        )
    })

    test("refuses an endless device and a directory", () => {
        expect(() => readRegularFile("/dev/zero")).toThrow(/not a regular file/)
        expect(() => readRegularFile(dir)).toThrow(/not a regular file/)
    })

    test("propagates a missing path", () => {
        expect(() => readRegularFile(path.join(dir, "gone"))).toThrow(/ENOENT/)
    })
})

describe("hashRegularFile", () => {
    const { hashRegularFile } = __test__
    let dir
    beforeEach(() => {
        dir = realpathSync(mkdtempSync(path.join(tmpdir(), "hash-")))
    })
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true })
    })

    test("streams a multi-chunk file to the same digest as hashing it whole", () => {
        const content = Buffer.alloc(200 * 1024 + 7, "xyz")
        writeFileSync(path.join(dir, "big.bin"), content)
        expect(hashRegularFile(path.join(dir, "big.bin"))).toBe(
            createHash("sha256").update(content).digest("hex")
        )
    })

    test("hashes an empty file", () => {
        writeFileSync(path.join(dir, "empty"), "")
        expect(hashRegularFile(path.join(dir, "empty"))).toBe(
            createHash("sha256").update("").digest("hex")
        )
    })

    test("refuses a FIFO without blocking", () => {
        const fifo = path.join(dir, "pipe")
        execFileSync("mkfifo", [fifo])
        expect(() => hashRegularFile(fifo)).toThrow(/not a regular file/)
    })
})

describe("defaultFileMeta", () => {
    const { defaultFileMeta } = __test__
    let dir
    beforeEach(() => {
        dir = realpathSync(mkdtempSync(path.join(tmpdir(), "meta-")))
    })
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true })
    })

    test("reports regular and executable files in git mode terms", () => {
        const f = path.join(dir, "f.sh")
        writeFileSync(f, "x\n")
        chmodSync(f, 0o644)
        expect(defaultFileMeta(f)).toBe("100644")
        chmodSync(f, 0o755)
        expect(defaultFileMeta(f)).toBe("100755")
    })

    test("reports a symlink with its target, even when dangling", () => {
        const l = path.join(dir, "l")
        symlinkSync("nowhere.txt", l)
        expect(defaultFileMeta(l)).toBe("120000 nowhere.txt")
    })

    test("reports directories and missing paths", () => {
        expect(defaultFileMeta(dir)).toBe("040000")
        expect(defaultFileMeta(path.join(dir, "gone"))).toBe("MISSING")
    })
})

describe("submoduleRecords", () => {
    const { submoduleRecords } = __test__
    const zero = "0".repeat(40)
    const io = (over = {}) => ({
        fileMeta: () => "100644",
        hashFile: (abs) => `h(${abs})`,
        git: () => "",
        markIncomplete: jest.fn(),
        ...over,
    })
    // One changed nested gitlink "deep" at every level.
    const nestedGit =
        (patch = "Subproject commit aaa") =>
        (_cwd, args) => {
            if (args[0] !== "diff") return ""
            if (args.includes("--raw")) {
                return `:160000 160000 ${zero} ${zero} M\0deep\0`
            }
            return patch
        }

    test("skips a gitlink directory that is not an initialized repo", () => {
        const git = jest.fn()
        const out = submoduleRecords(
            "/r/sub",
            io({
                git,
                fileMeta: (abs) =>
                    abs === "/r/sub/.git" ? "MISSING" : "040000",
            })
        )
        expect(out).toBeNull()
        expect(git).not.toHaveBeenCalled()
    })

    test("records a git failure and marks the fingerprint incomplete", () => {
        const deps = io({
            git: () => {
                throw new Error("corrupt")
            },
        })
        expect(submoduleRecords("/r/sub", deps)).toEqual([
            ["git-error", "corrupt"],
        ])
        expect(deps.markIncomplete).toHaveBeenCalled()
    })

    test("hashes a nested gitlink's patch, which names its checked-out commit", () => {
        const a = submoduleRecords(
            "/r/sub",
            io({ git: nestedGit("Subproject commit aaa") })
        )
        const b = submoduleRecords(
            "/r/sub",
            io({ git: nestedGit("Subproject commit bbb") })
        )
        expect(a[0][5]).toMatch(/^[0-9a-f]{64}$/)
        expect(a[0][5]).not.toBe(b[0][5])
    })

    test("recurses into nested submodules and marks incomplete past the depth limit", () => {
        const deps = io({ git: nestedGit() })
        const out = submoduleRecords("/r/sub", deps)
        let depth = 0
        for (let level = out; level; level = level[0][6]) depth++
        expect(depth).toBe(4)
        expect(deps.markIncomplete).toHaveBeenCalledTimes(1)
    })

    test("leaves the fingerprint complete for an ordinary dirty submodule", () => {
        const deps = io({
            git: (_cwd, args) =>
                args.includes("--raw")
                    ? `:100644 100644 ${zero} ${zero} M\0s.txt\0`
                    : "",
        })
        submoduleRecords("/r/sub", deps)
        expect(deps.markIncomplete).not.toHaveBeenCalled()
    })
})

describe("parseRawZ", () => {
    const { parseRawZ } = __test__
    const zero = "0".repeat(40)
    const sha = "a".repeat(40)

    test("keys entries by path with modes and status, dropping object ids", () => {
        const out = parseRawZ(
            `:100644 100755 ${sha} ${zero} M\0run.sh\0` +
                `:000000 100644 ${zero} ${sha} A\0new.js\0`
        )
        expect(out.get("run.sh")).toEqual({
            srcMode: "100644",
            dstMode: "100755",
            status: "M",
            from: null,
        })
        expect(out.get("new.js").status).toBe("A")
    })

    test("keys rename and copy records by the destination path", () => {
        const out = parseRawZ(
            `:100644 100644 ${sha} ${sha} R087\0old.js\0new.js\0` +
                `:100644 100644 ${sha} ${sha} C100\0a.js\0b.js\0`
        )
        expect(out.has("old.js")).toBe(false)
        expect(out.get("new.js")).toMatchObject({
            status: "R087",
            from: "old.js",
        })
        expect(out.get("b.js").status).toBe("C100")
    })

    test("returns an empty map for empty output", () => {
        expect(parseRawZ("").size).toBe(0)
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

    test("progressHash covers promptHash plus each changed file's full content", () => {
        writeFileSync(path.join(dir, "x.txt"), "hello\n")
        const out = buildPayload({ repoRoot: dir, config: baseConfig() })
        const sha = (v) => createHash("sha256").update(v).digest("hex")
        expect(out.progressHash).toBe(
            sha(
                JSON.stringify([
                    out.promptHash,
                    [["x.txt", sha("hello\n"), "100644"]],
                ])
            )
        )
    })

    test("progressHash flips for a non-prior untracked file edited PAST maxFileBytes truncation", () => {
        // Untracked content has no git `index` header line to flip the
        // prompt, so only the full-content part can see this edit.
        const big = path.join(dir, "big.txt")
        const cfg = baseConfig()
        cfg.limits.maxFileBytes = 200
        writeFileSync(big, "a".repeat(2000) + "X\n")
        const before = buildPayload({ repoRoot: dir, config: cfg })
        writeFileSync(big, "a".repeat(2000) + "Y\n")
        const after = buildPayload({ repoRoot: dir, config: cfg })
        expect(before.truncated).toBe(true)
        expect(after.promptHash).toBe(before.promptHash)
        expect(after.progressHash).not.toBe(before.progressHash)
    })

    test("progressHash flips for an edit to a file omitted by maxFiles", () => {
        const cfg = baseConfig()
        cfg.limits.maxFiles = 1
        writeFileSync(path.join(dir, "a.txt"), "a\n")
        writeFileSync(path.join(dir, "b.txt"), "b\n")
        const before = buildPayload({ repoRoot: dir, config: cfg })
        writeFileSync(path.join(dir, "b.txt"), "b2\n")
        const after = buildPayload({ repoRoot: dir, config: cfg })
        expect(after.promptHash).toBe(before.promptHash)
        expect(after.progressHash).not.toBe(before.progressHash)
    })

    describe("git metadata on a file omitted by maxFiles", () => {
        // README.md sorts first and takes the only file slot, so the
        // path under test is emitted as a bare "omitted" header.
        const omittedConfig = () => {
            const cfg = baseConfig()
            cfg.limits.maxFiles = 1
            return cfg
        }
        const commitAll = (msg) => {
            execFileSync("git", ["-C", dir, "add", "."])
            execFileSync("git", ["-C", dir, "commit", "-qm", msg])
        }

        test("progressHash flips when only the executable bit changes", () => {
            writeFileSync(path.join(dir, "run.sh"), "echo hi\n")
            commitAll("script")
            writeFileSync(path.join(dir, "README.md"), "edited\n")
            writeFileSync(path.join(dir, "run.sh"), "echo hi there\n")
            const before = buildPayload({
                repoRoot: dir,
                config: omittedConfig(),
            })
            chmodSync(path.join(dir, "run.sh"), 0o755)
            const after = buildPayload({
                repoRoot: dir,
                config: omittedConfig(),
            })
            expect(after.promptText).toMatch(/run\.sh \(modified, omitted/)
            expect(after.promptHash).toBe(before.promptHash)
            expect(after.progressHash).not.toBe(before.progressHash)
        })

        test("progressHash flips when a symlink is retargeted to an identical file", () => {
            for (const t of ["t1.txt", "t2.txt", "t3.txt"]) {
                writeFileSync(path.join(dir, t), "same\n")
            }
            symlinkSync("t1.txt", path.join(dir, "lnk"))
            commitAll("link")
            const retarget = (t) => {
                rmSync(path.join(dir, "lnk"))
                symlinkSync(t, path.join(dir, "lnk"))
            }
            writeFileSync(path.join(dir, "README.md"), "edited\n")
            retarget("t2.txt")
            const before = buildPayload({
                repoRoot: dir,
                config: omittedConfig(),
            })
            retarget("t3.txt")
            const after = buildPayload({
                repoRoot: dir,
                config: omittedConfig(),
            })
            // Same bytes behind the link, same mode, same omitted header:
            // only the hashed patch can tell the targets apart.
            expect(after.promptText).toMatch(/lnk \(modified, omitted/)
            expect(after.promptHash).toBe(before.promptHash)
            expect(after.progressHash).not.toBe(before.progressHash)
        })

        // Adds a submodule at sub/ (committed), runs fn with helpers for
        // committing inside it, and removes its source repo afterwards.
        const withSubmodule = (fn) => {
            const sub = realpathSync(mkdtempSync(path.join(tmpdir(), "sub-")))
            try {
                execFileSync("git", ["init", "-q", "-b", "main", sub])
                execFileSync("git", ["-C", sub, "config", "user.email", "t@t"])
                execFileSync("git", ["-C", sub, "config", "user.name", "t"])
                writeFileSync(path.join(sub, "s.txt"), "s1\n")
                execFileSync("git", ["-C", sub, "add", "."])
                execFileSync("git", ["-C", sub, "commit", "-qm", "s1"])
                execFileSync(
                    "git",
                    [
                        "-C",
                        dir,
                        "-c",
                        "protocol.file.allow=always",
                        "submodule",
                        "add",
                        "-q",
                        sub,
                        "sub",
                    ],
                    { stdio: "ignore" }
                )
                commitAll("add sub")
                const inner = path.join(dir, "sub")
                for (const [k, v] of [
                    ["user.email", "t@t"],
                    ["user.name", "t"],
                ]) {
                    execFileSync("git", ["-C", inner, "config", k, v])
                }
                const innerCommit = (text) => {
                    writeFileSync(path.join(inner, "s.txt"), text)
                    execFileSync("git", ["-C", inner, "commit", "-qam", text])
                }
                writeFileSync(path.join(dir, "README.md"), "edited\n")
                fn({ inner, innerCommit })
            } finally {
                rmSync(sub, { recursive: true, force: true })
            }
        }
        const build = () =>
            buildPayload({ repoRoot: dir, config: omittedConfig() })

        test("progressHash flips when a submodule moves to another commit", () => {
            withSubmodule(({ innerCommit }) => {
                innerCommit("s2\n")
                const before = build()
                innerCommit("s3\n")
                const after = build()
                expect(after.promptText).toMatch(/sub \(modified, omitted/)
                expect(after.promptHash).toBe(before.promptHash)
                expect(after.progressHash).not.toBe(before.progressHash)
            })
        })

        test("progressHash flips when a nested submodule moves while its parent submodule stays dirty", () => {
            const env = {
                ...process.env,
                GIT_AUTHOR_NAME: "t",
                GIT_AUTHOR_EMAIL: "t@t",
                GIT_COMMITTER_NAME: "t",
                GIT_COMMITTER_EMAIL: "t@t",
            }
            const g = (cwd, ...args) =>
                execFileSync(
                    "git",
                    ["-C", cwd, "-c", "protocol.file.allow=always", ...args],
                    { env, stdio: "pipe" }
                )
            const srcs = realpathSync(mkdtempSync(path.join(tmpdir(), "nest-")))
            try {
                const nestedSrc = path.join(srcs, "nested")
                const subSrc = path.join(srcs, "sub")
                for (const repo of [nestedSrc, subSrc]) {
                    execFileSync("git", ["init", "-q", "-b", "main", repo])
                    writeFileSync(path.join(repo, "f.txt"), "1\n")
                    g(repo, "add", ".")
                    g(repo, "commit", "-qm", "init")
                }
                g(subSrc, "submodule", "add", "-q", nestedSrc, "nested")
                g(subSrc, "commit", "-qm", "nested")
                g(dir, "submodule", "add", "-q", subSrc, "sub")
                g(dir, "submodule", "update", "-q", "--init", "--recursive")
                commitAll("add sub")
                const sub = path.join(dir, "sub")
                const nested = path.join(sub, "nested")
                const nestedCommit = (text) => {
                    writeFileSync(path.join(nested, "f.txt"), text)
                    g(nested, "commit", "-qam", text)
                }
                writeFileSync(path.join(dir, "README.md"), "edited\n")
                // Keep the parent submodule dirty throughout.
                writeFileSync(path.join(sub, "f.txt"), "dirty\n")
                nestedCommit("2\n")
                const before = build()
                nestedCommit("3\n")
                const after = build()
                expect(after.promptHash).toBe(before.promptHash)
                expect(after.progressHash).not.toBe(before.progressHash)
                expect(after.fingerprintComplete).toBe(true)
            } finally {
                rmSync(srcs, { recursive: true, force: true })
            }
        })

        test("progressHash flips for further edits inside an already dirty submodule", () => {
            withSubmodule(({ inner, innerCommit }) => {
                innerCommit("s2\n")
                writeFileSync(path.join(inner, "s.txt"), "dirty 1\n")
                const dirty1 = build()
                writeFileSync(path.join(inner, "s.txt"), "dirty 2\n")
                const dirty2 = build()
                writeFileSync(path.join(inner, "extra.txt"), "new\n")
                const withUntracked = build()
                // The gitlink patch reads "<sha>-dirty" every time.
                expect(dirty2.promptHash).toBe(dirty1.promptHash)
                expect(dirty2.progressHash).not.toBe(dirty1.progressHash)
                expect(withUntracked.progressHash).not.toBe(dirty2.progressHash)
            })
        })
    })

    test("progressHash flips when only an untracked file's executable bit changes", () => {
        const script = path.join(dir, "new.sh")
        writeFileSync(script, "echo hi\n")
        const before = buildPayload({ repoRoot: dir, config: baseConfig() })
        chmodSync(script, 0o755)
        const after = buildPayload({ repoRoot: dir, config: baseConfig() })
        expect(after.promptHash).toBe(before.promptHash)
        expect(after.progressHash).not.toBe(before.progressHash)
    })

    test("progressHash flips when an untracked symlink is retargeted to an identical file", () => {
        writeFileSync(path.join(dir, "t1.txt"), "same\n")
        writeFileSync(path.join(dir, "t2.txt"), "same\n")
        execFileSync("git", ["-C", dir, "add", "."])
        execFileSync("git", ["-C", dir, "commit", "-qm", "targets"])
        const lnk = path.join(dir, "lnk")
        symlinkSync("t1.txt", lnk)
        const before = buildPayload({ repoRoot: dir, config: baseConfig() })
        rmSync(lnk)
        symlinkSync("t2.txt", lnk)
        const after = buildPayload({ repoRoot: dir, config: baseConfig() })
        expect(after.files.untracked.map((u) => u.path)).toContain("lnk")
        expect(after.promptHash).toBe(before.promptHash)
        expect(after.progressHash).not.toBe(before.progressHash)
    })

    describe("paths whose headers the payload limit dropped", () => {
        const commitAll = (msg) => {
            execFileSync("git", ["-C", dir, "add", "-A"])
            execFileSync("git", ["-C", dir, "commit", "-qm", msg])
        }
        // README.md's block is emitted first; sizing maxPayloadBytes to
        // exactly that block leaves no room for any later header.
        const tightConfig = () => {
            writeFileSync(path.join(dir, "README.md"), "edited\n")
            const probe = buildPayload({ repoRoot: dir, config: baseConfig() })
            const cfg = baseConfig()
            cfg.limits.maxPayloadBytes = probe.totalBytes
            return cfg
        }
        const git = (...args) => execFileSync("git", ["-C", dir, ...args])

        test("progressHash flips when a different tracked file is deleted", () => {
            writeFileSync(path.join(dir, "a.txt"), "a\n")
            writeFileSync(path.join(dir, "b.txt"), "b\n")
            commitAll("files")
            const cfg = tightConfig()
            rmSync(path.join(dir, "a.txt"))
            const before = buildPayload({ repoRoot: dir, config: cfg })
            git("checkout", "--", "a.txt")
            rmSync(path.join(dir, "b.txt"))
            const after = buildPayload({ repoRoot: dir, config: cfg })
            expect(before.files.deleted).toEqual(["a.txt"])
            expect(after.files.deleted).toEqual(["b.txt"])
            expect(after.promptText).not.toMatch(/deleted/)
            expect(after.promptHash).toBe(before.promptHash)
            expect(after.progressHash).not.toBe(before.progressHash)
        })

        test("a symlink target can't forge another path's record", () => {
            // Under newline-joined "path:hash:mode" records, a dangling
            // link whose target spells out m.txt's record hashed the same
            // as the link plus a real m.txt.
            const cfg = tightConfig()
            const sha = (v) => createHash("sha256").update(v).digest("hex")
            const lnk = path.join(dir, "lnk")
            symlinkSync("x", lnk)
            writeFileSync(path.join(dir, "m.txt"), "c\n")
            const before = buildPayload({ repoRoot: dir, config: cfg })
            rmSync(path.join(dir, "m.txt"))
            rmSync(lnk)
            symlinkSync(`x\nm.txt:${sha("c\n")}:100644`, lnk)
            const after = buildPayload({ repoRoot: dir, config: cfg })
            expect(before.files.untracked.map((u) => u.path)).toContain("m.txt")
            expect(after.promptHash).toBe(before.promptHash)
            expect(after.progressHash).not.toBe(before.progressHash)
        })

        test("progressHash flips when a different source is renamed into an identical file", () => {
            writeFileSync(path.join(dir, "x.txt"), "same content\n")
            writeFileSync(path.join(dir, "z.txt"), "same content\n")
            commitAll("sources")
            const cfg = tightConfig()
            git("mv", "x.txt", "y.txt")
            const before = buildPayload({ repoRoot: dir, config: cfg })
            git("mv", "y.txt", "x.txt")
            git("mv", "z.txt", "y.txt")
            const after = buildPayload({ repoRoot: dir, config: cfg })
            expect(before.files.renamed.map((r) => r.from)).toEqual(["x.txt"])
            expect(after.files.renamed.map((r) => r.from)).toEqual(["z.txt"])
            expect(after.promptHash).toBe(before.promptHash)
            expect(after.progressHash).not.toBe(before.progressHash)
        })
    })

    test("completes when changed symlinks point at a FIFO or an endless device", () => {
        writeFileSync(path.join(dir, "t.txt"), "t\n")
        symlinkSync("t.txt", path.join(dir, "tracked-link"))
        execFileSync("git", ["-C", dir, "add", "."])
        execFileSync("git", ["-C", dir, "commit", "-qm", "link"])
        execFileSync("mkfifo", [path.join(dir, "pipe")])
        rmSync(path.join(dir, "tracked-link"))
        symlinkSync("pipe", path.join(dir, "tracked-link"))
        symlinkSync("/dev/zero", path.join(dir, "untracked-link"))
        const out = buildPayload({ repoRoot: dir, config: baseConfig() })
        expect(out.files.modified.map((f) => f.path)).toContain("tracked-link")
        expect(typeof out.progressHash).toBe("string")
    })

    describe("blockHashes", () => {
        const commitAll = (msg) => {
            execFileSync("git", ["-C", dir, "add", "-A"])
            execFileSync("git", ["-C", dir, "commit", "-qm", msg])
        }

        test("a prior-free build of the same tree shows a subset when the prior file is in the diff", () => {
            writeFileSync(path.join(dir, "a.js"), "one\n")
            commitAll("a")
            writeFileSync(path.join(dir, "a.js"), "two\n")
            writeFileSync(path.join(dir, "README.md"), "edited\n")
            const priorFindings = [{ file: "a.js", severity: "major" }]
            const reviewed = buildPayload({
                repoRoot: dir,
                config: baseConfig(),
                priorFindings,
            })
            const priorFree = buildPayload({
                repoRoot: dir,
                config: baseConfig(),
            })
            expect(priorFree.blockHashes.length).toBeGreaterThan(0)
            expect(
                priorFree.blockHashes.every((h) =>
                    reviewed.blockHashes.includes(h)
                )
            ).toBe(true)
        })

        test("a prior-free build exposes a block the reviewed one omitted when an ignored flagged file used the budget", () => {
            writeFileSync(path.join(dir, "deps.lock"), "v1\n")
            writeFileSync(path.join(dir, "z.txt"), "z1\n")
            commitAll("files")
            writeFileSync(path.join(dir, "deps.lock"), "v2 ".repeat(300) + "\n")
            const priorFindings = [{ file: "deps.lock", severity: "major" }]
            const cfg = baseConfig()
            // Budget fits the flagged lock file's block and nothing more.
            cfg.limits.maxPayloadBytes =
                buildPayload({ repoRoot: dir, config: cfg, priorFindings })
                    .totalBytes + 10
            writeFileSync(path.join(dir, "z.txt"), "z2\n")
            const reviewed = buildPayload({
                repoRoot: dir,
                config: cfg,
                priorFindings,
            })
            const priorFree = buildPayload({ repoRoot: dir, config: cfg })
            expect(reviewed.promptText).not.toMatch(/z\.txt/)
            expect(priorFree.promptText).toMatch(/z\.txt \(modified\)/)
            expect(
                priorFree.blockHashes.every((h) =>
                    reviewed.blockHashes.includes(h)
                )
            ).toBe(false)
        })
    })

    test("hashes tracked modified files without reading them whole", () => {
        writeFileSync(path.join(dir, "asset.bin"), Buffer.from([0, 1, 2]))
        execFileSync("git", ["-C", dir, "add", "."])
        execFileSync("git", ["-C", dir, "commit", "-qm", "asset"])
        writeFileSync(path.join(dir, "asset.bin"), Buffer.from([0, 1, 3]))
        const readFile = jest.fn(readFileSync)
        const hashFile = jest.fn(() => "digest")
        buildPayload({
            repoRoot: dir,
            config: baseConfig(),
            readFile,
            hashFile,
        })
        const abs = path.join(dir, "asset.bin")
        expect(hashFile).toHaveBeenCalledWith(abs)
        expect(readFile).not.toHaveBeenCalledWith(abs)
    })

    test("progressHash ignores edits to ignorePaths files", () => {
        writeFileSync(path.join(dir, "x.txt"), "hello\n")
        writeFileSync(path.join(dir, "deps.lock"), "v1\n")
        const before = buildPayload({ repoRoot: dir, config: baseConfig() })
        writeFileSync(path.join(dir, "deps.lock"), "v2\n")
        const after = buildPayload({ repoRoot: dir, config: baseConfig() })
        expect(after.progressHash).toBe(before.progressHash)
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

describe("buildPayload — unborn branch (no commits yet)", () => {
    let dir
    const emptyTree = () =>
        execFileSync("git", [
            "-C",
            dir,
            "hash-object",
            "-t",
            "tree",
            "/dev/null",
        ])
            .toString()
            .trim()
    beforeEach(() => {
        dir = realpathSync(mkdtempSync(path.join(tmpdir(), "unborn-")))
        execFileSync("git", ["init", "-q", "-b", "main", dir])
        execFileSync("git", ["-C", dir, "config", "user.email", "t@t"])
        execFileSync("git", ["-C", dir, "config", "user.name", "t"])
    })
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true })
    })

    test("diffs staged and untracked files against the empty tree", () => {
        writeFileSync(path.join(dir, "app.js"), "one\n")
        execFileSync("git", ["-C", dir, "add", "."])
        // An unstaged edit on top of the staged file is reviewed too.
        writeFileSync(path.join(dir, "app.js"), "one\ntwo\n")
        writeFileSync(path.join(dir, "notes.txt"), "loose\n")
        const out = buildPayload({ repoRoot: dir, config: baseConfig() })
        expect(out.headSha).toBe(emptyTree())
        expect(out.source).toBe("working-tree")
        expect(out.files.modified.map((f) => f.path)).toEqual(["app.js"])
        expect(out.files.untracked.map((u) => u.path)).toEqual(["notes.txt"])
        expect(out.promptText).toMatch(/\+one\n\+two/)
    })

    test("keeps a stable fingerprint until something changes, then the first commit moves headSha", () => {
        writeFileSync(path.join(dir, "app.js"), "one\n")
        execFileSync("git", ["-C", dir, "add", "."])
        const a = buildPayload({ repoRoot: dir, config: baseConfig() })
        const b = buildPayload({ repoRoot: dir, config: baseConfig() })
        expect(b.progressHash).toBe(a.progressHash)
        writeFileSync(path.join(dir, "app.js"), "changed\n")
        const c = buildPayload({ repoRoot: dir, config: baseConfig() })
        expect(c.progressHash).not.toBe(a.progressHash)
        execFileSync("git", ["-C", dir, "commit", "-qam", "first"])
        const d = buildPayload({ repoRoot: dir, config: baseConfig() })
        expect(d.headSha).not.toBe(emptyTree())
        expect(d.empty).toBe(true)
    })

    test("an empty unborn repo with fallbackToHead on builds an empty payload", () => {
        const out = buildPayload({
            repoRoot: dir,
            config: { ...baseConfig(), payload: { fallbackToHead: true } },
        })
        expect(out.empty).toBe(true)
        expect(out.source).toBe("working-tree")
    })

    test.each([
        ["exists but can't be read", 1],
        ["exists, yet HEAD still won't resolve", 0],
        ["can't be checked by an old git without --exists", 129],
    ])("rethrows the HEAD error when the branch ref %s", (_label, status) => {
        const headError = new Error("bad HEAD")
        const git = (_cwd, args) => {
            if (args[0] === "rev-parse") throw headError
            if (args[0] === "symbolic-ref") return "refs/heads/main\n"
            if (args[0] === "show-ref") {
                if (status === 0) return ""
                throw Object.assign(new Error("show-ref"), { status })
            }
            throw new Error(`unexpected git ${args.join(" ")}`)
        }
        expect(() =>
            buildPayload({ repoRoot: dir, config: baseConfig(), git })
        ).toThrow(headError)
    })

    test("a corrupt branch ref is reported, not reviewed against the empty tree", () => {
        writeFileSync(path.join(dir, "a.js"), "x\n")
        execFileSync("git", ["-C", dir, "add", "."])
        execFileSync("git", ["-C", dir, "commit", "-qm", "a"])
        writeFileSync(
            path.join(dir, ".git", "refs", "heads", "main"),
            "garbage\n"
        )
        expect(() =>
            buildPayload({ repoRoot: dir, config: baseConfig() })
        ).toThrow()
    })

    test("rethrows when HEAD is neither a commit nor a branch", () => {
        const headError = new Error("bad HEAD")
        const git = (_cwd, args) => {
            if (args[0] === "rev-parse") throw headError
            throw new Error("not a symbolic ref")
        }
        expect(() =>
            buildPayload({ repoRoot: dir, config: baseConfig(), git })
        ).toThrow(headError)
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

    test("an edit to only an ignored file still falls back to the commit range", () => {
        const clean = buildPayload({
            repoRoot: dir,
            config: fallbackOnConfig(),
        })
        writeFileSync(path.join(dir, "deps.lock"), "v2\n")
        const out = buildPayload({ repoRoot: dir, config: fallbackOnConfig() })
        expect(out.source).toBe("head-fallback")
        expect(out.empty).toBe(false)
        // Same range, same fingerprint: a repeat Stop hook hits NO_CHANGES.
        expect(out.progressHash).toBe(clean.progressHash)
    })

    test("an ignored file a prior finding flagged is reviewable, so no fallback", () => {
        writeFileSync(path.join(dir, "deps.lock"), "v2\n")
        const out = buildPayload({
            repoRoot: dir,
            config: fallbackOnConfig(),
            priorFindings: [{ file: "deps.lock", severity: "major" }],
        })
        expect(out.source).toBe("working-tree")
        expect(out.files.untracked.map((u) => u.path)).toContain("deps.lock")
    })

    test("an ignored-only edit with fallback off leaves an empty working-tree payload", () => {
        writeFileSync(path.join(dir, "deps.lock"), "v2\n")
        const out = buildPayload({ repoRoot: dir, config: baseConfig() })
        expect(out.source).toBe("working-tree")
        expect(out.empty).toBe(true)
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

describe("prior-free builds of the same tree", () => {
    let dir
    beforeEach(() => {
        dir = realpathSync(mkdtempSync(path.join(tmpdir(), "pf-")))
        execFileSync("git", ["init", "-q", "-b", "main", dir])
        execFileSync("git", ["-C", dir, "config", "user.email", "t@t"])
        execFileSync("git", ["-C", dir, "config", "user.name", "t"])
        writeFileSync(path.join(dir, "a.js"), "one\n")
        writeFileSync(path.join(dir, "b.js"), "stable\n")
        execFileSync("git", ["-C", dir, "add", "."])
        execFileSync("git", ["-C", dir, "commit", "-qm", "init"])
        writeFileSync(path.join(dir, "a.js"), "two\n")
        writeFileSync(path.join(dir, "new.js"), "fresh\n")
    })
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true })
    })
    // b.js is unchanged vs HEAD, so the prior forces a context block
    // into the payload that a prior-free build doesn't have.
    const priors = [{ file: "b.js", severity: "major" }]
    const subset = (a, b) => a.every((h) => b.includes(h))

    test("on an unchanged tree shows only blocks and fingerprints the reviewed build had", () => {
        const reviewed = buildPayload({
            repoRoot: dir,
            config: baseConfig(),
            priorFindings: priors,
        })
        const priorFree = buildPayload({ repoRoot: dir, config: baseConfig() })
        expect(reviewed.progressHash).not.toBe(priorFree.progressHash)
        expect(subset(priorFree.blockHashes, reviewed.blockHashes)).toBe(true)
        expect(subset(priorFree.contentHashes, reviewed.contentHashes)).toBe(
            true
        )
    })

    test("an edit between the two builds hidden from the prompt surfaces as an unseen fingerprint", () => {
        const cfg = baseConfig()
        cfg.limits.maxFileBytes = 200
        writeFileSync(path.join(dir, "new.js"), "a".repeat(2000) + "X\n")
        const reviewed = buildPayload({
            repoRoot: dir,
            config: cfg,
            priorFindings: priors,
        })
        writeFileSync(path.join(dir, "new.js"), "a".repeat(2000) + "Y\n")
        const priorFree = buildPayload({ repoRoot: dir, config: cfg })
        expect(subset(priorFree.blockHashes, reviewed.blockHashes)).toBe(true)
        expect(subset(priorFree.contentHashes, reviewed.contentHashes)).toBe(
            false
        )
    })
})

describe("isWorkingTreeClean", () => {
    let dir
    beforeEach(() => {
        dir = realpathSync(mkdtempSync(path.join(tmpdir(), "clean-")))
        execFileSync("git", ["init", "-q", "-b", "main", dir])
        execFileSync("git", ["-C", dir, "config", "user.email", "t@t"])
        execFileSync("git", ["-C", dir, "config", "user.name", "t"])
        writeFileSync(path.join(dir, "a.js"), "x\n")
        execFileSync("git", ["-C", dir, "add", "."])
        execFileSync("git", ["-C", dir, "commit", "-qm", "init"])
    })
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true })
    })

    test("returns true on a freshly committed tree", () => {
        expect(isWorkingTreeClean(dir)).toBe(true)
    })

    test("returns false when a tracked file is modified", () => {
        writeFileSync(path.join(dir, "a.js"), "y\n")
        expect(isWorkingTreeClean(dir)).toBe(false)
    })

    test("returns false when an untracked file exists", () => {
        writeFileSync(path.join(dir, "scratch.txt"), "wip\n")
        expect(isWorkingTreeClean(dir)).toBe(false)
    })

    test("returns false for an untracked file even with status.showUntrackedFiles=no", () => {
        execFileSync("git", [
            "-C",
            dir,
            "config",
            "status.showUntrackedFiles",
            "no",
        ])
        writeFileSync(path.join(dir, "scratch.txt"), "wip\n")
        expect(isWorkingTreeClean(dir)).toBe(false)
    })

    test("returns false when git fails (defer to slow path)", () => {
        const bogus = path.join(dir, "not-a-repo")
        // No .git dir → git exits non-zero.
        expect(isWorkingTreeClean(bogus)).toBe(false)
    })

    test("honors an injected git function (no real subprocess needed)", () => {
        const fakeGit = jest.fn(() => "") // empty = clean
        expect(isWorkingTreeClean("/anywhere", fakeGit)).toBe(true)
        expect(fakeGit).toHaveBeenCalledWith("/anywhere", [
            "status",
            "--porcelain",
            "-z",
            "--untracked-files=normal",
        ])
        const dirtyGit = jest.fn(() => " M file.txt\0?? scratch.txt\0")
        expect(isWorkingTreeClean("/anywhere", dirtyGit)).toBe(false)
    })
})

describe("resolveFallbackBase", () => {
    test("prefers the merge-base with the upstream branch", () => {
        const git = jest.fn((_root, args) => {
            if (args[0] === "merge-base") return "upbase\n"
            return "parent\n"
        })
        expect(resolveFallbackBase("/repo", git)).toBe("upbase")
        expect(git).toHaveBeenCalledWith("/repo", [
            "merge-base",
            "HEAD",
            "@{upstream}",
        ])
    })

    test("falls back to HEAD~1 when there is no upstream", () => {
        const git = jest.fn((_root, args) => {
            if (args[0] === "merge-base") throw new Error("no upstream")
            return "parent\n"
        })
        expect(resolveFallbackBase("/repo", git)).toBe("parent")
    })

    test("returns null when neither resolves", () => {
        const git = jest.fn(() => {
            throw new Error("initial commit")
        })
        expect(resolveFallbackBase("/repo", git)).toBeNull()
    })
})

describe("currentHeadSha", () => {
    let dir
    beforeEach(() => {
        dir = realpathSync(mkdtempSync(path.join(tmpdir(), "head-")))
        execFileSync("git", ["init", "-q", "-b", "main", dir])
        execFileSync("git", ["-C", dir, "config", "user.email", "t@t"])
        execFileSync("git", ["-C", dir, "config", "user.name", "t"])
        writeFileSync(path.join(dir, "a.js"), "x\n")
        execFileSync("git", ["-C", dir, "add", "."])
        execFileSync("git", ["-C", dir, "commit", "-qm", "init"])
    })
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true })
    })

    test("returns the current HEAD SHA after a commit", () => {
        const sha = currentHeadSha(dir)
        const expected = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], {
            encoding: "utf8",
        }).trim()
        expect(sha).toBe(expected)
        expect(sha).toMatch(/^[0-9a-f]{40}$/)
    })

    test("reflects a new commit (HEAD moves)", () => {
        const before = currentHeadSha(dir)
        writeFileSync(path.join(dir, "b.js"), "y\n")
        execFileSync("git", ["-C", dir, "add", "."])
        execFileSync("git", ["-C", dir, "commit", "-qm", "second"])
        const after = currentHeadSha(dir)
        expect(after).not.toBe(before)
    })

    test("returns null when git fails (non-repo path)", () => {
        const bogus = path.join(dir, "not-a-repo")
        expect(currentHeadSha(bogus)).toBeNull()
    })

    test("honors an injected git function", () => {
        const fakeGit = jest.fn(() => "deadbeef\n")
        expect(currentHeadSha("/x", fakeGit)).toBe("deadbeef")
        expect(fakeGit).toHaveBeenCalledWith("/x", ["rev-parse", "HEAD"])
    })
})
