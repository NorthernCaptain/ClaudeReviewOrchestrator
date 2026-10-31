/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createStateStore } from "../../state.js"
import {
    combineResults,
    dropLinks,
    LINK_IDLE_MS,
    linksOf,
    recordLink,
    runFolders,
    settleLinks,
} from "./linked.js"

const app = {
    repo: "app",
    repoRoot: "/w/app",
    branch: "main",
    key: "/w/app|main",
}
const infra = {
    repo: "infra",
    repoRoot: "/w/tmp/infra",
    branch: "feat",
    key: "/w/tmp/infra|feat",
}
const web = {
    repo: "web",
    repoRoot: "/w/tmp/web",
    branch: "x",
    key: "/w/tmp/web|x",
}

let dir
let store
beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "linked-"))
    store = createStateStore({ filePath: path.join(dir, "state.json") })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe("links", () => {
    test("recording keeps the first link time, refreshes the last edit, never links a context to itself", () => {
        let t = 1000
        expect(
            recordLink({ store, primary: app, secondary: infra, now: () => t })
        ).toBe(true)
        t = 2000
        recordLink({ store, primary: app, secondary: infra, now: () => t })
        expect(store.peek(app.key).linkedContexts[infra.key]).toEqual({
            repo: "infra",
            repoRoot: "/w/tmp/infra",
            branch: "feat",
            linkedAt: 1000,
            lastChangeAt: 2000,
        })
        expect(recordLink({ store, primary: app, secondary: app })).toBe(false)
        expect(store.peek(app.key).repoRoot).toBe("/w/app")
    })

    test("linksOf lists live links oldest first, and forgets ones idle past the limit", () => {
        recordLink({ store, primary: app, secondary: infra, now: () => 2000 })
        recordLink({ store, primary: app, secondary: web, now: () => 1000 })
        expect(
            linksOf({ store, key: app.key, now: () => 3000 }).map((l) => l.key)
        ).toEqual([web.key, infra.key])
        const later = 1000 + LINK_IDLE_MS + 1
        expect(
            linksOf({ store, key: app.key, now: () => later }).map((l) => l.key)
        ).toEqual([infra.key])
        expect(Object.keys(store.peek(app.key).linkedContexts)).toEqual([
            infra.key,
        ])
        expect(linksOf({ store, key: "/none|x" })).toEqual([])
    })

    test("dropLinks removes only the named keys and ignores contexts without links", () => {
        recordLink({ store, primary: app, secondary: infra })
        recordLink({ store, primary: app, secondary: web })
        dropLinks({ store, key: app.key, keys: [infra.key] })
        expect(Object.keys(store.peek(app.key).linkedContexts)).toEqual([
            web.key,
        ])
        dropLinks({ store, key: "/none|x", keys: [infra.key] })
        dropLinks({ store, key: app.key, keys: [] })
    })

    test("settling drops passed folders without edits since, and gone ones; keeps the rest", () => {
        const t0 = 1000
        for (const s of [infra, web]) {
            recordLink({ store, primary: app, secondary: s, now: () => t0 })
        }
        const other = {
            ...web,
            key: "/w/tmp/other|y",
            repoRoot: "/w/tmp/other",
        }
        const gone = { ...web, key: "/w/tmp/gone|y", repoRoot: "/w/tmp/gone" }
        const edited = {
            ...web,
            key: "/w/tmp/edited|y",
            repoRoot: "/w/tmp/edited",
        }
        for (const s of [other, gone]) {
            recordLink({ store, primary: app, secondary: s, now: () => t0 })
        }
        recordLink({ store, primary: app, secondary: edited, now: () => 5000 })
        const ok = (status, httpStatus = 200) => ({
            httpStatus,
            body: { status },
        })
        settleLinks({
            store,
            key: app.key,
            startedAt: 2000,
            results: [
                { link: infra, result: ok("GOOD_TO_GO") },
                { link: web, result: ok("ISSUES") },
                { link: other, result: ok("ESCALATE", 503) },
                { link: gone, result: ok("ESCALATE", 403) },
                { link: edited, result: ok("NO_CHANGES") },
            ],
        })
        expect(Object.keys(store.peek(app.key).linkedContexts).sort()).toEqual(
            [edited.key, other.key, web.key].sort()
        )
    })
})

