#!/usr/bin/env node
/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

// Render the launchd plist by replacing the documented placeholder
// strings. This used to be a sed pipeline in install.sh, but sed's
// replacement syntax interprets `&` (matched text) and the delimiter
// character (e.g. `|`) inside the replacement string — which can
// silently corrupt the rendered plist when a path contains those bytes.
//
// Doing the substitution in JS via plain String.replaceAll is safe for
// any byte content. We also XML-escape the substituted value so a path
// containing `<` / `>` / `&` / `"` cannot break the surrounding
// <string>...</string> elements.
//
// Status output:
//   installed:<path>   — wrote new file
//   updated:<path>     — replaced an existing file (bytes differed)
//   unchanged:<path>   — bytes match what's already on disk

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"

const PLACEHOLDERS = ["__NODE_BIN__", "__REPO_ROOT__", "__HOME__"]

// XML escape per the spec for character data and attribute values.
// Apostrophe is not strictly required inside <string>...</string>, but
// escaping it costs nothing.
const xmlEscape = (s) =>
    String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;")

const writeAtomic = (filePath, content, mode = 0o644) => {
    const tmp = `${filePath}.tmp`
    writeFileSync(tmp, content, { mode })
    renameSync(tmp, filePath)
}

export const renderPlist = ({
    templatePath,
    destPath,
    values,
    readFile = readFileSync,
    existsFn = existsSync,
    writeAtomicFn = writeAtomic,
}) => {
    const template = readFile(templatePath, "utf8")
    let rendered = template
    for (const key of PLACEHOLDERS) {
        const v = values?.[key]
        if (typeof v !== "string" || v.length === 0) {
            throw new Error(`renderPlist: missing or empty value for ${key}`)
        }
        rendered = rendered.replaceAll(key, xmlEscape(v))
    }
    // Any placeholders left? That would mean the template referenced
    // something we don't know how to substitute.
    for (const key of PLACEHOLDERS) {
        if (rendered.includes(key)) {
            throw new Error(
                `renderPlist: placeholder ${key} still present after substitution`
            )
        }
    }

    const existed = existsFn(destPath)
    if (existed) {
        const current = readFile(destPath, "utf8")
        if (current === rendered) {
            return { action: "unchanged", path: destPath }
        }
    }
    writeAtomicFn(destPath, rendered)
    return { action: existed ? "updated" : "installed", path: destPath }
}

export const __test__ = { xmlEscape, PLACEHOLDERS }

/* istanbul ignore next */
const isDirectInvocation = () => {
    if (!process.argv[1]) return false
    if (!import.meta.url.startsWith("file:")) return false
    return import.meta.url.endsWith(path.basename(process.argv[1]))
}

/* istanbul ignore next */
if (isDirectInvocation()) {
    try {
        const [, , templatePath, destPath, nodeBin, repoRoot, home] =
            process.argv
        if (!templatePath || !destPath || !nodeBin || !repoRoot || !home) {
            process.stderr.write(
                "usage: render-plist.mjs <template> <dest> <node-bin> <repo-root> <home>\n"
            )
            process.exit(1)
        }
        const r = renderPlist({
            templatePath,
            destPath,
            values: {
                __NODE_BIN__: nodeBin,
                __REPO_ROOT__: repoRoot,
                __HOME__: home,
            },
        })
        process.stdout.write(`${r.action}:${r.path}\n`)
    } catch (err) {
        process.stderr.write(`error:${err.message}\n`)
        process.exit(1)
    }
}
