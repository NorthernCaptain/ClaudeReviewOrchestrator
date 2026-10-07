#!/usr/bin/env bash
# replay-review.sh — re-run a /review call without going through Claude.
#
# Reads a hook snapshot file (default: most recent one under
# ~/.claude/logs/review-hook-calls/) and POSTs the same body to the
# server. Use this when debugging the full chain — server logs will
# show every pipeline stage; this script lets you fire the request as
# many times as you need without bothering Claude to "finish" a task.
#
# Usage:
#   scripts/replay-review.sh                    # latest snapshot
#   scripts/replay-review.sh <snapshot.json>    # specific snapshot
#   scripts/replay-review.sh --cwd /path/to/repo
#                                               # ad-hoc, no snapshot needed
#
# Requires: jq, node. Sends the request through hooks/signed-client.mjs,
# which reads the token from the same config file the server and hooks
# do and signs the request with it.

set -euo pipefail

CONFIG_PATH="${REVIEW_ORCH_CONFIG:-$HOME/.config/review-orchestrator/config.json}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLIENT="$SCRIPT_DIR/../hooks/signed-client.mjs"
CALLS_DIR="$HOME/.claude/logs/review-hook-calls"

usage() {
    cat <<EOF >&2
usage: $(basename "$0") [snapshot.json | --cwd <path>]

  no args            replay the most recent snapshot in
                     ~/.claude/logs/review-hook-calls/
  <snapshot.json>    replay the named snapshot file
  --cwd <path>       skip snapshot lookup; build a fresh request for the
                     given working directory
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

# A signed request through the shared client (the token is never sent).
# Prints the response body; exits 0 on a 2xx, 1 on an error status, 4 when
# no server proves the token or the response doesn't verify.
signed() {
    node "$CLIENT" --config "$CONFIG_PATH" "$@"
}

REQUEST_BODY=""
SOURCE=""

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
    usage
elif [[ "${1:-}" == "--cwd" ]]; then
    [[ -n "${2:-}" ]] || usage
    REQUEST_BODY=$(jq -n --arg cwd "$2" \
        '{cwd: $cwd, trigger: "manual"}')
    SOURCE="ad-hoc cwd=$2"
elif [[ -n "${1:-}" ]]; then
    [[ -r "$1" ]] || {
        echo "error: snapshot file not readable: $1" >&2
        exit 3
    }
    REQUEST_BODY=$(jq '.serverRequest.body // (
        .claudeInput | {cwd: .cwd, session_id: .session_id, trigger: "stop_hook"}
    )' "$1")
    SOURCE="$1"
else
    if [[ ! -d "$CALLS_DIR" ]]; then
        echo "error: no snapshots directory at $CALLS_DIR" >&2
        echo "       trigger one Stop hook first or pass --cwd <path>" >&2
        exit 3
    fi
    # macOS-friendly find: largest sorted filename wins, since the hook
    # writes ISO timestamps in the filename.
    LATEST=$(find "$CALLS_DIR" -maxdepth 1 -name "*.json" -type f 2>/dev/null \
        | sort | tail -1)
    [[ -n "$LATEST" ]] || {
        echo "error: no .json snapshots found in $CALLS_DIR" >&2
        exit 3
    }
    REQUEST_BODY=$(jq '.serverRequest.body // (
        .claudeInput | {cwd: .cwd, session_id: .session_id, trigger: "stop_hook"}
    )' "$LATEST")
    SOURCE="$LATEST"
fi

echo "==> replay from: $SOURCE" >&2
echo "==> POST /review" >&2
echo "==> body:" >&2
echo "$REQUEST_BODY" | jq . >&2
echo "" >&2

# A review can run up to the hooks' 29-minute cap.
RC=0
signed --timeout 1740 --verbose POST /review "$REQUEST_BODY" | jq . \
    || RC=${PIPESTATUS[0]}
echo "" >&2
echo "==> grep the server log for the request id above to see the full pipeline trace." >&2

exit "$RC"

