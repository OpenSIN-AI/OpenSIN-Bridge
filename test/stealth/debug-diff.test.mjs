// Tests for the pure helpers in extension/src/tools/debug.js
// (fingerprint diff computation + record summarization). The chrome.*
// and router surfaces are stubbed so we can exercise the tool module
// without loading the whole extension runtime.

import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

const __dirname = dirname(fileURLToPath(import.meta.url))
const SRC = resolve(
  __dirname,
  "..",
  "..",
  "extension/src/tools/debug.js",
)

// We evaluate the module by stripping its ESM imports and extracting the
// private helpers via a wrapper function. Same approach as
// stealth-main.test.mjs: production file stays a real module, tests load
// it as plain text so they don't need a bundler.
function loadHelpers() {
  let src = readFileSync(SRC, "utf8")
  src = src
    .replace(/^import .*?from .*?$/gm, "")
    .replace(/\bexport\s+function\s+register\b/, "function register")

  const wrapper =
    "'use strict';\n" +
    // minimal ambient stubs so the module body evaluates
    "const createLogger = () => ({ info(){}, warn(){}, debug(){}, error(){} });\n" +
    "const Tabs = { resolveTabId: async (id) => id || 1 };\n" +
    src +
    "\nreturn { computeDiff, summarize, randomId };"

  return new Function(wrapper)()
}

const { computeDiff, summarize, randomId } = loadHelpers()

// ---------------------------------------------------------------------------

test("computeDiff: detects URL change", () => {
  const before = { fingerprint: { url: "https://a.test/" } }
  const after = { fingerprint: { url: "https://a.test/next" } }
  const d = computeDiff(before, after)
  assert.equal(d.urlChanged, true)
  assert.equal(d.urlBefore, "https://a.test/")
  assert.equal(d.urlAfter, "https://a.test/next")
})

test("computeDiff: detects title change", () => {
  const before = { fingerprint: { url: "x", title: "Home" } }
  const after = { fingerprint: { url: "x", title: "Survey — Step 1" } }
  const d = computeDiff(before, after)
  assert.equal(d.titleChanged, true)
  assert.equal(d.urlChanged, false)
})

test("computeDiff: detects body content change via hash", () => {
  const before = { fingerprint: { bodyHash: "aaaaaaaa" } }
  const after = { fingerprint: { bodyHash: "bbbbbbbb" } }
  const d = computeDiff(before, after)
  assert.equal(d.bodyChanged, true)
})

test("computeDiff: identical fingerprints -> no changes", () => {
  const fp = {
    url: "x",
    title: "x",
    bodyHash: "deadbeef",
    nodeCount: 100,
    interactiveCount: 10,
    bodyLength: 500,
  }
  const d = computeDiff({ fingerprint: fp }, { fingerprint: fp })
  assert.equal(d.urlChanged, false)
  assert.equal(d.titleChanged, false)
  assert.equal(d.bodyChanged, false)
  assert.equal(d.nodesDelta, 0)
  assert.equal(d.interactiveDelta, 0)
  assert.equal(d.bodyLengthDelta, 0)
})

test("computeDiff: positive and negative node deltas", () => {
  const grew = computeDiff(
    { fingerprint: { nodeCount: 100, interactiveCount: 5 } },
    { fingerprint: { nodeCount: 250, interactiveCount: 18 } },
  )
  assert.equal(grew.nodesDelta, 150)
  assert.equal(grew.interactiveDelta, 13)

  const shrank = computeDiff(
    { fingerprint: { nodeCount: 250, interactiveCount: 18, bodyLength: 2000 } },
    { fingerprint: { nodeCount: 100, interactiveCount: 5, bodyLength: 400 } },
  )
  assert.equal(shrank.nodesDelta, -150)
  assert.equal(shrank.interactiveDelta, -13)
  assert.equal(shrank.bodyLengthDelta, -1600)
})

test("computeDiff: tolerates missing fingerprint fields", () => {
  // If CDP fingerprint capture fails, upstream passes {} or { error: '...' }.
  const d1 = computeDiff({}, {})
  assert.equal(d1.urlChanged, false)
  assert.equal(d1.nodesDelta, 0)

  const d2 = computeDiff({ fingerprint: {} }, { fingerprint: { nodeCount: 42 } })
  assert.equal(d2.nodesDelta, 42)
})

test("summarize: strips heavy payload while keeping key signals", () => {
  const before = {
    timestamp: 1000,
    fingerprint: { url: "x", nodeCount: 42 },
    console: { available: true, lastSeq: 7, entries: [{}, {}, {}] },
    screenshot: { format: "jpeg", dataUrl: "data:image/jpeg;base64,AAAA...(huge)" },
  }
  const s = summarize(before)
  assert.equal(s.timestamp, 1000)
  assert.deepEqual(s.fingerprint, { url: "x", nodeCount: 42 })
  assert.equal(s.console.available, true)
  assert.equal(s.console.lastSeq, 7)
  assert.equal(s.console.size, 3)
  // Heavy payload must not leak into summary.
  assert.equal(s.screenshot, undefined)
  assert.equal(s.console.entries, undefined)
})

test("summarize: handles null/undefined inputs defensively", () => {
  assert.equal(summarize(null), null)
  assert.equal(summarize(undefined), undefined)
  const s = summarize({ timestamp: 5 })
  assert.equal(s.timestamp, 5)
  assert.equal(s.console, null)
})

test("randomId: returns a 16-hex-char id and is unique", () => {
  const ids = new Set()
  for (let i = 0; i < 200; i++) {
    const id = randomId()
    assert.match(id, /^[0-9a-f]{16}$/)
    ids.add(id)
  }
  // With 64 bits of entropy 200 samples collide with probability ~0.
  assert.equal(ids.size, 200)
})