describe("runFolders", () => {
    const deferred = () => {
        let resolve
        const promise = new Promise((r) => (resolve = r))
        return { promise, resolve }
    }

    test("a review holds its slot until its work is done, not just until it answers", async () => {
        const work = [deferred(), deferred()]
        const started = []
        const tasks = [0, 1, 2].map((i) => async () => {
            started.push(i)
            return { i, background: work[i]?.promise }
        })
        const { answered, done } = runFolders({
            tasks,
            limit: 2,
            notStarted: () => "skipped",
            settle: (answer) => answer.background,
        })
        await new Promise((r) => setImmediate(r))
        // Two answered, both still working: the third waits.
        expect(started).toEqual([0, 1])
        work[0].resolve()
        await new Promise((r) => setImmediate(r))
        expect(started).toEqual([0, 1, 2])
        work[1].resolve()
        expect((await answered).map((r) => r.i)).toEqual([0, 1, 2])
        await done
    })

    test("at the deadline, folders still waiting are answered as not started and never run", async () => {
        const busy = deferred()
        const started = []
        const tasks = [0, 1, 2].map((i) => async () => {
            started.push(i)
            return { i, background: i === 0 ? busy.promise : null }
        })
        const { answered, done } = runFolders({
            tasks,
            limit: 1,
            deadline: Date.now() + 20,
            notStarted: () => ({ skipped: true }),
            settle: (answer) => answer.background,
        })
        const results = await answered
        expect(results).toEqual([
            { i: 0, background: busy.promise },
            { skipped: true },
            { skipped: true },
        ])
        busy.resolve()
        await done
        expect(started).toEqual([0])
    })

    test("a review that throws is answered as failed; the others still answer and every slot is released", async () => {
        const { answered, done } = runFolders({
            tasks: [
                async () => "ok",
                async () => {
                    throw new Error("disk full")
                },
            ],
            notStarted: () => null,
            failed: (err) => ({ failed: err.message }),
            settle: async () => {
                throw new Error("cleanup broke")
            },
        })
        expect(await answered).toEqual(["ok", { failed: "disk full" }])
        await expect(done).resolves.toBeDefined()
    })

    test("with no deadline everything runs; an empty list is done at once", async () => {
        const { answered } = runFolders({
            tasks: [async () => 1, async () => 2],
            notStarted: () => null,
        })
        expect(await answered).toEqual([1, 2])
        const empty = runFolders({ tasks: [], notStarted: () => null })
        expect(await empty.answered).toEqual([])
        await empty.done
    })
})

