/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
    closeSync,
    constants,
    fstatSync,
    lstatSync,
    openSync,
    readFileSync,
    readSync,
    readlinkSync,
} from "node:fs"
import path from "node:path"
import { minimatch } from "minimatch"

const defaultGit = (cwd, args) =>
    execFileSync("git", ["-C", cwd, ...args], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
    })

// Parses `git diff --raw -z` into path → { srcMode, dstMode, status,
// from }. Rename/copy records carry two paths; they are keyed by the
// destination, with the source kept as `from` (null otherwise).
// Object ids are dropped: for working-tree entries git reports either
// zeros or the index blob depending on its stat cache, so they would
// flip the hash without any real change.
const parseRawZ = (output) => {
    const meta = new Map()
    const parts = output.split("\0")
    let i = 0
    while (i < parts.length) {
        const head = parts[i++]
        if (!head?.startsWith(":")) continue
        const [srcMode, dstMode, , , status = ""] = head.slice(1).split(" ")
        const twoPaths = status[0] === "R" || status[0] === "C"
        const from = twoPaths ? parts[i++] : null
        const file = parts[i++]
        if (file) meta.set(file, { srcMode, dstMode, status, from })
    }
    return meta
}

// Gitlinks and symlinks diff as metadata, not file bytes: a submodule
// reads as a directory and a symlink reads as its target's content.
const METADATA_MODES = new Set(["160000", "120000"])

const hashOrMissing = (hashFile, abs) => {
    try {
        return hashFile(abs)
    } catch {
        return "MISSING"
    }
}

// Once a submodule is "-dirty", further edits inside it leave its gitlink
// mode, status and patch unchanged, so fingerprint its working tree the
// way the top level is: each changed or untracked path with its content
// hash and lstat metadata, plus the full patch for nested gitlinks and
// symlinks (a nested submodule's checked-out commit isn't in any bytes),
// recursing into nested submodules. Only an initialized submodule (its
// own .git) is entered — git run in an empty gitlink directory would
// resolve to the superproject. Where a working tree can't be scanned (git
// failed, or nesting passed MAX_SUBMODULE_DEPTH) io.markIncomplete() is
// called so the caller refuses a cache hit instead of trusting a gap.
const MAX_SUBMODULE_DEPTH = 4
const submoduleRecords = (subAbs, io, depth = 1) => {
    if (io.fileMeta(path.join(subAbs, ".git")) === "MISSING") return null
    try {
        const raw = parseRawZ(
            io.git(subAbs, ["diff", "HEAD", "--raw", "-z", "--no-abbrev"])
        )
        const untracked = io
            .git(subAbs, ["ls-files", "--others", "--exclude-standard", "-z"])
            .split("\0")
            .filter(Boolean)
        return [...new Set([...raw.keys(), ...untracked])].sort().map((p) => {
            const abs = path.join(subAbs, p)
            const m = raw.get(p)
            const patch = METADATA_MODES.has(m?.dstMode)
                ? sha256Hex(io.git(subAbs, ["diff", "HEAD", "--", p]))
                : null
            let nested = null
            if (m?.dstMode === "160000") {
                if (depth < MAX_SUBMODULE_DEPTH) {
                    nested = submoduleRecords(abs, io, depth + 1)
                } else {
                    io.markIncomplete()
                }
            }
            return [
                p,
                hashOrMissing(io.hashFile, abs),
                io.fileMeta(abs),
                m?.status ?? "untracked",
                m?.from ?? null,
                patch,
                nested,
            ]
        })
    } catch (err) {
        io.markIncomplete()
        return [["git-error", String(err?.message ?? err)]]
    }
}

const parseNameStatusZ = (output) => {
    const parts = output.split("\0")
    const result = {
        modified: [],
        added: [],
        deleted: [],
        renamed: [],
        typeChanged: [],
    }
    let i = 0
    while (i < parts.length) {
        const status = parts[i]
        i++
        if (!status) continue
        const code = status[0]
        if (code === "R" || code === "C") {
            const from = parts[i++]
            const to = parts[i++]
            if (from && to) {
                result.renamed.push({ from, to })
            }
        } else {
            const file = parts[i++]
            if (!file) continue
            switch (code) {
                case "M":
                    result.modified.push(file)
                    break
                case "A":
                    result.added.push(file)
                    break
                case "D":
                    result.deleted.push(file)
                    break
                case "T":
                    result.typeChanged.push(file)
                    break
                default:
                    break
            }
        }
    }
    return result
}

