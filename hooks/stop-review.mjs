#!/usr/bin/env node
/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

// Phase 7: Stop hook entrypoint.
// - Read Stop payload JSON from stdin (cwd, session_id, ...).
// - Load authToken directly from ~/.config/review-orchestrator/config.json.
// - POST http://127.0.0.1:7777/review with X-Review-Token header and
//   body { cwd, session_id, trigger: "stop_hook" }.
// - On GOOD_TO_GO / GOOD_TO_GO_WITH_NOTES / NO_CHANGES → exit 0.
//   GOOD_TO_GO_WITH_NOTES writes a non-blocking notes summary to stderr.
// - On ESCALATE → write banner to stderr, exit 0.
// - On ISSUES / NO_PROGRESS_WITH_OPEN_ISSUES → emit
//   { decision: "block", reason: <formatted blocking findings> } on
//   stdout, exit 0.
// - Fail open (exit 0) on any error so the CLI never hangs.

process.exitCode = 0
