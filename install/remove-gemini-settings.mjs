#!/usr/bin/env node
/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

// Remove our review effort aliases (names starting with
// GEMINI_ALIAS_PREFIX) from ~/.gemini/settings.json. Everything else
// stays, comments included; customAliases and modelConfigs stay too,
// even when only our aliases were in them (an empty one is harmless,
// and there is no telling whether the user made it). Idempotent.
//
// The command line cleans every gemini home install.sh recorded plus the
// ones it is given, under the config writers' lock: it checks that every
// file can be read and written before it changes any, then removes the
// record.

import {
    accessSync,
    constants,
    existsSync,
    readFileSync,
    rmSync,
} from "node:fs"
import path from "node:path"
import { withConfigLock } from "./config-lock.mjs"
import { parseJsonc } from "./jsonc.mjs"
import {
    assertGeminiNotRunning,
    changeSettingsFile,
    deleteMember,
    memberOf,
    ownedAlias,
    parseSettings,
    readHomeRecord,
    settingsTarget,
    updateSettingsFile,
    withoutOldMarks,
} from "./merge-gemini-settings.mjs"

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v)

// The text without our aliases (and old markers), or null when it has
// neither.
export const withoutAliases = (text) => {
    const start = text
    text = withoutOldMarks(text)
    for (;;) {
        const root = parseJsonc(text)
        const configs = memberOf(root, "modelConfigs")
        const custom = isObj(configs?.node.value)
            ? memberOf(configs.node, "customAliases")
            : null
        const ours =
            custom && isObj(custom.node.value)
                ? custom.node.members.find((m) => ownedAlias(m.key))
                : null
        if (!ours) return text === start ? null : text
        text = deleteMember(text, custom.node, ours)
    }
}

const compute = ({ text, root }) => (root ? withoutAliases(text) : null)

const resultOf = (settingsPath, absent, r) => {
    if (absent) return { action: "absent", path: settingsPath }
    if (!r.changed) return { action: "unchanged", path: settingsPath }
    return { action: "removed", path: settingsPath, backup: r.backup }
}

export const removeGeminiSettings = async ({ settingsPath, ...options }) => {
    const absent = !existsSync(settingsPath)
    const r = await updateSettingsFile({ settingsPath, ...options, compute })
    return resultOf(settingsPath, absent, r)
}

// Throws unless settingsPath is absent, needs no change, or can be
// read, parsed and replaced.
const checkSettings = (settingsPath, { read, access }) => {
    const target = settingsTarget(settingsPath)
    let text
    try {
        text = read(target)
    } catch (err) {
        if (err.code === "ENOENT") return
        throw new Error(`can't read ${settingsPath}: ${err.message}`)
    }
    if (compute(parseSettings(settingsPath, text)) === null) return
    try {
        access(target, constants.W_OK)
        access(path.dirname(target), constants.W_OK)
    } catch (err) {
        throw new Error(`can't write ${settingsPath}: ${err.message}`)
    }
}

// Every recorded gemini home's settings plus settingsPaths: all checked
// first, then cleaned, then the record removed, all under one lock.
export const removeAllGeminiSettings = ({
    settingsPaths = [],
    record = null,
    lockTarget,
    lock = withConfigLock,
    read = (p) => readFileSync(p, "utf8"),
    access = accessSync,
}) =>
    lock(lockTarget, () => {
        const recorded = record ? readHomeRecord(record) : []
        const paths = [
            ...new Set([
                ...settingsPaths.map((p) => path.resolve(p)),
                ...recorded.map((home) =>
                    path.join(home, ".gemini", "settings.json")
                ),
            ]),
        ]
        for (const p of paths) checkSettings(p, { read, access })
        const results = paths.map((p) =>
            resultOf(
                p,
                !existsSync(p),
                changeSettingsFile({ settingsPath: p, compute })
            )
        )
        if (record) rmSync(record, { force: true })
        return results
    })

/* istanbul ignore next */
const isDirectInvocation = () => {
    if (!process.argv[1]) return false
    if (!import.meta.url.startsWith("file:")) return false
    return import.meta.url.endsWith(path.basename(process.argv[1]))
}

/* istanbul ignore next */
if (isDirectInvocation()) {
    try {
        const args = process.argv.slice(2)
        const take = (flag) => {
            const i = args.indexOf(flag)
            if (i < 0) return null
            const [, value] = args.splice(i, 2)
            return value
        }
        const lockTarget = take("--lock")
        const record = take("--record")
        if (!lockTarget || args.length === 0) {
            process.stderr.write(
                "usage: remove-gemini-settings.mjs --lock <lockTarget> [--record <file>] <settingsPath>...\n"
            )
            process.exit(1)
        }
        assertGeminiNotRunning()
        const results = await removeAllGeminiSettings({
            settingsPaths: args,
            record,
            lockTarget,
        })
        for (const r of results) process.stdout.write(`${r.action}:${r.path}\n`)
    } catch (err) {
        process.stderr.write(`error:${err.message}\n`)
        process.exit(1)
    }
}
