#!/usr/bin/env bash
# reset-review.sh — clear the review loop counters for a repo+branch.
#
# POSTs to /reset, which resolves the given directory to its (repoRoot,
# branch) context and clears that context's codexRounds, blockCount, and
# prior findings. Use it when the loop hit MAX_CODEX_ROUNDS / MAX_BLOCKS
# and you want reviews to resume from a clean slate, or when starting an
# unrelated task in the same repo.
#
# Usage:
#   scripts/reset-review.sh                 # reset the current directory's repo+branch
#   scripts/reset-review.sh /path/to/repo   # reset a specific repo path
#
# Requires: jq, curl. Reads token + URL from the same config file the
# server and hook do.

set -euo pipefail

CONFIG_PATH="${REVIEW_ORCH_CONFIG:-$HOME/.config/review-orchestrator/config.json}"

usage() {
    cat <<EOF >&2
usage: $(basename "$0") [repo-path]

Clears the review loop counters (codexRounds, blockCount, prior findings)
for the repo+branch resolved from the given path. Defaults to the current
working directory. The path must resolve to a git repo inside the
server's allowedRoots.
EOF
    exit 2
}

require() {
    command -v "$1" >/dev/null 2>&1 || {
        echo "error: $1 not installed" >&2
        exit 3
    }
}

case "${1:-}" in
    -h | --help) usage ;;
esac

require jq
require curl

# Resolve the target to an absolute path the server can match against
# allowedRoots. Default to the current directory.
TARGET="${1:-$PWD}"
if [[ ! -d "$TARGET" ]]; then
    echo "error: not a directory: $TARGET" >&2
    exit 2
fi
# Absolute, symlink-resolved path (BSD-compatible: cd + pwd -P).
CWD=$(cd "$TARGET" && pwd -P)

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
URL="http://$HOST:$PORT/reset"

if [[ -z "$TOKEN" ]]; then
    echo "error: no authToken in $CONFIG_PATH" >&2
    exit 3
fi

BODY=$(jq -n --arg cwd "$CWD" '{cwd: $cwd}')

echo "==> POST $URL  (cwd=$CWD)" >&2

curl -sS -X POST "$URL" \
    -H "content-type: application/json" \
    -H "x-review-token: $TOKEN" \
    --data "$BODY" \
    | jq .
