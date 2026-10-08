#!/usr/bin/env bash
# setprovider.sh — switch the reviewer provider on the running server.
#
# PUTs to /provider, which sets the provider in the live config and in
# the config file together (one config transaction): the next review
# uses it, and it survives a restart.
#
# Usage:
#   scripts/setprovider.sh gemini
#   scripts/setprovider.sh claude
#   scripts/setprovider.sh codex
#
# Requires: jq, node. Sends the request through hooks/signed-client.mjs,
# which reads the token from the same config file the server and hooks
# do and signs the request with it.

set -euo pipefail

CONFIG_PATH="${REVIEW_ORCH_CONFIG:-$HOME/.config/review-orchestrator/config.json}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLIENT="$SCRIPT_DIR/../hooks/signed-client.mjs"
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
require node

PROVIDER="${1:-}"
[[ -n "$PROVIDER" ]] || usage
case " $VALID " in
    *" $PROVIDER "*) ;;
    *)
        echo "error: unknown provider '$PROVIDER' (valid: $VALID)" >&2
        exit 2
        ;;
esac

# A signed request through the shared client (the token is never sent).
# Prints the response body; exits 0 on a 2xx, 1 on an error status, 4 when
# no server proves the token or the response doesn't verify.
signed() {
    node "$CLIENT" --config "$CONFIG_PATH" "$@"
}

BODY=$(jq -n --arg provider "$PROVIDER" '{provider: $provider}')

echo "==> PUT /provider  (provider=$PROVIDER)" >&2

RC=0
signed PUT /provider "$BODY" | jq . || RC=${PIPESTATUS[0]}
exit "$RC"

