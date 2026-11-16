#!/usr/bin/env node
/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

// Write the review effort aliases into ~/.gemini/settings.json. The
// gemini CLI has no flag for the thinking level, so each model and
// effort the reviewer offers gets a named alias under
// modelConfigs.customAliases, and a review runs `gemini -m <alias>`.
// The aliases do nothing unless a run names them.
//
// We own every alias whose name starts with GEMINI_ALIAS_PREFIX: ours
// are refreshed, stale ones of ours (a model or effort no longer
// offered) are dropped, and everything else in the file is kept as is.
// The CLI's settings loader accepts comments in this file, so edits go
// member by member into the text: comments and layout outside the
// members we change survive. The installer itself writes no comments:
// gemini's launcher reads this file with plain JSON.parse (for
// advanced.autoConfigureMemory), so a file that was plain JSON stays
// plain JSON. Idempotent.

import { execFileSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import {
    appendFileSync,
    closeSync,
    fstatSync,
    lstatSync,
    mkdirSync,
    openSync,
    readFileSync,
    readSync,
    realpathSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs"
import path from "node:path"
import { MAX_UPDATE_ATTEMPTS, withConfigLock } from "./config-lock.mjs"
import { parseJsonc, skipBlank } from "./jsonc.mjs"
import {
    GEMINI_ALIAS_PREFIX,
    geminiAliasDefinitions,
} from "../server/src/core/review/gemini.js"

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v)

const splice = (text, from, to, insert) =>
    text.slice(0, from) + insert + text.slice(to)
const lineStart = (text, pos) => text.lastIndexOf("\n", pos - 1) + 1
const indentAt = (text, pos) =>
    /^[ \t]*/.exec(text.slice(lineStart(text, pos)))[0]
const startsLine = (text, pos) =>
    /^[ \t]*$/.test(text.slice(lineStart(text, pos), pos))
// Past the line's end (LF or CRLF) when only blanks follow pos.
const lineRestEnd = (text, pos) => {
    const m = /^[ \t]*(?:\r?\n|$)/.exec(text.slice(pos))
    return m ? pos + m[0].length : pos
}
const indentUnit = (text) => /\n([ \t]+)\S/.exec(text)?.[1] ?? "  "
// The file's line ending: what we insert uses the same.
const eolOf = (text) => (text.includes("\r\n") ? "\r\n" : "\n")
const render = (value, indent, unit, eol) =>
    JSON.stringify(value, null, unit).replace(/\n/g, `${eol}${indent}`)

export const memberOf = (objNode, key) =>
    objNode?.members?.findLast((m) => m.key === key) ?? null

// Sets key in the object at objNode: replaces the value of an existing
// member, or appends a member before the closing brace.
// renderValue(indent, unit, eol) is the value's text for a member at
// indent.
const putMember = (text, objNode, key, renderValue) => {
    const unit = indentUnit(text)
    const eol = eolOf(text)
    const existing = memberOf(objNode, key)
    if (existing) {
        const { start, end } = existing.node
        const indent = indentAt(text, existing.keyStart)
        return splice(text, start, end, renderValue(indent, unit, eol))
    }
    const last = objNode.members.at(-1)
    const indent = last
        ? indentAt(text, last.keyStart)
        : indentAt(text, objNode.start) + unit
    const member = `${JSON.stringify(key)}: ${renderValue(indent, unit, eol)}`
    const close = objNode.end - 1
    if (startsLine(text, close)) {
        const at = lineStart(text, close)
        const out = splice(text, at, at, `${indent}${member}${eol}`)
        return last ? splice(out, last.node.end, last.node.end, ",") : out
    }
    // On one line, the member goes right after the one before it (or
    // the opening brace), so the blanks the file had before the closing
    // brace stay where they were for uninstall to leave alone.
    if (!last) return splice(text, objNode.start + 1, objNode.start + 1, member)
    return splice(text, last.node.end, last.node.end, `, ${member}`)
}

export const setMember = (text, objNode, key, value) =>
    putMember(text, objNode, key, (indent, unit, eol) =>
        render(value, indent, unit, eol)
    )

const blankRest = (text, pos) => /^[ \t]*(?:\r?\n|$)/.test(text.slice(pos))
const blanksAt = (text, pos) => /^[ \t]*/.exec(text.slice(pos))[0].length
const blanksBefore = (text, pos) => /[ \t]*$/.exec(text.slice(0, pos))[0].length

// The comment 1.12.0 pre-releases put in containers they created. Gemini's
// launcher can't read a file with comments, so it is taken out again
// wherever it sits on a line of its own.
export const OLD_MARK =
    "// added by review-orchestrator; uninstall.sh removes it once empty"

export const withoutOldMarks = (text) => {
    let from = 0
    for (;;) {
        const at = text.indexOf(OLD_MARK, from)
        if (at < 0) return text
        const end = at + OLD_MARK.length
        if (startsLine(text, at) && blankRest(text, end)) {
            text = splice(text, lineStart(text, at), lineRestEnd(text, end), "")
            from = lineStart(text, at)
        } else {
            from = end
        }
    }
}

// Cuts the member's text up to end (its value's end, or past its comma):
// its whole line when nothing else is on it, else only that span and
// the blanks after it, so a comment after it on the line stays.
const cutMember = (text, member, end) =>
    startsLine(text, member.keyStart) && blankRest(text, end)
        ? splice(
              text,
              lineStart(text, member.keyStart),
              lineRestEnd(text, end),
              ""
          )
        : splice(text, member.keyStart, end + blanksAt(text, end), "")

// Removes one member and the comma that separated it; comments around
// them stay.
export const deleteMember = (text, objNode, member) => {
    const ownLine = startsLine(text, member.keyStart)
    const after = skipBlank(text, member.node.end)
    if (text[after] === ",") {
        if (text.slice(member.node.end, after).trim()) {
            // Comments between the value and its comma: the comma (its
            // line, when it has one to itself) and the member go apart.
            const out =
                startsLine(text, after) && blankRest(text, after + 1)
                    ? splice(
                          text,
                          lineStart(text, after),
                          lineRestEnd(text, after + 1),
                          ""
                      )
                    : splice(text, after, after + 1, "")
            return cutMember(out, member, member.node.end)
        }
        return cutMember(text, member, after + 1)
    }
    // The last member, then the comma before it.
    const out = ownLine
        ? cutMember(text, member, member.node.end)
        : splice(
              text,
              member.keyStart - blanksBefore(text, member.keyStart),
              member.node.end,
              ""
          )
    const prev = objNode.members[objNode.members.indexOf(member) - 1]
    if (!prev) return out
    const comma = skipBlank(text, prev.node.end)
    return splice(out, comma, comma + 1, "")
}

// --- settings file ---

export const timestamp = () => new Date().toISOString().replace(/[:.]/g, "-")

// { text, root }: root is the parsed object node, null when the file is
// missing (text null) or blank.
export const parseSettings = (settingsPath, text) => {
    if (text === null || text.trim() === "") return { text, root: null }
    let root
    try {
        root = parseJsonc(text)
    } catch (err) {
        throw new Error(`failed to parse ${settingsPath}: ${err.message}`)
    }
    if (!root.members) {
        throw new Error(`${settingsPath} is valid JSON but not an object`)
    }
    return { text, root }
}

// The open file's text, read from its start.
const readFd = (fd) => {
    const chunks = []
    const buf = Buffer.alloc(64 * 1024)
    let pos = 0
    for (;;) {
        const n = readSync(fd, buf, 0, buf.length, pos)
        if (n === 0) break
        chunks.push(Buffer.from(buf.subarray(0, n)))
        pos += n
    }
    return Buffer.concat(chunks).toString("utf8")
}

// The real file behind settingsPath, so a symlinked settings.json is
// edited where it points and stays a link. A link to a missing file is
// refused; a missing settings.json is created.
export const settingsTarget = (settingsPath) => {
    let link = false
    try {
        link = lstatSync(settingsPath).isSymbolicLink()
    } catch (err) {
        if (err.code !== "ENOENT") throw err
    }
    if (!link) return settingsPath
    try {
        return realpathSync(settingsPath)
    } catch (err) {
        if (err.code !== "ENOENT") throw err
        throw new Error(`${settingsPath} links to a missing file`)
    }
}

// Whether target is still the file open as fd (null: still absent).
const sameFile = (target, fd) => {
    let st
    try {
        st = statSync(target)
    } catch (err) {
        if (err.code === "ENOENT") return fd === null
        throw err
    }
    if (fd === null) return false
    const open = fstatSync(fd)
    return st.ino === open.ino && st.dev === open.dev
}

const tempPath = (target) => `${target}.tmp-${randomBytes(6).toString("hex")}`

// One change to the settings file. Holding the config writers' lock
// (config.json.lock, via lockTarget; so an install and an uninstall
// don't interleave), it opens the file, reads
// it, computes the new text (compute({ text, root }) → text, or null for
// no change), writes it and a backup of the old text
// (<file>.bak.<ts>-<random>),
// and renames it over the file only if the path still holds the file it
// opened, with the text it read. The gemini CLI saves settings in place,
// so a save that lands after that check reaches the file just replaced:
// it shows up through the open handle, is put back, and the change is
// redone on top of it. Up to 3 attempts. hooks (tests) run just before
// the check and just after the rename. Resolves to
// { changed, existed, backup }.
// changeSettingsFile is that change for a caller already holding the
// lock; updateSettingsFile takes the lock around it.
export const changeSettingsFile = ({
    settingsPath,
    compute,
    now = timestamp,
    hooks = {},
    suffix = () => randomBytes(4).toString("hex"),
}) => {
    const target = settingsTarget(settingsPath)
    for (let attempt = 1; attempt <= MAX_UPDATE_ATTEMPTS; attempt++) {
        let fd = null
        try {
            fd = openSync(target, "r")
        } catch (err) {
            if (err.code !== "ENOENT") throw err
        }
        let tmp = null
        let backup = null
        try {
            const before = fd === null ? null : readFd(fd)
            const next = compute(parseSettings(settingsPath, before))
            if (next === null || next === before) {
                return { changed: false, existed: before !== null }
            }
            const mode = fd === null ? 0o600 : fstatSync(fd).mode & 0o777
            mkdirSync(path.dirname(target), { recursive: true })
            tmp = tempPath(target)
            writeFileSync(tmp, next, { mode })
            if (before !== null) {
                // Unique and created exclusively; ours (so cleanup
                // removes it) only once written. A taken name is
                // retried with a new suffix.
                for (;;) {
                    const name = `${target}.bak.${now()}-${suffix()}`
                    try {
                        writeFileSync(name, before, { mode, flag: "wx" })
                        backup = name
                        break
                    } catch (err) {
                        if (err.code !== "EEXIST") throw err
                    }
                }
            }
            hooks.beforeReplace?.()
            if (
                !sameFile(target, fd) ||
                (fd !== null && readFd(fd) !== before)
            ) {
                continue
            }
            renameSync(tmp, target)
            tmp = null
            hooks.afterReplace?.()
            const late = fd === null ? null : readFd(fd)
            if (late !== null && late !== before) {
                tmp = tempPath(target)
                writeFileSync(tmp, late, { mode })
                renameSync(tmp, target)
                tmp = null
                continue
            }
            const kept = backup
            backup = null
            return { changed: true, existed: before !== null, backup: kept }
        } finally {
            if (tmp) rmSync(tmp, { force: true })
            if (backup) rmSync(backup, { force: true })
            if (fd !== null) closeSync(fd)
        }
    }
    throw new Error(`${settingsPath} kept changing while saving — try again`)
}

export const updateSettingsFile = ({
    lockTarget,
    lock = withConfigLock,
    ...options
}) =>
    lock(lockTarget ?? options.settingsPath, () => changeSettingsFile(options))

// The gemini CLI saves settings.json without any lock, so no edit is
// safe while one runs: a save it makes around our replacement can be
// lost. The install and uninstall commands refuse to edit then.
// The gemini program itself: an executable named gemini, or node (or
// nodejs) whose script, the first word after its options, is gemini or
// gemini.js. A word "gemini" anywhere else (vim gemini) is not it.
const GEMINI_SCRIPT = /(^|\/)gemini(\.js)?$/
const isGeminiCommand = (command) => {
    const [program, ...args] = command.trim().split(/\s+/)
    if (GEMINI_SCRIPT.test(program)) return true
    if (!/(^|\/)node(js)?$/.test(program)) return false
    const script = args.find((word) => !word.startsWith("-"))
    return script !== undefined && GEMINI_SCRIPT.test(script)
}

export const runningGeminiPids = ({
    ps = () =>
        execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }),
    self = process.pid,
} = {}) =>
    ps()
        .split("\n")
        .map((line) => /^\s*(\d+)\s+(.*)$/.exec(line))
        .filter((m) => m && Number(m[1]) !== self && isGeminiCommand(m[2]))
        .map((m) => Number(m[1]))