export const isBinary = (buffer) => {
    const sample = buffer.subarray(0, Math.min(buffer.length, 8192))
    for (let i = 0; i < sample.length; i++) {
        if (sample[i] === 0) return true
    }
    return false
}

const matchesAny = (file, patterns) =>
    patterns.some((pat) => minimatch(file, pat, { dot: true }))

const filterIgnored = (files, patterns) =>
    files.filter((f) => !matchesAny(f, patterns))

const truncateText = (text, max) => {
    if (text.length <= max) return { text, truncated: false }
    return {
        text: text.slice(0, max) + "\n... (truncated)\n",
        truncated: true,
    }
}

const makeHeader = (file, label) => `=== FILE: ${file} (${label}) ===`

const sha256Hex = (input) => {
    const h = createHash("sha256")
    h.update(input)
    return h.digest("hex")
}

// Validate a Codex-supplied file path so it cannot escape repoRoot via
// "..", absolute paths, backslash traversal, or null bytes. Returns the
// normalized POSIX path on success, or null if the input is unsafe.
//
// This is a security boundary — Codex output is untrusted data. Callers
// MUST drop any finding for which this returns null, both when storing
// findings into state and when re-reading those findings on the next
// round. Belt-and-braces validation at both sites is intentional.
export const sanitizeFindingPath = (file, repoRoot) => {
    if (typeof file !== "string" || file.length === 0) return null
    if (file.includes("\0") || file.includes("\\")) return null
    if (path.isAbsolute(file)) return null
    const norm = path.posix.normalize(file)
    if (norm === "." || norm === "" || norm.startsWith("/")) return null
    if (norm === ".." || norm.startsWith("../")) return null
    // Resolve against repoRoot and require the result to stay inside.
    const resolved = path.resolve(repoRoot, norm)
    const rel = path.relative(repoRoot, resolved)
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null
    return norm
}

const collectPriorFindingPaths = (priorFindings, repoRoot) => {
    const set = new Set()
    for (const f of priorFindings) {
        if (!f || typeof f.file !== "string") continue
        const safe = sanitizeFindingPath(f.file, repoRoot)
        if (safe !== null) set.add(safe)
    }
    return set
}

// Opens a regular file, following symlinks, and refuses anything else.
// The fd is opened non-blocking and checked with fstat before any read,
// so a FIFO or device — directly or behind a symlink — can neither block
// forever nor stream without end, and the path can't be swapped between
// the check and the read.
const openRegularFile = (abs) => {
    const fd = openSync(abs, constants.O_RDONLY | constants.O_NONBLOCK)
    try {
        if (fstatSync(fd).isFile()) return fd
    } catch (err) {
        closeSync(fd)
        throw err
    }
    closeSync(fd)
    throw Object.assign(new Error(`not a regular file: ${abs}`), {
        code: "ENOTREG",
    })
}

const readRegularFile = (abs) => {
    const fd = openRegularFile(abs)
    try {
        return readFileSync(fd)
    } finally {
        closeSync(fd)
    }
}

// sha256 of a regular file, streamed in fixed-size chunks so a large
// asset that never reaches the prompt is never held in memory either.
const HASH_CHUNK_BYTES = 64 * 1024
const hashRegularFile = (abs) => {
    const fd = openRegularFile(abs)
    try {
        const h = createHash("sha256")
        const chunk = Buffer.allocUnsafe(HASH_CHUNK_BYTES)
        let n
        while ((n = readSync(fd, chunk, 0, chunk.length, null)) > 0) {
            h.update(chunk.subarray(0, n))
        }
        return h.digest("hex")
    } finally {
        closeSync(fd)
    }
}

// Filesystem mode for untracked paths, which have no `git diff --raw`
// entry: the executable bit or a symlink's target, neither of which shows
// in the bytes read through the path. Uses git's mode vocabulary.
const defaultFileMeta = (abs) => {
    try {
        const st = lstatSync(abs)
        if (st.isSymbolicLink()) return `120000 ${readlinkSync(abs)}`
        if (st.isDirectory()) return "040000"
        return st.mode & 0o111 ? "100755" : "100644"
    } catch {
        return "MISSING"
    }
}

