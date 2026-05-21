/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { execFileSync } from "node:child_process"
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
            if (from !== undefined && to !== undefined) {
                result.renamed.push({ from, to })
            }
        } else {
            const file = parts[i++]
            if (file === undefined) continue
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

export const buildPayload = ({
    repoRoot,
    config,
    git = defaultGit,
    readFile = readFileSync,
}) => {
    const headSha = git(repoRoot, ["rev-parse", "HEAD"]).trim()

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
    const modifiedSet = filterIgnored(
        [...changed.modified, ...changed.added, ...changed.typeChanged],
        ignorePaths
    )
    const deletedSet = filterIgnored(changed.deleted, ignorePaths)
    const renamedSet = changed.renamed.filter(
        (r) => !matchesAny(r.to, ignorePaths)
    )
    const untrackedSet = filterIgnored(untrackedAll, ignorePaths)

    const { limits } = config
    let totalBytes = 0
    let truncated = false
    let filesEmitted = 0
    const blocks = []
    const filesMeta = {
        modified: [],
        untracked: [],
        deleted: [],
        renamed: [],
    }

    const room = () => limits.maxPayloadBytes - totalBytes
    const haveFileSlot = () => filesEmitted < limits.maxFiles

    const pushBlock = (header, body) => {
        const block = body ? `${header}\n${body}\n` : `${header}\n`
        if (block.length > room()) {
            blocks.push(`${header} (omitted: payload limit)\n`)
            truncated = true
            filesEmitted++
            return
        }
        blocks.push(block)
        totalBytes += block.length
        filesEmitted++
    }

    const pushHeaderOnly = (header) => {
        const block = `${header}\n`
        if (block.length > room()) {
            truncated = true
            return
        }
        blocks.push(block)
        totalBytes += block.length
    }

    for (const file of modifiedSet) {
        filesMeta.modified.push({ path: file })
        if (!haveFileSlot()) {
            pushHeaderOnly(makeHeader(file, "modified, omitted: maxFiles"))
            truncated = true
            continue
        }
        let diff = git(repoRoot, ["diff", "HEAD", "--", file])
        const { text, truncated: t } = truncateText(diff, limits.maxFileBytes)
        diff = text
        if (t) truncated = true
        pushBlock(
            makeHeader(file, t ? "modified, truncated" : "modified"),
            diff
        )
    }

    for (const r of renamedSet) {
        filesMeta.renamed.push({ from: r.from, to: r.to })
        if (!haveFileSlot()) {
            pushHeaderOnly(
                makeHeader(`${r.from} -> ${r.to}`, "renamed, omitted: maxFiles")
            )
            truncated = true
            continue
        }
        let diff = git(repoRoot, ["diff", "HEAD", "--", r.to])
        const { text, truncated: t } = truncateText(diff, limits.maxFileBytes)
        diff = text
        if (t) truncated = true
        pushBlock(
            makeHeader(
                `${r.from} -> ${r.to}`,
                t ? "renamed, truncated" : "renamed"
            ),
            diff
        )
    }

    for (const file of deletedSet) {
        filesMeta.deleted.push(file)
        if (!haveFileSlot()) {
            pushHeaderOnly(makeHeader(file, "deleted, omitted: maxFiles"))
            truncated = true
            continue
        }
        const diff = git(repoRoot, ["diff", "HEAD", "--", file])
        const { text, truncated: t } = truncateText(diff, limits.maxFileBytes)
        if (t) truncated = true
        pushBlock(makeHeader(file, t ? "deleted, truncated" : "deleted"), text)
    }

    for (const file of untrackedSet) {
        const abs = path.join(repoRoot, file)
        let buf
        try {
            buf = readFile(abs)
        } catch {
            continue
        }
        const binary = isBinary(buf)
        filesMeta.untracked.push({ path: file, binary })
        if (!haveFileSlot()) {
            pushHeaderOnly(makeHeader(file, "untracked, omitted: maxFiles"))
            truncated = true
            continue
        }
        if (binary) {
            pushHeaderOnly(
                makeHeader(file, `untracked, binary, ${buf.length}B, omitted`)
            )
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
            truncatedText
        )
    }

    const promptText = blocks.join("\n")

    return {
        headSha,
        files: filesMeta,
        totalBytes,
        truncated,
        promptText,
        empty: blocks.length === 0,
        nonBinaryFileCount:
            filesMeta.modified.length +
            filesMeta.renamed.length +
            filesMeta.deleted.length +
            filesMeta.untracked.filter((u) => !u.binary).length,
    }
}

export const __defaults__ = { defaultGit }
export const __test__ = {
    parseNameStatusZ,
    filterIgnored,
    matchesAny,
    isBinary,
    truncateText,
}
