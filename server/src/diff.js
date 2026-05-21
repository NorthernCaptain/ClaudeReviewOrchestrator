/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"
import { minimatch } from "minimatch"

const defaultGit = (cwd, args) =>
    execFileSync("git", ["-C", cwd, ...args], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
    })

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

// Reads a file as raw bytes for hashing. Returns null on missing.
const readBytesOrNull = (readFile, abs) => {
    try {
        return readFile(abs)
    } catch {
        return null
    }
}

export const buildPayload = ({
    repoRoot,
    config,
    priorFindings = [],
    git = defaultGit,
    readFile = readFileSync,
}) => {
    const headSha = git(repoRoot, ["rev-parse", "HEAD"]).trim()
    const priorFindingPaths = collectPriorFindingPaths(priorFindings, repoRoot)
    const isPrior = (p) => priorFindingPaths.has(p)

    const nameStatusOut = git(repoRoot, ["diff", "HEAD", "--name-status", "-z"])
    const changed = parseNameStatusZ(nameStatusOut)

    const untrackedOut = git(repoRoot, [
        "ls-files",
        "--others",
        "--exclude-standard",
        "-z",
    ])
    const untrackedAll = untrackedOut.split("\0").filter(Boolean)

    const ignorePaths = config.ignorePaths
    const keepOrPrior = (p) => isPrior(p) || !matchesAny(p, ignorePaths)

    const modifiedSet = [
        ...changed.modified,
        ...changed.added,
        ...changed.typeChanged,
    ].filter(keepOrPrior)
    const deletedSet = changed.deleted.filter(keepOrPrior)
    const renamedSet = changed.renamed.filter(
        (r) =>
            isPrior(r.to) || isPrior(r.from) || !matchesAny(r.to, ignorePaths)
    )
    const untrackedSet = untrackedAll.filter(keepOrPrior)

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
        const diff = git(repoRoot, ["diff", "HEAD", "--", file])
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
        const diff = git(repoRoot, ["diff", "HEAD", "--", r.to])
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
        const diff = git(repoRoot, ["diff", "HEAD", "--", file])
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

    const promptHash = sha256Hex(promptText)

    // progressHash: incorporates the FULL on-disk content of every prior-
    // finding file (regardless of any prompt truncation), so an edit past
    // maxFileBytes still flips the hash and the no-progress check sees
    // forward motion. Sort by path for stability.
    const sortedPriorPaths = [...priorFindingPaths].sort()
    const priorContentParts = sortedPriorPaths.map((p) => {
        const buf = readBytesOrNull(readFile, path.join(repoRoot, p))
        const h = buf === null ? "MISSING" : sha256Hex(buf)
        return `${p}:${h}`
    })
    const progressHash = sha256Hex(
        `${promptHash}|${priorContentParts.join("\n")}`
    )

    return {
        headSha,
        files: filesMeta,
        totalBytes,
        truncated,
        promptText,
        promptHash,
        progressHash,
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
    parseNameStatusZ,
    matchesAny,
    filterIgnored,
    isBinary,
    truncateText,
    sha256Hex,
    collectPriorFindingPaths,
    sanitizeFindingPath,
}
