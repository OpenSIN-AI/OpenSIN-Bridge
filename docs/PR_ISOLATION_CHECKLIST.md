# OpenSIN-Bridge PR Isolation Checklist

Use this checklist right before review, push, or PR creation.

- [ ] I am inside `/Users/jeremy/dev/clean-worktrees/OpenSIN-Bridge-issue-<issue-number>`
- [ ] The branch name matches the issue branch requested by the task
- [ ] `git status --short` is empty
- [ ] `git diff --name-only origin/main...HEAD` only contains issue-owned files
- [ ] I ran `npm run verify:pr`
- [ ] I ran the issue-scoped regression command when the issue defines one
- [ ] I ran `npm run verify:issue-scope -- ...` with the correct allowlist
- [ ] The PR description states the exact verification commands and results
- [ ] No unrelated generated files, local experiments, or rescue edits were left in the branch

Recommended verification command template:

```bash
npm run verify:issue-scope -- \
  --issue <issue-number> \
  --branch <branch-name> \
  --base origin/main \
  --allow <path-or-prefix> \
  --allow <path-or-prefix>
```
