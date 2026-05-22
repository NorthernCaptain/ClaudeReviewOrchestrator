/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { mergeClaudeMd } from "./merge-claude-md.mjs"

const makeTmp = () => mkdtempSync(path.join(tmpdir(), "merge-claude-md-"))

const SNIPPET = `<!-- review-orchestrator:begin -->
## Review loop

Call request_review before finishing.
<!-- review-orchestrator:end -->`

describe("mergeClaudeMd", () => {
    let dir
    let snippetPath
    beforeEach(() => {
        dir = makeTmp()
        snippetPath = path.join(dir, "snippet.md")
        writeFileSync(snippetPath, SNIPPET + "\n")
    })
    afterEach(() => rmSync(dir, { recursive: true, force: true }))

    test("creates ~/.claude/CLAUDE.md with the snippet when missing", () => {
        const p = path.join(dir, "CLAUDE.md")
        const r = mergeClaudeMd({ claudeMdPath: p, snippetPath })
        expect(r.action).toBe("installed")
        const c = readFileSync(p, "utf8")
        expect(c).toMatch(/<!-- review-orchestrator:begin -->/)
        expect(c).toMatch(/Call request_review/)
        expect(c).toMatch(/<!-- review-orchestrator:end -->/)
    })

    test("appends the block when markers are absent in an existing file", () => {
        const p = path.join(dir, "CLAUDE.md")
        writeFileSync(p, "# My CLAUDE.md\n\nExisting content.\n")
        const r = mergeClaudeMd({ claudeMdPath: p, snippetPath })
        expect(r.action).toBe("updated")
        const c = readFileSync(p, "utf8")
        // Original content preserved at the top, marker block at the end.
        expect(c.indexOf("Existing content.")).toBeLessThan(
            c.indexOf("<!-- review-orchestrator:begin -->")
        )
    })

    test("replaces the block in place when markers exist", () => {
        const p = path.join(dir, "CLAUDE.md")
        writeFileSync(
            p,
            [
                "# My notes",
                "",
                "<!-- review-orchestrator:begin -->",
                "OLD CONTENT",
                "<!-- review-orchestrator:end -->",
                "",
                "## My other section",
                "still here",
                "",
            ].join("\n")
        )
        const r = mergeClaudeMd({ claudeMdPath: p, snippetPath })
        expect(r.action).toBe("updated")
        const c = readFileSync(p, "utf8")
        expect(c).not.toMatch(/OLD CONTENT/)
        expect(c).toMatch(/Call request_review/)
        // Surrounding hand-written content survives.
        expect(c).toMatch(/# My notes/)
        expect(c).toMatch(/My other section/)
        expect(c).toMatch(/still here/)
    })

    test("idempotent: re-running with the same snippet returns unchanged", () => {
        const p = path.join(dir, "CLAUDE.md")
        mergeClaudeMd({ claudeMdPath: p, snippetPath })
        const r2 = mergeClaudeMd({ claudeMdPath: p, snippetPath })
        expect(r2.action).toBe("unchanged")
    })

    test("rejects a snippet that is missing the markers", () => {
        const bad = path.join(dir, "bad-snippet.md")
        writeFileSync(bad, "## just a heading\n")
        const p = path.join(dir, "CLAUDE.md")
        expect(() =>
            mergeClaudeMd({ claudeMdPath: p, snippetPath: bad })
        ).toThrow(/missing the begin\/end markers/)
    })

    test("writes a .bak.<ts> when bytes change, and no backup on a no-op rerun", () => {
        const p = path.join(dir, "CLAUDE.md")
        writeFileSync(p, "# Pre-existing\n")
        const r1 = mergeClaudeMd({
            claudeMdPath: p,
            snippetPath,
            now: () => "ts1",
        })
        expect(r1.backup).toMatch(/\.bak\.ts1$/)
        const r2 = mergeClaudeMd({
            claudeMdPath: p,
            snippetPath,
            now: () => "ts2",
        })
        expect(r2.action).toBe("unchanged")
        expect(() => readFileSync(`${p}.bak.ts2`)).toThrow()
    })
})
