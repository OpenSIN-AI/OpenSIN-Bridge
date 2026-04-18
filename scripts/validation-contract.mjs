import fs from 'node:fs';
import path from 'node:path';

// This file is the single source of truth for how OpenSIN-Bridge interprets
// the validation contract. We centralize the helpers here so package scripts,
// contract guards, and node:test execution all resolve suites the same way.

// We resolve paths from the repository root because npm scripts execute from
// the root and every contract path in test/validation-contract.json is stored
// relative to that location.
export const repoRoot = process.cwd();

// Keeping the contract path in one constant prevents every caller from hard-
// coding the file location differently, which would re-introduce ambiguity.
export const contractPath = path.join(repoRoot, 'test', 'validation-contract.json');

// Reading JSON is wrapped in a helper so validation and test execution use the
// exact same parsing behavior and error messages.
export function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

// The contract loader is intentionally tiny: it only knows where the manifest
// lives and leaves all semantic checks to validateContract(). That separation
// keeps runtime behavior simple and makes failures easier to explain.
export function loadContract() {
  return readJson(contractPath);
}

// We only care about issue-scoped directories that follow the documented
// issue-<number> naming convention. This lets us discover forgotten suites
// without needing an external globbing dependency.
export function listIssueDirectories() {
  const issuesRoot = path.join(repoRoot, 'test', 'issues');

  if (!fs.existsSync(issuesRoot)) {
    return [];
  }

  return fs
    .readdirSync(issuesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^issue-\d+$/.test(entry.name))
    .map((entry) => path.posix.join('test', 'issues', entry.name))
    .sort();
}

// We walk directories recursively because issue suites may grow into nested
// folders over time, and the contract should keep working without script edits.
export function collectTestFiles(relativeDirectory) {
  const absoluteDirectory = path.join(repoRoot, relativeDirectory);

  if (!fs.existsSync(absoluteDirectory)) {
    return [];
  }

  const collectedFiles = [];

  const walk = (currentDirectory) => {
    for (const entry of fs.readdirSync(currentDirectory, { withFileTypes: true })) {
      const absolutePath = path.join(currentDirectory, entry.name);

      if (entry.isDirectory()) {
        walk(absolutePath);
        continue;
      }

      // The contract currently standardizes on *.test.js so Node's built-in
      // runner can execute suites without extra tooling or transpilation.
      if (entry.isFile() && entry.name.endsWith('.test.js')) {
        collectedFiles.push(path.relative(repoRoot, absolutePath));
      }
    }
  };

  walk(absoluteDirectory);
  return collectedFiles.sort();
}

// Validation errors are returned as data instead of thrown immediately so the
// caller can present a single actionable report that explains every mismatch in
// one run rather than forcing a fix-one-error-at-a-time loop.
export function validateContract(contract, packageJson) {
  const errors = [];

  if (!Array.isArray(contract.defaultSuiteDirectories) || contract.defaultSuiteDirectories.length === 0) {
    errors.push('defaultSuiteDirectories must contain at least one directory.');
  }

  if (!Array.isArray(contract.issueSuites)) {
    errors.push('issueSuites must be an array.');
  }

  const registeredIssueDirectories = new Set();

  for (const suite of contract.issueSuites || []) {
    if (!suite.issue || !/^\d+$/.test(String(suite.issue))) {
      errors.push(`Issue suite ${JSON.stringify(suite)} must define a numeric issue value.`);
    }

    if (!suite.directory || !/^test\/issues\/issue-\d+$/.test(suite.directory)) {
      errors.push(`Issue suite ${suite.issue ?? 'unknown'} must use a test/issues/issue-<number> directory.`);
    }

    if (suite.directory) {
      registeredIssueDirectories.add(suite.directory);
    }

    if (!Array.isArray(suite.requiredIn) || !suite.requiredIn.includes('test:all') || !suite.requiredIn.includes('verify:pr')) {
      errors.push(`Issue suite ${suite.issue ?? 'unknown'} must require both test:all and verify:pr.`);
    }

    if (suite.directory && collectTestFiles(suite.directory).length === 0) {
      errors.push(`Issue suite ${suite.issue ?? 'unknown'} does not contain any *.test.js files in ${suite.directory}.`);
    }
  }

  for (const discoveredDirectory of listIssueDirectories()) {
    if (!registeredIssueDirectories.has(discoveredDirectory)) {
      errors.push(`Discovered issue suite directory ${discoveredDirectory} is missing from test/validation-contract.json.`);
    }
  }

  for (const defaultDirectory of contract.defaultSuiteDirectories || []) {
    if (collectTestFiles(defaultDirectory).length === 0) {
      errors.push(`Default suite directory ${defaultDirectory} does not contain any *.test.js files.`);
    }
  }

  // The package.json checks keep the public npm surface aligned with the test
  // contract. If someone renames a script without updating the manifest/docs,
  // the guard fails before reviewers get ambiguous instructions.
  const scripts = packageJson.scripts || {};
  const requiredScripts = ['test', 'test:contract', 'test:default', 'test:all', 'test:issue', 'verify:pr'];

  for (const scriptName of requiredScripts) {
    if (!scripts[scriptName]) {
      errors.push(`package.json is missing the ${scriptName} script required by the validation contract.`);
    }
  }

  if (scripts.test !== 'npm run test:default') {
    errors.push('package.json script "test" must resolve to "npm run test:default".');
  }

  return errors;
}

// Suite resolution is centralized here so test:default, test:all, and
// test:issue differ only by an explicit scope instead of each script building
// its own file list ad hoc.
export function resolveTestFiles({ contract, scope, issue }) {
  const defaultFiles = (contract.defaultSuiteDirectories || []).flatMap((directory) => collectTestFiles(directory));

  if (scope === 'default') {
    return defaultFiles;
  }

  if (scope === 'all' || scope === 'pr') {
    const issueFiles = (contract.issueSuites || []).flatMap((suite) => collectTestFiles(suite.directory));
    return [...new Set([...defaultFiles, ...issueFiles])];
  }

  if (scope === 'issue') {
    const targetSuite = (contract.issueSuites || []).find((suite) => String(suite.issue) === String(issue));

    if (!targetSuite) {
      throw new Error(`No issue suite is registered for issue ${issue}.`);
    }

    return collectTestFiles(targetSuite.directory);
  }

  throw new Error(`Unsupported validation scope: ${scope}`);
}