export const assertGeminiNotRunning = (options) => {
    const pids = runningGeminiPids(options)
    if (pids.length > 0) {
        throw new Error(
            `gemini is running (pid ${pids.join(", ")}); it saves settings.json without a lock, so close it and run this again`
        )
    }
}

export const ownedAlias = (name) => name.startsWith(GEMINI_ALIAS_PREFIX)

// The text with exactly our aliases under modelConfigs.customAliases,
// one member edit at a time. A modelConfigs or customAliases that isn't
// an object is the user's to fix: it is refused, never replaced.
const withAliases = (text, aliases, settingsPath) => {
    const refuse = (what) => {
        throw new Error(
            `${settingsPath}: ${what} is not an object; fix it and run this again`
        )
    }
    text = withoutOldMarks(text)
    for (;;) {
        const root = parseJsonc(text)
        const configs = memberOf(root, "modelConfigs")
        if (!configs) {
            text = setMember(text, root, "modelConfigs", {
                customAliases: aliases,
            })
            continue
        }
        if (!isObj(configs.node.value)) refuse("modelConfigs")
        const custom = memberOf(configs.node, "customAliases")
        if (!custom) {
            text = setMember(text, configs.node, "customAliases", aliases)
            continue
        }
        if (!isObj(custom.node.value)) refuse("modelConfigs.customAliases")
        const list = custom.node
        const stale = list.members.find(
            (m) => ownedAlias(m.key) && !Object.hasOwn(aliases, m.key)
        )
        if (stale) {
            text = deleteMember(text, list, stale)
            continue
        }
        const todo = Object.entries(aliases).find(([name, def]) => {
            const found = list.members.filter((m) => m.key === name)
            return (
                found.length !== 1 ||
                JSON.stringify(found[0].node.value) !== JSON.stringify(def)
            )
        })
        if (!todo) return text
        const [name, def] = todo
        const found = list.members.filter((m) => m.key === name)
        text =
            found.length > 1
                ? deleteMember(text, list, found[0])
                : setMember(text, list, name, def)
    }
}

