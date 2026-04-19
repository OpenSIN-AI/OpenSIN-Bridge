/**
 * tools/debug.js — per-step tracing for agent operations.
 *
 * Exposed tools:
 *   debug.startSession, debug.endSession, debug.traceAction,
 *   debug.snapshotState, debug.getTrace, debug.clearTrace,
 *   debug.getConsoleErrors
 *
 * Use case (from the survey-worker blocker post-mortem, Issue #61):
 * When an agent fails to open a survey, we currently have no visibility
 * into WHAT happened at each step. Was the click dispatched? Did the
 * page navigate? Did a modal intercept? Did the console throw?
 *
 * debug.traceAction wraps a single router.invoke and records, before
 * and after the inner call:
 *   - URL, title, tab.id
 *   - Lightweight DOM fingerprint (node count, interactive count, hash)
 *   - Screenshot (opt-in, expensive)
 *   - New console errors/warnings captured since "before" by
 *     content/debug-console.js (MAIN-world, runs at document_start)
 *
 * Runtime contract:
 *   - `debug-console.js` must already be loaded in the MAIN world before
 *     this tool can read any console entries.
 *   - `stealth-main.js` must load first so `debug-console.js` can inherit
 *     the native-toString marker and stay non-fingerprintable.
 *   - The manifest must keep `proxy` and `declarativeNetRequest` granted
 *     at install time; they are part of the v2 stealth/debug runtime, not
 *     optional convenience permissions.
 *
 * The trace record is stored in chrome.storage.session under key
 * `__opensin_debug_trace`, keyed by sessionId. The Worker retrieves it
 * with debug.getTrace({ sessionId }) when it wants to ship the trace
 * to the audit log (e.g. after a RETRY-spiral exits).
 *
 * chrome.storage.session is chosen deliberately over storage.local:
 *   - Cleared on browser restart (we don't want to leak traces across
 *     boots)
 *   - Survives SW termination within one browser session (MV3 SWs get
 *     killed after ~30s idle; storage.session survives that)
 *   - No quota pressure because per-trace records are small when
 *     `captureScreenshot` is false.
 */

import { createLogger } from "../core/logger.js"
import * as Tabs from "../drivers/tabs.js"

const log = createLogger("tools.debug")

const STORAGE_KEY = "__opensin_debug_trace"
const MAX_RECORDS_PER_SESSION = 500
const DOM_FINGERPRINT_SCRIPT = `
  (function(){
    try {
      var nodes = document.querySelectorAll('*').length;
      var interactive = document.querySelectorAll(
        'a[href], button, input, select, textarea, [role="button"], [role="link"], [tabindex]'
      ).length;
      var bodyText = (document.body && document.body.innerText) || '';
      // Small stable hash — NOT cryptographic, just a diff signal.
      var h = 2166136261 >>> 0;
      for (var i = 0; i < bodyText.length; i++) {
        h = Math.imul(h ^ bodyText.charCodeAt(i), 16777619) >>> 0;
      }
      return {
        nodeCount: nodes,
        interactiveCount: interactive,
        bodyHash: h.toString(16).padStart(8, '0'),
        bodyLength: bodyText.length,
        url: document.location.href,
        title: document.title
      };
    } catch (e) {
      return { error: String(e && e.message || e) };
    }
  })();
`

// ----- tiny uuid without a dependency --------------------------------------

function randomId() {
  // 8 bytes = 16 hex chars. Enough to avoid collisions in one session.
  const a = new Uint8Array(8)
  crypto.getRandomValues(a)
  let s = ""
  for (let i = 0; i < a.length; i++) s += a[i].toString(16).padStart(2, "0")
  return s
}

// ----- storage helpers -----------------------------------------------------

async function readState() {
  if (!chrome.storage || !chrome.storage.session) return {}
  const out = await chrome.storage.session.get(STORAGE_KEY)
  return out[STORAGE_KEY] || {}
}

async function writeState(state) {
  if (!chrome.storage || !chrome.storage.session) return
  await chrome.storage.session.set({ [STORAGE_KEY]: state })
}

async function pushRecord(sessionId, record) {
  const state = await readState()
  if (!state.sessions) state.sessions = {}
  const s = state.sessions[sessionId]
  if (!s) {
    log.warn("trace record for unknown session", { sessionId })
    return
  }
  s.records.push(record)
  if (s.records.length > MAX_RECORDS_PER_SESSION) {
    s.records = s.records.slice(-MAX_RECORDS_PER_SESSION)
    s.truncated = true
  }
  s.lastUpdateAt = Date.now()
  await writeState(state)
}

