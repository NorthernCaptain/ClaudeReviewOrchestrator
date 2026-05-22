#!/usr/bin/env node
/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

// Insert the review-orchestrator guidance block into ~/.claude/CLAUDE.md
// between the markers
//   <!-- review-orchestrator:begin -->
//   <!-- review-orchestrator:end -->
//
// Idempotent: if the markers are present, the body between them is
// replaced in place; otherwise the marker-bounded block is appended at
// the end of the file. Hand-written content outside the markers is
// always preserved.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"

const BEGIN_MARKER = "<!-- review-orchestrator:begin -->"
const END_MARKER = "<!-- review-orchestrator:end -->"

const writeAtomic = (filePath, content, mode = 0o644) => {
    const tmp = `${filePath}.tmp`
    writeFileSync(tmp, content, { mode })
    renameSync(tmp, filePath)
}

const backupIfDifferent = (filePath, newContent, nowStr) => {
    if (!existsSync(filePath)) return null
    const current = readFileSync(filePath, "utf8")
    if (current === newContent) return null
    const bak = `${filePath}.bak.${nowStr}`
    writeFileSync(bak, current)
    return bak
}

// Pull the body between markers (if any) and the surrounding text.
const splitMarkers = (text) => {
    const begin = text.indexOf(BEGIN_MARKER)
    if (begin === -1) return { hasBlock: false }
    const end = text.indexOf(END_MARKER, begin)
    if (end === -1) return { hasBlock: false }
    return {
        hasBlock: true,
        before: text.slice(0, begin),
        after: text.slice(end + END_MARKER.length),
    }
}

export const mergeClaudeMd = ({
    claudeMdPath,
    snippetPath,
    now = () => new Date().toISOString().replace(/[:.]/g, "-"),
    existsFn = existsSync,
    readFile = readFileSync,
    writeAtomicFn = writeAtomic,
    backup = backupIfDifferent,
}) => {
    const snippetRaw = readFile(snippetPath, "utf8")
    // The snippet file MUST already include the marker pair (it's the
    // canonical block we ship in this repo). Verify it does so the
    // installer can't accidentally embed unbounded content.
    if (
        !snippetRaw.includes(BEGIN_MARKER) ||
        !snippetRaw.includes(END_MARKER)
    ) {
        throw new Error(
            `snippet at ${snippetPath} is missing the begin/end markers`
        )
    }
    const block = snippetRaw.trimEnd() + "\n"

    let existed = existsFn(claudeMdPath)
    if (!existed) {
        writeAtomicFn(claudeMdPath, block)
        return { action: "installed", path: claudeMdPath }
    }

    const current = readFile(claudeMdPath, "utf8")
    const split = splitMarkers(current)
    let next
    if (split.hasBlock) {
        // Replace the block in place. Normalize a single blank line of
        // padding on each side so reruns produce identical bytes to the
        // append-path output (see below) and the rerun is "unchanged".
        const before = split.before.replace(/\n+$/, "")
        const after = split.after.replace(/^\n+/, "")
        next =
            (before ? `${before}\n\n` : "") +
            block +
            (after ? `\n${after}` : "")
    } else {
        // Append: trim trailing whitespace, add one blank-line separator
        // between the existing file and our block.
        const trimmed = current.replace(/\n+$/, "")
        next = trimmed ? `${trimmed}\n\n${block}` : block
    }

    if (next === current) {
        return { action: "unchanged", path: claudeMdPath }
    }
    const ts = now()
    const bak = backup(claudeMdPath, next, ts)
    writeAtomicFn(claudeMdPath, next)
    return { action: "updated", path: claudeMdPath, backup: bak }
}

/* istanbul ignore next */
const isDirectInvocation = () => {
    if (!process.argv[1]) return false
    if (!import.meta.url.startsWith("file:")) return false
    return import.meta.url.endsWith(path.basename(process.argv[1]))
}

/* istanbul ignore next */
if (isDirectInvocation()) {
    try {
        const claudeMdPath = process.argv[2]
        const snippetPath = process.argv[3]
        if (!claudeMdPath || !snippetPath) {
            process.stderr.write(
                "usage: merge-claude-md.mjs <claudeMdPath> <snippetPath>\n"
            )
            process.exit(1)
        }
        const r = mergeClaudeMd({ claudeMdPath, snippetPath })
        process.stdout.write(`${r.action}:${r.path}\n`)
    } catch (err) {
        process.stderr.write(`error:${err.message}\n`)
        process.exit(1)
    }
}
