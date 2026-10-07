/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import {
    handleSetMaxBlocks,
    MIN_MAX_BLOCKS,
    MAX_MAX_BLOCKS,
} from "./maxBlocks.js"

// Records each delta and answers like the shell's config transaction.
const fakeTransaction = (result = { revision: 4, replaced: [] }) => {
    const tx = async (delta) => {
        tx.calls.push(delta)
        return result
    }
    tx.calls = []
    return tx
}

const cfg = () => ({ limits: { maxBlocks: 5 }, reviewer: {} })

describe("handleSetMaxBlocks", () => {
    test("400 when value is missing or non-numeric, without a transaction", async () => {
        const tx = fakeTransaction()
        for (const body of [{}, { value: "x" }, { value: Infinity }]) {
            const r = await handleSetMaxBlocks({
                body,
                config: cfg(),
                configTransaction: tx,
            })
            expect(r.httpStatus).toBe(400)
            expect(r.body.ok).toBe(false)
        }
        expect(tx.calls).toEqual([])
    })

    test("400 when value is out of range", async () => {
        const tx = fakeTransaction()
        for (const value of [MIN_MAX_BLOCKS - 1, MAX_MAX_BLOCKS + 1]) {
            const r = await handleSetMaxBlocks({
                body: { value },
                config: cfg(),
                configTransaction: tx,
            })
            expect(r.httpStatus).toBe(400)
        }
        expect(tx.calls).toEqual([])
    })

    test("commits limits.maxBlocks through the config transaction", async () => {
        const tx = fakeTransaction()
        const r = await handleSetMaxBlocks({
            body: { value: 12 },
            config: cfg(),
            configTransaction: tx,
        })
        expect(tx.calls).toEqual([[[["limits", "maxBlocks"], 12]]])
        expect(r).toEqual({
            httpStatus: 200,
            body: {
                ok: true,
                value: 12,
                previous: 5,
                persisted: true,
                revision: 4,
            },
        })
    })

    test("truncates non-integer input; previous is null without a limits block", async () => {
        const tx = fakeTransaction()
        const r = await handleSetMaxBlocks({
            body: { value: 7.9 },
            config: {},
            configTransaction: tx,
        })
        expect(r.body).toMatchObject({ value: 7, previous: null })
    })

    test("reports a manual edit the change replaced", async () => {
        const replaced = [{ key: "limits.maxBlocks", manualValue: 9 }]
        const r = await handleSetMaxBlocks({
            body: { value: 3 },
            config: cfg(),
            configTransaction: fakeTransaction({ revision: 1, replaced }),
        })
        expect(r.body.replacedManualEdits).toEqual(replaced)
    })

    test("a rejected transaction is the response, with nothing changed", async () => {
        const err = Object.assign(new Error("config.json isn't valid JSON"), {
            code: "CONFIG_FILE_INVALID",
            httpStatus: 409,
        })
        const warn = []
        const r = await handleSetMaxBlocks({
            body: { value: 3 },
            config: cfg(),
            configTransaction: async () => {
                throw err
            },
            logger: { warn: (...a) => warn.push(a), info() {} },
        })
        expect(r).toEqual({
            httpStatus: 409,
            body: {
                ok: false,
                error: "config.json isn't valid JSON",
                code: "CONFIG_FILE_INVALID",
            },
        })
        expect(warn).toHaveLength(1)
    })
})
