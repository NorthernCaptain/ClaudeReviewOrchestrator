/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { renderPlist, __test__ } from "./render-plist.mjs"

const { xmlEscape } = __test__

const TEMPLATE = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
  <dict>
    <key>ProgramArguments</key>
    <array>
      <string>__NODE_BIN__</string>
      <string>__REPO_ROOT__/server/src/index.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>__REPO_ROOT__</string>
    <key>StandardOutPath</key>
    <string>__HOME__/.claude/logs/review-server.out.log</string>
  </dict>
</plist>
`

const makeTmp = () => mkdtempSync(path.join(tmpdir(), "render-plist-"))

describe("xmlEscape", () => {
    test("escapes the five XML metachars", () => {
        expect(xmlEscape("a & b")).toBe("a &amp; b")
        expect(xmlEscape("<x>")).toBe("&lt;x&gt;")
        expect(xmlEscape('say "hi"')).toBe("say &quot;hi&quot;")
        expect(xmlEscape("it's")).toBe("it&apos;s")
    })

    test("leaves other bytes alone", () => {
        expect(xmlEscape("/Users/leo/work")).toBe("/Users/leo/work")
        expect(xmlEscape("path|with|pipes")).toBe("path|with|pipes")
    })
})

describe("renderPlist", () => {
    let dir
    let template
    beforeEach(() => {
        dir = makeTmp()
        template = path.join(dir, "tpl.plist")
        writeFileSync(template, TEMPLATE)
    })
    afterEach(() => rmSync(dir, { recursive: true, force: true }))

    test("substitutes the three documented placeholders", () => {
        const dest = path.join(dir, "out.plist")
        const r = renderPlist({
            templatePath: template,
            destPath: dest,
            values: {
                __NODE_BIN__: "/usr/local/bin/node",
                __REPO_ROOT__: "/Users/leo/work/trace/review",
                __HOME__: "/Users/leo",
            },
        })
        expect(r.action).toBe("installed")
        const out = readFileSync(dest, "utf8")
        expect(out).toMatch(/<string>\/usr\/local\/bin\/node<\/string>/)
        expect(out).toMatch(
            /<string>\/Users\/leo\/work\/trace\/review<\/string>/
        )
        expect(out).toMatch(/<string>\/Users\/leo\/\.claude\/logs/)
    })

    test("handles paths with `&` (XML-escapes safely)", () => {
        const dest = path.join(dir, "out.plist")
        renderPlist({
            templatePath: template,
            destPath: dest,
            values: {
                __NODE_BIN__: "/opt/r&d/node",
                __REPO_ROOT__: "/repo",
                __HOME__: "/home",
            },
        })
        const out = readFileSync(dest, "utf8")
        expect(out).toMatch(/<string>\/opt\/r&amp;d\/node<\/string>/)
        // Raw `&` must NOT appear (would be invalid XML).
        expect(out).not.toMatch(/<string>\/opt\/r&d/)
    })

    test("handles paths with `|`, `<`, `>` characters", () => {
        const dest = path.join(dir, "out.plist")
        renderPlist({
            templatePath: template,
            destPath: dest,
            values: {
                __NODE_BIN__: "/node",
                __REPO_ROOT__: "/path|with|pipes",
                __HOME__: "/home<x>",
            },
        })
        const out = readFileSync(dest, "utf8")
        expect(out).toMatch(/<string>\/path\|with\|pipes<\/string>/)
        expect(out).toMatch(/<string>\/home&lt;x&gt;\/\.claude/)
    })

    test("idempotent: identical rerun reports unchanged", () => {
        const dest = path.join(dir, "out.plist")
        const values = {
            __NODE_BIN__: "/n",
            __REPO_ROOT__: "/r",
            __HOME__: "/h",
        }
        const r1 = renderPlist({
            templatePath: template,
            destPath: dest,
            values,
        })
        expect(r1.action).toBe("installed")
        const r2 = renderPlist({
            templatePath: template,
            destPath: dest,
            values,
        })
        expect(r2.action).toBe("unchanged")
    })

    test("reports updated when bytes differ from existing file", () => {
        const dest = path.join(dir, "out.plist")
        renderPlist({
            templatePath: template,
            destPath: dest,
            values: {
                __NODE_BIN__: "/old/node",
                __REPO_ROOT__: "/r",
                __HOME__: "/h",
            },
        })
        const r = renderPlist({
            templatePath: template,
            destPath: dest,
            values: {
                __NODE_BIN__: "/new/node",
                __REPO_ROOT__: "/r",
                __HOME__: "/h",
            },
        })
        expect(r.action).toBe("updated")
    })

    test("throws if a placeholder value is missing", () => {
        const dest = path.join(dir, "out.plist")
        expect(() =>
            renderPlist({
                templatePath: template,
                destPath: dest,
                values: { __NODE_BIN__: "/n", __HOME__: "/h" },
            })
        ).toThrow(/__REPO_ROOT__/)
    })
})
