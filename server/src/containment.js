/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

// Code containment for core snapshots (hot-reload plan §5.3 step 3a).
// Every JS file is parsed (acorn, not a regex) and checked so the core
// can only reach code that is part of its own snapshot:
//   * static imports / re-exports: bare packages are fine (shared
//     dependencies); relative ones must resolve to a file in the
//     snapshot; absolute paths, file: URLs, #aliases and the package's
//     own name are refused;
//   * the other ways to load or run code: dynamic import(), require,
//     eval, Function, import.meta.resolve, process.execPath, and the
//     module / vm / worker_threads / child_process builtins.
// This guards against accidental drift (a helper imported from the
// shell, a stray createRequire), not against deliberately hostile code.

import { parse } from "acorn"
import path from "node:path"

const FORBIDDEN_MODULES = new Set([
    "module",
    "vm",
    "worker_threads",
    "child_process",
])
const FORBIDDEN_GLOBALS = new Set(["require", "eval", "Function"])

export class ContainmentError extends Error {
    constructor(violations) {
        super(
            `core code reaches outside its snapshot: ${violations
                .map((v) => `${v.file}: ${v.what}`)
                .join("; ")}`
        )
        this.name = "ContainmentError"
        this.code = "CORE_CONTAINMENT"
        this.violations = violations
    }
}

const builtinName = (spec) => spec.replace(/^node:/, "")

const isBare = (spec) =>
    !spec.startsWith(".") &&
    !spec.startsWith("/") &&
    !spec.startsWith("#") &&
    !/^[a-z][a-z0-9+.-]*:/i.test(spec.replace(/^node:/, ""))

// Checks one import specifier from `file` against the snapshot's files.
const checkSpecifier = (spec, file, files, ownName) => {
    if (FORBIDDEN_MODULES.has(builtinName(spec))) return `import "${spec}"`
    if (ownName && (spec === ownName || spec.startsWith(`${ownName}/`))) {
        return `import "${spec}" (the package's own name)`
    }
    if (spec.startsWith("./") || spec.startsWith("../")) {
        const target = path.posix.normalize(
            path.posix.join(path.posix.dirname(file), spec)
        )
        if (target.startsWith("../") || !Object.hasOwn(files, target)) {
            return `import "${spec}" (outside the snapshot)`
        }
        // Only .js files are parsed and checked, so nothing else may run.
        if (!target.endsWith(".js")) {
            return `import "${spec}" (not a .js module)`
        }
        return null
    }
    if (isBare(spec)) return null
    return `import "${spec}"`
}

const isNonComputedKey = (parent, key, node) =>
    (parent?.type === "MemberExpression" &&
        key === "property" &&
        !parent.computed) ||
    ((parent?.type === "Property" || parent?.type === "PropertyDefinition") &&
        key === "key" &&
        !parent.computed &&
        parent.value !== node) ||
    (parent?.type === "MethodDefinition" && key === "key" && !parent.computed)

const propertyName = (member) =>
    member.computed
        ? member.property.type === "Literal"
            ? member.property.value
            : null
        : member.property.name

const walk = (node, visit, parent = null, key = null) => {
    if (!node || typeof node.type !== "string") return
    visit(node, parent, key)
    for (const [childKey, child] of Object.entries(node)) {
        if (Array.isArray(child)) {
            for (const c of child) walk(c, visit, node, childKey)
        } else if (child && typeof child.type === "string") {
            walk(child, visit, node, childKey)
        }
    }
}

// Violations in one parsed file.
export const checkFile = (file, source, files, { ownName = null } = {}) => {
    const found = []
    let ast
    try {
        ast = parse(source, {
            ecmaVersion: "latest",
            sourceType: "module",
            allowHashBang: true,
        })
    } catch (err) {
        return [{ file, what: `does not parse: ${err.message}` }]
    }
    walk(ast, (node, parent, key) => {
        switch (node.type) {
            case "ImportDeclaration":
            case "ExportNamedDeclaration":
            case "ExportAllDeclaration": {
                if (!node.source) return
                const what = checkSpecifier(
                    node.source.value,
                    file,
                    files,
                    ownName
                )
                if (what) found.push({ file, what })
                return
            }
            case "ImportExpression":
                found.push({ file, what: "dynamic import()" })
                return
            case "Identifier":
                if (
                    FORBIDDEN_GLOBALS.has(node.name) &&
                    !isNonComputedKey(parent, key, node)
                ) {
                    found.push({ file, what: node.name })
                }
                return
            case "MemberExpression": {
                const name = propertyName(node)
                if (
                    node.object.type === "MetaProperty" &&
                    node.object.meta.name === "import" &&
                    name === "resolve"
                ) {
                    found.push({ file, what: "import.meta.resolve" })
                }
                if (
                    node.object.type === "Identifier" &&
                    node.object.name === "process" &&
                    name === "execPath"
                ) {
                    found.push({ file, what: "process.execPath" })
                }
                return
            }
            default:
        }
    })
    return found
}

// Throws a ContainmentError naming every violation in the snapshot's JS
// files (`files`: relative path → bytes).
export const checkContainment = (files, { ownName = null } = {}) => {
    const violations = []
    for (const [file, bytes] of Object.entries(files)) {
        if (!file.endsWith(".js")) continue
        violations.push(
            ...checkFile(file, Buffer.from(bytes).toString("utf8"), files, {
                ownName,
            })
        )
    }
    if (violations.length > 0) throw new ContainmentError(violations)
}

// The relative static-import closure of `entry` (paths in `files`),
// entry included. Used for `reviewVersion`.
export const importClosure = (entry, files) => {
    const seen = new Set()
    const visit = (file) => {
        if (seen.has(file) || !Object.hasOwn(files, file)) return
        seen.add(file)
        const ast = parse(Buffer.from(files[file]).toString("utf8"), {
            ecmaVersion: "latest",
            sourceType: "module",
            allowHashBang: true,
        })
        for (const node of ast.body) {
            const spec = node.source?.value
            if (
                typeof spec === "string" &&
                (spec.startsWith("./") || spec.startsWith("../"))
            ) {
                visit(
                    path.posix.normalize(
                        path.posix.join(path.posix.dirname(file), spec)
                    )
                )
            }
        }
    }
    visit(entry)
    return [...seen].sort()
}