// ----- core capture --------------------------------------------------------

async function captureFingerprint(tabId) {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: new Function("return " + DOM_FINGERPRINT_SCRIPT),
    })
    return (res && res.result) || null
  } catch (e) {
    log.warn("fingerprint failed", { error: String(e && e.message) })
    return { error: String(e && e.message) }
  }
}

async function captureConsoleBuffer(tabId, sinceSeq = 0) {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      args: [sinceSeq],
      func: (since) => {
        const w = window.__OPENSIN_DEBUG_CONSOLE__
        if (!w) return { available: false, entries: [] }
        const all = w.snapshot(w.capacity)
        const entries = all.filter((e) => e.seq > (since || 0))
        return { available: true, entries, lastSeq: all.length > 0 ? all[all.length - 1].seq : 0 }
      },
    })
    return (res && res.result) || { available: false, entries: [], lastSeq: 0 }
  } catch (e) {
    return { available: false, error: String(e && e.message), entries: [], lastSeq: 0 }
  }
}

async function captureScreenshot(tabId, format = "jpeg", quality = 60) {
  try {
    const tab = await chrome.tabs.get(tabId)
    if (!tab || !tab.windowId) return null
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format, quality })
    return { format, dataUrl }
  } catch (e) {
    return { error: String(e && e.message) }
  }
}

async function captureState(tabId, opts = {}) {
  const { screenshot = false, consoleSince = 0 } = opts
  const [fingerprint, consoleBuf, shot] = await Promise.all([
    captureFingerprint(tabId),
    captureConsoleBuffer(tabId, consoleSince),
    screenshot ? captureScreenshot(tabId) : Promise.resolve(null),
  ])
  return {
    timestamp: Date.now(),
    fingerprint: fingerprint || {},
    console: consoleBuf,
    screenshot: shot,
  }
}

function computeDiff(before, after) {
  const bf = (before && before.fingerprint) || {}
  const af = (after && after.fingerprint) || {}
  return {
    urlChanged: bf.url !== af.url,
    titleChanged: bf.title !== af.title,
    bodyChanged: bf.bodyHash !== af.bodyHash,
    nodesDelta: (af.nodeCount || 0) - (bf.nodeCount || 0),
    interactiveDelta: (af.interactiveCount || 0) - (bf.interactiveCount || 0),
    bodyLengthDelta: (af.bodyLength || 0) - (bf.bodyLength || 0),
    urlBefore: bf.url,
    urlAfter: af.url,
  }
}

// ----- public handlers -----------------------------------------------------

