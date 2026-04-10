# Worktree Hygiene & PR Isolation
Always use `scripts/create-issue-worktree.sh <issue-id>` to perform work in a clean environment.

## PR validation checklist
1. Run `npm test` before asking for review. This is the default OpenSIN regression contract and must cover every checked-in `test/*.test.js` file.
2. Use `npm run test:all` when you want an explicit "full suite" command in PR notes or handoff instructions. It is intentionally the same contract as `npm test`.
3. Use targeted `node --test test/<surface>.test.js` commands only for issue-scoped iteration, then rerun `npm test` before marking the branch ready.
