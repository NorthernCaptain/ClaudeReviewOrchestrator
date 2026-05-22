/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

// Single source of truth for the orchestrator's version. Read once at
// module load from package.json so a manual edit / `npm version` bump
// reflects on the next server restart. Both the HTTP server (index.js)
// and the MCP server (mcp.js) import this — keeping them in sync.

import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const pkgPath = path.join(here, "..", "..", "package.json")

export const VERSION = (() => {
    try {
        return JSON.parse(readFileSync(pkgPath, "utf8")).version ?? "unknown"
    } catch {
        return "unknown"
    }
})()
