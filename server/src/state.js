/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import {
    readFileSync,
    writeFileSync,
    renameSync,
    mkdirSync,
    existsSync,
} from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

export const defaultStatePath = () =>
    path.join(homedir(), ".cache", "review-orchestrator", "state.json")

const blankContext = ({ key, repoRoot, branch }) => ({
    key,
    repoRoot,
    branch,
    codexRounds: 0,
    blockCount: 0,
    lastBaseline: null,
    priorFindings: [],
    lastReviewedAt: 0,
    lastResultStatus: null,
})

const cloneState = (state) => JSON.parse(JSON.stringify(state))

const loadFromDisk = (filePath) => {
    if (!filePath) return {}
    if (!existsSync(filePath)) return {}
    try {
        const raw = readFileSync(filePath, "utf8")
        const parsed = JSON.parse(raw)
        if (parsed && typeof parsed === "object" && parsed.contexts) {
            return parsed.contexts
        }
        return {}
    } catch {
        return {}
    }
}

const persistAtomically = (filePath, contexts) => {
    if (!filePath) return
    const dir = path.dirname(filePath)
    mkdirSync(dir, { recursive: true })
    const tmp = `${filePath}.tmp`
    const payload = JSON.stringify({ version: 1, contexts }, null, 2)
    writeFileSync(tmp, payload, { mode: 0o600 })
    renameSync(tmp, filePath)
}

export const createStateStore = ({
    filePath = defaultStatePath(),
    now = Date.now,
    idleResetMs = 10 * 60 * 1000,
} = {}) => {
    const contexts = loadFromDisk(filePath)

    const ensure = ({ key, repoRoot, branch }) => {
        if (!contexts[key]) {
            contexts[key] = blankContext({ key, repoRoot, branch })
        }
        return contexts[key]
    }

    const get = ({ key, repoRoot, branch }) => {
        const state = ensure({ key, repoRoot, branch })
        // Idle reset: when the loop has been quiet long enough, drop
        // counters and the baseline so the next call starts fresh. We
        // preserve no historical data on purpose — see README "Counter
        // reset triggers".
        if (
            state.lastReviewedAt > 0 &&
            now() - state.lastReviewedAt > idleResetMs
        ) {
            contexts[key] = blankContext({ key, repoRoot, branch })
            persistAtomically(filePath, contexts)
        }
        return cloneState(contexts[key])
    }

    const save = (key, next) => {
        if (!contexts[key]) {
            contexts[key] = blankContext({
                key,
                repoRoot: next.repoRoot,
                branch: next.branch,
            })
        }
        Object.assign(contexts[key], next, { key })
        persistAtomically(filePath, contexts)
        return cloneState(contexts[key])
    }

    const reset = ({ key, repoRoot, branch }) => {
        contexts[key] = blankContext({ key, repoRoot, branch })
        persistAtomically(filePath, contexts)
        return cloneState(contexts[key])
    }

    const list = () => Object.values(contexts).map(cloneState)

    return { get, save, reset, list }
}

export const __test__ = { blankContext, cloneState }
