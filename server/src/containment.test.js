/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import {
    checkContainment,
    checkFile,
    ContainmentError,
    importClosure,
} from "./containment.js"
import { readCoreFiles } from "./core-loader.js"

const files = (map) =>
    Object.fromEntries(Object.entries(map).map(([k, v]) => [k, Buffer.from(v)]))

const violationsOf = (map, opts) => {
    try {
        checkContainment(files(map), opts)
        return []
    } catch (err) {
        expect(err).toBeInstanceOf(ContainmentError)
        expect(err.code).toBe("CORE_CONTAINMENT")
        return err.violations.map((v) => `${v.file}: ${v.what}`)
    }
}

describe("checkContainment — imports", () => {
    test("bare packages, builtins and relative files inside the snapshot are fine", () => {
        expect(
            violationsOf({
                "index.js": `import { z } from "zod"\nimport fs from "node:fs"\nimport { a } from "./review/a.js"\nexport * from "./b.js"`,
                "review/a.js": `import { b } from "../b.js"\nexport const a = b`,
                "b.js": `export const b = 1`,
            })
        ).toEqual([])
    })

    test.each([
        ["../../src/state.js", "outside the snapshot"],
        ["./missing.js", "outside the snapshot"],
        ["/abs/x.js", "/abs/x.js"],
        ["file:///x.js", "file:///x.js"],
        ["#internal", "#internal"],
        ["review-orchestrator", "the package's own name"],
        ["review-orchestrator/server/src/state.js", "the package's own name"],
        ["node:child_process", "child_process"],
        ["child_process", "child_process"],
        ["node:module", "module"],
        ["vm", "vm"],
        ["node:worker_threads", "worker_threads"],
    ])("refuses import %s", (spec, mentions) => {
        const out = violationsOf(
            { "index.js": `import x from "${spec}"\nexport default x` },
            { ownName: "review-orchestrator" }
        )
        expect(out).toHaveLength(1)
        expect(out[0]).toContain("index.js")
        expect(out[0]).toContain(mentions)
    })

    test.each(["helper.mjs", "helper.cjs", "data.json"])(
        "refuses a relative import of %s: only .js modules are checked",
        (name) => {
            const out = violationsOf({
                "index.js": `import x from "./${name}"\nexport default x`,
                [name]: "require('../shell.js')",
            })
            expect(out).toEqual([
                `index.js: import "./${name}" (not a .js module)`,
            ])
        }
    )

    test("re-exports are checked like imports", () => {
        expect(
            violationsOf({
                "index.js": `export { s } from "../state.js"\nexport * from "/x.js"`,
            })
        ).toHaveLength(2)
    })

    test("a transitive escape is caught in the file that makes it", () => {
        const out = violationsOf({
            "index.js": `import { b } from "./b.js"\nexport const a = b`,
            "b.js": `export { s as b } from "../shell.js"`,
        })
        expect(out).toEqual([
            expect.stringMatching(/^b\.js: .*outside the snapshot/),
        ])
    })
})

describe("checkContainment — other ways to load or run code", () => {
    test.each([
        ["await import('./x.js')", "dynamic import()"],
        ["require('x')", "require"],
        ["[require]", "require"],
        ["eval('1')", "eval"],
        ["new Function('a', 'return a')", "Function"],
        ["Function('return 1')()", "Function"],
        ["import.meta.resolve('x')", "import.meta.resolve"],
        ["import.meta['resolve']('x')", "import.meta.resolve"],
        ["process.execPath", "process.execPath"],
        ["process['execPath']", "process.execPath"],
    ])("refuses %s", (code, what) => {
        expect(
            violationsOf({ "index.js": `export const x = ${code}` })
        ).toEqual([`index.js: ${what}`])
    })

    test("property names that merely spell a banned word are fine", () => {
        expect(
            violationsOf({
                "index.js": [
                    "const o = { require: 1, eval: 2, Function: 3 }",
                    "class C { require() {} }",
                    "export const x = [o.require, o.eval, o.Function, C, import.meta.url]",
                ].join("\n"),
            })
        ).toEqual([])
    })

    test("a file that doesn't parse is a violation, and non-JS files are skipped", () => {
        expect(
            violationsOf({
                "index.js": "export const = ",
                "review/schema.json": "{ not js",
            })
        ).toEqual([expect.stringMatching(/^index\.js: does not parse/)])
    })

    test("checkFile reports every construct in one file", () => {
        const found = checkFile(
            "a.js",
            "import x from '/x.js'\nexport const y = [x, eval('1'), process.execPath]",
            files({ "a.js": "" })
        )
        expect(found.map((f) => f.what)).toEqual([
            'import "/x.js"',
            "eval",
            "process.execPath",
        ])
    })
})

describe("importClosure", () => {
    test("follows relative static imports and re-exports from the entry", () => {
        const map = files({
            "index.js": `import "./review/index.js"\nimport "./ui.js"`,
            "review/index.js": `import { a } from "./a.js"\nexport * from "./b.js"\nimport { z } from "zod"`,
            "review/a.js": `import { c } from "../c.js"\nexport const a = c`,
            "review/b.js": `export const b = 1`,
            "c.js": `export const c = 1`,
            "ui.js": `import "./review/index.js"`,
        })
        expect(importClosure("review/index.js", map)).toEqual([
            "c.js",
            "review/a.js",
            "review/b.js",
            "review/index.js",
        ])
    })

    test("the real review entry never reaches the UI modules", () => {
        const map = readCoreFiles(new URL("./core", import.meta.url).pathname)
        const closure = importClosure("review/index.js", map)
        expect(closure).toContain("review/review.js")
        expect(closure.filter((p) => !p.startsWith("review/"))).toEqual([])
    })

    test("the real core passes the containment check", () => {
        const map = readCoreFiles(new URL("./core", import.meta.url).pathname)
        expect(() =>
            checkContainment(map, { ownName: "review-orchestrator" })
        ).not.toThrow()
    })
})
