#!/usr/bin/env node
/**
 * scripts/validate-bridge-contract.mjs
 *
 * CI guard for the OpenSIN-Bridge Contract v1 (worker issue #69).
 *
 * Checks:
 *   1. The contract module loads and exposes a non-trivial method list.
 *   2. Every method declared in the contract has a stable shape (name,
 *      idempotent flag, params/returns/raises, retryHint).
 *   3. Every error code referenced by `raises` is part of the public
 *      ERROR_CODES enum.
 *   4. Every entry in INTERNAL_TO_CONTRACT maps to a known contract code.
 *   5. The HuggingFace `server.js` TOOL_DEFINITIONS list does not silently
 *      lose visibility for any contract method.
 *
 * Failures exit with code 1 so CI breaks loudly. This file deliberately
 * stays dependency-free.
 */

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, "..")

const errors = []

function fail(msg) {
  errors.push(msg)
}

const contractPath = path.join(repoRoot, "extension/src/contract/v1/index.js")
if (!fs.existsSync(contractPath)) {
  console.error(`[validate-bridge-contract] missing ${contractPath}`)
  process.exit(1)
}

const contractModule = await import(pathToFileURL(contractPath).href)

const { buildContract, METHODS, ERROR_CODES, INTERNAL_TO_CONTRACT, RETRY_HINTS, VERSION, REVISION } = contractModule

if (!VERSION || typeof VERSION !== "string") fail("VERSION must be a non-empty string")
if (!Number.isFinite(REVISION)) fail("REVISION must be a finite number")
if (!Array.isArray(METHODS) || METHODS.length === 0) fail("METHODS must be a non-empty array")

const codeSet = new Set(Object.values(ERROR_CODES || {}))
if (codeSet.size === 0) fail("ERROR_CODES enum is empty")

for (const method of METHODS) {
  if (!method || typeof method !== "object") {
    fail("METHOD entry must be an object")
    continue
  }
  if (typeof method.name !== "string" || !method.name.includes(".")) {
    fail(`method.name must be namespaced (got ${method.name})`)
  }
  if (typeof method.idempotent !== "boolean") fail(`${method.name}: idempotent flag missing`)
  if (typeof method.mutates !== "boolean") fail(`${method.name}: mutates flag missing`)
  if (typeof method.description !== "string" || !method.description.length) {
    fail(`${method.name}: description required`)
  }
  if (!Array.isArray(method.raises)) {
    fail(`${method.name}: raises must be an array`)
  } else {
    for (const code of method.raises) {
      if (!codeSet.has(code)) fail(`${method.name}: raises unknown code ${code}`)
    }
  }
  if (!["safe_retry", "recover_then_retry", "abort"].includes(method.retryHint)) {
    fail(`${method.name}: retryHint must be safe_retry|recover_then_retry|abort`)
  }
}

for (const [internal, contract] of Object.entries(INTERNAL_TO_CONTRACT || {})) {
  if (!codeSet.has(contract)) {
    fail(`INTERNAL_TO_CONTRACT[${internal}] -> ${contract} is not a known contract code`)
  }
}

for (const [code, hint] of Object.entries(RETRY_HINTS || {})) {
  if (!codeSet.has(code)) fail(`RETRY_HINTS has unknown code ${code}`)
  if (!["safe_retry", "recover_then_retry", "abort"].includes(hint)) {
    fail(`RETRY_HINTS[${code}] = ${hint} is not a known hint`)
  }
}

// Cross-check: every public method appears either as a canonical tool name
// OR as a legacy alias inside server.js TOOL_DEFINITIONS (the HF surface).
// A missing name is a soft warning, because server.js is a flat alias list,
// not the canonical registry.
const serverPath = path.join(repoRoot, "server.js")
if (fs.existsSync(serverPath)) {
  const serverSrc = fs.readFileSync(serverPath, "utf8")
  const missingFromServer = []
  for (const method of METHODS) {
    const flat = method.name.replace(/\./g, "_")
    if (!serverSrc.includes(`'${method.name}'`) && !serverSrc.includes(`'${flat}'`)) {
      missingFromServer.push(method.name)
    }
  }
  if (missingFromServer.length) {
    console.warn(
      `[validate-bridge-contract] WARN: ${missingFromServer.length} contract methods are not advertised in server.js TOOL_DEFINITIONS:`,
      missingFromServer.join(", "),
    )
  }
}

const built = buildContract()
if (built.version !== VERSION || built.revision !== REVISION) {
  fail("buildContract() returned mismatched version/revision")
}

if (errors.length) {
  console.error("OpenSIN bridge contract validation FAILED:")
  for (const e of errors) console.error(` - ${e}`)
  process.exit(1)
}

console.log(
  `OpenSIN bridge contract OK — ${VERSION} rev=${REVISION}, methods=${METHODS.length}, errorCodes=${codeSet.size}`,
)
