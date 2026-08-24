#!/bin/bash
# ==============================================================================
# OpenSIN Component: create-issue-worktree.sh
# ==============================================================================
# DESCRIPTION: Creates an isolated, clean worktree for a specific issue.
# WHY: Prevents dirty checkouts from contaminating feature PRs.
# ==============================================================================
if [ -z "$1" ]; then echo "Usage: $0 <issue-number>"; exit 1; fi
WORKTREE_PATH="../clean-worktrees/OpenSIN-Bridge-issue-$1"
git worktree add "$WORKTREE_PATH" -b "feat/issue-$1"
echo "Clean worktree created at $WORKTREE_PATH"
