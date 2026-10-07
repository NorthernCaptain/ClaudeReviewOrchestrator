/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import {
    handleSetBlockingSeverities,
    SEVERITY_ORDER,
} from "./blockingSeverities.js"

// Records each delta and answers like the shell's config transaction.
const fakeTransaction = (result = { revision: 2, replaced: [] }) => {
    const tx = async (delta) => {
        tx.calls.push(delta)
        return result
    }
    tx.calls = []
    return tx
}

const cfg = () => ({ blockingSeverities: ["blocker", "major"] })

describe("handleSetBlockingSeverities", () => {
    test("exposes the canonical severity order", () => {
        expect(SEVERITY_ORDER).toEqual(["blocker", "major", "minor", "nit"])
    })

    test("400 when value is missing or not an array", async () => {
        const tx = fakeTransaction()
        for (const body of [{}, { value: "major" }]) {
            const r = await handleSetBlockingSeverities({
                body,
                config: cfg(),
                configTransaction: tx,
            })
            expect(r.httpStatus).toBe(400)
        }
        expect(tx.calls).toEqual([])
    })

    test("400 when value contains an invalid severity", async () => {
        const r = await handleSetBlockingSeverities({
            body: { value: ["major", "critical"] },
            config: cfg(),
            configTransaction: fakeTransaction(),
        })
        expect(r.httpStatus).toBe(400)
        expect(r.body.error).toMatch(/critical/)
    })

    test("accepts an empty array as the 'nothing blocks' policy", async () => {
        const tx = fakeTransaction()
        const r = await handleSetBlockingSeverities({
            body: { value: [] },
            config: cfg(),
            configTransaction: tx,
        })
        expect(r.httpStatus).toBe(200)
        expect(tx.calls).toEqual([[[["blockingSeverities"], []]]])
    })

    test("commits the normalized policy through the config transaction", async () => {
        const tx = fakeTransaction()
        const r = await handleSetBlockingSeverities({
            body: { value: ["nit", "blocker", "nit"] },
            config: cfg(),
            configTransaction: tx,
        })
        expect(tx.calls).toEqual([
            [[["blockingSeverities"], ["blocker", "nit"]]],
        ])
        expect(r.body).toEqual({
            ok: true,
            value: ["blocker", "nit"],
            previous: ["blocker", "major"],
            persisted: true,
            revision: 2,
        })
    })

    test("previous is null when config had no prior array", async () => {
        const r = await handleSetBlockingSeverities({
            body: { value: ["blocker"] },
            config: {},
            configTransaction: fakeTransaction(),
        })
        expect(r.body.previous).toBeNull()
    })

    test("a rejected transaction is the response, with nothing changed", async () => {
        const r = await handleSetBlockingSeverities({
            body: { value: ["blocker"] },
            config: cfg(),
            configTransaction: async () => {
                throw new Error("config.json changed while saving — try again")
            },
        })
        expect(r.httpStatus).toBe(409)
        expect(r.body).toMatchObject({
            ok: false,
            code: "CONFIG_CHANGE_FAILED",
        })
    })
})
