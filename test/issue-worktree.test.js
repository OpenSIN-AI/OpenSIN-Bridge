/**
 * ==============================================================================
 * OpenSIN Component: issue-worktree.test.js
 * ==============================================================================
 *
 * DESCRIPTION / BESCHREIBUNG:
 * Regression coverage for the clean-worktree helper and the PR-isolation gate.
 *
 * WHY IT EXISTS / WARUM ES EXISTIERT:
 * Issue-scoped cloud execution only works when two guarantees hold in practice:
 * 1. a clean worktree can be created from a declared base branch
 * 2. a PR can be blocked when its diff drifts outside the declared issue scope
 *
 * CONSEQUENCES / KONSEQUENZEN:
 * If these checks regress, cloud executors can mix unrelated dirty changes into
 * feature branches and reviewers lose deterministic PR diffs.
 * ==============================================================================
 */

const { afterEach, beforeEach, describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const sourceRepoRoot = path.resolve(__dirname, '..');
const sourceCreateIssueWorktreeScript = path.join(sourceRepoRoot, 'scripts', 'create_issue_worktree.sh');
const sourceVerifyIssueScopeScript = path.join(sourceRepoRoot, 'scripts', 'verify_issue_scope.sh');

let sandboxRoot = '';

function run(command, args, cwd, extraEnv = {}) {
  // Every fixture command is executed synchronously so the test can assert on
  // the exact stdout/stderr pair that reproduces the workflow contract.
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function configureGitIdentity(cwd) {
  // Temporary fixture repositories need an explicit identity because git commit
  // refuses to run without author metadata.
  run('git', ['config', 'user.name', 'OpenSIN Test Runner'], cwd);
  run('git', ['config', 'user.email', 'tests@opensin.ai'], cwd);
}

function writeFile(cwd, relativePath, content) {
  // The helpers under test operate on real files, so the fixture repo writes the
  // exact paths that later appear in git diff and PR-scope validation.
  const absolutePath = path.join(cwd, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content);
}

function installWorkflowScripts(targetRepoPath) {
  // The shell helpers resolve REPO_ROOT from their own location. Copying them
  // into the fixture repository makes them inspect the fixture instead of the
  // real working tree running this test suite.
  const targetScriptsDir = path.join(targetRepoPath, 'scripts');
  fs.mkdirSync(targetScriptsDir, { recursive: true });
  fs.copyFileSync(sourceCreateIssueWorktreeScript, path.join(targetScriptsDir, 'create_issue_worktree.sh'));
  fs.copyFileSync(sourceVerifyIssueScopeScript, path.join(targetScriptsDir, 'verify_issue_scope.sh'));
}

function createSeedRepository() {
  // The tests use a bare remote plus a seeded clone so origin/main exists just
  // like it does in the real OpenSIN-Bridge workflow.
  const bareRemote = path.join(sandboxRoot, 'remote.git');
  const seedRepo = path.join(sandboxRoot, 'seed');

  run('git', ['init', '--bare', bareRemote], sandboxRoot);
  run('git', ['clone', bareRemote, seedRepo], sandboxRoot);
  configureGitIdentity(seedRepo);
  installWorkflowScripts(seedRepo);

  writeFile(seedRepo, 'README.md', '# OpenSIN-Bridge test fixture\n');
  writeFile(seedRepo, 'package.json', '{"name":"opensin-bridge-fixture"}\n');

  run('git', ['checkout', '-b', 'main'], seedRepo);
  run('git', ['add', 'README.md', 'package.json', 'scripts/create_issue_worktree.sh', 'scripts/verify_issue_scope.sh'], seedRepo);
  run('git', ['commit', '-m', 'seed fixture'], seedRepo);
  run('git', ['push', '-u', 'origin', 'main'], seedRepo);

  return { bareRemote, seedRepo };
}

function createIssueLaneClone() {
  // Each verification test gets a fresh issue-scoped checkout whose path ends in
  // OpenSIN-Bridge-issue-26 so the path validation logic can run unchanged.
  const repoPath = path.join(sandboxRoot, 'OpenSIN-Bridge-issue-26');
  const { bareRemote } = createSeedRepository();

  run('git', ['clone', bareRemote, repoPath], sandboxRoot);
  configureGitIdentity(repoPath);
  run('git', ['checkout', '-b', 'feat/worktree-pr-isolation-ops', 'origin/main'], repoPath);

  return repoPath;
}

beforeEach(() => {
  sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opensin-bridge-worktree-'));
});

afterEach(() => {
  if (sandboxRoot) {
    fs.rmSync(sandboxRoot, { recursive: true, force: true });
  }
});

describe('issue worktree workflow', () => {
  it('creates an isolated issue worktree on the requested branch', () => {
    const { seedRepo } = createSeedRepository();
    const cleanWorktreeRoot = path.join(sandboxRoot, 'clean-worktrees');
    const fixtureCreateIssueWorktreeScript = path.join(seedRepo, 'scripts', 'create_issue_worktree.sh');

    const output = run('bash', [fixtureCreateIssueWorktreeScript, '--issue', '26', '--branch', 'feat/worktree-pr-isolation-ops', '--worktree-root', cleanWorktreeRoot], seedRepo);
    const targetPath = path.join(cleanWorktreeRoot, 'OpenSIN-Bridge-issue-26');

    assert.match(output, /Created isolated worktree/);
    assert.strictEqual(run('git', ['branch', '--show-current'], targetPath), 'feat/worktree-pr-isolation-ops');
    assert.match(run('git', ['status', '--short', '--branch'], targetPath), /feat\/worktree-pr-isolation-ops/);
  });

  it('passes when the committed diff stays inside the declared allowlist', () => {
    const repoPath = createIssueLaneClone();
    const fixtureVerifyIssueScopeScript = path.join(repoPath, 'scripts', 'verify_issue_scope.sh');

    writeFile(repoPath, 'README.md', '# OpenSIN-Bridge issue scope fixture\nupdated\n');
    run('git', ['add', 'README.md'], repoPath);
    run('git', ['commit', '-m', 'docs only change'], repoPath);

    const output = run('bash', [fixtureVerifyIssueScopeScript, '--issue', '26', '--branch', 'feat/worktree-pr-isolation-ops', '--base', 'origin/main', '--allow', 'README.md'], repoPath);

    assert.match(output, /\[issue-scope\] PASS/);
    assert.match(output, /README\.md/);
  });

  it('fails when the committed diff contains files outside the declared allowlist', () => {
    const repoPath = createIssueLaneClone();
    const fixtureVerifyIssueScopeScript = path.join(repoPath, 'scripts', 'verify_issue_scope.sh');

    writeFile(repoPath, 'README.md', '# OpenSIN-Bridge issue scope fixture\nupdated\n');
    writeFile(repoPath, 'package.json', '{"name":"opensin-bridge-fixture","extra":true}\n');
    run('git', ['add', 'README.md', 'package.json'], repoPath);
    run('git', ['commit', '-m', 'mixed change'], repoPath);

    assert.throws(() => {
      run('bash', [fixtureVerifyIssueScopeScript, '--issue', '26', '--branch', 'feat/worktree-pr-isolation-ops', '--base', 'origin/main', '--allow', 'README.md'], repoPath);
    }, /package\.json/);
  });
});
