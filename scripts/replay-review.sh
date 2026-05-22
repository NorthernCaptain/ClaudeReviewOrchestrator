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
# Requires: jq, curl. Reads token + URL from the same config file the
# server and hook do.

set -euo pipefail

CONFIG_PATH="${REVIEW_ORCH_CONFIG:-$HOME/.config/review-orchestrator/config.json}"
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
require curl

if [[ ! -r "$CONFIG_PATH" ]]; then
    echo "error: config not readable: $CONFIG_PATH" >&2
    exit 3
fi

TOKEN=$(jq -r '.authToken // empty' "$CONFIG_PATH")
PORT=$(jq -r '.port // 7777' "$CONFIG_PATH")
BIND=$(jq -r '.bind // "127.0.0.1"' "$CONFIG_PATH")
case "$BIND" in
    "0.0.0.0") HOST="127.0.0.1" ;;
    "::" | "::1") HOST="[::1]" ;;
    *) HOST="$BIND" ;;
esac
URL="http://$HOST:$PORT/review"

if [[ -z "$TOKEN" ]]; then
    echo "error: no authToken in $CONFIG_PATH" >&2
    exit 3
fi

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
echo "==> POST $URL" >&2
echo "==> body:" >&2
echo "$REQUEST_BODY" | jq . >&2
echo "" >&2

curl -sS -X POST "$URL" \
    -H "content-type: application/json" \
    -H "x-review-token: $TOKEN" \
    -D /tmp/replay-headers.$$ \
    --data "$REQUEST_BODY" \
    | jq .

RC=${PIPESTATUS[0]}

REQ_ID=$(grep -i '^x-request-id:' /tmp/replay-headers.$$ \
    | awk '{print $2}' | tr -d '\r' | head -1)
echo "" >&2
echo "==> server request id: ${REQ_ID:-<none>}" >&2
echo "==> grep the server log for that id to see the full pipeline trace." >&2

rm -f /tmp/replay-headers.$$

exit "$RC"
