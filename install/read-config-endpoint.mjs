#!/usr/bin/env node
/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

// Read the daemon-side config.json and print
//   <port>\t<bind>\t<clientHost>
// to stdout so install.sh can wire merge-mcp / --launch verification at
// the actual port/bind the daemon will use. clientHost is the form to
// use in URLs (wildcard binds normalized to loopback; bare IPv6 wrapped
// in brackets).

import { readFileSync } from "node:fs"
import path from "node:path"

const DEFAULT_PORT = 7777
const DEFAULT_BIND = "127.0.0.1"

export const clientHostFromBind = (bind) => {
    if (!bind || bind === "0.0.0.0") return "127.0.0.1"
    if (bind === "::" || bind === "::1") return "[::1]"
    if (bind.startsWith("[")) return bind
    const colonCount = (bind.match(/:/g) ?? []).length
    if (colonCount >= 2) return `[${bind}]`
    return bind
}

export const readConfigEndpoint = ({ configPath, read = readFileSync }) => {
    let cfg
    try {
        cfg = JSON.parse(read(configPath, "utf8"))
    } catch (err) {
        throw new Error(`failed to parse ${configPath}: ${err.message}`)
    }
    const port = Number.isInteger(cfg?.port) ? cfg.port : DEFAULT_PORT
    const bind =
        typeof cfg?.bind === "string" && cfg.bind.length > 0
            ? cfg.bind
            : DEFAULT_BIND
    const clientHost = clientHostFromBind(bind)
    return { port, bind, clientHost }
}

/* istanbul ignore next */
const isDirectInvocation = () => {
    if (!process.argv[1]) return false
    if (!import.meta.url.startsWith("file:")) return false
    return import.meta.url.endsWith(path.basename(process.argv[1]))
}

/* istanbul ignore next */
if (isDirectInvocation()) {
    try {
        const configPath = process.argv[2]
        if (!configPath) {
            process.stderr.write(
                "usage: read-config-endpoint.mjs <configPath>\n"
            )
            process.exit(1)
        }
        const { port, bind, clientHost } = readConfigEndpoint({
            configPath,
        })
        process.stdout.write(`${port}\t${bind}\t${clientHost}\n`)
    } catch (err) {
        process.stderr.write(`error:${err.message}\n`)
        process.exit(1)
    }
}