export function register(router) {
  router.register(
    "debug.startSession",
    async ({ label = "" } = {}) => {
      const sessionId = randomId()
      const state = await readState()
      if (!state.sessions) state.sessions = {}
      state.sessions[sessionId] = {
        sessionId,
        label,
        startedAt: Date.now(),
        lastUpdateAt: Date.now(),
        records: [],
        truncated: false,
      }
      await writeState(state)
      log.info("debug session started", { sessionId, label })
      return { sessionId, startedAt: state.sessions[sessionId].startedAt }
    },
    {
      description: "Start a new debug-trace session and get a sessionId",
      paramsSchema: { label: "string? — free-form tag for this session" },
    },
  )

  router.register(
    "debug.endSession",
    async ({ sessionId } = {}) => {
      if (!sessionId) throw new Error("sessionId required")
      const state = await readState()
      const s = state.sessions && state.sessions[sessionId]
      if (!s) return { ok: false, reason: "unknown sessionId" }
      s.endedAt = Date.now()
      await writeState(state)
      return { ok: true, records: s.records.length, endedAt: s.endedAt }
    },
  )

  router.register(
    "debug.snapshotState",
    async ({ tabId, screenshot = false } = {}) => {
      const id = await Tabs.resolveTabId(tabId)
      return captureState(id, { screenshot })
    },
    {
      description: "Capture url/title/DOM fingerprint/console state without executing anything",
    },
  )

  router.register(
    "debug.traceAction",
    async ({ sessionId, operation, tabId, screenshot = false, metadata } = {}, ctx) => {
      if (!operation || !operation.name) {
        throw new Error("operation.name required (e.g. { name: 'dom.click', args: {...} })")
      }
      const id = await Tabs.resolveTabId(tabId)
      const innerName = operation.name
      const innerArgs = { ...(operation.args || {}) }
      if (innerArgs.tabId == null) innerArgs.tabId = id

      const step = randomId()
      const startTime = Date.now()
      const before = await captureState(id, { screenshot })
      const sinceSeq = (before.console && before.console.lastSeq) || 0

      let result = null
      let error = null
      try {
        result = await router.invoke(innerName, innerArgs, ctx || { transport: "internal" })
      } catch (e) {
        error = { message: String(e && e.message), code: e && e.code, stack: e && e.stack }
      }

      const after = await captureState(id, { screenshot, consoleSince: sinceSeq })
      const durationMs = Date.now() - startTime
      const diff = computeDiff(before, after)
      const newConsole = (after.console && after.console.entries) || []

      const record = {
        step,
        timestamp: startTime,
        durationMs,
        operation: { name: innerName, args: innerArgs },
        metadata: metadata || null,
        tabId: id,
        result: error ? null : result,
        error,
        before: summarize(before),
        after: summarize(after),
        diff,
        newConsoleEntries: newConsole,
        screenshot: screenshot
          ? {
              before: before.screenshot && before.screenshot.dataUrl ? "<dataUrl-redacted-in-log>" : null,
              after: after.screenshot && after.screenshot.dataUrl ? "<dataUrl-redacted-in-log>" : null,
            }
          : null,
      }

      if (sessionId) await pushRecord(sessionId, record)

      // Return full payload including the base64 screenshot dataUrls if
      // the caller asked for screenshots. We redact only in the stored
      // record to keep storage.session small.
      return {
        ...record,
        screenshot: screenshot
          ? { before: before.screenshot, after: after.screenshot }
          : null,
      }
    },
    {
      description:
        "Wrap any router tool call with before/after state capture and optional screenshots. " +
        "Use { sessionId } to append into a persistent session, or omit it for a one-shot.",
    },
  )

  router.register(
    "debug.getTrace",
    async ({ sessionId, limit, sinceStep } = {}) => {
      const state = await readState()
      if (!sessionId) {
        return {
          sessions: Object.values(state.sessions || {}).map((s) => ({
            sessionId: s.sessionId,
            label: s.label,
            startedAt: s.startedAt,
            endedAt: s.endedAt,
            records: s.records.length,
            truncated: !!s.truncated,
          })),
        }
      }
      const s = state.sessions && state.sessions[sessionId]
      if (!s) return { sessionId, found: false }
      let records = s.records
      if (sinceStep) {
        const idx = records.findIndex((r) => r.step === sinceStep)
        if (idx >= 0) records = records.slice(idx + 1)
      }
      if (typeof limit === "number" && limit > 0) records = records.slice(-limit)
      return { sessionId, label: s.label, truncated: !!s.truncated, records }
    },
  )

  router.register("debug.clearTrace", async ({ sessionId } = {}) => {
    const state = await readState()
    if (!sessionId) {
      await writeState({ sessions: {} })
      return { ok: true, cleared: "all" }
    }
    if (state.sessions && state.sessions[sessionId]) {
      delete state.sessions[sessionId]
      await writeState(state)
    }
    return { ok: true, cleared: sessionId }
  })

  router.register(
    "debug.getConsoleErrors",
    async ({ tabId, limit = 50 } = {}) => {
      const id = await Tabs.resolveTabId(tabId)
      const buf = await captureConsoleBuffer(id, 0)
      if (!buf.available) return { available: false, entries: [] }
      const errors = buf.entries.filter((e) => e.level === "error").slice(-limit)
      return { available: true, total: buf.entries.length, errors }
    },
  )
}

// ----- helpers -------------------------------------------------------------

/** Strip large binary blobs from a state snapshot for storage/log use. */
function summarize(state) {
  if (!state) return state
  return {
    timestamp: state.timestamp,
    fingerprint: state.fingerprint,
    console: state.console
      ? {
          available: !!state.console.available,
          lastSeq: state.console.lastSeq,
          // Do NOT store full entries in the before/after summary —
          // the delta is already captured in newConsoleEntries.
          size: (state.console.entries || []).length,
        }
      : null,
  }
}
