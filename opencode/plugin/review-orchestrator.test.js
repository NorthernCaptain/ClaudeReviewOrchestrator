/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { jest } from "@jest/globals"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
// The plugin module exports ONLY its default (opencode skips a module that
// exports anything else), so the deps are injected through the input object.
import plugin from "./review-orchestrator.js"

const MUTATING_TOOLS = ["write", "edit", "patch", "bash"]

const here = path.dirname(fileURLToPath(import.meta.url))
// The plugin loads the /review protocol out of the installed copy of
// hooks/stop-review.mjs; point it at the repo's own copy for tests.
const LIB = path.join(here, "..", "..", "hooks", "stop-review.mjs")

const TOKEN = "tok-abc"
const CONFIG_JSON = JSON.stringify({ authToken: TOKEN, port: 7777 })

const okResponse = (body, status = 200) => ({
    status,
    json: async () => body,
})

// Minimal opencode client double: records what the plugin asked for.
const makeClient = ({ session = {}, sessionGetError = null } = {}) => {
    const calls = { prompts: [], toasts: [], sessionGets: [] }
    return {
        calls,
        tui: {
            showToast: jest.fn(async (opts) => {
                calls.toasts.push(opts.body)
            }),
        },
        session: {
            get: jest.fn(async (opts) => {
                calls.sessionGets.push(opts.path.id)
                if (sessionGetError) throw sessionGetError
                return { data: session }
            }),
            promptAsync: jest.fn(async (opts) => {
                calls.prompts.push(opts)
            }),
        },
    }
}

const build = async (over = {}) => {
    const client =
        over.client ?? makeClient({ session: { directory: "/repo" } })
    // over.fetchImpl === null omits the seam entirely, so the plugin picks
    // its own transport.
    const fetchImpl =
        over.fetchImpl === null
            ? null
            : (over.fetchImpl ?? jest.fn(async () => okResponse({})))
    const logs = []
    const hooks = await plugin({
        client,
        directory: "/repo",
        env: { REVIEW_ORCH_LIB: LIB, ...(over.env ?? {}) },
        ...(fetchImpl ? { fetchImpl } : {}),
        readFile: over.readFile ?? (() => CONFIG_JSON),
        logLine: (l) => logs.push(l),
        ...(over.importLib ? { importLib: over.importLib } : {}),
    })
    return { hooks, client, fetchImpl, logs }
}

describe("plugin activation", () => {
    test("registers all three hooks when the token and lib resolve", async () => {
        const { hooks } = await build()
        expect(Object.keys(hooks).sort()).toEqual([
            "config",
            "event",
            "tool.execute.after",
        ])
    })

    test("no-ops entirely when REVIEW_ORCH_SKIP is set", async () => {
        const { hooks, logs } = await build({
            env: { REVIEW_ORCH_SKIP: "1" },
        })
        expect(hooks).toEqual({})
        expect(logs.join("\n")).toMatch(/REVIEW_ORCH_SKIP=1/)
    })

    test("stays inactive (rather than throwing) when the lib is missing", async () => {
        const { hooks, logs } = await build({
            importLib: async () => {
                throw new Error("ENOENT")
            },
        })
        expect(hooks).toEqual({})
        expect(logs.join("\n")).toMatch(/could not load/)
    })

    test("stays inactive when config.json has no authToken", async () => {
        const { hooks, logs } = await build({
            readFile: () => JSON.stringify({}),
        })
        expect(hooks).toEqual({})
        expect(logs.join("\n")).toMatch(/no authToken/)
    })
})

