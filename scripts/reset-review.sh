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
# Requires: jq, node. Sends the request through hooks/signed-client.mjs,
# which reads the token from the same config file the server and hooks
# do and signs the request with it.

set -euo pipefail

CONFIG_PATH="${REVIEW_ORCH_CONFIG:-$HOME/.config/review-orchestrator/config.json}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLIENT="$SCRIPT_DIR/../hooks/signed-client.mjs"

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
require node

# Resolve the target to an absolute path the server can match against
# allowedRoots. Default to the current directory.
TARGET="${1:-$PWD}"
if [[ ! -d "$TARGET" ]]; then
    echo "error: not a directory: $TARGET" >&2
    exit 2
fi
# Absolute, symlink-resolved path (BSD-compatible: cd + pwd -P).
CWD=$(cd "$TARGET" && pwd -P)

# A signed request through the shared client (the token is never sent).
# Prints the response body; exits 0 on a 2xx, 1 on an error status, 4 when
# no server proves the token or the response doesn't verify.
signed() {
    node "$CLIENT" --config "$CONFIG_PATH" "$@"
}

BODY=$(jq -n --arg cwd "$CWD" '{cwd: $cwd}')

echo "==> POST /reset  (cwd=$CWD)" >&2

RC=0
signed POST /reset "$BODY" | jq . || RC=${PIPESTATUS[0]}
exit "$RC"

