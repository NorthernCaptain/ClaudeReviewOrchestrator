#!/usr/bin/env node
/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

// Reviewer evaluation: runs the real reviewer CLIs over small fixture
// repositories with planted problems (and clean ones) and scores the
// findings. It drives the same core code the server runs (buildPayload,
// wrapPrompt, the review rules, the provider adapters), straight from
// this checkout, so new rules and prompts can be measured before the
// daemon reloads them.
//
// Each case is eval/cases/<id>/: case.json, base/ (committed) and change/
// (copied over it, left uncommitted: the working-tree change reviewed).

import {
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { SEVERITY_ORDER } from "../server/src/core/blockingSeverities.js"
import { validateConfig } from "../server/src/core/config.js"
import { buildPayload } from "../server/src/core/review/diff.js"
import { filterPayloadFindings } from "../server/src/core/review/review.js"
import { pickReviewer, wrapPrompt } from "../server/src/core/review/reviewer.js"
import { createReviewRules } from "../server/src/core/review/rules.js"
import { createOutputSchema } from "../server/src/core/review/schema.js"
import { createTools, REVIEWER_TOOLS } from "../server/src/tools.js"

const here = path.dirname(fileURLToPath(import.meta.url))
const CORE_REVIEW_DIR = path.join(here, "..", "server", "src", "core", "review")
export const DEFAULT_CASES_DIR = path.join(here, "cases")
export const DEFAULT_CONFIG_PATH = path.join(
    homedir(),
    ".config",
    "review-orchestrator",
    "config.json"
)

// Higher is more severe; derived from the server's canonical order.
export const SEVERITY_RANK = Object.freeze(
    Object.fromEntries(
        SEVERITY_ORDER.map((s, i) => [s, SEVERITY_ORDER.length - 1 - i])
    )
)
export const DEFAULT_MIN_SEVERITY = "major"
// How far a finding's line may sit from the expected one and still count.
export const DEFAULT_LINE_SLACK = 6
const KINDS = new Set(["issues", "clean"])
const GIT_IDENTITY = [
    "-c",
    "user.name=review-eval",
    "-c",
    "user.email=review-eval@localhost",
    "-c",
    "commit.gpgsign=false",
]

export const USAGE = `Usage: node eval/eval.mjs [options]

  --providers <list>   comma-separated reviewers (default: codex,claude)
  --cases <list>       comma-separated case ids (default: all)
  --rules <which>      bundled (default: what the config resolves to),
                       none (no rules block: the old prompt), or a path
  --config <path>      config.json (default: ${DEFAULT_CONFIG_PATH})
  --concurrency <n>    reviews run at once (default: 3)
  --work <dir>         where repos and results go (default: a new temp dir)
  --keep               keep the case repositories after the run
  --help               show this help`

export class UsageError extends Error {}

export const parseArgs = (argv) => {
    const opts = {
        providers: ["codex", "claude"],
        cases: null,
        rules: "bundled",
        config: DEFAULT_CONFIG_PATH,
        concurrency: 3,
        work: null,
        keep: false,
        help: false,
    }
    // Duplicates dropped: two jobs for one case and provider would share,
    // and delete, the same repository folder.
    const list = (v) => [
        ...new Set(
            v
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean)
        ),
    ]
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]
        const value = () => {
            const v = argv[++i]
            if (v === undefined || v.startsWith("--")) {
                throw new UsageError(`${arg} needs a value`)
            }
            return v
        }
        if (arg === "--providers") opts.providers = list(value())
        else if (arg === "--cases") opts.cases = list(value())
        else if (arg === "--rules") opts.rules = value()
        else if (arg === "--config") opts.config = value()
        else if (arg === "--work") opts.work = value()
        else if (arg === "--keep") opts.keep = true
        else if (arg === "--help" || arg === "-h") opts.help = true
        else if (arg === "--concurrency") {
            const n = Number(value())
            if (!Number.isInteger(n) || n < 1) {
                throw new UsageError("--concurrency must be a positive integer")
            }
            opts.concurrency = n
        } else throw new UsageError(`unknown option: ${arg}`)
    }
    if (opts.providers.length === 0)
        throw new UsageError("--providers is empty")
    const unknown = opts.providers.filter(
        (p) => !Object.hasOwn(REVIEWER_TOOLS, p)
    )
    if (unknown.length > 0) {
        throw new UsageError(
            `unknown provider: ${unknown.join(", ")} (one of ${Object.keys(REVIEWER_TOOLS).join(", ")})`
        )
    }
    if (opts.cases !== null && opts.cases.length === 0)
        throw new UsageError("--cases is empty")
    return opts
}