describe("transport", () => {
    test("prefers the lib's node:http client over global fetch", async () => {
        // A review can outlast undici's 300s cap, which fires regardless of
        // our AbortController — that's why the lib ships nodeHttpFetch.
        const realLib = await import(pathToFileURL(LIB).href)
        const nodeHttpFetch = jest.fn(async () =>
            okResponse({ status: "GOOD_TO_GO", findings: [] })
        )
        const globalFetch = jest.fn()
        const prevFetch = globalThis.fetch
        globalThis.fetch = globalFetch
        try {
            const { hooks } = await build({
                fetchImpl: null,
                importLib: async () => ({ ...realLib, nodeHttpFetch }),
            })
            await hooks.event({
                event: { type: "session.idle", properties: { sessionID: "s" } },
            })
            expect(nodeHttpFetch).toHaveBeenCalledTimes(1)
            expect(globalFetch).not.toHaveBeenCalled()
        } finally {
            globalThis.fetch = prevFetch
        }
    })
})

describe("config hook (MCP registration)", () => {
    test("adds the review server with the token header", async () => {
        const { hooks } = await build()
        const cfg = {}
        await hooks.config(cfg)
        expect(cfg.mcp.review).toEqual({
            type: "remote",
            url: "http://127.0.0.1:7777/mcp",
            enabled: true,
            headers: { "X-Review-Token": TOKEN },
        })
    })

    test("preserves other MCP servers", async () => {
        const { hooks } = await build()
        const cfg = { mcp: { other: { type: "local", command: ["x"] } } }
        await hooks.config(cfg)
        expect(cfg.mcp.other).toEqual({ type: "local", command: ["x"] })
        expect(cfg.mcp.review).toBeDefined()
    })

    test("never clobbers a hand-written review entry", async () => {
        const { hooks } = await build()
        const mine = { type: "remote", url: "http://example/mcp" }
        const cfg = { mcp: { review: mine } }
        await hooks.config(cfg)
        expect(cfg.mcp.review).toBe(mine)
    })
})

describe("tool.execute.after (notify-change)", () => {
    test.each(MUTATING_TOOLS)("notifies for %s", async (tool) => {
        const { hooks, fetchImpl } = await build()
        await hooks["tool.execute.after"]({
            tool,
            sessionID: "ses_1",
            args: { filePath: "a.js" },
        })
        expect(fetchImpl).toHaveBeenCalledTimes(1)
        const [url, init] = fetchImpl.mock.calls[0]
        expect(url).toBe("http://127.0.0.1:7777/notify-change")
        expect(init.headers["x-review-token"]).toBe(TOKEN)
        expect(JSON.parse(init.body)).toEqual({
            cwd: "/repo",
            tool,
            file: "a.js",
        })
    })

    test("notifies against the editing session's own worktree", async () => {
        // One opencode server can host sessions in several worktrees.
        const client = makeClient({ session: { directory: "/other/repo" } })
        const { hooks, fetchImpl } = await build({ client })
        await hooks["tool.execute.after"]({
            tool: "write",
            sessionID: "ses_2",
            args: { filePath: "b.js" },
        })
        expect(JSON.parse(fetchImpl.mock.calls[0][1].body).cwd).toBe(
            "/other/repo"
        )
    })

    test("looks a session's directory up only once", async () => {
        const client = makeClient({ session: { directory: "/repo" } })
        const { hooks } = await build({ client })
        for (let i = 0; i < 3; i++) {
            await hooks["tool.execute.after"]({
                tool: "edit",
                sessionID: "ses_1",
                args: {},
            })
        }
        expect(client.calls.sessionGets).toEqual(["ses_1"])
    })

    test("ignores read-only tools", async () => {
        const { hooks, fetchImpl } = await build()
        for (const tool of ["read", "grep", "glob", "list", "task"]) {
            await hooks["tool.execute.after"]({ tool, args: {} })
        }
        expect(fetchImpl).not.toHaveBeenCalled()
    })

    test("survives a server that is down", async () => {
        const fetchImpl = jest.fn(async () => {
            throw new Error("ECONNREFUSED")
        })
        const { hooks } = await build({ fetchImpl })
        await expect(
            hooks["tool.execute.after"]({
                tool: "write",
                sessionID: "ses_1",
                args: {},
            })
        ).resolves.toBeUndefined()
    })
})

