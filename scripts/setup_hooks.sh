#!/usr/bin/env bash
# Setup git hooks for 16ane Protocol
set -e

echo "Configuring git hooks for 16ane..."
git config core.hooksPath .githooks
chmod +x .githooks/* scripts/*.sh test/gitleaks/*.sh 2>/dev/null || true
echo "Git hooks configured to .githooks (pre-commit & pre-push active)"