const validateSpec = (id, spec) => {
    if (!KINDS.has(spec?.expect)) {
        throw new Error(`case ${id}: "expect" must be "issues" or "clean"`)
    }
    const findings = spec.findings ?? []
    if (spec.expect === "issues" && findings.length === 0) {
        throw new Error(`case ${id}: an "issues" case needs "findings"`)
    }
    for (const f of findings) {
        if (!Array.isArray(f.files) || f.files.length === 0) {
            throw new Error(`case ${id}: every expected finding needs "files"`)
        }
        if (f.minSeverity !== undefined && !(f.minSeverity in SEVERITY_RANK)) {
            throw new Error(`case ${id}: unknown minSeverity ${f.minSeverity}`)
        }
    }
    return { ...spec, findings }
}

export const loadCases = (casesDir, only = null) => {
    const ids = readdirSync(casesDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort()
    if (only) {
        const missing = only.filter((id) => !ids.includes(id))
        if (missing.length > 0) {
            throw new UsageError(`unknown case: ${missing.join(", ")}`)
        }
    }
    return ids
        .filter((id) => !only || only.includes(id))
        .map((id) => {
            const dir = path.join(casesDir, id)
            const spec = JSON.parse(
                readFileSync(path.join(dir, "case.json"), "utf8")
            )
            return { id, dir, spec: validateSpec(id, spec) }
        })
}

// base/ committed on main, change/ copied over it and left uncommitted.
export const buildCaseRepo = async ({ caseDir, spec, repoDir, git }) => {
    mkdirSync(repoDir, { recursive: true })
    cpSync(path.join(caseDir, "base"), repoDir, { recursive: true })
    await git(repoDir, ["init", "-q", "-b", "main"])
    await git(repoDir, ["add", "-A"])
    await git(repoDir, [
        ...GIT_IDENTITY,
        "commit",
        "-q",
        "-m",
        spec.baseMessage ?? "Initial version",
    ])
    const change = path.join(caseDir, "change")
    if (existsSync(change)) cpSync(change, repoDir, { recursive: true })
    for (const rel of spec.delete ?? [])
        rmSync(path.join(repoDir, rel), { force: true })
    return repoDir
}

// A case's repository folder, which is deleted and rebuilt on every run:
// it must be a direct child of <work>/repos.
export const caseRepoDir = (work, caseId, provider) => {
    const repos = path.resolve(work, "repos")
    const dir = path.resolve(repos, `${caseId}--${provider}`)
    if (path.dirname(dir) !== repos) {
        throw new UsageError(
            `case repository escapes ${repos}: ${caseId}--${provider}`
        )
    }
    return dir
}

// 1-based line of the first line containing `needle`, or null.
export const lineOf = (text, needle) => {
    const lines = text.split("\n")
    const i = lines.findIndex((l) => l.includes(needle))
    return i === -1 ? null : i + 1
}

const rank = (severity) => SEVERITY_RANK[severity] ?? -1

const matches = (expected, finding, readFile) => {
    if (!expected.files.includes(finding.file)) return false
    if (
        rank(finding.severity) <
        rank(expected.minSeverity ?? DEFAULT_MIN_SEVERITY)
    )
        return false
    if (!expected.near || finding.line === 0) return true
    let target = null
    try {
        target = lineOf(readFile(finding.file), expected.near)
    } catch {
        return false
    }
    if (target === null) return false
    return (
        Math.abs(finding.line - target) <=
        (expected.slack ?? DEFAULT_LINE_SLACK)
    )
}

// `blocking` are the severities the config blocks on: a clean case passes
// when the review raised none of those.
export const scoreCase = ({ spec, result, blocking, readFile }) => {
    const findings = result.findings ?? []
    const blockingFindings = findings.filter((f) =>
        blocking.includes(f.severity)
    )
    if (result.status === "ESCALATE") {
        return {
            pass: false,
            error: result.reason ?? "reviewer failed",
            hits: [],
            blocking: 0,
        }
    }
    if (spec.expect === "clean") {
        return {
            pass: blockingFindings.length === 0,
            hits: [],
            blocking: blockingFindings.length,
        }
    }
    const hits = spec.findings.map(
        (expected) =>
            findings.find((f) => matches(expected, f, readFile)) ?? null
    )
    return {
        pass: hits.every(Boolean),
        hits,
        blocking: blockingFindings.length,
    }
}

// One review the way the server runs it, minus state and caching.
export const reviewRepo = async ({
    repoDir,
    config,
    provider,
    rulesText,
    schema,
    tools,
    deps = {},
}) => {
    const payload = await (deps.buildPayload ?? buildPayload)({
        repoRoot: repoDir,
        config,
        git: tools.git,
    })
    const prompt = wrapPrompt({
        payloadText: payload.promptText,
        extraInstructions: config.extraReviewerInstructions,
        omittedFiles: payload.omittedFiles ?? [],
        diffRef: payload.diffRef,
        reviewRules: rulesText,
    })
    const adapter = (deps.pickReviewer ?? pickReviewer)(config, provider)
    const started = Date.now()
    try {
        const result = await adapter.runAndParse({
            repoRoot: repoDir,
            prompt,
            config,
            schema,
            spawn: (_binary, args, opts) =>
                tools.spawnTool(provider, args, { ...opts, config }),
        })
        // Score only what the server would keep: it drops findings on
        // files outside the payload, so those can never block a change.
        const { kept, dropped } = filterPayloadFindings(
            result.findings ?? [],
            payload,
            repoDir
        )
        return {
            status: result.status,
            findings: kept,
            droppedFindings: dropped,
            reason: result.reason ?? null,
            durationMs: result.raw?.durationMs ?? Date.now() - started,
        }
    } catch (err) {
        return {
            status: "ESCALATE",
            findings: [],
            droppedFindings: [],
            reason: err?.message ?? String(err),
            durationMs: Date.now() - started,
        }
    }
}

export const runPool = async (items, concurrency, fn) => {
    const results = new Array(items.length)
    let next = 0
    const worker = async () => {
        while (next < items.length) {
            const i = next++
            results[i] = await fn(items[i], i)
        }
    }
    await Promise.all(
        Array.from({ length: Math.min(concurrency, items.length) }, worker)
    )
    return results
}

export const resolveRulesText = ({
    which,
    config,
    bundledBytes,
    readFile = readFileSync,
}) => {
    if (which === "none") return { text: null, source: "none" }
    const rules = createReviewRules(bundledBytes)
    if (which === "bundled") {
        const r = rules.resolve(config)
        return { text: r.text, source: r.source }
    }
    const r = createReviewRules(readFile(which))
    return { text: r.bundled.text, source: which }
}

const pad = (s, n) => String(s).padEnd(n)

export const formatReport = ({ cases, providers, runs, rulesSource }) => {
    const out = [`Rules: ${rulesSource}`, ""]
    const idWidth = Math.max(4, ...cases.map((c) => c.id.length)) + 2
    out.push(
        pad("case", idWidth) +
            pad("expect", 8) +
            providers.map((p) => pad(p, 22)).join("")
    )
    for (const c of cases) {
        const cells = providers.map((p) => {
            const r = runs.find((x) => x.caseId === c.id && x.provider === p)
            if (!r) return pad("-", 22)
            const verdict = r.score.error
                ? "ERROR"
                : r.score.pass
                  ? "pass"
                  : "FAIL"
            return pad(
                `${verdict} b=${r.score.blocking} ${Math.round(r.result.durationMs / 1000)}s`,
                22
            )
        })
        out.push(pad(c.id, idWidth) + pad(c.spec.expect, 8) + cells.join(""))
    }
    out.push("")
    for (const p of providers) {
        const mine = runs.filter((r) => r.provider === p)
        const issues = mine.filter((r) => r.spec.expect === "issues")
        const clean = mine.filter((r) => r.spec.expect === "clean")
        const errors = mine.filter((r) => r.score.error).length
        out.push(
            `${p}: caught ${issues.filter((r) => r.score.pass).length}/${issues.length} planted, ` +
                `clean ${clean.filter((r) => r.score.pass).length}/${clean.length}, ` +
                `false blocking on clean ${clean.reduce((n, r) => n + r.score.blocking, 0)}, errors ${errors}`
        )
    }
    const misses = runs.filter((r) => !r.score.pass)
    if (misses.length > 0) {
        out.push("", "Not passed:")
        for (const r of misses) {
            out.push(
                `  ${r.caseId} [${r.provider}]${r.score.error ? ` error: ${r.score.error}` : ""}`
            )
            for (const f of r.result.findings) {
                out.push(
                    `    ${f.severity} ${f.file}:${f.line} ${f.message.slice(0, 160)}`
                )
            }
            for (const f of r.result.droppedFindings ?? []) {
                out.push(
                    `    dropped (not in the change) ${f.severity} ${f.file}:${f.line} ${f.message.slice(0, 120)}`
                )
            }
        }
    }
    return out.join("\n")
}

export const main = async (argv, deps = {}) => {
    const log = deps.log ?? console.log
    const opts = parseArgs(argv)
    if (opts.help) {
        log(USAGE)
        return 0
    }
    const read = deps.readFile ?? readFileSync
    const config = validateConfig(JSON.parse(read(opts.config, "utf8")))
    const cases = loadCases(deps.casesDir ?? DEFAULT_CASES_DIR, opts.cases)
    if (cases.length === 0) throw new UsageError("no cases to run")
    const work = opts.work ?? mkdtempSync(path.join(tmpdir(), "review-eval-"))
    mkdirSync(work, { recursive: true })
    const coreDir = deps.coreReviewDir ?? CORE_REVIEW_DIR
    const rules = resolveRulesText({
        which: opts.rules,
        config,
        bundledBytes: read(path.join(coreDir, "review-rules.md")),
        readFile: read,
    })
    const schema = createOutputSchema(
        read(path.join(coreDir, "codex-output.schema.json")),
        {
            strictPath: path.join(work, "codex-output.strict.json"),
        }
    )
    const tools =
        deps.tools ??
        createTools({
            getGitTimeoutMs: () => config.limits.gitTimeoutSeconds * 1000,
        })
    const review = deps.reviewRepo ?? reviewRepo
    const jobs = cases.flatMap((c) =>
        opts.providers.map((provider) => ({
            c,
            provider,
            // Checked before any job starts, so a bad path stops the run
            // before anything is deleted or spawned.
            repoDir: caseRepoDir(work, c.id, provider),
        }))
    )
    log(
        `Running ${jobs.length} reviews (${cases.length} cases × ${opts.providers.join(", ")}) in ${work}`
    )
    const runs = await runPool(
        jobs,
        opts.concurrency,
        async ({ c, provider, repoDir }) => {
            let result
            // A failed case is an error result, never a rejection: the
            // pool must keep waiting on the reviewers still running.
            try {
                rmSync(repoDir, { recursive: true, force: true })
                await buildCaseRepo({
                    caseDir: c.dir,
                    spec: c.spec,
                    repoDir,
                    git: tools.git,
                })
                result = await review({
                    repoDir,
                    config,
                    provider,
                    rulesText: rules.text,
                    schema,
                    tools,
                })
            } catch (err) {
                result = {
                    status: "ESCALATE",
                    findings: [],
                    droppedFindings: [],
                    reason: `case setup or payload failed: ${err?.message ?? String(err)}`,
                    durationMs: 0,
                }
            }
            const score = scoreCase({
                spec: c.spec,
                result,
                blocking: config.blockingSeverities,
                readFile: (rel) => read(path.join(repoDir, rel), "utf8"),
            })
            log(
                `  ${c.id} [${provider}] ${score.error ? "ERROR" : score.pass ? "pass" : "FAIL"}`
            )
            return { caseId: c.id, provider, spec: c.spec, result, score }
        }
    )
    const report = formatReport({
        cases,
        providers: opts.providers,
        runs,
        rulesSource: rules.source,
    })
    writeFileSync(
        path.join(work, "results.json"),
        JSON.stringify(
            { rules: rules.source, providers: opts.providers, runs },
            null,
            2
        ) + "\n"
    )
    log("")
    log(report)
    log(`\nDetails: ${path.join(work, "results.json")}`)
    if (!opts.keep)
        rmSync(path.join(work, "repos"), { recursive: true, force: true })
    return runs.every((r) => r.score.pass) ? 0 : 1
}

/* istanbul ignore next -- CLI entry */
if (
    process.argv[1] &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
    main(process.argv.slice(2)).then(
        (code) => process.exit(code),
        (err) => {
            console.error(
                err instanceof UsageError ? `${err.message}\n\n${USAGE}` : err
            )
            process.exit(2)
        }
    )
}
