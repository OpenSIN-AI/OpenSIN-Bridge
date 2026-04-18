# Issue-Scoped Worktree Execution for OpenSIN-Bridge

> Last updated: 2026-04-10

## Why this exists

Cloud execution feedback for issue lanes like `#13` and `#16` exposed the same failure mode: the default checkout already contained unrelated dirty changes, so feature work and PRs could easily absorb files that had nothing to do with the requested issue.

For OpenSIN-Bridge, the default checkout is now treated as a coordination lane, not as a safe implementation lane. Real issue work happens in a dedicated git worktree with a dedicated branch and an explicit PR-scope verification step.

## Standard workflow

### 1. Create one clean worktree per issue

Use the helper script from the repository root:

```bash
npm run issue:worktree -- --issue 26 --branch feat/worktree-pr-isolation-ops
```

Default location:

```text
/Users/jeremy/dev/clean-worktrees/OpenSIN-Bridge-issue-<issue-number>
```

Example:

```text
/Users/jeremy/dev/clean-worktrees/OpenSIN-Bridge-issue-26
```

### 2. Map issue -> worktree -> branch explicitly

OpenSIN-Bridge now uses this mapping rule:

| Surface | Convention | Purpose |
|--------|------------|---------|
| Worktree path | `.../OpenSIN-Bridge-issue-<issue-number>` | Makes the issue lane visible in local and cloud execution logs |
| Preferred branch name | `<type>/issue-<issue-number>-<slug>` | Keeps the issue number in the git ref itself |
| Accepted compatibility branch | User-assigned branch name | Use when the issue already dictates a branch name, but still keep the issue number in the worktree path |

Examples:

- Preferred: `feat/issue-26-worktree-pr-isolation`
- Compatibility mode for this issue: `feat/worktree-pr-isolation-ops`

### 3. Do all implementation from inside the issue worktree

After creation:

```bash
cd /Users/jeremy/dev/clean-worktrees/OpenSIN-Bridge-issue-26
git status --short --branch
```

Expected result before editing:

- branch matches the requested issue branch
- worktree is clean
- no unrelated untracked files are present

### 4. Keep the issue scope explicit before you code

Before implementation, write down the surfaces that are allowed to change for the issue. This becomes the PR allowlist.

Examples:

| Issue type | Typical allowlist |
|-----------|-------------------|
| Docs / process | `README.md`, `docs/`, `scripts/`, `package.json` |
| Extension-only | `extension/`, `README.md`, `docs/`, `package.json` |
| Server-only | `server/`, `README.md`, `docs/`, `package.json` |
| Full-stack bridge feature | `extension/`, `server/`, `README.md`, `docs/`, `package.json` |

If the work requires additional surfaces, update the issue comment or implementation notes before continuing. Do not silently widen the scope during execution.

## Targeted verification guidance

OpenSIN-Bridge now distinguishes between three verification surfaces:

1. `npm test` / `npm run test:default` for the fast default local gate
2. `npm run test:issue -- --issue <n>` for issue-scoped regression coverage
3. `npm run verify:pr` for the review-ready pull-request contract (`test:all` + `build`)

The issue worktree and PR-scope gate still matter, but they now sit beside an explicit test contract instead of replacing it.

### Docs / process issues

1. Run the issue-scoped suite when the issue registers one:
   ```bash
   npm run test:issue -- --issue 27
   ```
2. Run the PR verification contract:
   ```bash
   npm run verify:pr
   ```
3. Run the PR isolation gate:
   ```bash
   npm run verify:issue-scope -- \
     --issue 27 \
     --branch feat/test-hygiene-validation-contract \
     --base origin/main \
     --allow README.md \
     --allow docs/ \
     --allow scripts/ \
     --allow test/ \
     --allow package.json
   ```

### Extension-only issues

1. Run the relevant issue-scoped suite, if one exists.
2. Run `npm run verify:pr`.
3. Verify the PR scope against the expected extension surfaces:
   ```bash
   npm run verify:issue-scope -- --issue <n> --branch <branch> --base origin/main --allow extension/ --allow README.md --allow docs/ --allow test/ --allow package.json
   ```

### Server-only issues

1. Run the relevant issue-scoped suite, if one exists.
2. Run `npm run verify:pr`.
3. Verify the PR scope against the expected server surfaces:
   ```bash
   npm run verify:issue-scope -- --issue <n> --branch <branch> --base origin/main --allow server/ --allow README.md --allow docs/ --allow test/ --allow package.json
   ```

### Mixed extension + server issues

Run the issue-scoped suite, then `npm run verify:pr`, then one final scope gate:

```bash
npm run verify:issue-scope -- --issue <n> --branch <branch> --base origin/main --allow extension/ --allow server/ --allow README.md --allow docs/ --allow test/ --allow package.json
```

## PR isolation checklist

Use this checklist before opening or updating a PR:

- [ ] Work was implemented in `OpenSIN-Bridge-issue-<issue-number>`, not in the default checkout
- [ ] Current branch matches the issue branch requested in the task
- [ ] `git status --short` is clean before PR verification
- [ ] `git diff --name-only origin/main...HEAD` contains only files that belong to the issue
- [ ] The targeted verification command for the issue lane was run and passed
- [ ] Any scope expansion was documented explicitly instead of appearing silently in the diff
- [ ] The PR summary names the exact verification command that was used

## Helper scripts

| Command | Purpose |
|--------|---------|
| `npm run issue:worktree -- --issue <n> --branch <branch>` | Creates the isolated worktree for one issue |
| `npm run verify:issue-scope -- ...` | Blocks PRs that drift outside the declared issue scope |

## Recommended operator habit

If a cloud executor lands in a dirty default checkout, stop immediately. Do not clean that checkout by hand, do not cherry-pick half-finished files, and do not start editing in place. Create or reuse the issue-scoped worktree first, then continue from the isolated lane.
