import { test, beforeEach } from "node:test"
import assert from "node:assert/strict"

import * as Lifecycle from "../../extension/src/drivers/session-lifecycle.js"

beforeEach(() => {
  Lifecycle._resetForTests()
})

test("buildManifest creates a fresh manifest when none exists", async () => {
  const m = await Lifecycle.buildManifest({ origin: "https://app.example.com", tabId: 42, ttlSeconds: 600 })
  assert.equal(m.origin, "https://app.example.com")
  assert.equal(m.tabId, 42)
  assert.equal(m.state, "active")
  assert.equal(m.ttlSeconds, 600)
  assert.ok(m.expiresAt > Date.now())
})

test("buildManifest normalizes origins (case, trailing slash, missing scheme)", async () => {
  const a = await Lifecycle.buildManifest({ origin: "https://APP.example.com/" })
  const b = await Lifecycle.buildManifest({ origin: "app.example.com" })
  assert.equal(a.origin, "https://app.example.com")
  assert.equal(b.origin, "https://app.example.com")
})

test("buildManifest refreshes existing active manifest, preserves createdAt", async () => {
  const m1 = await Lifecycle.buildManifest({ origin: "https://x.example.com", tabId: 1 })
  const createdAt = m1.createdAt
  const m2 = await Lifecycle.buildManifest({ origin: "https://x.example.com", tabId: 99, ttlSeconds: 30 })
  assert.equal(m2.createdAt, createdAt)
  assert.equal(m2.tabId, 99)
  assert.equal(m2.ttlSeconds, 30)
})

test("invalidate marks manifest invalid + promotes lastKnownGood", async () => {
  await Lifecycle.buildManifest({ origin: "https://y.example.com", tabId: 7, ttlSeconds: 600 })
  const r = await Lifecycle.invalidate({ origin: "https://y.example.com", reason: "logged_out_remote" })
  assert.equal(r.ok, true)
  assert.equal(r.reason, "logged_out_remote")
  const lkg = await Lifecycle.lastKnownGood({ origin: "https://y.example.com" })
  assert.ok(lkg)
  assert.equal(lkg.tabId, 7)
})

test("invalidate without prior manifest returns ok=false", async () => {
  const r = await Lifecycle.invalidate({ origin: "https://nope.example.com", reason: "x" })
  assert.equal(r.ok, false)
  assert.equal(r.reason, "no_manifest")
})

test("invalidate requires reason", async () => {
  await Lifecycle.buildManifest({ origin: "https://z.example.com" })
  await assert.rejects(Lifecycle.invalidate({ origin: "https://z.example.com", reason: "" }))
  await assert.rejects(Lifecycle.invalidate({ origin: "https://z.example.com" }))
})

test("health returns absent / active / stale / invalid", async () => {
  const h0 = await Lifecycle.health({ origin: "https://h.example.com" })
  assert.equal(h0.status, "absent")

  await Lifecycle.buildManifest({ origin: "https://h.example.com", ttlSeconds: 3600 })
  const h1 = await Lifecycle.health({ origin: "https://h.example.com" })
  assert.equal(h1.status, "active")
  assert.ok(h1.ttlSecondsRemaining > 0)

  // Force expired by writing a TTL of 0 then waiting one tick
  await Lifecycle.buildManifest({ origin: "https://h.example.com", ttlSeconds: 0.001 })
  await new Promise((r) => setTimeout(r, 5))
  const h2 = await Lifecycle.health({ origin: "https://h.example.com" })
  assert.equal(h2.status, "stale")

  await Lifecycle.invalidate({ origin: "https://h.example.com", reason: "test" })
  const h3 = await Lifecycle.health({ origin: "https://h.example.com" })
  assert.equal(h3.status, "invalid")
  assert.equal(h3.reason, "test")
})

test("listManifests returns newest first", async () => {
  await Lifecycle.buildManifest({ origin: "https://a.example.com" })
  await new Promise((r) => setTimeout(r, 2))
  await Lifecycle.buildManifest({ origin: "https://b.example.com" })
  const list = await Lifecycle.listManifests()
  assert.ok(list.length >= 2)
  assert.equal(list[0].origin, "https://b.example.com")
})

test("dropManifest removes the entry", async () => {
  await Lifecycle.buildManifest({ origin: "https://drop.example.com" })
  const r = await Lifecycle.dropManifest({ origin: "https://drop.example.com" })
  assert.equal(r.ok, true)
  const m = await Lifecycle.getManifest({ origin: "https://drop.example.com" })
  assert.equal(m, null)
})

test("invalid origin is rejected on writes and returns absent on reads", async () => {
  await assert.rejects(Lifecycle.buildManifest({ origin: "" }))
  await assert.rejects(Lifecycle.invalidate({ origin: "", reason: "x" }))
  const lkg = await Lifecycle.lastKnownGood({ origin: "" })
  assert.equal(lkg, null)
  const h = await Lifecycle.health({ origin: "" })
  assert.equal(h.status, "unknown")
})
