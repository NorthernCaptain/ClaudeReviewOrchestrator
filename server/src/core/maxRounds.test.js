/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import {
    handleSetMaxRounds,
    MIN_MAX_ROUNDS,
    MAX_MAX_ROUNDS,
} from "./maxRounds.js"

// Records each delta and answers like the shell's config transaction.
const fakeTransaction = (result = { revision: 4, replaced: [] }) => {
    const tx = async (delta) => {
        tx.calls.push(delta)
        return result
    }
    tx.calls = []
    return tx
}

const cfg = () => ({ limits: { maxCodexRounds: 5 }, reviewer: {} })

describe("handleSetMaxRounds", () => {
    test("400 when value is missing or non-numeric, without a transaction", async () => {
        const tx = fakeTransaction()
        for (const body of [{}, { value: "x" }, { value: Infinity }]) {
            const r = await handleSetMaxRounds({
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
        for (const value of [MIN_MAX_ROUNDS - 1, MAX_MAX_ROUNDS + 1]) {
            const r = await handleSetMaxRounds({
                body: { value },
                config: cfg(),
                configTransaction: tx,
            })
            expect(r.httpStatus).toBe(400)
        }
        expect(tx.calls).toEqual([])
    })

    test("commits limits.maxCodexRounds through the config transaction", async () => {
        const tx = fakeTransaction()
        const r = await handleSetMaxRounds({
            body: { value: 12 },
            config: cfg(),
            configTransaction: tx,
        })
        expect(tx.calls).toEqual([[[["limits", "maxCodexRounds"], 12]]])
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
        const r = await handleSetMaxRounds({
            body: { value: 7.9 },
            config: {},
            configTransaction: tx,
        })
        expect(r.body).toMatchObject({ value: 7, previous: null })
    })

    test("reports a manual edit the change replaced", async () => {
        const replaced = [{ key: "limits.maxCodexRounds", manualValue: 9 }]
        const r = await handleSetMaxRounds({
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
        const r = await handleSetMaxRounds({
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
