import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  contractPath,
  loadContract,
  readJson,
  repoRoot,
  resolveTestFiles,
} from '../../../scripts/validation-contract.mjs';

// This issue-specific regression suite encodes the contract introduced for
// issue #27. Future changes can refactor the implementation, but they cannot
// quietly make package scripts, documentation, and PR guidance drift apart.

test('package scripts expose the default, issue, full, and PR validation surfaces', () => {
  const packageJson = readJson(path.join(repoRoot, 'package.json'));

  assert.equal(packageJson.scripts.test, 'npm run test:default');
  assert.ok(packageJson.scripts['test:contract']);
  assert.ok(packageJson.scripts['test:default']);
  assert.ok(packageJson.scripts['test:all']);
  assert.ok(packageJson.scripts['test:issue']);
  assert.ok(packageJson.scripts['verify:pr']);
});

test('issue 27 stays registered for full-suite and PR validation', () => {
  const contract = loadContract();
  const suite = contract.issueSuites.find((entry) => entry.issue === '27');

  assert.ok(suite, 'issue 27 suite must stay registered');
  assert.deepEqual(suite.requiredIn, ['test:all', 'verify:pr']);
});

test('full-suite validation includes default and issue-specific files', () => {
  const contract = loadContract();
  const resolvedFiles = resolveTestFiles({ contract, scope: 'all' });

  assert.deepEqual(resolvedFiles, [
    'test/default/validation-contract.test.js',
    'test/issues/issue-27/validation-contract.test.js',
  ]);
});

test('documentation explains the validation contract and PR guidance', () => {
  const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
  const validationDoc = fs.readFileSync(path.join(repoRoot, 'docs', 'VALIDATION.md'), 'utf8');

  assert.match(readme, /npm run test:default/);
  assert.match(readme, /npm run test:all/);
  assert.match(readme, /npm run verify:pr/);
  assert.match(validationDoc, /npm run test:issue -- --issue=27/);
  assert.match(validationDoc, /pull request/i);
  assert.match(validationDoc, /issue-scoped/i);
});

test('the validation contract manifest remains present for automation lanes', () => {
  assert.ok(fs.existsSync(contractPath), 'test/validation-contract.json must exist');
});
