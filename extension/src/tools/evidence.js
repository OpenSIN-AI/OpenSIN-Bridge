/**
 * tools/evidence.js — `bridge.evidenceBundle`.
 *
 * Worker issue #70 demands every failed live run produce a complete
 * evidence bundle. This tool composes existing bridge capabilities into
 * one bounded JSON envelope keyed by a trace ID.
 */

import { buildEvidenceBundle } from "../drivers/evidence.js"
import { ensureTraceId, getRecentDispatches } from "../drivers/trace.js"

export function register(router) {
  router.register(
    "bridge.evidenceBundle",
    async (params = {}, ctx = {}) => {
      const traceId = ensureTraceId({ params, context: ctx })
      const bundle = await buildEvidenceBundle({
        router,
        context: { ...ctx, traceId },
        tabId: typeof params.tabId === "number" ? params.tabId : null,
        traceId,
        includeScreenshot: params.includeScreenshot !== false,
        maxNetworkEvents: typeof params.maxNetworkEvents === "number" ? params.maxNetworkEvents : 50,
        maxBehaviorEvents: typeof params.maxBehaviorEvents === "number" ? params.maxBehaviorEvents : 100,
        maxDomNodes: typeof params.maxDomNodes === "number" ? params.maxDomNodes : 600,
      })
      return { traceId, bundle }
    },
    {
      description: "Assemble a forensic evidence bundle (snapshot, screenshot, network, behavior, command history).",
      category: "bridge",
    },
  )

  router.register(
    "bridge.traces",
    async ({ traceId, limit = 50 } = {}) => {
      const items = getRecentDispatches({ traceId, limit })
      return { count: items.length, items }
    },
    {
      description: "Return recent RPC dispatches, optionally filtered by trace ID.",
      category: "bridge",
    },
  )
}
