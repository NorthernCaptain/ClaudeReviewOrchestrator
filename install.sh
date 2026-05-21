#!/usr/bin/env bash
# Copyright AlpineReplay Inc, 2026. All rights reserved.
# Author: Leo Khramov

set -euo pipefail

# TODO(phase-8): full installer.
# - Generate authToken (32 bytes base64url) into
#   ~/.config/review-orchestrator/config.json (mode 0600) if absent.
# - Write ~/.config/review-orchestrator/mcp-headers.sh (mode 0700) that
#   emits {"X-Review-Token":"<token>"} JSON by reading the config.
# - Copy launchd/com.leo.review-orchestrator.plist into
#   ~/Library/LaunchAgents/ with __NODE_BIN__ / __REPO_ROOT__ / __HOME__
#   placeholders replaced; launchctl bootstrap it.
# - Copy hooks/stop-review.mjs to ~/.claude/hooks/ (mode 0700).
# - Merge claude-mcp.json into ~/.claude.json (with .bak backup).
# - Merge the Stop hook entry into ~/.claude/settings.json (with backup).
# - Append claude-md-snippet.md into ~/.claude/CLAUDE.md between markers
#   (idempotent: replace existing block in place).
# - Print next-steps banner.

printf '%s\n' "install.sh is a Phase 0 stub. See README.md Phase 8." >&2
exit 1
