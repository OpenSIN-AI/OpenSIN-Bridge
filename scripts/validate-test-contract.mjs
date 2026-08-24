import path from 'node:path';

import { loadContract, readJson, repoRoot, validateContract } from './validation-contract.mjs';

// This command is intentionally strict because silent omissions are the exact
// problem issue #27 is fixing. If the repo contains an unregistered issue suite
// or package scripts drift away from the contract, we fail loudly and early.
const contract = loadContract();
const packageJson = readJson(path.join(repoRoot, 'package.json'));
const errors = validateContract(contract, packageJson);

if (errors.length > 0) {
  console.error('OpenSIN validation contract check failed:');

  for (const error of errors) {
    console.error(`- ${error}`);
  }

  process.exit(1);
}

console.log('OpenSIN validation contract check passed.');
