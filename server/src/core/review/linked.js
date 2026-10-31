/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

// Linked folders: other repos a session works on besides its own (a
// worktree of another repo, edited from the same session). A link lives
// on the session repo's context as `linkedContexts[key]` and is made by
// a change notification whose file is in another repo, or by an agent's
// request_review on another folder (linked to the session's advertised
// root). The Stop hook then reviews every linked
// folder alongside the session's own, in parallel, and answers once for
// all of them. A link goes away once its folder passes with no edit
// since, when the folder is no longer reviewable, or after
// LINK_IDLE_MS without an edit.

export const LINK_IDLE_MS = 12 * 60 * 60 * 1000
export const MAX_PARALLEL_REVIEWS = 3

const PASSING = new Set(["GOOD_TO_GO", "GOOD_TO_GO_WITH_NOTES", "NO_CHANGES"])

// Links `secondary` (a resolved context) to `primary`'s context, or
// refreshes its last edit time. A context never links to itself.
export const recordLink = ({ store, primary, secondary, now = Date.now }) => {
    if (primary.key === secondary.key) return false
    const existing = store.peek(primary.key)?.linkedContexts ?? {}
    const t = now()
    store.save(primary.key, {
        repoRoot: primary.repoRoot,
        branch: primary.branch,
        linkedContexts: {
            ...existing,
            [secondary.key]: {
                repo: secondary.repo,
                repoRoot: secondary.repoRoot,
                branch: secondary.branch,
                linkedAt: existing[secondary.key]?.linkedAt ?? t,
                lastChangeAt: t,
            },
        },
    })
    return true
}

const isLive = (link, t) =>
    Boolean(link) &&
    typeof link.repoRoot === "string" &&
    t - (Number(link.lastChangeAt) || 0) < LINK_IDLE_MS

// The live links of `key`'s context, oldest first; expired ones are
// dropped from the store on the way.
export const linksOf = ({ store, key, now = Date.now }) => {
    const all = store.peek(key)?.linkedContexts ?? {}
    const t = now()
    const expired = Object.keys(all).filter((k) => !isLive(all[k], t))
    if (expired.length > 0) dropLinks({ store, key, keys: expired })
    return Object.entries(all)
        .filter(([, link]) => isLive(link, t))
        .map(([linkKey, link]) => ({ key: linkKey, ...link }))
        .sort((a, b) => (a.linkedAt ?? 0) - (b.linkedAt ?? 0))
}

export const dropLinks = ({ store, key, keys }) => {
    const all = store.peek(key)?.linkedContexts
    if (!all || keys.length === 0) return
    const next = { ...all }
    for (const k of keys) delete next[k]
    store.save(key, { linkedContexts: next })
}

// After a Stop-hook fan-out: a linked folder that passed with no edit
// since `startedAt` is done; one that can't be reviewed any more (moved,
// deleted, outside allowedRoots, not a repo) is dropped too.
export const settleLinks = ({ store, key, results, startedAt }) => {
    const live = store.peek(key)?.linkedContexts ?? {}
    const done = []
    for (const { link, result } of results) {
        const status = result?.body?.status
        const editedSince =
            (Number(live[link.key]?.lastChangeAt) || 0) > startedAt
        const gone =
            result?.httpStatus === 400 ||
            result?.httpStatus === 403 ||
            result?.httpStatus === 404
        if (gone || (PASSING.has(status) && !editedSince)) done.push(link.key)
    }
    dropLinks({ store, key, keys: done })
}

