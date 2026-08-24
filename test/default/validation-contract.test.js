import test from 'node:test';
import assert from 'node:assert/strict';

import {
  collectTestFiles,
  listIssueDirectories,
  loadContract,
  resolveTestFiles,
} from '../../scripts/validation-contract.mjs';

// These default tests protect the shared plumbing that every validation command
// depends on. They stay in the fast local suite because if the contract helper
// breaks, every other test entrypoint becomes ambiguous again.

test('default validation resolves the documented default suite files', () => {
  const contract = loadContract();
  const resolvedFiles = resolveTestFiles({ contract, scope: 'default' });

  assert.deepEqual(resolvedFiles, ['test/default/validation-contract.test.js']);
});

test('issue discovery returns the directories that must be registered', () => {
  assert.deepEqual(listIssueDirectories(), ['test/issues/issue-27']);
});

test('issue suite directories expose executable node:test files', () => {
  assert.deepEqual(collectTestFiles('test/issues/issue-27'), ['test/issues/issue-27/validation-contract.test.js']);
});
