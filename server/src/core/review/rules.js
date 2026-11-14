/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

// The reviewer's review rules: what to check and how to grade it, kept in
// Markdown so they can change without touching code. The bundled copy
// (review/review-rules.md) reaches the core as bytes the shell read at
// load; config.reviewer.rulesFile points at a replacement anywhere on
// disk, read on every review so an edit applies to the next one.

import { createHash } from "node:crypto"
import { closeSync, readSync } from "node:fs"
import { openRegularFile } from "./diff.js"

export const REVIEW_RULES_RESOURCE = "review/review-rules.md"

// Rules go into every prompt; anything this large is a wrong path.
export const MAX_RULES_BYTES = 128 * 1024

export class RulesError extends Error {
    constructor(message) {
        super(message)
        this.name = "RulesError"
        this.code = "REVIEW_RULES_UNREADABLE"
    }
}

const sha256 = (text) => createHash("sha256").update(text).digest("hex")

// The cap applies to the bytes as read: readRulesFile stops one byte past
// it, so a trimmed length could hide a cut-off file.
const decode = (bytes, where) => {
    const buf = Buffer.from(bytes)
    if (buf.length > MAX_RULES_BYTES) {
        throw new RulesError(
            `review rules are larger than ${MAX_RULES_BYTES} bytes: ${where}`
        )
    }
    const text = buf.toString("utf8").trim()
    if (!text) throw new RulesError(`review rules are empty: ${where}`)
    return text
}

// Reads a regular file (see openRegularFile: a FIFO or device at the path
// can't hang the review), at most MAX_RULES_BYTES + 1 bytes of it.
export const readRulesFile = (filePath, { open = openRegularFile } = {}) => {
    let fd
    try {
        fd = open(filePath)
    } catch (err) {
        throw new RulesError(
            err?.code === "ENOTREG"
                ? `review rules are not a file: ${filePath}`
                : `can't open review rules ${filePath}: ${err?.message}`
        )
    }
    try {
        const buf = Buffer.alloc(MAX_RULES_BYTES + 1)
        let total = 0
        while (total < buf.length) {
            const n = readSync(fd, buf, total, buf.length - total, null)
            if (n === 0) break
            total += n
        }
        return buf.subarray(0, total)
    } catch (err) {
        throw new RulesError(
            `can't read review rules ${filePath}: ${err.message}`
        )
    } finally {
        closeSync(fd)
    }
}

// `bytes` are the bundled rules; a core without them can't review.
export const createReviewRules = (bytes, { readFile = readRulesFile } = {}) => {
    if (!bytes) {
        throw new Error(`core resource missing: ${REVIEW_RULES_RESOURCE}`)
    }
    const bundledText = decode(bytes, REVIEW_RULES_RESOURCE)
    const bundled = Object.freeze({
        text: bundledText,
        source: "bundled",
        hash: sha256(bundledText),
    })
    // The rules this config reviews with: { text, source, hash }. Throws
    // RulesError when the configured file can't be used.
    const resolve = (config) => {
        const file = config?.reviewer?.rulesFile ?? null
        if (!file) return bundled
        const text = decode(readFile(file), file)
        return { text, source: file, hash: sha256(text) }
    }
    return { bundled, resolve }
}
