/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import {
    chmodSync,
    closeSync,
    ftruncateSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    openSync,
    realpathSync,
    symlinkSync,
    writeSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { jest } from "@jest/globals"
import {
    assertGeminiNotRunning,
    OLD_MARK,
    mergeGeminiSettings,
    runningGeminiPids,
} from "./merge-gemini-settings.mjs"
import { parseJsonc } from "./jsonc.mjs"
import { removeGeminiSettings } from "./remove-gemini-settings.mjs"
import { geminiAliasDefinitions } from "../server/src/core/review/gemini.js"

const OURS = geminiAliasDefinitions()
const read = (p) => parseJsonc(readFileSync(p, "utf8")).value

describe("mergeGeminiSettings", () => {
    let dir
    let settings
    beforeEach(() => {
        dir = mkdtempSync(path.join(tmpdir(), "gemini-settings-"))
        settings = path.join(dir, ".gemini", "settings.json")
    })
    afterEach(() => rmSync(dir, { recursive: true, force: true }))

    test("creates the file, owner-only, with every alias", async () => {
        const r = await mergeGeminiSettings({ settingsPath: settings })
        expect(r.action).toBe("installed")
        expect(read(settings)).toEqual({
            modelConfigs: { customAliases: OURS },
        })
        expect(statSync(settings).mode & 0o777).toBe(0o600)
    })

    test("treats a blank file as empty settings", async () => {
        await mergeGeminiSettings({ settingsPath: settings })
        writeFileSync(settings, "  \n")
        expect(
            (await mergeGeminiSettings({ settingsPath: settings })).action
        ).toBe("updated")
        expect(read(settings).modelConfigs.customAliases).toEqual(OURS)
    })

    test("keeps other settings and aliases, its mode, and backs up the old file", async () => {
        await mergeGeminiSettings({ settingsPath: settings })
        const before = {
            security: { auth: { selectedType: "gemini-api-key" } },
            modelConfigs: {
                overrides: [{ match: { model: "x" } }],
                customAliases: { mine: { modelConfig: { model: "m" } } },
            },
        }
        writeFileSync(settings, JSON.stringify(before))
        chmodSync(settings, 0o644)
        const r = await mergeGeminiSettings({
            settingsPath: settings,
            now: () => "TS",
        })
        expect(r).toEqual({
            action: "updated",
            path: settings,
            backup: expect.stringMatching(/\.bak\.TS-[0-9a-f]{8}$/),
        })
        const after = read(settings)
        expect(after.security).toEqual(before.security)
        expect(after.modelConfigs.overrides).toEqual(
            before.modelConfigs.overrides
        )
        expect(after.modelConfigs.customAliases).toEqual({
            mine: { modelConfig: { model: "m" } },
            ...OURS,
        })
        expect(statSync(settings).mode & 0o777).toBe(0o644)
        expect(read(r.backup)).toEqual(before)
        expect(r.backup.startsWith(`${settings}.bak.TS-`)).toBe(true)
    })

    test("drops stale aliases of ours and refreshes changed ones", async () => {
        await mergeGeminiSettings({ settingsPath: settings })
        const stale = read(settings)
        stale.modelConfigs.customAliases[
            "review-orchestrator-gemini-2-old-high"
        ] = {}
        stale.modelConfigs.customAliases[
            "review-orchestrator-gemini-4-carbon-low"
        ] = { stale: true }
        writeFileSync(settings, JSON.stringify(stale))
        expect(
            (await mergeGeminiSettings({ settingsPath: settings })).action
        ).toBe("updated")
        expect(read(settings).modelConfigs.customAliases).toEqual(OURS)
    })

    test("a second run changes nothing and writes no backup", async () => {
        await mergeGeminiSettings({ settingsPath: settings })
        expect(
            (await mergeGeminiSettings({ settingsPath: settings })).action
        ).toBe("unchanged")
        expect(
            readdirSync(path.dirname(settings)).filter((f) =>
                f.includes(".bak.")
            )
        ).toEqual([])
    })

    test("refuses a file that isn't a JSON object", async () => {
        await mergeGeminiSettings({ settingsPath: settings })
        writeFileSync(settings, "{ nope")
        await expect(
            mergeGeminiSettings({ settingsPath: settings })
        ).rejects.toThrow(`failed to parse ${settings}`)
        writeFileSync(settings, "[1]")
        await expect(
            mergeGeminiSettings({ settingsPath: settings })
        ).rejects.toThrow("is valid JSON but not an object")
    })
})

describe("updateSettingsFile", () => {
    let dir
    let settings
    beforeEach(() => {
        dir = mkdtempSync(path.join(tmpdir(), "gemini-update-"))
        settings = path.join(dir, "settings.json")
    })
    afterEach(() => rmSync(dir, { recursive: true, force: true }))

    test("the installer writes plain JSON, which gemini's launcher can read", async () => {
        await mergeGeminiSettings({ settingsPath: settings })
        expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({
            modelConfigs: { customAliases: OURS },
        })
    })

    test("markers from 1.12.0 pre-releases are taken out", async () => {
        writeFileSync(
            settings,
            `{\n  "modelConfigs": {\n    ${OLD_MARK}\n    "customAliases": {\n      ${OLD_MARK}\n    }\n  }\n}\n`
        )
        await mergeGeminiSettings({ settingsPath: settings })
        expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({
            modelConfigs: { customAliases: OURS },
        })
    })

    // Writes into the existing file, the way the gemini CLI saves.
    const saveInPlace = (p, text) => {
        const fd = openSync(p, "r+")
        ftruncateSync(fd, 0)
        writeSync(fd, text, 0)
        closeSync(fd)
    }

    test("a save landing before the rename is redone on top", async () => {
        writeFileSync(settings, '{"a": 1}')
        let saves = 0
        const beforeReplace = () => {
            if (saves++ === 0) saveInPlace(settings, '{"a": 2}')
        }
        const r = await mergeGeminiSettings({
            settingsPath: settings,
            hooks: { beforeReplace },
        })
        expect(r.action).toBe("updated")
        const value = read(settings)
        expect(value.a).toBe(2)
        expect(value.modelConfigs.customAliases).toEqual(OURS)
        expect(readFileSync(r.backup, "utf8")).toBe('{"a": 2}')
        expect(
            readdirSync(dir).filter((f) => /\.tmp-|\.bak\./.test(f))
        ).toEqual([path.basename(r.backup)])
    })

    test("a file replaced before the rename is redone on top", async () => {
        writeFileSync(settings, '{"a": 1}')
        let saves = 0
        const beforeReplace = () => {
            if (saves++ === 0) {
                rmSync(settings)
                writeFileSync(settings, '{"a": 3}')
            }
        }
        await mergeGeminiSettings({
            settingsPath: settings,
            hooks: { beforeReplace },
        })
        expect(read(settings).a).toBe(3)
    })

    test("a save that hits the replaced file is put back and redone on top", async () => {
        writeFileSync(settings, '{"a": 1}')
        let late = null
        let saves = 0
        const r = await mergeGeminiSettings({
            settingsPath: settings,
            hooks: {
                // gemini opened the file before the rename ...
                beforeReplace: () => {
                    if (saves === 0) late = openSync(settings, "r+")
                },
                // ... and writes after it.
                afterReplace: () => {
                    if (saves++ === 0) {
                        ftruncateSync(late, 0)
                        writeSync(late, '{"a": 4}', 0)
                        closeSync(late)
                    }
                },
            },
        })
        expect(r.action).toBe("updated")
        const value = read(settings)
        expect(value.a).toBe(4)
        expect(value.modelConfigs.customAliases).toEqual(OURS)
    })

    test("gives up, writing nothing, when the file keeps changing", async () => {
        writeFileSync(settings, '{"n": 0}')
        let n = 0
        await expect(
            mergeGeminiSettings({
                settingsPath: settings,
                hooks: {
                    beforeReplace: () => saveInPlace(settings, `{"n": ${++n}}`),
                },
            })
        ).rejects.toThrow("kept changing while saving")
        expect(readdirSync(dir).sort()).toEqual([
            "settings.json",
            "settings.json.lock",
        ])
        expect(readFileSync(settings, "utf8")).toBe('{"n": 3}')
    })

    test("a file that appears before the rename isn't overwritten", async () => {
        let made = false
        await mergeGeminiSettings({
            settingsPath: settings,
            hooks: {
                beforeReplace: () => {
                    if (!made) writeFileSync(settings, '{"b": 1}')
                    made = true
                },
            },
        })
        expect(read(settings).b).toBe(1)
        expect(read(settings).modelConfigs.customAliases).toEqual(OURS)
    })

    test("a symlinked settings file is edited where it points", async () => {
        const real = path.join(dir, "shared", "gemini.json")
        mkdirSync(path.dirname(real))
        writeFileSync(real, '{"a": 1}')
        symlinkSync(real, settings)
        const r = await mergeGeminiSettings({ settingsPath: settings })
        expect(lstatSync(settings).isSymbolicLink()).toBe(true)
        expect(read(real).modelConfigs.customAliases).toEqual(OURS)
        expect(path.dirname(r.backup)).toBe(path.dirname(realpathSync(real)))
        await removeGeminiSettings({ settingsPath: settings })
        expect(lstatSync(settings).isSymbolicLink()).toBe(true)
        expect(read(real)).toEqual({
            a: 1,
            modelConfigs: { customAliases: {} },
        })
    })

    test("a link to a missing file is refused", async () => {
        symlinkSync(path.join(dir, "gone.json"), settings)
        await expect(
            mergeGeminiSettings({ settingsPath: settings })
        ).rejects.toThrow(`${settings} links to a missing file`)
    })

    test("CRLF files keep their line endings through install + uninstall", async () => {
        for (const original of [
            '{\r\n  "security": {},\r\n  "modelConfigs": {\r\n    "customAliases": {}\r\n  }\r\n}\r\n',
            '{\r\n  "modelConfigs": {\r\n    "customAliases": {\r\n      "mine": {}\r\n    }\r\n  }\r\n}\r\n',
        ]) {
            writeFileSync(settings, original)
            await mergeGeminiSettings({ settingsPath: settings })
            const installed = readFileSync(settings, "utf8")
            expect(installed.replace(/\r\n/g, "")).not.toContain("\n")
            expect(read(settings).modelConfigs.customAliases).toMatchObject(
                OURS
            )
            await removeGeminiSettings({ settingsPath: settings })
            expect(readFileSync(settings, "utf8")).toBe(original)
        }
    })

    test("one-line objects keep their spacing through install + uninstall", async () => {
        for (const original of [
            '{"security": {}, "modelConfigs": {"customAliases": {} } }',
            '{ "modelConfigs": { "customAliases": { } } }',
            '{ "modelConfigs": { "customAliases": { "mine": {} } } }',
            '{"modelConfigs":{"customAliases":{}}}',
        ]) {
            writeFileSync(settings, original)
            await mergeGeminiSettings({ settingsPath: settings })
            expect(read(settings).modelConfigs.customAliases).toMatchObject(
                OURS
            )
            await removeGeminiSettings({ settingsPath: settings })
            expect(readFileSync(settings, "utf8")).toBe(original)
        }
    })

    test("a trailing comma is refused, as gemini refuses it", async () => {
        const original = '{"modelConfigs":{"customAliases":{"mine":{},}}}'
        writeFileSync(settings, original)
        await expect(
            mergeGeminiSettings({ settingsPath: settings })
        ).rejects.toThrow(`failed to parse ${settings}`)
        expect(readFileSync(settings, "utf8")).toBe(original)
    })

    test("two edits in the same millisecond keep both backups", async () => {
        writeFileSync(settings, '{"a": 1}')
        const first = await mergeGeminiSettings({
            settingsPath: settings,
            now: () => "SAME",
        })
        writeFileSync(settings, '{"a": 2}')
        const second = await mergeGeminiSettings({
            settingsPath: settings,
            now: () => "SAME",
        })
        expect(second.backup).not.toBe(first.backup)
        expect(readFileSync(first.backup, "utf8")).toBe('{"a": 1}')
        expect(readFileSync(second.backup, "utf8")).toBe('{"a": 2}')
    })

    test("a backup name that is taken is retried, the old backup kept", async () => {
        writeFileSync(settings, '{"a": 1}')
        const taken = `${settings}.bak.T-aaaaaaaa`
        writeFileSync(taken, "older backup")
        const names = ["aaaaaaaa", "bbbbbbbb"]
        const r = await mergeGeminiSettings({
            settingsPath: settings,
            now: () => "T",
            suffix: () => names.shift(),
        })
        expect(r.backup).toBe(`${settings}.bak.T-bbbbbbbb`)
        expect(readFileSync(taken, "utf8")).toBe("older backup")
        expect(readFileSync(r.backup, "utf8")).toBe('{"a": 1}')
    })

    test("records the home first: a record it can't write leaves the settings alone", async () => {
        writeFileSync(settings, '{"a": 1}')
        const record = path.join(dir, "record-is-a-folder")
        mkdirSync(record)
        await expect(
            mergeGeminiSettings({ settingsPath: settings, record })
        ).rejects.toThrow()
        expect(readFileSync(settings, "utf8")).toBe('{"a": 1}')
        const ok = path.join(dir, "gemini-home")
        await mergeGeminiSettings({ settingsPath: settings, record: ok })
        await mergeGeminiSettings({ settingsPath: settings, record: ok })
        expect(readFileSync(ok, "utf8")).toBe(`${path.dirname(dir)}\n`)
    })

    test("a failed edit takes the home it just recorded back out", async () => {
        const record = path.join(dir, "gemini-home")
        writeFileSync(record, "/other/home\n")
        writeFileSync(settings, "{ broken")
        await expect(
            mergeGeminiSettings({ settingsPath: settings, record })
        ).rejects.toThrow(`failed to parse ${settings}`)
        expect(readFileSync(record, "utf8")).toBe("/other/home\n")
        // A home listed before the failed run stays listed.
        writeFileSync(record, `${path.dirname(dir)}\n`)
        await expect(
            mergeGeminiSettings({ settingsPath: settings, record })
        ).rejects.toThrow()
        expect(readFileSync(record, "utf8")).toBe(`${path.dirname(dir)}\n`)
    })

    test("runs under the lock for its lock target", async () => {
        const lock = jest.fn((target, fn) => fn())
        await mergeGeminiSettings({
            settingsPath: settings,
            lockTarget: path.join(dir, "gemini-settings"),
            lock,
        })
        expect(lock).toHaveBeenCalledWith(
            path.join(dir, "gemini-settings"),
            expect.any(Function)
        )
    })

    test("a failed write leaves no temp file behind", async () => {
        writeFileSync(settings, "{}")
        await expect(
            mergeGeminiSettings({
                settingsPath: settings,
                now: () => {
                    throw new Error("clock broke")
                },
            })
        ).rejects.toThrow("clock broke")
        expect(readdirSync(dir).filter((f) => f.includes(".tmp-"))).toEqual([])
        expect(readFileSync(settings, "utf8")).toBe("{}")
    })
})

describe("settings with comments (JSONC)", () => {
    let dir
    let settings
    beforeEach(() => {
        dir = mkdtempSync(path.join(tmpdir(), "gemini-jsonc-"))
        settings = path.join(dir, "settings.json")
    })
    afterEach(() => rmSync(dir, { recursive: true, force: true }))

    const commented = [
        "{",
        "  // auth for the CLI",
        '  "security": {',
        '    "auth": { "selectedType": "gemini-api-key" } // inline note',
        "  },",
        "  /* model tweaks */",
        '  "modelConfigs": {',
        '    "customAliases": {',
        "      // my own alias",
        '      "mine": { "modelConfig": { "model": "m" } }',
        "    }",
        "  }",
        "}",
        "",
    ].join("\n")

    test("install keeps every comment and the layout around our aliases", async () => {
        writeFileSync(settings, commented)
        expect(
            (await mergeGeminiSettings({ settingsPath: settings })).action
        ).toBe("updated")
        const text = readFileSync(settings, "utf8")
        for (const line of commented.split("\n").slice(0, 9)) {
            expect(text).toContain(line)
        }
        expect(text).toContain(
            '      "mine": { "modelConfig": { "model": "m" } },\n' +
                '      "review-orchestrator-gemini-4-hydrogen-xhigh": {\n' +
                '        "extends": "chat-base",'
        )
        expect(parseJsonc(text).value.modelConfigs.customAliases).toEqual({
            mine: { modelConfig: { model: "m" } },
            ...OURS,
        })
        expect(
            (await mergeGeminiSettings({ settingsPath: settings })).action
        ).toBe("unchanged")
    })

    test("install then uninstall gives back the original text", async () => {
        writeFileSync(settings, commented)
        await mergeGeminiSettings({ settingsPath: settings })
        await removeGeminiSettings({ settingsPath: settings })
        expect(readFileSync(settings, "utf8")).toBe(commented)
    })

    test("a file without modelConfigs keeps comments and empty containers after uninstall", async () => {
        const plain = [
            "{",
            "  // only auth here",
            '  "security": { "auth": {} } // note',
            "}",
            "",
        ].join("\n")
        writeFileSync(settings, plain)
        await mergeGeminiSettings({ settingsPath: settings })
        const text = readFileSync(settings, "utf8")
        expect(text).toContain('  "security": { "auth": {} }, // note\n')
        expect(text).toContain('  "modelConfigs": {\n    "customAliases": {\n')
        await removeGeminiSettings({ settingsPath: settings })
        const after = readFileSync(settings, "utf8")
        expect(after).toContain("  // only auth here\n")
        expect(after).toContain("// note")
        expect(parseJsonc(after).value).toEqual({
            security: { auth: {} },
            modelConfigs: { customAliases: {} },
        })
    })

    test("one-line objects are read and edited", async () => {
        writeFileSync(settings, '{"a": 1, "modelConfigs": {}}')
        await mergeGeminiSettings({ settingsPath: settings })
        const value = parseJsonc(readFileSync(settings, "utf8")).value
        expect(value.a).toBe(1)
        expect(value.modelConfigs.customAliases).toEqual(OURS)
        writeFileSync(settings, "{}")
        await mergeGeminiSettings({ settingsPath: settings })
        expect(
            parseJsonc(readFileSync(settings, "utf8")).value.modelConfigs
        ).toEqual({ customAliases: OURS })
    })

    test("a non-object modelConfigs or customAliases is refused, file untouched", async () => {
        for (const [original, what] of [
            ['{\n  "modelConfigs": [1]\n}\n', "modelConfigs"],
            [
                '{\n  "modelConfigs": {\n    "customAliases": "x"\n  }\n}\n',
                "modelConfigs.customAliases",
            ],
        ]) {
            writeFileSync(settings, original)
            await expect(
                mergeGeminiSettings({ settingsPath: settings })
            ).rejects.toThrow(
                `${settings}: ${what} is not an object; fix it and run this again`
            )
            expect(readFileSync(settings, "utf8")).toBe(original)
        }
    })

    test("a duplicated alias of ours collapses to one", async () => {
        const name = "review-orchestrator-gemini-4-carbon-low"
        const aliases = JSON.stringify(OURS).slice(1, -1)
        writeFileSync(
            settings,
            `{"modelConfigs": {"customAliases": {"${name}": {}, ${aliases}}}}`
        )
        await mergeGeminiSettings({ settingsPath: settings })
        const custom = parseJsonc(readFileSync(settings, "utf8")).value
            .modelConfigs.customAliases
        expect(custom).toEqual(OURS)
    })
})

describe("running gemini processes", () => {
    const ps = () =>
        [
            "  101 /bin/zsh -l",
            "  202 node /Users/u/.local/bin/gemini --skip-trust -p hi",
            "  303 /usr/local/bin/node --max-old-space-size=8192 /Users/u/.local/lib/node_modules/@google/gemini-cli/bundle/gemini.js",
            "  404 node install/merge-gemini-settings.mjs /Users/u/.gemini/settings.json",
            "  505 vim notes-about-gemini.md",
            "  707 vim gemini",
            "  708 grep -r gemini /src",
            "  709 node script.js gemini",
            "  710 /opt/homebrew/bin/gemini",
            "  606 node /Users/u/.local/bin/gemini",
            "",
        ].join("\n")

    test("finds the gemini CLI and its relaunched child, not lookalikes or itself", () => {
        expect(runningGeminiPids({ ps, self: 606 })).toEqual([202, 303, 710])
    })

    test("refuses with the pids while gemini runs", () => {
        expect(() => assertGeminiNotRunning({ ps, self: 1 })).toThrow(
            "gemini is running (pid 202, 303, 710, 606); it saves settings.json without a lock, so close it and run this again"
        )
        expect(() =>
            assertGeminiNotRunning({ ps: () => "  1 /bin/zsh\n" })
        ).not.toThrow()
    })

    test("reads the real process list by default", () => {
        expect(Array.isArray(runningGeminiPids())).toBe(true)
    })
})