// Reads a file as raw bytes for hashing. Returns null on missing.
const readBytesOrNull = (readFile, abs) => {
    try {
        return readFile(abs)
    } catch {
        return null
    }
}

// Shallow "is the working tree clean?" probe used by the change-
// notification fast path. ONE `git status --porcelain -z` call —
// reports modifications, additions, deletions, renames, and untracked
// (non-ignored) files all in a single command. Empty output = clean.
// --untracked-files overrides a user's status.showUntrackedFiles=no,
// which would otherwise hide files buildPayload's ls-files picks up.
// Returns true only when stdout is empty. Any error is treated as "not
// clean" so the fast path defers to the slow path when in doubt.
//
// ~5ms in practice — much cheaper than buildPayload's full sweep.
export const isWorkingTreeClean = (repoRoot, git = defaultGit) => {
    try {
        const out = git(repoRoot, [
            "status",
            "--porcelain",
            "-z",
            "--untracked-files=normal",
        ])
        return out.length === 0
    } catch {
        return false
    }
}

// Current HEAD SHA. Used by the fast path to verify HEAD hasn't moved
// since the cached baseline was captured — a commit / pull / rebase
// done outside Claude (e.g. in a terminal) would leave the working
// tree clean while invalidating the cache. Returns null on error so
// callers must defer to the slow path when in doubt.
export const currentHeadSha = (repoRoot, git = defaultGit) => {
    try {
        return git(repoRoot, ["rev-parse", "HEAD"]).trim() || null
    } catch {
        return null
    }
}

// HEAD's commit, or — on an unborn branch (a new repo before its first
// commit, where files may already be staged) — git's empty tree, so the
// whole index and working tree diff as additions. The returned sha stands
// in as headSha: stable until the first commit, which then changes it.
// "Unborn" requires HEAD to name a branch whose ref does not exist:
// `show-ref --exists` exits 2 only for a missing ref, so a ref that exists
// but can't be read (or a git too old for --exists) rethrows the original
// HEAD error instead of silently reviewing against the empty tree.
const REF_MISSING_STATUS = 2
const resolveHead = (repoRoot, git) => {
    try {
        return {
            sha: git(repoRoot, ["rev-parse", "HEAD"]).trim(),
            unborn: false,
        }
    } catch (err) {
        let missing = false
        try {
            const ref = git(repoRoot, ["symbolic-ref", "-q", "HEAD"]).trim()
            git(repoRoot, ["show-ref", "--exists", ref])
        } catch (refErr) {
            missing = refErr?.status === REF_MISSING_STATUS
        }
        if (!missing) throw err
        return {
            sha: git(repoRoot, [
                "hash-object",
                "-t",
                "tree",
                "/dev/null",
            ]).trim(),
            unborn: true,
        }
    }
}

// Resolve a base commit for the head-fallback. Prefer the merge-base
// with the upstream branch (so a feature branch with N unreviewed
// commits is reviewed as one range), fall back to HEAD~1 for branches
// without an upstream. Returns null when neither resolves (e.g. an
// initial commit with no parent). Also used by the review fast path:
// the merge-base can move (upstream changed or force-pushed) while HEAD
// stays put, so a cached head-fallback verdict is only valid for the
// same base.
export const resolveFallbackBase = (repoRoot, git = defaultGit) => {
    const tryGit = (args) => {
        try {
            return git(repoRoot, args).trim()
        } catch {
            return ""
        }
    }
    const upstream = tryGit(["merge-base", "HEAD", "@{upstream}"])
    if (upstream) return upstream
    const parent = tryGit(["rev-parse", "HEAD~1"])
    return parent || null
}

