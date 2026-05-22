/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
    clientHostFromBind,
    readConfigEndpoint,
} from "./read-config-endpoint.mjs"

const makeTmp = () => mkdtempSync(path.join(tmpdir(), "read-cfg-"))

describe("clientHostFromBind", () => {
    test("0.0.0.0 → 127.0.0.1", () => {
        expect(clientHostFromBind("0.0.0.0")).toBe("127.0.0.1")
    })
    test("empty/null → 127.0.0.1", () => {
        expect(clientHostFromBind("")).toBe("127.0.0.1")
        expect(clientHostFromBind(null)).toBe("127.0.0.1")
    })
    test(":: and ::1 → [::1]", () => {
        expect(clientHostFromBind("::")).toBe("[::1]")
        expect(clientHostFromBind("::1")).toBe("[::1]")
    })
    test("wraps bare IPv6 with multiple colons", () => {
        expect(clientHostFromBind("fe80::1")).toBe("[fe80::1]")
    })
    test("passes IPv4 / hostname through", () => {
        expect(clientHostFromBind("127.0.0.1")).toBe("127.0.0.1")
        expect(clientHostFromBind("localhost")).toBe("localhost")
    })
})

describe("readConfigEndpoint", () => {
    let dir
    beforeEach(() => {
        dir = makeTmp()
    })
    afterEach(() => rmSync(dir, { recursive: true, force: true }))

    test("returns defaults when port/bind absent", () => {
        const p = path.join(dir, "config.json")
        writeFileSync(p, JSON.stringify({ authToken: "x" }))
        const r = readConfigEndpoint({ configPath: p })
        expect(r).toEqual({
            port: 7777,
            bind: "127.0.0.1",
            clientHost: "127.0.0.1",
        })
    })

    test("returns config's port + bind when present", () => {
        const p = path.join(dir, "config.json")
        writeFileSync(
            p,
            JSON.stringify({ authToken: "x", port: 9999, bind: "0.0.0.0" })
        )
        const r = readConfigEndpoint({ configPath: p })
        expect(r.port).toBe(9999)
        expect(r.bind).toBe("0.0.0.0")
        expect(r.clientHost).toBe("127.0.0.1")
    })

    test("normalizes IPv6 wildcard to [::1] in clientHost", () => {
        const p = path.join(dir, "config.json")
        writeFileSync(p, JSON.stringify({ authToken: "x", bind: "::" }))
        const r = readConfigEndpoint({ configPath: p })
        expect(r.bind).toBe("::")
        expect(r.clientHost).toBe("[::1]")
    })

    test("throws on invalid JSON", () => {
        const p = path.join(dir, "config.json")
        writeFileSync(p, "{ not json")
        expect(() => readConfigEndpoint({ configPath: p })).toThrow(
            /failed to parse/
        )
    })
})
