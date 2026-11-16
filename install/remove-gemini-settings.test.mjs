/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { mergeGeminiSettings, OLD_MARK } from "./merge-gemini-settings.mjs"
import { parseJsonc } from "./jsonc.mjs"
import {
    removeAllGeminiSettings,
    removeGeminiSettings,
} from "./remove-gemini-settings.mjs"
import { geminiAliasDefinitions } from "../server/src/core/review/gemini.js"

const OURS = geminiAliasDefinitions()
const read = (p) => parseJsonc(readFileSync(p, "utf8")).value
const text = (p) => readFileSync(p, "utf8")

describe("removeGeminiSettings", () => {
    let dir
    let settings
    beforeEach(() => {
        dir = mkdtempSync(path.join(tmpdir(), "gemini-settings-"))
        settings = path.join(dir, "settings.json")
    })
    afterEach(() => rmSync(dir, { recursive: true, force: true }))

    const remove = (extra = {}) =>
        removeGeminiSettings({ settingsPath: settings, ...extra })

    test("absent when there is no settings file", async () => {
        expect((await remove()).action).toBe("absent")
        expect(existsSync(settings)).toBe(false)
    })

    test("unchanged without aliases of ours, or for a blank file", async () => {
        writeFileSync(settings, JSON.stringify({ security: {} }))
        expect((await remove()).action).toBe("unchanged")
        writeFileSync(
            settings,
            JSON.stringify({ modelConfigs: { customAliases: { mine: {} } } })
        )
        expect((await remove()).action).toBe("unchanged")
        writeFileSync(settings, JSON.stringify({ modelConfigs: [] }))
        expect((await remove()).action).toBe("unchanged")
        writeFileSync(settings, " \n")
        expect((await remove()).action).toBe("unchanged")
    })

    test("removes only our aliases, keeps the rest and the file's mode", async () => {
        writeFileSync(
            settings,
            JSON.stringify({
                security: { auth: {} },
                modelConfigs: {
                    overrides: [],
                    customAliases: { mine: {}, ...OURS },
                },
            })
        )
        chmodSync(settings, 0o640)
        const r = await remove({ now: () => "TS" })
        expect(r).toEqual({
            action: "removed",
            path: settings,
            backup: expect.stringMatching(/\.bak\.TS-[0-9a-f]{8}$/),
        })
        expect(r.backup.startsWith(`${settings}.bak.TS-`)).toBe(true)
        expect(read(settings)).toEqual({
            security: { auth: {} },
            modelConfigs: { overrides: [], customAliases: { mine: {} } },
        })
        expect(statSync(settings).mode & 0o777).toBe(0o640)
    })

    test("keeps the containers, even ones the installer created", async () => {
        writeFileSync(settings, '{\n  "security": { "auth": {} }\n}\n')
        await mergeGeminiSettings({ settingsPath: settings })
        expect((await remove()).action).toBe("removed")
        expect(JSON.parse(text(settings))).toEqual({
            security: { auth: {} },
            modelConfigs: { customAliases: {} },
        })
    })

    test("takes out markers from 1.12.0 pre-releases", async () => {
        writeFileSync(
            settings,
            `{\n  "modelConfigs": {\n    ${OLD_MARK}\n    "customAliases": {}\n  }\n}\n`
        )
        expect((await remove()).action).toBe("removed")
        expect(text(settings)).toBe(
            '{\n  "modelConfigs": {\n    "customAliases": {}\n  }\n}\n'
        )
    })

    test("keeps an empty customAliases the user had", async () => {
        const original = '{"modelConfigs":{"customAliases":{}}}'
        writeFileSync(settings, original)
        await mergeGeminiSettings({ settingsPath: settings })
        await remove()
        expect(text(settings)).toBe(original)
    })

    test("keeps a container that holds a comment", async () => {
        const original = [
            "{",
            '  "modelConfigs": {',
            '    "customAliases": {',
            "      // My aliases belong here",
            "    }",
            "  }",
            "}",
            "",
        ].join("\n")
        writeFileSync(settings, original)
        await mergeGeminiSettings({ settingsPath: settings })
        await remove()
        expect(text(settings)).toBe(original)
    })

    test("keeps a created container the user added to", async () => {
        await mergeGeminiSettings({ settingsPath: settings })
        const added = text(settings).replace(
            '"customAliases": {',
            '"customAliases": {\n      "mine": {},'
        )
        writeFileSync(settings, added)
        await remove()
        expect(read(settings)).toEqual({
            modelConfigs: { customAliases: { mine: {} } },
        })
    })

    test("keeps a created modelConfigs that holds more than our aliases", async () => {
        await mergeGeminiSettings({ settingsPath: settings })
        const added = text(settings).replace(
            '"modelConfigs": {',
            '"modelConfigs": {\n    "overrides": [],'
        )
        writeFileSync(settings, added)
        await remove()
        expect(read(settings)).toEqual({
            modelConfigs: { overrides: [], customAliases: {} },
        })
    })

    test("comments between an alias and its comma stay", async () => {
        const name = "review-orchestrator-gemini-4-carbon-low"
        writeFileSync(
            settings,
            [
                "{",
                '  "modelConfigs": {',
                '    "customAliases": {',
                `      "${name}": {}`,
                "      // keep note",
                "      ,",
                '      "mine": {} /* also mine */',
                "    }",
                "  }",
                "}",
                "",
            ].join("\n")
        )
        await remove()
        expect(text(settings)).toBe(
            [
                "{",
                '  "modelConfigs": {',
                '    "customAliases": {',
                "      // keep note",
                '      "mine": {} /* also mine */',
                "    }",
                "  }",
                "}",
                "",
            ].join("\n")
        )
        writeFileSync(
            settings,
            [
                "{",
                '  "modelConfigs": {',
                '    "customAliases": {',
                `      "${name}": {} // keep inline note`,
                "      ,",
                '      "mine": {}',
                "    }",
                "  }",
                "}",
                "",
            ].join("\n")
        )
        await remove()
        expect(text(settings)).toBe(
            [
                "{",
                '  "modelConfigs": {',
                '    "customAliases": {',
                "      // keep inline note",
                '      "mine": {}',
                "    }",
                "  }",
                "}",
                "",
            ].join("\n")
        )
        writeFileSync(
            settings,
            `{"modelConfigs": {"customAliases": {"${name}": {} /* c */, "mine": {}}}}`
        )
        await remove()
        expect(text(settings)).toBe(
            '{"modelConfigs": {"customAliases": {/* c */ "mine": {}}}}'
        )
    })

    test("a comment after an alias on its line stays", async () => {
        const name = "review-orchestrator-gemini-4-carbon-low"
        const other = "review-orchestrator-gemini-4-carbon-high"
        writeFileSync(
            settings,
            [
                "{",
                '  "modelConfigs": {',
                '    "customAliases": {',
                `      "${name}": {}, // after a comma`,
                '      "mine": {},',
                `      "${other}": {} // after the last one`,
                "    }",
                "  }",
                "}",
                "",
            ].join("\n")
        )
        await remove()
        expect(text(settings)).toBe(
            [
                "{",
                '  "modelConfigs": {',
                '    "customAliases": {',
                "      // after a comma",
                '      "mine": {}',
                "      // after the last one",
                "    }",
                "  }",
                "}",
                "",
            ].join("\n")
        )
    })
})

