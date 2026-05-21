/**
 * Copyright AlpineReplay Inc, 2026. All rights reserved.
 * Author: Leo Khramov
 */

// TODO(phase-2): POST /review handler. Resolves context, runs change
// detection (promptHash + progressHash), short-circuits on NO_CHANGES /
// NO_PROGRESS_WITH_OPEN_ISSUES, otherwise invokes codex via codex.js.
// Increments codexRounds and blockCount per the rules in README's
// "Change detection and the no-progress path" section. Stop-hook calls
// receive a decision:"block" reason for ISSUES/NO_PROGRESS.

export {}