describe("event hook (session.idle → review)", () => {
    const idle = (sessionID = "ses_1") => ({
        event: { type: "session.idle", properties: { sessionID } },
    })

    test("ignores every event except session.idle", async () => {
        const { hooks, fetchImpl } = await build()
        await hooks.event({ event: { type: "session.status" } })
        await hooks.event({ event: { type: "message.updated" } })
        expect(fetchImpl).not.toHaveBeenCalled()
    })

    test("ignores an idle event with no sessionID", async () => {
        const { hooks, fetchImpl } = await build()
        await hooks.event({ event: { type: "session.idle", properties: {} } })
        expect(fetchImpl).not.toHaveBeenCalled()
    })

    test("posts /review with trigger stop_hook and the session's directory", async () => {
        const client = makeClient({ session: { directory: "/other/repo" } })
        const fetchImpl = jest.fn(async () =>
            okResponse({ status: "GOOD_TO_GO", findings: [] })
        )
        const { hooks } = await build({ client, fetchImpl })
        await hooks.event(idle())
        const [url, init] = fetchImpl.mock.calls[0]
        expect(url).toBe("http://127.0.0.1:7777/review")
        expect(JSON.parse(init.body)).toEqual({
            cwd: "/other/repo",
            session_id: "ses_1",
            trigger: "stop_hook",
        })
        expect(client.calls.prompts).toEqual([])
    })

    test("skips subagent sessions", async () => {
        const client = makeClient({
            session: { directory: "/repo", parentID: "ses_parent" },
        })
        const { hooks, fetchImpl } = await build({ client })
        await hooks.event(idle("ses_child"))
        expect(fetchImpl).not.toHaveBeenCalled()
    })

    test("falls back to the plugin directory when session lookup fails", async () => {
        const client = makeClient({ sessionGetError: new Error("nope") })
        const fetchImpl = jest.fn(async () =>
            okResponse({ status: "GOOD_TO_GO", findings: [] })
        )
        const { hooks } = await build({ client, fetchImpl })
        await hooks.event(idle())
        expect(JSON.parse(fetchImpl.mock.calls[0][1].body).cwd).toBe("/repo")
    })

    test("feeds blocking findings back as a new user turn", async () => {
        const client = makeClient({ session: { directory: "/repo" } })
        const fetchImpl = jest.fn(async () =>
            okResponse({
                status: "ISSUES",
                findings: [],
                blockingFindings: [
                    {
                        file: "a.js",
                        line: 4,
                        severity: "blocker",
                        category: "bug",
                        message: "off by one",
                        suggestion: null,
                    },
                ],
                state: { codexRounds: 1, blockCount: 1 },
                codex: { provider: "claude" },
            })
        )
        const { hooks } = await build({ client, fetchImpl })
        await hooks.event(idle())
        expect(client.calls.prompts).toHaveLength(1)
        const sent = client.calls.prompts[0]
        expect(sent.path).toEqual({ id: "ses_1" })
        const text = sent.body.parts[0].text
        expect(text).toMatch(/DESCRIPTIVE DATA/)
        expect(text).toMatch(/a\.js:4/)
        expect(text).toMatch(/off by one/)
    })

    test("passive mode reports via toast instead of continuing the session", async () => {
        const client = makeClient({ session: { directory: "/repo" } })
        const fetchImpl = jest.fn(async () =>
            okResponse({
                status: "ISSUES",
                findings: [],
                blockingFindings: [
                    {
                        file: "a.js",
                        line: 1,
                        severity: "major",
                        category: "bug",
                        message: "x",
                        suggestion: null,
                    },
                ],
            })
        )
        const { hooks, logs } = await build({
            client,
            fetchImpl,
            env: { REVIEW_ORCH_OPENCODE_PASSIVE: "1" },
        })
        await hooks.event(idle())
        expect(client.calls.prompts).toEqual([])
        expect(client.calls.toasts[0].variant).toBe("warning")
        // The toast points at the terminal, so the findings must be there:
        // decideStopHookResponse returns them only in the block reason.
        expect(logs.join("\n")).toMatch(/a\.js:1/)
    })

    test("passive mode labels a reviewer failure as a failure, not findings", async () => {
        const client = makeClient({ session: { directory: "/repo" } })
        const fetchImpl = jest.fn(async () =>
            okResponse({
                status: "ESCALATE",
                findings: [],
                reason: "codex exited with code 1",
                code: "CODEX_ERROR",
                notifyUser: true,
            })
        )
        const { hooks, logs } = await build({
            client,
            fetchImpl,
            env: { REVIEW_ORCH_OPENCODE_PASSIVE: "1" },
        })
        await hooks.event(idle())
        expect(client.calls.toasts[0]).toEqual({
            title: "code review",
            message: "reviewer failed — see the terminal output",
            variant: "error",
        })
        expect(logs.join("\n")).toMatch(/REVIEWER FAILURE/)
    })

    test("toasts terminal non-ISSUES statuses", async () => {
        const cases = [
            ["GOOD_TO_GO_WITH_NOTES", "success"],
            ["NO_CHANGES", "success"],
            ["ESCALATE", "warning"],
        ]
        for (const [status, variant] of cases) {
            const client = makeClient({ session: { directory: "/repo" } })
            const fetchImpl = jest.fn(async () =>
                okResponse({ status, findings: [], reason: "r", code: "c" })
            )
            const { hooks } = await build({ client, fetchImpl })
            await hooks.event(idle())
            expect(client.calls.toasts[0]).toEqual({
                title: "code review",
                message: status,
                variant,
            })
            expect(client.calls.prompts).toEqual([])
        }
    })

    test("a fetch failure logs and never continues the session", async () => {
        const client = makeClient({ session: { directory: "/repo" } })
        const fetchImpl = jest.fn(async () => {
            throw new Error("ECONNREFUSED")
        })
        const { hooks, logs } = await build({ client, fetchImpl })
        await hooks.event(idle())
        expect(client.calls.prompts).toEqual([])
        expect(logs.join("\n")).toMatch(/ECONNREFUSED/)
    })

    test.each([
        [
            "a rejection",
            () => {
                throw new Error("session is busy")
            },
            /session is busy/,
        ],
        [
            // hey-api is generated with ThrowOnError=false, so a failed call
            // RESOLVES with { error } — catching alone would miss it and the
            // findings would vanish silently.
            "a resolved { error }",
            async () => ({
                data: undefined,
                error: { data: { message: "session is busy" } },
            }),
            /session is busy/,
        ],
        [
            "a bare string error",
            async () => ({ data: undefined, error: "session is busy" }),
            /session is busy/,
        ],
        [
            // No message anywhere — fall back to the serialized payload.
            "a shapeless error payload",
            async () => ({
                data: undefined,
                error: { errors: [{ field: "parts" }] },
            }),
            /"field":"parts"/,
        ],
    ])(
        "prints the findings when the hand-back fails with %s",
        async (_label, promptAsync, expected) => {
            const client = makeClient({ session: { directory: "/repo" } })
            client.session.promptAsync = jest.fn(promptAsync)
            const fetchImpl = jest.fn(async () =>
                okResponse({
                    status: "ISSUES",
                    findings: [],
                    blockingFindings: [
                        {
                            file: "a.js",
                            line: 9,
                            severity: "blocker",
                            category: "bug",
                            message: "boom",
                            suggestion: null,
                        },
                    ],
                })
            )
            const { hooks, logs } = await build({ client, fetchImpl })
            await expect(hooks.event(idle())).resolves.toBeUndefined()
            const out = logs.join("\n")
            expect(out).toMatch(/could not hand the findings back/)
            expect(out).toMatch(expected)
            expect(out).toMatch(/a\.js:9/)
        }
    )

    test("treats a successful hand-back as success (no error branch)", async () => {
        const client = makeClient({ session: { directory: "/repo" } })
        client.session.promptAsync = jest.fn(async () => ({
            data: { info: {} },
            error: undefined,
        }))
        const fetchImpl = jest.fn(async () =>
            okResponse({
                status: "ISSUES",
                findings: [],
                blockingFindings: [
                    {
                        file: "a.js",
                        line: 1,
                        severity: "blocker",
                        category: "bug",
                        message: "x",
                        suggestion: null,
                    },
                ],
            })
        )
        const { hooks, logs } = await build({ client, fetchImpl })
        await hooks.event(idle())
        expect(logs.join("\n")).not.toMatch(/could not hand the findings back/)
    })

    test("logs, rather than throwing, when the session refuses the findings", async () => {
        // The user starting a new turn between idle and the hand-back is
        // the common case; their turn wins.
        const client = makeClient({ session: { directory: "/repo" } })
        client.session.promptAsync = jest.fn(async () => {
            throw new Error("session is busy")
        })
        const fetchImpl = jest.fn(async () =>
            okResponse({
                status: "ISSUES",
                findings: [],
                blockingFindings: [
                    {
                        file: "a.js",
                        line: 1,
                        severity: "blocker",
                        category: "bug",
                        message: "x",
                        suggestion: null,
                    },
                ],
            })
        )
        const { hooks, logs } = await build({ client, fetchImpl })
        await expect(hooks.event(idle())).resolves.toBeUndefined()
        expect(logs.join("\n")).toMatch(/could not hand the findings back/)
        // …and the findings themselves are printed rather than lost.
        expect(logs.join("\n")).toMatch(/a\.js:1/)
    })

    test("a 200 with a non-JSON body is treated as an empty response", async () => {
        // e.g. a reverse proxy answering with HTML on the review port.
        const client = makeClient({ session: { directory: "/repo" } })
        const fetchImpl = jest.fn(async () => ({
            status: 200,
            json: async () => {
                throw new Error("Unexpected token <")
            },
        }))
        const { hooks, logs } = await build({ client, fetchImpl })
        await hooks.event(idle())
        expect(client.calls.prompts).toEqual([])
        expect(logs.join("\n")).toMatch(/empty response/)
    })

    test("an HTTP error status logs and never continues the session", async () => {
        const client = makeClient({ session: { directory: "/repo" } })
        const fetchImpl = jest.fn(async () => okResponse({}, 500))
        const { hooks, logs } = await build({ client, fetchImpl })
        await hooks.event(idle())
        expect(client.calls.prompts).toEqual([])
        expect(logs.join("\n")).toMatch(/HTTP 500/)
    })

    test("survives a TUI that cannot show toasts", async () => {
        const client = makeClient({ session: { directory: "/repo" } })
        client.tui.showToast = jest.fn(async () => {
            throw new Error("no tui")
        })
        const fetchImpl = jest.fn(async () =>
            okResponse({ status: "NO_CHANGES", findings: [] })
        )
        const { hooks } = await build({ client, fetchImpl })
        await expect(hooks.event(idle())).resolves.toBeUndefined()
    })

    test("does not run two reviews for the same session at once", async () => {
        const client = makeClient({ session: { directory: "/repo" } })
        let release
        const gate = new Promise((r) => {
            release = r
        })
        const fetchImpl = jest.fn(async () => {
            await gate
            return okResponse({ status: "GOOD_TO_GO", findings: [] })
        })
        const { hooks } = await build({ client, fetchImpl })
        const first = hooks.event(idle())
        await hooks.event(idle())
        release()
        await first
        expect(fetchImpl).toHaveBeenCalledTimes(1)
    })

    test("reviews again on the next idle after the first completes", async () => {
        const client = makeClient({ session: { directory: "/repo" } })
        const fetchImpl = jest.fn(async () =>
            okResponse({ status: "GOOD_TO_GO", findings: [] })
        )
        const { hooks } = await build({ client, fetchImpl })
        await hooks.event(idle())
        await hooks.event(idle())
        expect(fetchImpl).toHaveBeenCalledTimes(2)
    })
})