describe("combineResults", () => {
    const entry = (ctx, body, extra = {}) => ({
        ...ctx,
        result: {
            httpStatus: 200,
            body: {
                context: {
                    repo: ctx.repo,
                    branch: ctx.branch,
                    repoRoot: ctx.repoRoot,
                },
                ...body,
            },
        },
        ...extra,
    })
    const finding = (file, severity = "major") => ({
        file,
        line: 3,
        severity,
        message: "m",
    })

    test("any blocking folder blocks the stop, with each finding labelled by its folder", () => {
        const r = combineResults([
            entry(
                app,
                {
                    status: "GOOD_TO_GO",
                    findings: [],
                    state: { codexRounds: 2 },
                },
                { primary: true }
            ),
            entry(infra, {
                status: "ISSUES",
                findings: [finding("a.php"), finding("n.php", "minor")],
                blockingFindings: [finding("a.php")],
                state: { codexRounds: 1 },
                codex: { provider: "codex" },
            }),
        ])
        expect(r.httpStatus).toBe(200)
        expect(r.body.status).toBe("ISSUES")
        expect(r.body.blockingFindings).toEqual([
            { ...finding("/w/tmp/infra/a.php"), folder: "/w/tmp/infra" },
        ])
        expect(r.body.findings).toHaveLength(2)
        expect(r.body.state).toEqual({ codexRounds: 1 })
        expect(
            r.body.folders.map((f) => [f.repoRoot, f.status, f.primary])
        ).toEqual([
            ["/w/app", "GOOD_TO_GO", true],
            ["/w/tmp/infra", "ISSUES", false],
        ])
        expect(r.body.folders[1]).toMatchObject({
            provider: "codex",
            blockingFindings: [finding("a.php")],
        })
    })

    test("all blocking folders unchanged is NO_PROGRESS; the session's own state leads when it blocks", () => {
        const r = combineResults([
            entry(
                app,
                {
                    status: "NO_PROGRESS_WITH_OPEN_ISSUES",
                    blockingFindings: [finding("x.js")],
                    state: { codexRounds: 4 },
                },
                { primary: true }
            ),
            entry(infra, {
                status: "NO_PROGRESS_WITH_OPEN_ISSUES",
                blockingFindings: [finding("/abs/y.php")],
            }),
        ])
        expect(r.body.status).toBe("NO_PROGRESS_WITH_OPEN_ISSUES")
        expect(r.body.state).toEqual({ codexRounds: 4 })
        // Already-absolute paths stay as they are.
        expect(r.body.blockingFindings.map((f) => f.file)).toEqual([
            "/w/app/x.js",
            "/abs/y.php",
        ])
    })

    test("the session's own ESCALATE stands; a linked folder's is reported but doesn't hold the stop", () => {
        const own = combineResults([
            {
                ...app,
                primary: true,
                result: {
                    httpStatus: 503,
                    body: {
                        status: "ESCALATE",
                        code: "GIT_TIMEOUT",
                        reason: "slow",
                        notifyUser: false,
                    },
                },
            },
            entry(infra, { status: "GOOD_TO_GO" }),
        ])
        expect(own.httpStatus).toBe(503)
        expect(own.body).toMatchObject({
            status: "ESCALATE",
            code: "GIT_TIMEOUT",
        })
        const linked = combineResults([
            entry(app, { status: "GOOD_TO_GO" }, { primary: true }),
            entry(infra, {
                status: "ESCALATE",
                code: "REVIEWER_TIMEOUT",
                reason: "slow",
            }),
        ])
        expect(linked.body.status).toBe("GOOD_TO_GO")
        expect(linked.body.folders[1]).toMatchObject({
            status: "ESCALATE",
            code: "REVIEWER_TIMEOUT",
            reason: "slow",
        })
    })

    test("passes: notes beat a plain pass, which beats NO_CHANGES", () => {
        const status = (...ss) =>
            combineResults(
                ss.map((s, i) =>
                    entry(
                        i === 0 ? app : infra,
                        { status: s },
                        { primary: i === 0 }
                    )
                )
            ).body.status
        expect(status("NO_CHANGES", "GOOD_TO_GO_WITH_NOTES")).toBe(
            "GOOD_TO_GO_WITH_NOTES"
        )
        expect(status("NO_CHANGES", "GOOD_TO_GO")).toBe("GOOD_TO_GO")
        expect(status("NO_CHANGES", "NO_CHANGES")).toBe("NO_CHANGES")
    })

    test("a missing result counts as a failed folder", () => {
        const r = combineResults([
            entry(app, { status: "GOOD_TO_GO" }, { primary: true }),
            { ...infra, result: null },
        ])
        expect(r.body.folders[1]).toMatchObject({
            repoRoot: "/w/tmp/infra",
            status: "ESCALATE",
            repo: "infra",
        })
    })
})
