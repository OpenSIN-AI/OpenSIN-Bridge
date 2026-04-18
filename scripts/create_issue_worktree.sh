#!/usr/bin/env bash
# Creates an isolated git worktree for one OpenSIN-Bridge issue so cloud executors
# never have to work inside a dirty default checkout.
#
# Why this exists:
# - the default repository checkout may already contain unrelated local edits
# - issue execution should happen in a dedicated path with a dedicated branch
# - reviewers need a predictable mapping from issue -> worktree path -> branch
#
# Example:
#   bash scripts/create_issue_worktree.sh --issue 26 --branch feat/worktree-pr-isolation-ops
#
# Result:
#   /Users/jeremy/dev/clean-worktrees/OpenSIN-Bridge-issue-26
#
# The script is intentionally explicit instead of "smart" so operators can see
# exactly which base branch, target branch, and target path are being used.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEFAULT_BASE="origin/main"
DEFAULT_WORKTREE_ROOT="/Users/jeremy/dev/clean-worktrees"
ISSUE_NUMBER=""
BRANCH_NAME=""
BASE_REF="$DEFAULT_BASE"
WORKTREE_ROOT="$DEFAULT_WORKTREE_ROOT"

usage() {
  cat <<'EOF'
Usage:
  bash scripts/create_issue_worktree.sh --issue <number> --branch <branch-name> [--base <git-ref>] [--worktree-root <path>]

Options:
  --issue          Numeric issue identifier used in the worktree path.
  --branch         Target branch for the isolated worktree.
  --base           Base ref to branch from. Default: origin/main
  --worktree-root  Parent directory for all clean worktrees. Default: /Users/jeremy/dev/clean-worktrees

Example:
  bash scripts/create_issue_worktree.sh --issue 26 --branch feat/worktree-pr-isolation-ops
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --issue)
      ISSUE_NUMBER="${2:-}"
      shift 2
      ;;
    --branch)
      BRANCH_NAME="${2:-}"
      shift 2
      ;;
    --base)
      BASE_REF="${2:-}"
      shift 2
      ;;
    --worktree-root)
      WORKTREE_ROOT="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[issue-worktree] Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "$ISSUE_NUMBER" || -z "$BRANCH_NAME" ]]; then
  echo "[issue-worktree] --issue and --branch are required." >&2
  usage >&2
  exit 1
fi

if ! [[ "$ISSUE_NUMBER" =~ ^[0-9]+$ ]]; then
  echo "[issue-worktree] --issue must be numeric. Received: $ISSUE_NUMBER" >&2
  exit 1
fi

TARGET_PATH="$WORKTREE_ROOT/OpenSIN-Bridge-issue-$ISSUE_NUMBER"

mkdir -p "$WORKTREE_ROOT"
cd "$REPO_ROOT"

# Keep the base ref current so every isolated worktree starts from a verified base.
git fetch origin main >/dev/null

# Reuse the existing worktree path when it already exists instead of silently creating
# multiple directories for the same issue. This makes cloud handoff deterministic.
if [[ -d "$TARGET_PATH/.git" || -f "$TARGET_PATH/.git" ]]; then
  echo "[issue-worktree] Reusing existing worktree at $TARGET_PATH"
  echo "[issue-worktree] Open it with: cd "$TARGET_PATH""
  exit 0
fi

# Fail fast if the branch already exists elsewhere. This prevents two worktrees from
# fighting over the same branch and reintroducing the exact hygiene problem we want to avoid.
if git show-ref --verify --quiet "refs/heads/$BRANCH_NAME"; then
  echo "[issue-worktree] Branch already exists locally: $BRANCH_NAME" >&2
  echo "[issue-worktree] Inspect existing worktrees with: git worktree list" >&2
  exit 1
fi

# The new worktree is created from an explicit base ref so operators can reason about
# the exact diff range that will later appear in the PR.
git worktree add -b "$BRANCH_NAME" "$TARGET_PATH" "$BASE_REF"

echo "[issue-worktree] Created isolated worktree"
echo "  issue:   #$ISSUE_NUMBER"
echo "  branch:  $BRANCH_NAME"
echo "  base:    $BASE_REF"
echo "  path:    $TARGET_PATH"
echo "[issue-worktree] Next step: cd "$TARGET_PATH" && git status --short --branch"
