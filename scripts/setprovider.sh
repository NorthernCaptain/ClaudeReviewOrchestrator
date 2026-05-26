#!/usr/bin/env bash
# setprovider.sh — switch the reviewer provider on the running server.
#
# PUTs to /provider, which mutates the live in-memory config (the next
# review uses the new provider immediately) and best-effort persists the
# change to the on-disk config file so it survives a restart.
#
# Usage:
#   scripts/setprovider.sh gemini
#   scripts/setprovider.sh claude
#   scripts/setprovider.sh codex
#
# Requires: jq, curl. Reads token + URL from the same config file the
# server and hook do.

set -euo pipefail

CONFIG_PATH="${REVIEW_ORCH_CONFIG:-$HOME/.config/review-orchestrator/config.json}"
VALID="codex claude gemini"

usage() {
    cat <<EOF >&2
usage: $(basename "$0") <codex|claude|gemini>

Switches the reviewer provider on the running server. Takes effect on
the next review and is persisted to:
  $CONFIG_PATH
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

PROVIDER="${1:-}"
[[ -n "$PROVIDER" ]] || usage
case " $VALID " in
    *" $PROVIDER "*) ;;
    *)
        echo "error: unknown provider '$PROVIDER' (valid: $VALID)" >&2
        exit 2
        ;;
esac

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
URL="http://$HOST:$PORT/provider"

if [[ -z "$TOKEN" ]]; then
    echo "error: no authToken in $CONFIG_PATH" >&2
    exit 3
fi

BODY=$(jq -n --arg provider "$PROVIDER" '{provider: $provider}')

echo "==> PUT $URL  (provider=$PROVIDER)" >&2

curl -sS -X PUT "$URL" \
    -H "content-type: application/json" \
    -H "x-review-token: $TOKEN" \
    --data "$BODY" \
    | jq .
