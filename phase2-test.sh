#!/usr/bin/env bash
# phase-2 手动测试运行器
# cwd 隔离到 /tmp/licode-phase2-test，.licode（people/memory/journal）落在那里，不污染主仓库。
# 代码用本 worktree（feat/second-brain-phase2 分支，含最新修复）。
# 用法：./phase2-test.sh   （然后在 TUI 里照测试指南操作）
# 重置：rm -rf /tmp/licode-phase2-test/.licode
set -e
WORKTREE="$(cd "$(dirname "$0")" && pwd)"   # 绝对路径，须在 cd 之前取
TEST_DIR=/tmp/licode-phase2-test
mkdir -p "$TEST_DIR"
cd "$TEST_DIR"
exec "$WORKTREE/node_modules/.bin/tsx" "$WORKTREE/packages/cli/bin/licode.ts" "$@"
