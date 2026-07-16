#!/usr/bin/env node
/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

// Add our Stop + PostToolUse hook entries to ~/.codex/hooks.json.
//
// Codex's hooks.json has a small config envelope (unlike Claude Code's
// settings.json):
//
//   {
//     "description": "...",
//     "hooks": {
//       "Stop":        [ { "hooks": [ { type, command, timeout } ] } ],
//       "PostToolUse": [ { "matcher": "...", "hooks": [ { ... } ] } ]
//     }
//   }
//
// The stdin contract and the { decision:"block", reason } Stop output are
// the same as Claude Code's, so the SAME hook scripts (stop-review.mjs,
// notify-change.mjs) are reused — only the registration shape differs.
//
// Idempotent and sibling-preserving: each event keeps exactly one of our
// entries in a single canonical block, refreshed to the current shape;
// user-authored hooks in the same or other blocks are left intact. This
// is the merge-post-tool-use-hook.mjs algorithm generalized to either
// event (matcher present → PostToolUse; matcher null → Stop) and to the
// Codex's hooks envelope.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import { HARNESS_TIMEOUT_SECONDS } from "./merge-stop-hook.mjs"

// Mark the context dirty after ANY codex tool that can write files:
//   - apply_patch (file edits; Edit/Write are matcher aliases for it)
//   - exec_command (codex's shell tool — formatters, codegen, `sed -i`,
//     redirects, …) and write_stdin (feeding an interactive command)
//   - Bash (the name the hooks docs advertise; kept for version-robustness
//     in case a codex build normalizes the shell tool to it)
// The shell tools matter because the server's fast path trusts
// dirtySinceLastReview to short-circuit to NO_CHANGES; a command-side
// edit that didn't flip the flag could otherwise be followed by a Stop
// that skips review of the new diff. Over-marking on read-only commands
// is harmless — it only forces the (cheap) hash-based change check
// instead of the flag fast path; it never spawns an extra reviewer run
// when nothing actually changed. Anchored so it can't match unrelated
// mcp__*/substring tool names. (Verified against codex-cli 0.142.2.)
export const POST_MATCHER =
    "^(apply_patch|Edit|Write|exec_command|write_stdin|Bash)$"
// notify-change is a fire-and-forget fast path; it never needs long.
export const POST_TIMEOUT_SECONDS = 10
export const DESCRIPTION = "Review Orchestrator lifecycle hooks"

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v)

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

// Upsert our single entry into one event's matcher-block array.
// matcher === null → Stop-style block (canonical = block with no
// matcher). Returns { list, changed }. Ported from
// merge-post-tool-use-hook.mjs: pick one home, strip our command from
// every other block (dropping blocks emptied by the strip), refresh.
const mergeEvent = (rawList, ourEntry, matcher) => {
    const hookPath = ourEntry.command
    const list = Array.isArray(rawList) ? rawList.map((m) => m) : []
    const ourBlock =
        matcher === null
            ? { hooks: [ourEntry] }
            : { matcher, hooks: [ourEntry] }
    const isCanonical = (b) =>
        isObj(b) &&
        (matcher === null ? !("matcher" in b) : b.matcher === matcher)
    const hasOurs = (b) =>
        Array.isArray(b?.hooks) && b.hooks.some((h) => h?.command === hookPath)

    let preferredIdx = list.findIndex((b) => isCanonical(b) && hasOurs(b))
    if (preferredIdx === -1) preferredIdx = list.findIndex(isCanonical)
    const preferredRef = preferredIdx !== -1 ? list[preferredIdx] : null

    let changed = false
    const reindexed = []
    list.forEach((block, i) => {
        if (i === preferredIdx) {
            reindexed.push(block)
            return
        }
        if (!isObj(block) || !Array.isArray(block.hooks) || !hasOurs(block)) {
            reindexed.push(block)
            return
        }
        const kept = block.hooks.filter((h) => h?.command !== hookPath)
        if (kept.length > 0) reindexed.push({ ...block, hooks: kept })
        changed = true
    })

    if (preferredRef) {
        const where = reindexed.indexOf(preferredRef)
        const block = reindexed[where]
        const blockHooks = Array.isArray(block.hooks) ? block.hooks : []
        const firstIdx = blockHooks.findIndex((h) => h?.command === hookPath)
        let nextHooks
        if (firstIdx === -1) {
            nextHooks = [...blockHooks, ourEntry]
        } else {
            nextHooks = []
            for (let i = 0; i < blockHooks.length; i++) {
                const h = blockHooks[i]
                if (h?.command !== hookPath) {
                    nextHooks.push(h)
                    continue
                }
                if (i === firstIdx) nextHooks.push(ourEntry)
            }
        }
        if (JSON.stringify(nextHooks) !== JSON.stringify(blockHooks)) {
            reindexed[where] = { ...block, hooks: nextHooks }
            changed = true
        }
    } else {
        reindexed.push(ourBlock)
        changed = true
    }

    return { list: reindexed, changed }
}

