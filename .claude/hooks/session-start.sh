#!/bin/bash
# Installs workspace dependencies so lint/typecheck/tests work in Claude Code cloud sessions.
set -euo pipefail

# Cloud sessions only.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(pwd)}"

# pnpm version is pinned by "packageManager" in package.json; use corepack if pnpm is missing.
if ! command -v pnpm >/dev/null 2>&1; then
  corepack enable
  corepack prepare --activate >/dev/null 2>&1 || true
fi

# Prefer the lockfile exactly (what CI does); fall back to a normal install if it is out of date.
pnpm install --frozen-lockfile --prefer-offline || pnpm install --prefer-offline
