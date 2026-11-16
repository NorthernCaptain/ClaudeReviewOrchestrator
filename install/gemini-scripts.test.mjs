/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

// install.sh / uninstall.sh routing for the gemini reviewer's aliases:
// which gemini home they edit, the recorded home uninstall reads back,
// and the refusal while gemini runs (before anything else changes).
// Each run gets a throwaway HOME, and a fake `ps` first on PATH decides
// whether gemini "runs".

import { spawnSync } from "node:child_process"
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const ALIAS = "review-orchestrator-gemini-4-hydrogen-high"
// Uninstall leaves the containers, so the round trip starts with them.
const ORIGINAL =
    '{\n  // mine\n  "security": {},\n  "modelConfigs": {\n    "customAliases": {}\n  }\n}\n'

let root
let fakeBin
beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "gemini-scripts-"))
    fakeBin = path.join(root, "bin")
    mkdirSync(fakeBin)
    fakePs("")
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const fakePs = (lines) => {
    const ps = path.join(fakeBin, "ps")
    writeFileSync(ps, `#!/bin/sh\ncat <<'EOF'\n${lines}\nEOF\n`)
    chmodSync(ps, 0o755)
}

const dir = (name) => {
    const d = path.join(root, name)
    mkdirSync(d, { recursive: true })
    return d
}

const settingsIn = (home) => path.join(home, ".gemini", "settings.json")

const seed = (home) => {
    mkdirSync(path.join(home, ".gemini"), { recursive: true })
    writeFileSync(settingsIn(home), ORIGINAL)
}

const run = (script, { home, args = [], env = {}, cwd = REPO }) => {
    const base = { ...process.env }
    delete base.GEMINI_CLI_HOME
    const r = spawnSync("bash", [path.join(REPO, script), ...args], {
        env: {
            ...base,
            HOME: home,
            PATH: `${fakeBin}:${process.env.PATH}`,
            ...env,
        },
        encoding: "utf8",
        cwd,
    })
    return { status: r.status, out: r.stdout + r.stderr }
}

const hasAlias = (home) =>
    existsSync(settingsIn(home)) &&
    readFileSync(settingsIn(home), "utf8").includes(ALIAS)

const record = (home) =>
    readFileSync(
        path.join(home, ".config", "review-orchestrator", "gemini-home"),
        "utf8"
    ).trim()

describe("install.sh / uninstall.sh gemini routing", () => {
    test("--home wins over GEMINI_CLI_HOME", () => {
        const home = dir("home")
        const other = dir("other")
        seed(home)
        seed(other)
        const r = run("install.sh", {
            home: dir("unused"),
            args: ["--home", home],
            env: { GEMINI_CLI_HOME: other },
        })
        expect(r.status).toBe(0)
        expect(hasAlias(home)).toBe(true)
        expect(readFileSync(settingsIn(other), "utf8")).toBe(ORIGINAL)
        // install.sh resolves --home (pwd -P).
        expect(record(home)).toBe(realpathSync(home))
    }, 60000)

    test("GEMINI_CLI_HOME is used and recorded; uninstall reads the record back", () => {
        const home = dir("home")
        const gemini = dir("gemini")
        seed(gemini)
        expect(
            run("install.sh", { home, env: { GEMINI_CLI_HOME: gemini } }).status
        ).toBe(0)
        expect(hasAlias(gemini)).toBe(true)
        expect(existsSync(settingsIn(home))).toBe(false)
        expect(record(home)).toBe(realpathSync(gemini))

        // No GEMINI_CLI_HOME now: the record points uninstall at it.
        const r = run("uninstall.sh", { home })
        expect(r.status).toBe(0)
        expect(readFileSync(settingsIn(gemini), "utf8")).toBe(ORIGINAL)
    }, 60000)

    test("uninstall cleans GEMINI_CLI_HOME and every recorded home", () => {
        const home = dir("home")
        const gemini = dir("gemini")
        const elsewhere = dir("elsewhere")
        seed(gemini)
        seed(elsewhere)
        run("install.sh", { home, env: { GEMINI_CLI_HOME: gemini } })
        run("install.sh", { home, env: { GEMINI_CLI_HOME: elsewhere } })
        const r = run("uninstall.sh", {
            home,
            env: { GEMINI_CLI_HOME: dir("third") },
        })
        expect(r.status).toBe(0)
        expect(readFileSync(settingsIn(gemini), "utf8")).toBe(ORIGINAL)
        expect(readFileSync(settingsIn(elsewhere), "utf8")).toBe(ORIGINAL)
    }, 60000)

    test("install refuses while gemini runs, before changing anything", () => {
        const home = dir("home")
        seed(home)
        fakePs("  4242 node /usr/local/bin/gemini -p hi")
        const r = run("install.sh", { args: ["--home", home], home })
        expect(r.status).not.toBe(0)
        expect(r.out).toContain("gemini is running (pid 4242)")
        expect(readFileSync(settingsIn(home), "utf8")).toBe(ORIGINAL)
        expect(existsSync(path.join(home, ".claude"))).toBe(false)
        expect(
            existsSync(
                path.join(home, ".config", "review-orchestrator", "config.json")
            )
        ).toBe(false)
    }, 60000)

    test("uninstall refuses while gemini runs, before removing anything", () => {
        const home = dir("home")
        seed(home)
        expect(run("install.sh", { args: ["--home", home], home }).status).toBe(
            0
        )
        const hook = path.join(home, ".claude", "hooks", "stop-review.mjs")
        expect(existsSync(hook)).toBe(true)
        fakePs("  4242 node /usr/local/bin/gemini")
        const r = run("uninstall.sh", { args: ["--home", home], home })
        expect(r.status).not.toBe(0)
        expect(r.out).toContain("gemini is running (pid 4242)")
        expect(existsSync(hook)).toBe(true)
        expect(hasAlias(home)).toBe(true)
    }, 60000)

    test("a relative GEMINI_CLI_HOME is resolved and recorded absolute", () => {
        const home = dir("home")
        const gemini = dir("gemini")
        seed(gemini)
        const r = run("install.sh", {
            home,
            env: { GEMINI_CLI_HOME: "gemini" },
            cwd: root,
        })
        expect(r.status).toBe(0)
        expect(hasAlias(gemini)).toBe(true)
        expect(record(home)).toBe(realpathSync(gemini))
        // Uninstall from elsewhere, relying on the record.
        expect(run("uninstall.sh", { home, cwd: home }).status).toBe(0)
        expect(readFileSync(settingsIn(gemini), "utf8")).toBe(ORIGINAL)
    }, 60000)

    test("reinstalling into another gemini home records both and keeps both", () => {
        const home = dir("home")
        const first = dir("first")
        const second = dir("second")
        seed(first)
        seed(second)
        run("install.sh", { home, env: { GEMINI_CLI_HOME: first } })
        expect(
            run("install.sh", { home, env: { GEMINI_CLI_HOME: second } }).status
        ).toBe(0)
        // A server still pinned to the first home keeps its aliases.
        expect(hasAlias(first)).toBe(true)
        expect(hasAlias(second)).toBe(true)
        run("install.sh", { home, env: { GEMINI_CLI_HOME: second } })
        expect(record(home).split("\n")).toEqual([
            realpathSync(first),
            realpathSync(second),
        ])
        expect(run("uninstall.sh", { home }).status).toBe(0)
        expect(readFileSync(settingsIn(first), "utf8")).toBe(ORIGINAL)
        expect(readFileSync(settingsIn(second), "utf8")).toBe(ORIGINAL)
    }, 60000)
})
