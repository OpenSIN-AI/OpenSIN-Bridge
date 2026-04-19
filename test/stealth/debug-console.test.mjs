// Tests for extension/src/content/debug-console.js — MAIN-world
// console-capture installed alongside the stealth layer.
//
// Like stealth-main.test.mjs we evaluate the production file inside a
// handcrafted stub. No browser, no jsdom — just enough of the window
// surface for the file to install itself and the buffer to accept
// records.

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
  "extension/src/content/debug-console.js",
)

function buildWindow() {
  const listeners = new Map()
  const doc = {
    location: { href: "https://example.test/path?x=1" },
    title: "Example",
  }
  const consoleStub = {
    _errors: [],
    _warns: [],
    error(...a) {
      this._errors.push(a)
    },
    warn(...a) {
      this._warns.push(a)
    },
    log(..._a) {},
  }
  const win = {
    document: doc,
    console: consoleStub,
    addEventListener(type, fn, capture) {
      const key = type
      if (!listeners.has(key)) listeners.set(key, [])
      listeners.get(key).push({ fn, capture })
    },
    _dispatch(type, ev) {
      for (const l of listeners.get(type) || []) {
        try {
          l.fn(ev)
        } catch {
          /* swallow */
        }
      }
    },
    _listeners: listeners,
  }
  return { win, consoleStub, doc }
}

function loadInto(win) {
  const src = readFileSync(SRC, "utf8")
  const runner = new Function(
    "window",
    "document",
    "console",
    "crypto",
    `with (window) { ${src} }`,
  )
  runner(win, win.document, win.console, globalThis.crypto)
}

// ---------------------------------------------------------------------------

test("debug-console: exposes __OPENSIN_DEBUG_CONSOLE__ as a non-configurable surface", () => {
  const { win } = buildWindow()
  loadInto(win)
  const surface = win.__OPENSIN_DEBUG_CONSOLE__
  assert.ok(surface, "surface missing")
  assert.equal(typeof surface.snapshot, "function")
  assert.equal(typeof surface.clear, "function")
  assert.equal(typeof surface.capacity, "number")
  assert.equal(typeof surface.size, "number")

  const desc = Object.getOwnPropertyDescriptor(win, "__OPENSIN_DEBUG_CONSOLE__")
  assert.equal(desc.enumerable, false)
  assert.equal(desc.configurable, false)
  assert.equal(desc.writable, false)
})

test("debug-console: captures console.error with structured record", () => {
  const { win } = buildWindow()
  loadInto(win)
  win.console.error("hello", { a: 1 })
  const entries = win.__OPENSIN_DEBUG_CONSOLE__.snapshot(10)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].level, "error")
  assert.equal(entries[0].source, "console")
  assert.equal(entries[0].args[0], "hello")
  assert.deepEqual(entries[0].args[1], { a: 1 })
  assert.ok(entries[0].timestamp > 0)
  assert.ok(entries[0].seq >= 1)
})

test("debug-console: captures console.warn separately from error", () => {
  const { win } = buildWindow()
  loadInto(win)
  win.console.warn("careful")
  win.console.error("boom")
  const entries = win.__OPENSIN_DEBUG_CONSOLE__.snapshot(10)
  assert.equal(entries.length, 2)
  assert.equal(entries[0].level, "warn")
  assert.equal(entries[1].level, "error")
})

test("debug-console: forwards to original console so page logs still print", () => {
  const { win, consoleStub } = buildWindow()
  loadInto(win)
  win.console.error("forwarded")
  assert.equal(consoleStub._errors.length, 1)
  assert.deepEqual(consoleStub._errors[0], ["forwarded"])
})

test("debug-console: Error objects are serialized to plain JSON", () => {
  const { win } = buildWindow()
  loadInto(win)
  win.console.error(new Error("kaboom"))
  const e = win.__OPENSIN_DEBUG_CONSOLE__.snapshot(1)[0]
  assert.equal(e.args[0].__error__, true)
  assert.equal(e.args[0].message, "kaboom")
  assert.equal(e.args[0].name, "Error")
  assert.equal(typeof e.args[0].stack, "string")
})

test("debug-console: handles window 'error' events", () => {
  const { win } = buildWindow()
  loadInto(win)
  win._dispatch("error", {
    message: "global boom",
    filename: "x.js",
    lineno: 42,
    colno: 7,
    error: new Error("inner"),
  })
  const e = win.__OPENSIN_DEBUG_CONSOLE__.snapshot(1)[0]
  assert.equal(e.source, "window-error")
  assert.equal(e.args[0].message, "global boom")
  assert.equal(e.args[0].lineno, 42)
  assert.equal(e.args[0].error.message, "inner")
})

test("debug-console: handles 'unhandledrejection' with Error reason", () => {
  const { win } = buildWindow()
  loadInto(win)
  win._dispatch("unhandledrejection", { reason: new Error("rejected") })
  const e = win.__OPENSIN_DEBUG_CONSOLE__.snapshot(1)[0]
  assert.equal(e.source, "unhandledrejection")
  assert.equal(e.args[0].__error__, true)
  assert.equal(e.args[0].message, "rejected")
})

test("debug-console: ring buffer caps at capacity", () => {
  const { win } = buildWindow()
  loadInto(win)
  const surface = win.__OPENSIN_DEBUG_CONSOLE__
  const cap = surface.capacity
  for (let i = 0; i < cap + 50; i++) win.console.error("e" + i)
  const all = surface.snapshot(cap + 100)
  assert.equal(all.length, cap)
  // The oldest 50 must have been dropped; the newest must be retained.
  assert.equal(all[all.length - 1].args[0], "e" + (cap + 49))
})

test("debug-console: clear() empties buffer and resets seq", () => {
  const { win } = buildWindow()
  loadInto(win)
  win.console.error("first")
  win.console.error("second")
  win.__OPENSIN_DEBUG_CONSOLE__.clear()
  assert.equal(win.__OPENSIN_DEBUG_CONSOLE__.size, 0)
  win.console.error("third")
  const e = win.__OPENSIN_DEBUG_CONSOLE__.snapshot(1)[0]
  assert.equal(e.seq, 1, "seq should reset to 1 after clear()")
})

test("debug-console: idempotent — loading twice keeps same surface", () => {
  const { win } = buildWindow()
  loadInto(win)
  const first = win.__OPENSIN_DEBUG_CONSOLE__
  loadInto(win)
  const second = win.__OPENSIN_DEBUG_CONSOLE__
  assert.strictEqual(first, second, "surface identity must be preserved")
})

test("debug-console: snapshot(limit) returns at most `limit` entries from the tail", () => {
  const { win } = buildWindow()
  loadInto(win)
  for (let i = 0; i < 10; i++) win.console.error("e" + i)
  const tail = win.__OPENSIN_DEBUG_CONSOLE__.snapshot(3)
  assert.equal(tail.length, 3)
  assert.equal(tail[0].args[0], "e7")
  assert.equal(tail[2].args[0], "e9")
})

test("debug-console: stores url at record time (not at read time)", () => {
  const { win, doc } = buildWindow()
  loadInto(win)
  win.console.error("at /page-a")
  doc.location.href = "https://example.test/page-b"
  win.console.error("at /page-b")
  const entries = win.__OPENSIN_DEBUG_CONSOLE__.snapshot(10)
  assert.equal(entries[0].url, "https://example.test/path?x=1")
  assert.equal(entries[1].url, "https://example.test/page-b")
})
