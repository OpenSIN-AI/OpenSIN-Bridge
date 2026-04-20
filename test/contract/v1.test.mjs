import { test } from "node:test"
import assert from "node:assert/strict"

import {
  buildContract,
  ERROR_CODES,
  INTERNAL_TO_CONTRACT,
  METHODS,
  REVISION,
  RETRY_HINTS,
  VERSION,
  findMethod,
  isIdempotent,
  toContractCode,
} from "../../extension/src/contract/v1/index.js"

test("contract version is stable string", () => {
  assert.equal(VERSION, "opensin.bridge.contract/v1")
  assert.ok(Number.isFinite(REVISION) && REVISION >= 1)
})

test("every method declares idempotent + mutates booleans + raises array + retryHint", () => {
  for (const m of METHODS) {
    assert.ok(m.name.includes("."), `${m.name}: must be namespaced`)
    assert.equal(typeof m.idempotent, "boolean", `${m.name}: idempotent`)
    assert.equal(typeof m.mutates, "boolean", `${m.name}: mutates`)
    assert.ok(Array.isArray(m.raises), `${m.name}: raises array`)
    assert.match(m.retryHint, /^(safe_retry|recover_then_retry|abort)$/)
  }
})

test("every raised code is part of ERROR_CODES", () => {
  const codes = new Set(Object.values(ERROR_CODES))
  for (const m of METHODS) {
    for (const code of m.raises) {
      assert.ok(codes.has(code), `${m.name} raises unknown code ${code}`)
    }
  }
})

test("INTERNAL_TO_CONTRACT only maps to known contract codes", () => {
  const codes = new Set(Object.values(ERROR_CODES))
  for (const [k, v] of Object.entries(INTERNAL_TO_CONTRACT)) {
    assert.ok(codes.has(v), `${k} -> ${v} is unknown`)
  }
})

test("RETRY_HINTS has an entry for every error code", () => {
  for (const code of Object.values(ERROR_CODES)) {
    assert.ok(code in RETRY_HINTS, `missing retry hint for ${code}`)
  }
})

test("findMethod resolves known methods and returns null for unknown", () => {
  assert.ok(findMethod("dom.click"))
  assert.equal(findMethod("does.not.exist"), null)
  assert.equal(findMethod(null), null)
})

test("isIdempotent matches the contract entry", () => {
  assert.equal(isIdempotent("dom.snapshot"), true)
  assert.equal(isIdempotent("dom.click"), false)
  assert.equal(isIdempotent("nav.goto"), false)
  assert.equal(isIdempotent("session.invalidate"), true)
})

test("toContractCode falls back to internal_error for unknown input", () => {
  assert.equal(toContractCode("TIMEOUT"), ERROR_CODES.TIMEOUT)
  assert.equal(toContractCode("UNKNOWN_TOOL"), ERROR_CODES.UNKNOWN_METHOD)
  assert.equal(toContractCode("not-a-code"), ERROR_CODES.INTERNAL_ERROR)
  assert.equal(toContractCode(null), ERROR_CODES.INTERNAL_ERROR)
})

test("buildContract returns a serializable object pinned to VERSION + REVISION", () => {
  const c = buildContract()
  assert.equal(c.version, VERSION)
  assert.equal(c.revision, REVISION)
  assert.ok(Array.isArray(c.methods) && c.methods.length === METHODS.length)
  assert.ok(Array.isArray(c.errorCodes) && c.errorCodes.length === Object.values(ERROR_CODES).length)
  // serializable
  const serialized = JSON.stringify(c)
  assert.ok(serialized.length > 0)
})

test("contract method name set is unique", () => {
  const seen = new Set()
  for (const m of METHODS) {
    assert.ok(!seen.has(m.name), `duplicate method ${m.name}`)
    seen.add(m.name)
  }
})

test("a non-mutating method that is also non-idempotent must declare why via raises or category", () => {
  // The only legitimate non-mutating + non-idempotent combination is a method
  // that runs arbitrary user-supplied code (e.g. dom.evaluate). All other
  // read-only methods MUST be idempotent.
  for (const m of METHODS) {
    if (!m.mutates && !m.idempotent) {
      assert.match(
        m.name,
        /\.(evaluate|exec|run|execute)$/,
        `${m.name}: non-mutating + non-idempotent is only allowed for arbitrary-eval methods`,
      )
    }
  }
})
