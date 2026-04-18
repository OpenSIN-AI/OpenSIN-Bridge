import { spawnSync } from 'node:child_process';

import { loadContract, resolveTestFiles } from './validation-contract.mjs';

// The CLI uses explicit --scope and --issue flags so callers cannot rely on
// undocumented positional arguments. That keeps the invocation surface stable
// across local runs, issue-specific debugging, and PR verification.
function parseArgs(argv) {
  const parsed = { scope: 'default', issue: undefined };

  for (const argument of argv) {
    if (argument.startsWith('--scope=')) {
      parsed.scope = argument.slice('--scope='.length);
      continue;
    }

    if (argument.startsWith('--issue=')) {
      parsed.issue = argument.slice('--issue='.length);
    }
  }

  return parsed;
}

const options = parseArgs(process.argv.slice(2));
const contract = loadContract();
const testFiles = resolveTestFiles({ contract, scope: options.scope, issue: options.issue });

if (testFiles.length === 0) {
  console.error(`No test files resolved for validation scope ${options.scope}.`);
  process.exit(1);
}

// We print the resolved files before execution so every automation lane can see
// exactly which suites were exercised. That directly addresses the prior
// ambiguity where "tests passed" did not reveal what actually ran.
console.log(`OpenSIN validation scope: ${options.scope}${options.issue ? ` (issue ${options.issue})` : ''}`);
for (const file of testFiles) {
  console.log(`- ${file}`);
}

// Node's built-in test runner is enough here because the repository currently
// uses JavaScript tests without any transpilation or external assertion stack.
const result = spawnSync(process.execPath, ['--test', ...testFiles], {
  stdio: 'inherit',
  env: process.env,
});

process.exit(result.status ?? 1);