export const mergeCodexHooks = ({
    hooksJsonPath,
    stopHookPath,
    notifyHookPath,
    stopTimeout = HARNESS_TIMEOUT_SECONDS,
    postTimeout = POST_TIMEOUT_SECONDS,
    postMatcher = POST_MATCHER,
    now = () => new Date().toISOString().replace(/[:.]/g, "-"),
    existsFn = existsSync,
    readFile = readFileSync,
    writeAtomicFn = writeAtomic,
    backup = backupIfDifferent,
}) => {
    let root = {}
    const existed = existsFn(hooksJsonPath)
    if (existed) {
        const raw = readFile(hooksJsonPath, "utf8")
        if (raw.trim() !== "") {
            try {
                root = JSON.parse(raw)
            } catch (err) {
                throw new Error(
                    `failed to parse ${hooksJsonPath}: ${err.message}`
                )
            }
            if (!isObj(root)) {
                throw new Error(
                    `${hooksJsonPath} is valid JSON but not an object`
                )
            }
        }
    }

    const stopEntry = {
        type: "command",
        command: stopHookPath,
        timeout: stopTimeout,
    }
    const postEntry = {
        type: "command",
        command: notifyHookPath,
        timeout: postTimeout,
    }

    // Versions of this installer before Codex's hooks-config envelope was
    // discovered wrote event names at the root. Migrate that exact legacy
    // shape on the next install; it is not accepted by current Codex.
    const legacyRoot = !isObj(root.hooks)
    const hooks = legacyRoot ? root : root.hooks
    const stop = mergeEvent(hooks.Stop, stopEntry, null)
    const post = mergeEvent(hooks.PostToolUse, postEntry, postMatcher)

    if (existed && !legacyRoot && !stop.changed && !post.changed) {
        return { action: "unchanged", path: hooksJsonPath }
    }

    const nextHooks = { ...hooks, Stop: stop.list, PostToolUse: post.list }
    const next = legacyRoot
        ? { description: DESCRIPTION, hooks: nextHooks }
        : { ...root, hooks: nextHooks }
    const serialized = JSON.stringify(next, null, 2) + "\n"
    const ts = now()
    const bak = backup(hooksJsonPath, serialized, ts)
    writeAtomicFn(hooksJsonPath, serialized)
    return {
        action: existed ? "updated" : "installed",
        path: hooksJsonPath,
        backup: bak,
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
        const hooksJsonPath = process.argv[2]
        const stopHookPath = process.argv[3]
        const notifyHookPath = process.argv[4]
        if (!hooksJsonPath || !stopHookPath || !notifyHookPath) {
            process.stderr.write(
                "usage: merge-codex-hooks.mjs <hooksJsonPath> <stopHookPath> <notifyHookPath>\n"
            )
            process.exit(1)
        }
        const r = mergeCodexHooks({
            hooksJsonPath,
            stopHookPath,
            notifyHookPath,
        })
        process.stdout.write(`${r.action}:${r.path}\n`)
    } catch (err) {
        process.stderr.write(`error:${err.message}\n`)
        process.exit(1)
    }
}