// Runs the folders' reviews, at most `limit` at a time. A review holds
// its slot until its work is done (`settle(answer)`), even after it
// answered at the deadline with a reviewer still running; once the
// deadline passes, folders still waiting are answered `notStarted()`
// instead of starting late. A review that throws is answered
// `failed(err)`, so one folder never holds up the others. Returns
// { answered } (every answer, in order, by the deadline) and { done }
// (every slot released; never rejects).
export const runFolders = ({
    tasks,
    limit = MAX_PARALLEL_REVIEWS,
    deadline = null,
    notStarted,
    failed,
    settle = async () => {},
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
}) => {
    const slots = tasks.map(() => {
        let resolve
        const promise = new Promise((r) => (resolve = r))
        return { promise, resolve, state: "queued" }
    })
    const skipQueued = () => {
        for (const slot of slots) {
            if (slot.state !== "queued") continue
            slot.state = "skipped"
            slot.resolve(notStarted())
        }
    }
    const timer =
        deadline === null
            ? null
            : setTimer(skipQueued, Math.max(0, deadline - now()))
    let next = 0
    const worker = async () => {
        while (next < tasks.length) {
            const i = next++
            if (slots[i].state !== "queued") continue
            slots[i].state = "running"
            let answer
            try {
                answer = await tasks[i]()
            } catch (err) {
                answer = failed(err)
            }
            slots[i].resolve(answer)
            try {
                await settle(answer)
            } catch {
                // its work is over either way
            }
        }
    }
    const done = Promise.all(
        Array.from({ length: Math.min(limit, tasks.length) }, worker)
    ).finally(() => {
        if (timer !== null) clearTimer(timer)
    })
    return { answered: Promise.all(slots.map((s) => s.promise)), done }
}

const BLOCKING = new Set(["ISSUES", "NO_PROGRESS_WITH_OPEN_ISSUES"])

const labelled = (findings, repoRoot) =>
    (findings ?? []).map((f) => ({
        ...f,
        folder: repoRoot,
        file:
            typeof f?.file === "string" && !f.file.startsWith("/")
                ? `${repoRoot}/${f.file}`
                : f?.file,
    }))

const folderView = (entry) => {
    const body = entry.result?.body ?? {}
    return {
        repo: body.context?.repo ?? entry.repo ?? null,
        branch: body.context?.branch ?? entry.branch ?? null,
        repoRoot: body.context?.repoRoot ?? entry.repoRoot,
        primary: entry.primary === true,
        status: body.status ?? "ESCALATE",
        ...(body.code ? { code: body.code } : {}),
        ...(body.reason ? { reason: body.reason } : {}),
        ...(body.notifyUser !== undefined
            ? { notifyUser: body.notifyUser }
            : {}),
        state: body.state ?? null,
        provider: body.codex?.provider ?? null,
        findings: body.findings ?? [],
        blockingFindings: body.blockingFindings ?? [],
    }
}

// One answer for the session's folder and its linked ones. `entries` are
// { primary?, repoRoot, repo?, branch?, result } with the primary first.
//   - any folder with blocking findings → ISSUES (or NO_PROGRESS when
//     every blocking folder is unchanged), listing them all, each finding
//     labelled with its folder and an absolute path;
//   - else the session's own ESCALATE stands as it is;
//   - else the best pass; a linked folder's ESCALATE is reported but
//     doesn't hold the stop.
// `folders` carries each folder's own result for per-folder rendering.
export const combineResults = (entries) => {
    const folders = entries.map(folderView)
    const primary = entries[0].result
    const primaryBody = primary?.body ?? {}
    const blocking = folders.filter((f) => BLOCKING.has(f.status))
    const findings = folders.flatMap((f) => labelled(f.findings, f.repoRoot))
    const base = {
        ...primaryBody,
        findings,
        droppedFindings: primaryBody.droppedFindings ?? [],
        folders,
    }
    if (blocking.length > 0) {
        const lead = blocking.find((f) => f.primary) ?? blocking[0]
        return {
            httpStatus: 200,
            body: {
                ...base,
                status: blocking.some((f) => f.status === "ISSUES")
                    ? "ISSUES"
                    : "NO_PROGRESS_WITH_OPEN_ISSUES",
                blockingFindings: blocking.flatMap((f) =>
                    labelled(f.blockingFindings, f.repoRoot)
                ),
                state: lead.state ?? primaryBody.state,
            },
        }
    }
    if (primaryBody.status === "ESCALATE") {
        return {
            httpStatus: primary.httpStatus,
            body: { ...base, findings: primaryBody.findings ?? [] },
        }
    }
    const passes = folders.filter((f) => f.status !== "ESCALATE")
    const status = passes.some((f) => f.status === "GOOD_TO_GO_WITH_NOTES")
        ? "GOOD_TO_GO_WITH_NOTES"
        : passes.some((f) => f.status === "GOOD_TO_GO")
          ? "GOOD_TO_GO"
          : "NO_CHANGES"
    return {
        httpStatus: 200,
        body: { ...base, status, blockingFindings: [] },
    }
}
