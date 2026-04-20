/**
 * Evidence bundle assembler.
 *
 * Implements the Bridge-side counterpart of worker issue #70:
 * a deterministic, machine-readable evidence bundle that any failed run
 * can attach for triage. It composes existing bridge capabilities
 * (snapshot, screenshot, network buffer, behavior timeline) into one
 * envelope keyed by a trace ID.
 *
 * The bundle deliberately keeps payloads bounded (truncation, max-N
 * lists) so an evidence dump never explodes the service worker.
 */

import { getRecentDispatches } from "./trace.js"

export const EVIDENCE_SCHEMA = "opensin.bridge.evidence-bundle/v1"

const MAX_NETWORK_EVENTS = 50
const MAX_BEHAVIOR_EVENTS = 100
const MAX_DOM_NODES = 600

/**
 * Attempt to invoke a router method, returning either { ok: true, value }
 * or { ok: false, error: { code, message } } so a partial failure of one
 * subsystem does not poison the whole bundle.
 */
async function safeInvoke(router, method, params, context) {
  if (!router || !router.has || !router.has(method)) {
    return { ok: false, error: { code: "unsupported", message: `method ${method} not registered` } }
  }
  try {
    const result = await router.invoke(method, params || {}, context || {})
    return { ok: true, value: result }
  } catch (error) {
    return {
      ok: false,
      error: {
        code: typeof error?.code === "string" ? error.code : "internal_error",
        message: error?.message || String(error),
      },
    }
  }
}

/**
 * Build an evidence bundle for a tab. Every section is best-effort.
 * Failures in subsystems are reported under `bundle.errors` instead of
 * throwing, so the bundle is still useful when the tab is half-broken
 * (which is the most common case at failure time).
 */
export async function buildEvidenceBundle({
  router,
  context = {},
  tabId = null,
  traceId = null,
  includeScreenshot = true,
  maxNetworkEvents = MAX_NETWORK_EVENTS,
  maxBehaviorEvents = MAX_BEHAVIOR_EVENTS,
  maxDomNodes = MAX_DOM_NODES,
} = {}) {
  const startedAt = Date.now()
  const bundle = {
    schema: EVIDENCE_SCHEMA,
    generatedAt: new Date().toISOString(),
    traceId: traceId || null,
    tabId: typeof tabId === "number" ? tabId : null,
    sections: {},
    errors: [],
    notes: [],
  }

  // Tab metadata
  const tabRes = await safeInvoke(router, "tabs.get", { tabId }, context)
  if (tabRes.ok) bundle.sections.tab = tabRes.value
  else bundle.errors.push({ section: "tab", ...tabRes.error })

  // DOM snapshot (semantic, bounded)
  const snapshotRes = await safeInvoke(
    router,
    "dom.snapshot",
    { tabId, mode: "semantic", maxNodes: maxDomNodes },
    context,
  )
  if (snapshotRes.ok) bundle.sections.snapshot = snapshotRes.value
  else bundle.errors.push({ section: "snapshot", ...snapshotRes.error })

  // Screenshot (optional, bounded by includeScreenshot)
  if (includeScreenshot) {
    const shotRes = await safeInvoke(
      router,
      "dom.screenshot",
      { tabId, format: "png", fullPage: false },
      context,
    )
    if (shotRes.ok) {
      bundle.sections.screenshot = {
        format: "png",
        dataUrlLength: typeof shotRes.value?.dataUrl === "string" ? shotRes.value.dataUrl.length : 0,
        dataUrl: shotRes.value?.dataUrl || null,
      }
    } else {
      bundle.errors.push({ section: "screenshot", ...shotRes.error })
    }
  }

  // Network events
  const netRes = await safeInvoke(
    router,
    "net.events",
    { tabId, limit: maxNetworkEvents },
    context,
  )
  if (netRes.ok) {
    const events = Array.isArray(netRes.value?.events) ? netRes.value.events : []
    bundle.sections.network = { count: events.length, events: events.slice(-maxNetworkEvents) }
  } else {
    bundle.errors.push({ section: "network", ...netRes.error })
  }

  // Recent dispatches (command history) — pulled from the in-memory trace ring
  const dispatches = getRecentDispatches({ traceId, limit: 100 })
  bundle.sections.commandHistory = { count: dispatches.length, items: dispatches }

  // Behavior timeline (bounded). Behavior subsystem may not be recording.
  const behaviorStatusRes = await safeInvoke(router, "behavior.status", {}, context)
  if (behaviorStatusRes.ok) {
    bundle.sections.behavior = { status: behaviorStatusRes.value }
    const sessionId = behaviorStatusRes.value?.sessionId || null
    if (sessionId) {
      const sessionRes = await safeInvoke(router, "behavior.get", { sessionId }, context)
      if (sessionRes.ok) {
        const events = Array.isArray(sessionRes.value?.session?.events) ? sessionRes.value.session.events : []
        bundle.sections.behavior.sessionId = sessionId
        bundle.sections.behavior.eventCount = events.length
        bundle.sections.behavior.events = events.slice(-maxBehaviorEvents)
      }
    }
  } else {
    bundle.notes.push("behavior subsystem unavailable")
  }

  // Stealth posture (best effort)
  const stealthRes = await safeInvoke(router, "stealth.status", {}, context)
  if (stealthRes.ok) bundle.sections.stealth = stealthRes.value
  else bundle.notes.push("stealth status unavailable")

  bundle.assembledMs = Date.now() - startedAt
  return bundle
}
