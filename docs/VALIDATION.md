# OpenSIN-Bridge Validation Contract

> Last updated: 2026-04-10

## Why this exists

Cloud execution for issues #13, #14, #15, and #16 showed the same failure mode: a lane could report that tests passed without making it obvious whether it ran the fast local suite, the issue-specific regression suite, or a broader pull-request verification pass.

This document makes the validation surface explicit so OpenSIN coders, cloud runners, and reviewers all mean the same thing when they reference a test command.

## Command contract

| Command | Purpose | What it runs | When to use it |
|---|---|---|---|
| `npm test` | Default local validation | Alias for `npm run test:default` | Use for routine local edits when you want the repo's standard fast gate |
| `npm run test:contract` | Contract guard | Validates `package.json`, `test/validation-contract.json`, and issue suite registration | Runs before every other test surface so silent omissions fail loudly |
| `npm run test:default` | Fast default suite | `test/default/**/*.test.js` after the contract guard | Use for quick feedback during development |
| `npm run test:issue -- --issue=27` | Issue-scoped regression validation | Only the registered suite for the requested issue | Use before closing an issue or when debugging a specific regression |
| `npm run test:all` | Full repo validation | Default suite plus every registered issue suite | Use before handoff when changes could affect more than one issue surface |
| `npm run verify:pr` | Pull-request verification contract | `npm run test:all` plus `npm run build` | Use before opening or updating a pull request |

## Registration rules for issue-scoped tests

1. Every issue-specific regression suite lives in `test/issues/issue-<number>/`.
2. Every issue directory must be registered in `test/validation-contract.json`.
3. Every registered issue suite must declare `requiredIn: ["test:all", "verify:pr"]`.
4. `npm run test:contract` fails if an `issue-<number>` directory exists without registration or without executable `*.test.js` coverage.

These rules matter because issue-scoped regressions are allowed to stay out of the fast default loop, but they are **not** allowed to disappear from full-suite or pull-request verification.

## Pull request guidance

For a pull request to be review-ready, run the following command from the repository root:

```bash
npm run verify:pr
```

If the change is tied to a specific issue, also run the matching issue-scoped suite and include that command in the PR notes. Example for this contract change:

```bash
npm run test:issue -- --issue=27
```

## Adding a new issue regression suite

1. Create `test/issues/issue-<number>/`.
2. Add at least one `*.test.js` file.
3. Register the suite in `test/validation-contract.json`.
4. Confirm the repo still passes:

```bash
npm run test:contract
npm run test:all
npm run test:issue -- --issue=<number>
```

If any of those steps are skipped, the contract guard should fail and block the change.