describe("removeAllGeminiSettings", () => {
    let dir
    beforeEach(() => {
        dir = mkdtempSync(path.join(tmpdir(), "gemini-remove-all-"))
    })
    afterEach(() => rmSync(dir, { recursive: true, force: true }))

    const homeWith = async (name, original) => {
        const settings = path.join(dir, name, ".gemini", "settings.json")
        mkdirSync(path.dirname(settings), { recursive: true })
        writeFileSync(settings, original)
        await mergeGeminiSettings({ settingsPath: settings })
        return settings
    }
    const ORIG = '{"modelConfigs":{"customAliases":{}}}'

    test("cleans every recorded home and the given one, then drops the record", async () => {
        const a = await homeWith("a", ORIG)
        const b = await homeWith("b", ORIG)
        const record = path.join(dir, "gemini-home")
        writeFileSync(
            record,
            `${path.join(dir, "a")}\n${path.join(dir, "a")}\n`
        )
        const results = await removeAllGeminiSettings({
            settingsPaths: [
                b,
                path.join(dir, "none", ".gemini", "settings.json"),
            ],
            record,
            lockTarget: path.join(dir, "lock"),
        })
        expect(results.map((r) => r.action)).toEqual([
            "removed",
            "absent",
            "removed",
        ])
        expect(text(a)).toBe(ORIG)
        expect(text(b)).toBe(ORIG)
        expect(existsSync(record)).toBe(false)
    })

    test("checks every file before changing any", async () => {
        const good = await homeWith("good", ORIG)
        const bad = path.join(dir, "bad", ".gemini", "settings.json")
        mkdirSync(path.dirname(bad), { recursive: true })
        writeFileSync(bad, "{ broken")
        const before = text(good)
        await expect(
            removeAllGeminiSettings({
                settingsPaths: [good, bad],
                lockTarget: path.join(dir, "lock"),
            })
        ).rejects.toThrow(`failed to parse ${bad}`)
        expect(text(good)).toBe(before)
    })

    test("refuses, changing nothing, when a file can't be written", async () => {
        const good = await homeWith("good", ORIG)
        const ro = await homeWith("ro", ORIG)
        const before = text(good)
        await expect(
            removeAllGeminiSettings({
                settingsPaths: [good, ro],
                lockTarget: path.join(dir, "lock"),
                access: (p) => {
                    if (p.startsWith(path.join(dir, "ro"))) {
                        throw Object.assign(new Error("EACCES"), {
                            code: "EACCES",
                        })
                    }
                },
            })
        ).rejects.toThrow(`can't write ${ro}`)
        expect(text(good)).toBe(before)
    })

    test("an unreadable file is refused", async () => {
        const good = await homeWith("good", ORIG)
        await expect(
            removeAllGeminiSettings({
                settingsPaths: [good],
                lockTarget: path.join(dir, "lock"),
                read: () => {
                    throw Object.assign(new Error("EACCES"), { code: "EACCES" })
                },
            })
        ).rejects.toThrow(`can't read ${good}`)
    })
})
