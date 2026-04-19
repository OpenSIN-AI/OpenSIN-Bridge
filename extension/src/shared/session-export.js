/**
 * Serialise a session (network events + webRequest events + timeline markers)
 * into a deterministic JSON envelope that downstream replay/export tooling
 * consumes.
 */

export function buildSessionExport({
  sessionId = null,
  startedAt = Date.now(),
  tabId = null,
  frameUrl = null,
  networkEvents = [],
  webRequestEvents = [],
  behaviorEvents = [],
}) {
  return {
    schemaVersion: 1,
    sessionId: sessionId || `session-${startedAt}`,
    startedAt,
    tabId,
    frameUrl,
    exportedAt: Date.now(),
    networkEvents: Array.isArray(networkEvents) ? networkEvents : [],
    webRequestEvents: Array.isArray(webRequestEvents) ? webRequestEvents : [],
    behaviorEvents: Array.isArray(behaviorEvents) ? behaviorEvents : [],
    counts: {
      network: Array.isArray(networkEvents) ? networkEvents.length : 0,
      webRequests: Array.isArray(webRequestEvents) ? webRequestEvents.length : 0,
      behavior: Array.isArray(behaviorEvents) ? behaviorEvents.length : 0,
    },
  };
}
