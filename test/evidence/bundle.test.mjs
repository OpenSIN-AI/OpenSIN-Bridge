import { test, beforeEach } from "node:test"
import assert from "node:assert/strict"

import { buildEvidenceBundle, EVIDENCE_SCHEMA } from "../../extension/src/drivers/evidence.js"
import * as Trace from "../../extension/src/drivers/trace.js"

function makeRouter(handlers) {
  return {
    has: (name) => name in handlers,
    invoke: async (name, params) => {
      if (typeof handlers[name] === "function") return handlers[name](params)
      throw new Error(`unhandled ${name}`)
    },
  }
}

beforeEach(() => Trace._resetForTests())

test("evidence bundle returns the v1 schema marker", async () => {
  const router = makeRouter({
    "tabs.get": () => ({ tab: { id: 1, url: "https://x.example" } }),
    "dom.snapshot": () => ({ snapshot: { nodes: [] } }),
    "dom.screenshot": () => ({ dataUrl: "data:image/png;base64,AAA" }),
    "net.events": () => ({ events: [] }),
    "behavior.status": () => ({ recording: false, sessionId: null }),
    "stealth.status": () => ({ ok: true }),
  })
  const bundle = await buildEvidenceBundle({ router, tabId: 1, traceId: "t-1" })
  assert.equal(bundle.schema, EVIDENCE_SCHEMA)
  assert.equal(bundle.tabId, 1)
  assert.equal(bundle.traceId, "t-1")
  assert.equal(typeof bundle.assembledMs, "number")
})

test("evidence bundle reports failures per section without throwing", async () => {
  const router = makeRouter({
    "tabs.get": () => {
      throw Object.assign(new Error("tab gone"), { code: "TAB_GONE" })
    },
    "dom.snapshot": () => ({ snapshot: { nodes: [{ role: "button" }] } }),
    "dom.screenshot": () => {
      throw new Error("debugger attached elsewhere")
    },
    "net.events": () => ({ events: [{ id: 1 }, { id: 2 }] }),
    "behavior.status": () => ({ recording: false, sessionId: null }),
    "stealth.status": () => ({ ok: true }),
  })
  const bundle = await buildEvidenceBundle({ router, tabId: 9, traceId: "t-fail" })
  const sections = bundle.errors.map((e) => e.section)
  assert.ok(sections.includes("tab"))
  assert.ok(sections.includes("screenshot"))
  assert.ok(bundle.sections.snapshot, "snapshot still present")
  assert.equal(bundle.sections.network.count, 2)
})

test("includeScreenshot=false skips the screenshot section entirely", async () => {
  const router = makeRouter({
    "tabs.get": () => ({ tab: { id: 1 } }),
    "dom.snapshot": () => ({ snapshot: {} }),
    "net.events": () => ({ events: [] }),
    "behavior.status": () => ({ recording: false }),
    "stealth.status": () => ({ ok: true }),
  })
  const bundle = await buildEvidenceBundle({ router, tabId: 1, includeScreenshot: false })
  assert.ok(!bundle.sections.screenshot, "screenshot must be absent when disabled")
})

test("commandHistory includes recorded dispatches for the trace ID", async () => {
  Trace.recordDispatch({ traceId: "trace-evidence-1", method: "dom.click", status: "error", durationMs: 12, error: "boom" })
  Trace.recordDispatch({ traceId: "trace-evidence-1", method: "dom.snapshot", status: "ok", durationMs: 33 })
  Trace.recordDispatch({ traceId: "other-trace", method: "nav.goto", status: "ok", durationMs: 100 })

  const router = makeRouter({
    "tabs.get": () => ({ tab: { id: 1 } }),
    "dom.snapshot": () => ({ snapshot: {} }),
    "dom.screenshot": () => ({ dataUrl: "data:image/png;base64,AAA" }),
    "net.events": () => ({ events: [] }),
    "behavior.status": () => ({ recording: false }),
    "stealth.status": () => ({ ok: true }),
  })

  const bundle = await buildEvidenceBundle({ router, tabId: 1, traceId: "trace-evidence-1" })
  assert.equal(bundle.sections.commandHistory.count, 2)
  for (const item of bundle.sections.commandHistory.items) {
    assert.equal(item.traceId, "trace-evidence-1")
  }
})

test("trace IDs: ensureTraceId prefers params, then context, then mints", () => {
  const a = Trace.ensureTraceId({ params: { _traceId: "from-params" }, context: {} })
  assert.equal(a, "from-params")
  const b = Trace.ensureTraceId({ params: {}, context: { traceId: "from-ctx" } })
  assert.equal(b, "from-ctx")
  const c = Trace.ensureTraceId({})
  assert.match(c, /^trace-/)
})
