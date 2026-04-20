import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { METHODS, getMethod, isIdempotent } from "../../extension/src/contract/v1/index.js"

describe("contract v1: dom.resolve and dom.waitForSelector", () => {
  it("both methods are registered", () => {
    const names = METHODS.map((m) => m.name)
    assert.ok(names.includes("dom.resolve"), "dom.resolve missing from catalogue")
    assert.ok(names.includes("dom.waitForSelector"), "dom.waitForSelector missing from catalogue")
  })

  it("dom.resolve is read-only and retry-safe", () => {
    const m = getMethod("dom.resolve")
    assert.equal(m.mutates, false)
    assert.equal(m.idempotent, true)
    assert.notEqual(m.retryHint, "abort")
  })

  it("dom.waitForSelector is read-only and retry-safe", () => {
    const m = getMethod("dom.waitForSelector")
    assert.equal(m.mutates, false)
    assert.equal(m.idempotent, true)
  })

  it("isIdempotent helper agrees with catalogue", () => {
    assert.equal(isIdempotent("dom.resolve"), true)
    assert.equal(isIdempotent("dom.waitForSelector"), true)
  })
})
