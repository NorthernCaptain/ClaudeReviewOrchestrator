#!/usr/bin/env bash
# rotate-token.sh — rotate the review server's authToken.
#
# Writes a new token and a rotation record to config.json under the config
# lock, refreshes the hooks' credentials cache, updates Codex's MCP entry
# when it's installed, and confirms with a signed request (made with the
# new token) that the running server sees it. The previous token stays
# valid for auth.previousTokenGraceHours (default 24) so open MCP clients
# keep working until restarted; --revoke-now ends it at once (for a
# leaked token).
#
# Usage:
#   scripts/rotate-token.sh               # rotate, old token in grace
#   scripts/rotate-token.sh --revoke-now  # rotate, old token refused now
#
# Requires: node.

set -euo pipefail

CONFIG_PATH="${REVIEW_ORCH_CONFIG:-$HOME/.config/review-orchestrator/config.json}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ARGS=(--config "$CONFIG_PATH")
for arg in "$@"; do
    case "$arg" in
        --revoke-now) ARGS+=(--revoke-now) ;;
        -h | --help)
            sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//' >&2
            exit 2
            ;;
        *)
            echo "error: unknown option '$arg'" >&2
            exit 2
            ;;
    esac
done

command -v node >/dev/null 2>&1 || {
    echo "error: node not installed" >&2
    exit 3
}

exec node "$SCRIPT_DIR/../install/rotate-token.mjs" "${ARGS[@]}"