// The gemini homes listed in the record (one per line), in order.
export const readHomeRecord = (record) => {
    let text
    try {
        text = readFileSync(record, "utf8")
    } catch (err) {
        if (err.code === "ENOENT") return []
        throw err
    }
    return [...new Set(text.split("\n").filter((line) => line.trim()))]
}

// The gemini home a settings path belongs to (<home>/.gemini/settings.json).
export const homeOf = (settingsPath) =>
    path.dirname(path.dirname(path.resolve(settingsPath)))

// Adds home to the record unless it is listed already; true when added.
const recordHome = (record, home) => {
    if (readHomeRecord(record).includes(home)) return false
    mkdirSync(path.dirname(record), { recursive: true })
    appendFileSync(record, `${home}\n`, { mode: 0o600 })
    return true
}

// Takes home back out of the record (an entry this run just added).
const unrecordHome = (record, home) => {
    const left = readHomeRecord(record).filter((h) => h !== home)
    writeFileSync(record, left.map((h) => `${h}\n`).join(""), {
        mode: 0o600,
    })
}

// record: the file listing the gemini homes that have the aliases.
// Under the same lock, settingsPath's home is added before the edit, so
// uninstall (which reads it under that lock) never misses a home with
// aliases, and taken out again when the edit fails and this run added
// it, so it never lists a home the edit never reached.
export const mergeGeminiSettings = async ({
    settingsPath,
    aliases = geminiAliasDefinitions(),
    record = null,
    lockTarget,
    lock = withConfigLock,
    ...options
}) => {
    const home = homeOf(settingsPath)
    const r = await lock(lockTarget ?? settingsPath, () => {
        const added = record ? recordHome(record, home) : false
        try {
            return changeSettingsFile({
                settingsPath,
                ...options,
                // A missing or blank file starts as an empty object.
                compute: ({ text, root }) =>
                    withAliases(root ? text : "{\n}\n", aliases, settingsPath),
            })
        } catch (err) {
            if (added) unrecordHome(record, home)
            throw err
        }
    })
    if (!r.changed) return { action: "unchanged", path: settingsPath }
    return {
        action: r.existed ? "updated" : "installed",
        path: settingsPath,
        backup: r.backup,
    }
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
        const [, , settingsPath, lockTarget, record] = process.argv
        if (!settingsPath) {
            process.stderr.write(
                "usage: merge-gemini-settings.mjs <settingsPath> [lockTarget] [record]\n"
            )
            process.exit(1)
        }
        assertGeminiNotRunning()
        const r = await mergeGeminiSettings({
            settingsPath,
            lockTarget: lockTarget || settingsPath,
            record: record || null,
        })
        process.stdout.write(`${r.action}:${r.path}\n`)
    } catch (err) {
        process.stderr.write(`error:${err.message}\n`)
        process.exit(1)
    }
}
