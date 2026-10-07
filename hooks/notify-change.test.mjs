/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { jest } from "@jest/globals"
import { Readable } from "node:stream"
import { __main_for_tests as main } from "./notify-change.mjs"

const stdinOf = (text) => Readable.from([text])

const connected = () => {
    const request = jest.fn(async () => ({ httpStatus: 200 }))
    return {
        request,
        connect: jest.fn(async () => ({ ok: true, request })),
    }
}

describe("notify-change hook", () => {
    test("sends a signed POST /notify-change with the cwd, tool and file", async () => {
        const c = connected()
        const code = await main({
            stdin: stdinOf(
                JSON.stringify({
                    cwd: "/repo",
                    tool_name: "Edit",
                    tool_input: { file_path: "/repo/a.js" },
                })
            ),
            connect: c.connect,
        })
        expect(code).toBe(0)
        expect(c.connect).toHaveBeenCalledWith({ challengeTimeoutMs: 1000 })
        expect(c.request).toHaveBeenCalledWith({
            method: "POST",
            path: "/notify-change",
            body: { cwd: "/repo", tool: "Edit", file: "/repo/a.js" },
            timeoutMs: 2000,
        })
    })

    test("missing tool fields are sent as null", async () => {
        const c = connected()
        await main({ stdin: stdinOf('{"cwd":"/r"}'), connect: c.connect })
        expect(c.request.mock.calls[0][0].body).toEqual({
            cwd: "/r",
            tool: null,
            file: null,
        })
    })

    test("bad JSON, an empty payload or no cwd sends nothing", async () => {
        for (const text of ["{ bad", "", '{"cwd":""}']) {
            const c = connected()
            await expect(
                main({ stdin: stdinOf(text), connect: c.connect })
            ).resolves.toBe(0)
            expect(c.connect).not.toHaveBeenCalled()
        }
    })

    test("no connection, or a throwing one, is silent", async () => {
        const request = jest.fn()
        await expect(
            main({
                stdin: stdinOf('{"cwd":"/r"}'),
                connect: async () => ({ ok: false, request }),
            })
        ).resolves.toBe(0)
        expect(request).not.toHaveBeenCalled()
        await expect(
            main({
                stdin: stdinOf('{"cwd":"/r"}'),
                connect: async () => {
                    throw new Error("boom")
                },
            })
        ).resolves.toBe(0)
    })

    test("a Buffer chunk on stdin is read as UTF-8", async () => {
        const c = connected()
        await main({
            stdin: Readable.from([Buffer.from('{"cwd":"/b"}')]),
            connect: c.connect,
        })
        expect(c.request.mock.calls[0][0].body.cwd).toBe("/b")
    })
})
