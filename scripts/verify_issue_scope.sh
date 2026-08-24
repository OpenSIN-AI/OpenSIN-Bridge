#!/usr/bin/env bash
# Verifies that a branch is PR-ready for one issue only.
#
# The check is intentionally strict because its job is to block mixed PRs:
# - branch must match the requested branch name when provided
# - worktree path must match the issue-scoped path when provided
# - working tree must be clean so the PR diff is stable and reviewable
# - changed files versus the chosen base must stay inside the declared allowlist
#
# Example:
#   bash scripts/verify_issue_scope.sh \
#     --issue 26 \
#     --branch feat/worktree-pr-isolation-ops \
#     --base origin/main \
#     --allow README.md \
#     --allow docs/ \
#     --allow scripts/ \
#     --allow package.json
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
EXPECTED_ISSUE=""
EXPECTED_BRANCH=""
BASE_REF="origin/main"
declare -a ALLOWLIST=()

usage() {
  cat <<'EOF'
Usage:
  bash scripts/verify_issue_scope.sh [--issue <number>] [--branch <branch-name>] [--base <git-ref>] [--allow <path-or-prefix> ...]

Options:
  --issue    Numeric issue identifier. Enforces the standard worktree path suffix.
  --branch   Expected branch name. Fails if HEAD is on another branch.
  --base     Diff base used for PR verification. Default: origin/main
  --allow    Repeatable exact path or path prefix allowed in the PR diff.

Notes:
  - If no --allow entries are supplied, the script only checks branch/worktree cleanliness.
  - A trailing slash on --allow behaves like a directory prefix.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --issue)
      EXPECTED_ISSUE="${2:-}"
      shift 2
      ;;
    --branch)
      EXPECTED_BRANCH="${2:-}"
      shift 2
      ;;
    --base)
      BASE_REF="${2:-}"
      shift 2
      ;;
    --allow)
      ALLOWLIST+=("${2:-}")
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[issue-scope] Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

cd "$REPO_ROOT"

CURRENT_BRANCH="$(git branch --show-current)"
CURRENT_TOPLEVEL="$(git rev-parse --show-toplevel)"
CURRENT_STATUS="$(git status --short)"
EXPECTED_WORKTREE_SUFFIX=""

if [[ -n "$EXPECTED_ISSUE" ]]; then
  if ! [[ "$EXPECTED_ISSUE" =~ ^[0-9]+$ ]]; then
    echo "[issue-scope] --issue must be numeric. Received: $EXPECTED_ISSUE" >&2
    exit 1
  fi
  EXPECTED_WORKTREE_SUFFIX="OpenSIN-Bridge-issue-$EXPECTED_ISSUE"
fi

if [[ -n "$EXPECTED_BRANCH" && "$CURRENT_BRANCH" != "$EXPECTED_BRANCH" ]]; then
  echo "[issue-scope] Branch mismatch. Expected '$EXPECTED_BRANCH' but found '$CURRENT_BRANCH'." >&2
  exit 1
fi

if [[ -n "$EXPECTED_WORKTREE_SUFFIX" && "$CURRENT_TOPLEVEL" != *"$EXPECTED_WORKTREE_SUFFIX" ]]; then
  echo "[issue-scope] Worktree path mismatch. Expected path suffix '$EXPECTED_WORKTREE_SUFFIX' but found '$CURRENT_TOPLEVEL'." >&2
  exit 1
fi

# A clean status is required so the PR diff can be reproduced exactly from HEAD.
if [[ -n "$CURRENT_STATUS" ]]; then
  echo "[issue-scope] Working tree is not clean. Commit or discard local changes before PR verification." >&2
  echo "$CURRENT_STATUS" >&2
  exit 1
fi

if ! git rev-parse --verify --quiet "$BASE_REF" >/dev/null; then
  echo "[issue-scope] Base ref not found locally: $BASE_REF" >&2
  exit 1
fi

mapfile -t CHANGED_FILES < <(git diff --name-only "$BASE_REF...HEAD")

if [[ ${#CHANGED_FILES[@]} -eq 0 ]]; then
  echo "[issue-scope] No diff detected against $BASE_REF. Nothing to review." >&2
  exit 1
fi

matches_allowlist() {
  local path="$1"
  local allowed

  # Without an allowlist the caller is only asking for branch/worktree cleanliness.
  if [[ ${#ALLOWLIST[@]} -eq 0 ]]; then
    return 0
  fi

  for allowed in "${ALLOWLIST[@]}"; do
    if [[ "$allowed" == */ ]]; then
      if [[ "$path" == "$allowed"* ]]; then
        return 0
      fi
    else
      if [[ "$path" == "$allowed" || "$path" == "$allowed"/* ]]; then
        return 0
      fi
    fi
  done

  return 1
}

declare -a OUT_OF_SCOPE=()
for changed in "${CHANGED_FILES[@]}"; do
  if ! matches_allowlist "$changed"; then
    OUT_OF_SCOPE+=("$changed")
  fi
done

if [[ ${#OUT_OF_SCOPE[@]} -gt 0 ]]; then
  echo "[issue-scope] PR isolation failed. These files are outside the declared scope:" >&2
  printf '  - %s\n' "${OUT_OF_SCOPE[@]}" >&2
  exit 1
fi

echo "[issue-scope] PASS"
echo "  branch: $CURRENT_BRANCH"
echo "  base:   $BASE_REF"
if [[ -n "$EXPECTED_ISSUE" ]]; then
  echo "  issue:  #$EXPECTED_ISSUE"
fi
echo "  files:"
printf '    - %s\n' "${CHANGED_FILES[@]}"
if [[ ${#ALLOWLIST[@]} -gt 0 ]]; then
  echo "  allowlist:"
  printf '    - %s\n' "${ALLOWLIST[@]}"
fi
