#!/usr/bin/env bash
# Copyright AlpineReplay Inc, 2026. All rights reserved.
# Author: Leo Khramov
#
# Idempotent uninstaller for the review orchestrator. Removes ONLY the
# review-orchestrator-specific subtrees / files; leaves hand-edited
# content in shared files (~/.claude.json, ~/.claude/settings.json,
# ~/.claude/CLAUDE.md) intact. Pass --launch to also remove the launchd
# agent.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")" && pwd -P)"

LAUNCH=0
DRY_RUN=0
HOME_DIR="${HOME:-}"
KEEP_CONFIG=0

usage() {
    cat <<'EOF'
Usage: ./uninstall.sh [--launch] [--dry-run] [--home <dir>] [--keep-config] [--help]

  --launch        Also remove the launchd plist + bootout the agent.
  --dry-run       Print what would happen without writing.
  --home DIR      Operate on DIR/.config and DIR/.claude instead of $HOME.
  --keep-config   Keep ~/.config/review-orchestrator/ intact (preserves
                  authToken + reviewsDir state in case of reinstall).
  --help, -h      Show this help.
EOF
}

while [ $# -gt 0 ]; do
    case "$1" in
        --launch) LAUNCH=1; shift ;;
        --dry-run) DRY_RUN=1; shift ;;
        --home)
            shift
            [ $# -gt 0 ] || { echo "--home needs a value" >&2; exit 1; }
            HOME_DIR="$1"; shift ;;
        --keep-config) KEEP_CONFIG=1; shift ;;
        --help|-h) usage; exit 0 ;;
        *) echo "unknown arg: $1" >&2; usage; exit 1 ;;
    esac
done

if [ -z "$HOME_DIR" ]; then
    echo "HOME is empty and --home not supplied" >&2
    exit 1
fi
HOME_DIR="$(cd "$HOME_DIR" && pwd -P)"

CONFIG_DIR="$HOME_DIR/.config/review-orchestrator"
CONFIG_PATH="$CONFIG_DIR/config.json"
HEADERS_SCRIPT="$CONFIG_DIR/mcp-headers.sh"
CLAUDE_DIR="$HOME_DIR/.claude"
HOOK_PATH="$CLAUDE_DIR/hooks/stop-review.mjs"
CLAUDE_JSON="$HOME_DIR/.claude.json"
SETTINGS_JSON="$CLAUDE_DIR/settings.json"
CLAUDE_MD="$CLAUDE_DIR/CLAUDE.md"
PLIST_NAME="com.leo.review-orchestrator.plist"
PLIST_DST="$HOME_DIR/Library/LaunchAgents/$PLIST_NAME"

SUMMARY=()
note() { SUMMARY+=("$1"); }

maybe() {
    if [ "$DRY_RUN" -eq 1 ]; then
        echo "[dry-run] $*"
        return 1
    fi
    return 0
}

remove_file_idempotent() {
    local path="$1"
    local label="$2"
    if [ ! -e "$path" ]; then
        note "  absent:    $label ($path)"
        return 0
    fi
    if ! maybe "rm $path"; then return 0; fi
    rm -f "$path"
    note "  removed:   $label ($path)"
}

run_helper() {
    local label="$1"; shift
    local script="$1"; shift
    if ! maybe "run helper: $label"; then return 0; fi
    local out
    out="$(node "$script" "$@")" || {
        echo "uninstall: helper $label failed: $out" >&2
        exit 1
    }
    local action="${out%%:*}"
    local path_part="${out#*:}"
    note "  $action: $label ($path_part)"
}

echo "review-orchestrator uninstall"
echo "  REPO_ROOT:   $REPO_ROOT"
echo "  HOME:        $HOME_DIR"
echo "  --launch:    $([ "$LAUNCH" -eq 1 ] && echo yes || echo no)"
echo "  --dry-run:   $([ "$DRY_RUN" -eq 1 ] && echo yes || echo no)"
echo "  keep config: $([ "$KEEP_CONFIG" -eq 1 ] && echo yes || echo no)"
echo

# 1. launchd (first — bootout the agent before yanking the plist).
if [ "$LAUNCH" -eq 1 ]; then
    DOMAIN="gui/$(id -u)"
    if maybe "launchctl bootout"; then
        launchctl bootout "$DOMAIN/com.leo.review-orchestrator" 2>/dev/null || true
    fi
    remove_file_idempotent "$PLIST_DST" "launchd plist"
fi

# 2. Stop hook entry in settings.json
run_helper "~/.claude/settings.json (Stop hook)" "$REPO_ROOT/install/remove-stop-hook.mjs" "$SETTINGS_JSON" "$HOOK_PATH"

# 3. MCP entry in ~/.claude.json
run_helper "~/.claude.json (MCP entry)" "$REPO_ROOT/install/remove-mcp.mjs" "$CLAUDE_JSON"

# 4. CLAUDE.md snippet
run_helper "~/.claude/CLAUDE.md (snippet)" "$REPO_ROOT/install/remove-claude-md.mjs" "$CLAUDE_MD"

# 5. Hook file
remove_file_idempotent "$HOOK_PATH" "Stop hook"

# 6. Headers script + config dir.
if [ "$KEEP_CONFIG" -eq 1 ]; then
    note "  kept:      config dir ($CONFIG_DIR; --keep-config)"
else
    remove_file_idempotent "$HEADERS_SCRIPT" "mcp-headers.sh"
    remove_file_idempotent "$CONFIG_PATH" "config.json"
    if [ -d "$CONFIG_DIR" ] && [ -z "$(ls -A "$CONFIG_DIR" 2>/dev/null)" ]; then
        if maybe "rmdir $CONFIG_DIR"; then
            rmdir "$CONFIG_DIR" 2>/dev/null && note "  removed:   config dir ($CONFIG_DIR)" || true
        fi
    fi
fi

echo
echo "Summary:"
for line in ${SUMMARY[@]+"${SUMMARY[@]}"}; do
    printf '%s\n' "$line"
done
echo
echo "review-orchestrator: uninstall complete."
