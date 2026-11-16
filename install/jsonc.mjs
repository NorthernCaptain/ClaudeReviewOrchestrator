/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

// A reader for JSONC: JSON plus // and /* */ comments, the format the
// gemini CLI reads ~/.gemini/settings.json in (strip-json-comments, then
// JSON.parse). Like the CLI, it refuses trailing commas.
// Shared by the installer's settings helpers (which edit by the
// positions it records) and the server's startup check.

const BLANK = new Set([" ", "\t", "\n", "\r", "﻿"])
const SCALAR = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/y

// The first offset at or after pos that isn't whitespace or a comment.
export const skipBlank = (text, pos) => {
    let i = pos
    for (;;) {
        if (BLANK.has(text[i])) i += 1
        else if (text.startsWith("//", i)) {
            const nl = text.indexOf("\n", i)
            i = nl < 0 ? text.length : nl
        } else if (text.startsWith("/*", i)) {
            const end = text.indexOf("*/", i + 2)
            if (end < 0) throw new Error(`unterminated comment at offset ${i}`)
            i = end + 2
        } else return i
    }
}

// The value as a node { value, start, end }; an object node also has
// members: [{ key, keyStart, node }] in text order.
export const parseJsonc = (text) => {
    let i = 0
    const fail = (what) => {
        throw new Error(`${what} at offset ${i}`)
    }
    const string = () => {
        const start = i
        i += 1
        while (i < text.length && text[i] !== '"') {
            if (text[i] === "\n") break
            i += text[i] === "\\" ? 2 : 1
        }
        if (text[i] !== '"') fail("unterminated string")
        i += 1
        return JSON.parse(text.slice(start, i))
    }
    const node = () => {
        i = skipBlank(text, i)
        const start = i
        if (text[i] === "{") return object(start)
        if (text[i] === "[") return array(start)
        if (text[i] === '"') return { value: string(), start, end: i }
        SCALAR.lastIndex = i
        const m = SCALAR.exec(text)
        if (!m) fail("unexpected character")
        i += m[0].length
        return { value: JSON.parse(m[0]), start, end: i }
    }
    const object = (start) => {
        i += 1
        const value = {}
        const members = []
        for (let afterComma = false; ; afterComma = true) {
            i = skipBlank(text, i)
            if (text[i] === "}" && !afterComma) {
                i += 1
                return { value, start, end: i, members }
            }
            if (text[i] !== '"') fail("expected a key")
            const keyStart = i
            const key = string()
            i = skipBlank(text, i)
            if (text[i] !== ":") fail("expected ':'")
            i += 1
            const child = node()
            // defineProperty: a "__proto__" key stays a plain key.
            Object.defineProperty(value, key, {
                value: child.value,
                enumerable: true,
                writable: true,
                configurable: true,
            })
            members.push({ key, keyStart, node: child })
            i = skipBlank(text, i)
            if (text[i] === "}") {
                i += 1
                return { value, start, end: i, members }
            }
            if (text[i] !== ",") fail("expected ',' or '}'")
            i += 1
        }
    }
    const array = (start) => {
        i += 1
        const value = []
        i = skipBlank(text, i)
        if (text[i] === "]") {
            i += 1
            return { value, start, end: i }
        }
        for (;;) {
            value.push(node().value)
            i = skipBlank(text, i)
            if (text[i] === "]") {
                i += 1
                return { value, start, end: i }
            }
            if (text[i] !== ",") fail("expected ',' or ']'")
            i += 1
        }
    }
    const root = node()
    i = skipBlank(text, i)
    if (i < text.length) fail("unexpected text after the value")
    return root
}
