#!/usr/bin/env bash
# reload.sh — reload the running server's review core and config without
# a restart (hot-reload plan §5.9).
#
# The server re-reads server/src/core/ and config.json, checks the new
# code and settings, and swaps them in when no review is running (or at
# once with --now). Running reviews always finish on the core they
# started on.
#
# Usage:
#   scripts/reload.sh             # reload (applied now or scheduled)
#   scripts/reload.sh --wait      # ... and wait until a scheduled one ends
#   scripts/reload.sh --now       # apply now, even with reviews running
#   scripts/reload.sh --rollback  # undo the last reload (code and config)
#   scripts/reload.sh --cancel    # drop a pending reload
#
# Requires: jq, node. Sends the request through hooks/signed-client.mjs,
# which reads the token from the same config file the server and hooks
# do and signs the request with it. Exits non-zero when the reload
# fails.

set -euo pipefail

CONFIG_PATH="${REVIEW_ORCH_CONFIG:-$HOME/.config/review-orchestrator/config.json}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLIENT="$SCRIPT_DIR/../hooks/signed-client.mjs"
POLL_SECONDS="${REVIEW_ORCH_RELOAD_POLL_SECONDS:-2}"

usage() {
    cat <<EOF >&2
usage: $(basename "$0") [--now | --rollback | --cancel] [--wait]

Reloads the review core and config.json on the running server.
  --now       apply at once, even while reviews run (they finish on the old core)
  --rollback  undo the last reload, code and config
  --cancel    drop a pending reload
  --wait      when scheduled, wait until it's applied, cancelled or fails
EOF
    exit 2
}

require() {
    command -v "$1" >/dev/null 2>&1 || {
        echo "error: $1 not installed" >&2
        exit 3
    }
}

require jq
require node

NOW=false
ROLLBACK=false
CANCEL=false
WAIT=false
for arg in "$@"; do
    case "$arg" in
        --now) NOW=true ;;
        --rollback) ROLLBACK=true ;;
        --cancel) CANCEL=true ;;
        --wait) WAIT=true ;;
        -h | --help) usage ;;
        *)
            echo "error: unknown option '$arg'" >&2
            usage
            ;;
    esac
done

# A signed request through the shared client (the token is never sent).
# Prints the response body; exits 0 on a 2xx, 1 on an error status, 4 when
# no server proves the token or the response doesn't verify.
signed() {
    node "$CLIENT" --config "$CONFIG_PATH" "$@"
}

BODY=$(jq -n \
    --argjson now "$NOW" \
    --argjson rollback "$ROLLBACK" \
    --argjson cancel "$CANCEL" \
    '{now: $now, rollback: $rollback, cancel: $cancel}')

RESPONSE_FILE=$(mktemp)
trap 'rm -f "$RESPONSE_FILE"' EXIT

RC=0
signed POST /admin/reload "$BODY" >"$RESPONSE_FILE" || RC=$?
if [[ $RC -ne 0 && $RC -ne 1 ]]; then
    exit 4
fi

report() {
    jq -r '
        if .ok != true then "failed: \(.error // "unknown error") (\(.code // "?"))"
        elif .unchanged == true then
            "unchanged — nothing to reload" +
            (if .cancelledPending then " (cancelled the pending reload to \(.cancelledPending))" else "" end)
        elif .applied == true then
            "applied: \(.kind) \(.from) → \(.to)" +
            (if ((.configChanges // .reverted // []) | length) > 0
             then "\n  config: \((.configChanges // .reverted) | join(", "))" else "" end) +
            (if ((.keptEdited // []) | length) > 0
             then "\n  kept (edited since the reload): \(.keptEdited | join(", "))" else "" end) +
            (if ((.keptUnapplied // []) | length) > 0
             then "\n  kept (unapplied file edits): \(.keptUnapplied | join(", "))" else "" end) +
            (if .backup then "\n  backup: \(.backup)" else "" end)
        elif .scheduled == true then
            "scheduled: \(.kind) to \(.to) — waiting for \(.activeReviews) review(s)"
        elif .cancelled == true then "cancelled the pending \(.kind) to \(.to)"
        elif .cancelled == false then .reason
        else tostring end
    ' "$1"
}

report "$RESPONSE_FILE"
if [[ $RC -ne 0 ]] || [[ "$(jq -r '.ok' "$RESPONSE_FILE")" != "true" ]]; then
    exit 1
fi

if [[ "$WAIT" == "true" ]] && [[ "$(jq -r '.scheduled // false' "$RESPONSE_FILE")" == "true" ]]; then
    echo "waiting for the running reviews to finish…" >&2
    while :; do
        sleep "$POLL_SECONDS"
        signed GET /admin/reload >"$RESPONSE_FILE" || exit 4
        if [[ "$(jq -r '.reload.pending == null' "$RESPONSE_FILE")" == "true" ]]; then
            jq -r '.reload.history[0] |
                if .ok then "applied: \(.kind) \(.from) → \(.to)"
                else "not applied: \(.error // "unknown")" end' "$RESPONSE_FILE"
            [[ "$(jq -r '.reload.history[0].ok' "$RESPONSE_FILE")" == "true" ]] || exit 1
            exit 0
        fi
    done
fi