export const buildPayload = ({
    repoRoot,
    config,
    priorFindings = [],
    git = defaultGit,
    readFile = readRegularFile,
    fileMeta = defaultFileMeta,
    hashFile = hashRegularFile,
}) => {
    const head = resolveHead(repoRoot, git)
    const headSha = head.sha
    const workingTreeRef = head.unborn ? head.sha : "HEAD"
    const priorFindingPaths = collectPriorFindingPaths(priorFindings, repoRoot)
    const isPrior = (p) => priorFindingPaths.has(p)

    const nameStatusOut = git(repoRoot, [
        "diff",
        workingTreeRef,
        "--name-status",
        "-z",
    ])
    const untrackedOut = git(repoRoot, [
        "ls-files",
        "--others",
        "--exclude-standard",
        "-z",
    ])
    const untrackedAll = untrackedOut.split("\0").filter(Boolean)

    const ignorePaths = config.ignorePaths
    const keepOrPrior = (p) => isPrior(p) || !matchesAny(p, ignorePaths)
    // The reviewable subset of a change set: ignorePaths filtered out,
    // except where a prior finding forces a path back in.
    const selectReviewable = (changed, untracked) => ({
        modifiedSet: [
            ...changed.modified,
            ...changed.added,
            ...changed.typeChanged,
        ].filter(keepOrPrior),
        deletedSet: changed.deleted.filter(keepOrPrior),
        renamedSet: changed.renamed.filter(
            (r) =>
                isPrior(r.to) ||
                isPrior(r.from) ||
                !matchesAny(r.to, ignorePaths)
        ),
        untrackedSet: untracked.filter(keepOrPrior),
    })
    let sets = selectReviewable(parseNameStatusZ(nameStatusOut), untrackedAll)

    // No reviewable working-tree change + opt-in head-fallback → switch
    // the diff reference to the commit range so a Stop hook firing AFTER
    // the commit still has something to review. "Clean" is judged after
    // ignorePaths: an edit to an ignored file (a lockfile from an install)
    // leaves nothing to review in the tree, and must not hide the range.
    const fallbackEnabled = config?.payload?.fallbackToHead === true
    const workingTreeClean = Object.values(sets).every((v) => v.length === 0)
    let diffRef = workingTreeRef
    let source = "working-tree"
    let baseSha = null
    if (workingTreeClean && fallbackEnabled) {
        baseSha = resolveFallbackBase(repoRoot, git)
        if (baseSha && baseSha !== headSha) {
            diffRef = `${baseSha}..HEAD`
            // Re-fetch name-status for the commit range. Untracked is
            // irrelevant — every change in the range is committed.
            sets = selectReviewable(
                parseNameStatusZ(
                    git(repoRoot, ["diff", diffRef, "--name-status", "-z"])
                ),
                []
            )
            source = "head-fallback"
        }
    }
    const { modifiedSet, deletedSet, renamedSet, untrackedSet } = sets

    const { limits } = config
    let totalBytes = 0
    let truncated = false
    let filesEmitted = 0
    const blocks = []
    const emittedPaths = new Set()
    const filesMeta = {
        modified: [],
        untracked: [],
        deleted: [],
        renamed: [],
        priorFindingContext: [],
    }

    const room = () => limits.maxPayloadBytes - totalBytes
    const haveFileSlot = (path) =>
        isPrior(path) || filesEmitted < limits.maxFiles

    const tryEmit = (block) => {
        const bytes = Buffer.byteLength(block, "utf8")
        if (bytes > room()) return false
        blocks.push(block)
        totalBytes += bytes
        return true
    }

    const pushBlock = (header, body, file) => {
        if (!isPrior(file)) filesEmitted++
        emittedPaths.add(file)
        const block = body ? `${header}\n${body}\n` : `${header}\n`
        if (tryEmit(block)) return
        truncated = true
        tryEmit(`${header} (omitted: payload limit)\n`)
    }

    const pushHeaderOnly = (header) => {
        if (!tryEmit(`${header}\n`)) truncated = true
    }

    for (const file of modifiedSet) {
        filesMeta.modified.push({ path: file })
        if (!haveFileSlot(file)) {
            pushHeaderOnly(makeHeader(file, "modified, omitted: maxFiles"))
            truncated = true
            continue
        }
        const diff = git(repoRoot, ["diff", diffRef, "--", file])
        const { text, truncated: t } = truncateText(diff, limits.maxFileBytes)
        if (t) truncated = true
        pushBlock(
            makeHeader(file, t ? "modified, truncated" : "modified"),
            text,
            file
        )
    }

    for (const r of renamedSet) {
        filesMeta.renamed.push({ from: r.from, to: r.to })
        // If either endpoint was flagged, treat the rename as a prior-finding
        // for slot/cap purposes so it never gets dropped to a header-only.
        const slotKey = isPrior(r.from) ? r.from : r.to
        if (!haveFileSlot(slotKey)) {
            pushHeaderOnly(
                makeHeader(`${r.from} -> ${r.to}`, "renamed, omitted: maxFiles")
            )
            truncated = true
            continue
        }
        const diff = git(repoRoot, ["diff", diffRef, "--", r.to])
        const { text, truncated: t } = truncateText(diff, limits.maxFileBytes)
        if (t) truncated = true
        pushBlock(
            makeHeader(
                `${r.from} -> ${r.to}`,
                t ? "renamed, truncated" : "renamed"
            ),
            text,
            slotKey
        )
        // Mark both endpoints as emitted so a follow-up standalone pass
        // doesn't duplicate.
        emittedPaths.add(r.from)
        emittedPaths.add(r.to)
    }

    for (const file of deletedSet) {
        filesMeta.deleted.push(file)
        if (!haveFileSlot(file)) {
            pushHeaderOnly(makeHeader(file, "deleted, omitted: maxFiles"))
            truncated = true
            continue
        }
        const diff = git(repoRoot, ["diff", diffRef, "--", file])
        const { text, truncated: t } = truncateText(diff, limits.maxFileBytes)
        if (t) truncated = true
        pushBlock(
            makeHeader(file, t ? "deleted, truncated" : "deleted"),
            text,
            file
        )
    }

    for (const file of untrackedSet) {
        const abs = path.join(repoRoot, file)
        const buf = readBytesOrNull(readFile, abs)
        if (buf === null) continue
        const binary = isBinary(buf)
        filesMeta.untracked.push({ path: file, binary })
        if (!haveFileSlot(file)) {
            pushHeaderOnly(makeHeader(file, "untracked, omitted: maxFiles"))
            truncated = true
            continue
        }
        if (binary) {
            pushHeaderOnly(
                makeHeader(file, `untracked, binary, ${buf.length}B, omitted`)
            )
            emittedPaths.add(file)
            continue
        }
        const text = buf.toString("utf8")
        const { text: truncatedText, truncated: t } = truncateText(
            text,
            limits.maxFileBytes
        )
        if (t) truncated = true
        pushBlock(
            makeHeader(file, t ? "untracked, truncated" : "untracked"),
            truncatedText,
            file
        )
    }

    // Standalone prior-finding files: a previous round flagged something in
    // these paths but the user has not touched them this round (so they are
    // not in modified/untracked/deleted/renamed). Force-include their current
    // full content so Codex can verify-or-re-flag. These bypass ignorePaths
    // and maxFiles by construction (isPrior short-circuits both checks).
    for (const file of priorFindingPaths) {
        if (emittedPaths.has(file)) continue
        const abs = path.join(repoRoot, file)
        const buf = readBytesOrNull(readFile, abs)
        if (buf === null) {
            // File is gone — the deletion is already implicit; emit a marker
            // so Codex sees it and the prompt records the state.
            pushHeaderOnly(makeHeader(file, "prior-finding, deleted on disk"))
            filesMeta.priorFindingContext.push({ path: file, missing: true })
            emittedPaths.add(file)
            continue
        }
        const binary = isBinary(buf)
        filesMeta.priorFindingContext.push({
            path: file,
            missing: false,
            binary,
        })
        if (binary) {
            pushHeaderOnly(
                makeHeader(
                    file,
                    `prior-finding, binary, ${buf.length}B, omitted`
                )
            )
            emittedPaths.add(file)
            continue
        }
        const text = buf.toString("utf8")
        const { text: truncatedText, truncated: t } = truncateText(
            text,
            limits.maxFileBytes
        )
        if (t) truncated = true
        pushBlock(
            makeHeader(
                file,
                t
                    ? "prior-finding, full content, truncated"
                    : "prior-finding, full content"
            ),
            truncatedText,
            file
        )
    }

    // Concatenate without a separator: each block already ends in "\n" and
    // totalBytes is computed from those exact emitted bytes, so the invariant
    // Buffer.byteLength(promptText) === totalBytes holds.
    const promptText = blocks.join("")
    // Per-block identity, so a caller can tell whether another build of the
    // same tree shows the reviewer anything this one didn't.
    const blockHashes = blocks.map(sha256Hex)

    const promptHash = sha256Hex(promptText)

    // progressHash: promptHash plus the FULL on-disk content of every
    // changed and prior-finding file, so an edit hidden from the prompt by
    // maxFileBytes / maxPayloadBytes / maxFiles still flips the hash. The
    // cache must not depend on prior findings to see such edits: a
    // GOOD_TO_GO clears them, and the next request is built without them.
    // Sort by path for stability.
    const sortedPriorPaths = [...priorFindingPaths].sort()
    const contentPaths = [
        ...new Set([
            ...modifiedSet,
            ...untrackedSet,
            // Hashed as MISSING plus their raw "D" record, so a deletion
            // whose header the payload limit dropped still counts.
            ...deletedSet,
            ...renamedSet.map((r) => r.to),
            ...priorFindingPaths,
        ]),
    ].sort()
    // Raw diff metadata catches what file bytes can't: an executable-bit
    // flip or type change on a file the prompt omitted. For gitlinks and
    // symlinks also hash the full patch, which names the checked-out
    // submodule commit (and any -dirty state) or the link target.
    const rawMeta = parseRawZ(
        git(repoRoot, ["diff", diffRef, "--raw", "-z", "--no-abbrev"])
    )
    const untrackedPaths = new Set(untrackedSet)
    // Structured per-path records, hashed as JSON: paths and symlink
    // targets may contain any byte git allows (newlines, colons), so
    // interpolated strings could let one record forge another.
    // False when part of the tree couldn't be fingerprinted (see
    // submoduleRecords); the cache must not treat such a payload as
    // unchanged.
    let fingerprintComplete = true
    const contentRecords = contentPaths.map((p) => {
        const abs = path.join(repoRoot, p)
        const h = hashOrMissing(hashFile, abs)
        const m = rawMeta.get(p)
        if (!m) {
            return untrackedPaths.has(p) ? [p, h, fileMeta(abs)] : [p, h]
        }
        const patch = METADATA_MODES.has(m.dstMode)
            ? sha256Hex(git(repoRoot, ["diff", diffRef, "--", p]))
            : null
        const record = [p, h, m.srcMode, m.dstMode, m.status, m.from, patch]
        // A head-fallback range is committed, so a submodule's working
        // tree isn't part of what is reviewed.
        if (m.dstMode === "160000" && source === "working-tree") {
            record.push(
                submoduleRecords(abs, {
                    git,
                    hashFile,
                    fileMeta,
                    markIncomplete: () => {
                        fingerprintComplete = false
                    },
                })
            )
        }
        return record
    })
    const progressHash = sha256Hex(JSON.stringify([promptHash, contentRecords]))
    // Per-path fingerprint identity, the companion to blockHashes: a caller
    // can check another build saw no content, mode or path this one didn't.
    const contentHashes = contentRecords.map((r) =>
        sha256Hex(JSON.stringify(r))
    )

    return {
        headSha,
        // "working-tree" | "head-fallback". The dashboard / pipeline
        // log surfaces this so the operator can tell at a glance
        // whether a review was triggered by uncommitted work or by
        // a fallback to the latest commit range.
        source,
        // Non-null only when source === "head-fallback".
        baseSha,
        files: filesMeta,
        totalBytes,
        truncated,
        promptText,
        promptHash,
        progressHash,
        blockHashes,
        contentHashes,
        fingerprintComplete,
        priorFindingPaths: sortedPriorPaths,
        empty: blocks.length === 0,
        nonBinaryFileCount:
            filesMeta.modified.length +
            filesMeta.renamed.length +
            filesMeta.deleted.length +
            filesMeta.untracked.filter((u) => !u.binary).length +
            filesMeta.priorFindingContext.filter((p) => !p.missing && !p.binary)
                .length,
    }
}

export const __defaults__ = { defaultGit }
export const __test__ = {
    defaultFileMeta,
    submoduleRecords,
    hashRegularFile,
    readRegularFile,
    parseRawZ,
    parseNameStatusZ,
    matchesAny,
    filterIgnored,
    isBinary,
    truncateText,
    sha256Hex,
    collectPriorFindingPaths,
    sanitizeFindingPath,
}
