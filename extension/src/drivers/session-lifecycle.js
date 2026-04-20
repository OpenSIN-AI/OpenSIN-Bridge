/**
 * Session lifecycle driver.
 *
 * Implements the Bridge-side counterpart of worker issue #71:
 *
 *   - explicit session manifest with TTL, origin scope, last-known-good
 *     state, and a classified invalidation reason
 *   - clear separation between session restore (we already have state for
 *     this origin) and login acquisition (we need to create state)
 *   - poisoned/stale session detection that fails closed
 *
 * Storage: chrome.storage.local under `openSin.session.manifests`. The
 * driver gracefully degrades to an in-memory map when the chrome API is
 * unavailable (test harness).
 */

const STORAGE_KEY = "openSin.session.manifests"
const DEFAULT_TTL_SECONDS = 60 * 60 * 12 // 12h
const MAX_MANIFESTS = 32

const memoryFallback = new Map()

function hasChromeStorage() {
  return typeof chrome !== "undefined" && chrome?.storage?.local
}

async function readAll() {
  if (!hasChromeStorage()) {
    const obj = {}
    for (const [k, v] of memoryFallback.entries()) obj[k] = v
    return obj
  }
  return new Promise((resolve) => {
    chrome.storage.local.get(STORAGE_KEY, (data) => {
      const stored = data?.[STORAGE_KEY]
      if (stored && typeof stored === "object" && !Array.isArray(stored)) resolve(stored)
      else resolve({})
    })
  })
}

async function writeAll(manifests) {
  if (!hasChromeStorage()) {
    memoryFallback.clear()
    for (const [k, v] of Object.entries(manifests)) memoryFallback.set(k, v)
    return
  }
  return new Promise((resolve) => {
    chrome.storage.local.set({ [STORAGE_KEY]: manifests }, () => resolve())
  })
}

function normalizeOrigin(origin) {
  if (typeof origin !== "string" || !origin.trim()) return null
  try {
    const url = new URL(origin.includes("://") ? origin : `https://${origin}`)
    return url.origin
  } catch {
    return null
  }
}

function nowMs() {
  return Date.now()
}

function freshManifest({ origin, tabId, ttlSeconds, source = "runtime", note = null }) {
  const ttl = Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? ttlSeconds : DEFAULT_TTL_SECONDS
  return {
    origin,
    tabId: typeof tabId === "number" ? tabId : null,
    createdAt: nowMs(),
    updatedAt: nowMs(),
    expiresAt: nowMs() + ttl * 1000,
    ttlSeconds: ttl,
    source,
    note,
    state: "active",
    invalidatedAt: null,
    invalidationReason: null,
    lastKnownGood: null,
    health: { status: "unknown", checkedAt: null },
  }
}

/**
 * Build (or refresh) a session manifest for an origin. Returns the manifest.
 */
export async function buildManifest({ origin, tabId = null, ttlSeconds, source = "runtime", note = null } = {}) {
  const normalizedOrigin = normalizeOrigin(origin)
  if (!normalizedOrigin) throw new Error("session.manifest: origin required")

  const all = await readAll()
  const existing = all[normalizedOrigin]
  const manifest = existing && existing.state === "active"
    ? { ...existing, updatedAt: nowMs(), tabId: tabId ?? existing.tabId, source, note: note ?? existing.note }
    : freshManifest({ origin: normalizedOrigin, tabId, ttlSeconds, source, note })

  if (Number.isFinite(ttlSeconds) && ttlSeconds > 0) {
    manifest.ttlSeconds = ttlSeconds
    manifest.expiresAt = nowMs() + ttlSeconds * 1000
  }

  all[normalizedOrigin] = manifest
  await writeAll(pruneManifests(all))
  return manifest
}

/**
 * Mark a manifest invalid. The reason is stored as a classified string so
 * later triage can scan for trends (e.g. "session_stale", "captcha_required",
 * "logged_out_remote").
 */
export async function invalidate({ origin, reason }) {
  const normalizedOrigin = normalizeOrigin(origin)
  if (!normalizedOrigin) throw new Error("session.invalidate: origin required")
  if (typeof reason !== "string" || !reason.trim()) {
    throw new Error("session.invalidate: reason required")
  }

  const all = await readAll()
  const existing = all[normalizedOrigin]
  if (!existing) {
    return { ok: false, reason: "no_manifest" }
  }

  // Promote the previous manifest snapshot to lastKnownGood iff it was active.
  const lastKnownGood = existing.state === "active"
    ? {
        capturedAt: existing.updatedAt,
        tabId: existing.tabId,
        ttlSeconds: existing.ttlSeconds,
      }
    : existing.lastKnownGood

  all[normalizedOrigin] = {
    ...existing,
    state: "invalid",
    invalidatedAt: nowMs(),
    invalidationReason: reason,
    lastKnownGood,
  }
  await writeAll(all)
  return { ok: true, reason }
}

/**
 * Return the most recent known-good manifest for an origin. Used by the
 * worker's "should I restore vs re-login" decision.
 */
export async function lastKnownGood({ origin }) {
  const normalizedOrigin = normalizeOrigin(origin)
  if (!normalizedOrigin) return null
  const all = await readAll()
  const manifest = all[normalizedOrigin]
  if (!manifest) return null
  return manifest.lastKnownGood || null
}

/**
 * Probe whether the active session for an origin is usable. Performs a
 * lightweight check (TTL + invalidation state). When the manifest is past
 * its TTL the state is silently downgraded to "stale" so the caller can
 * decide between "extend" and "reacquire".
 */
export async function health({ origin }) {
  const normalizedOrigin = normalizeOrigin(origin)
  if (!normalizedOrigin) {
    return { status: "unknown", reason: "invalid_origin" }
  }
  const all = await readAll()
  const manifest = all[normalizedOrigin]
  if (!manifest) {
    return { status: "absent", reason: "no_manifest" }
  }
  if (manifest.state === "invalid") {
    return {
      status: "invalid",
      reason: manifest.invalidationReason || "unspecified",
      invalidatedAt: manifest.invalidatedAt,
    }
  }
  if (manifest.expiresAt && manifest.expiresAt <= nowMs()) {
    manifest.state = "stale"
    manifest.health = { status: "stale", checkedAt: nowMs() }
    all[normalizedOrigin] = manifest
    await writeAll(all)
    return { status: "stale", reason: "ttl_expired", expiresAt: manifest.expiresAt }
  }
  return {
    status: "active",
    expiresAt: manifest.expiresAt,
    ttlSecondsRemaining: Math.max(0, Math.round((manifest.expiresAt - nowMs()) / 1000)),
  }
}

/**
 * Get the active manifest for an origin (or null).
 */
export async function getManifest({ origin }) {
  const normalizedOrigin = normalizeOrigin(origin)
  if (!normalizedOrigin) return null
  const all = await readAll()
  return all[normalizedOrigin] || null
}

/**
 * List manifests sorted by updatedAt desc.
 */
export async function listManifests() {
  const all = await readAll()
  return Object.values(all).sort((a, b) => (b?.updatedAt || 0) - (a?.updatedAt || 0))
}

/**
 * Drop a manifest (factory reset for a single origin).
 */
export async function dropManifest({ origin }) {
  const normalizedOrigin = normalizeOrigin(origin)
  if (!normalizedOrigin) return { ok: false, reason: "invalid_origin" }
  const all = await readAll()
  if (!(normalizedOrigin in all)) return { ok: false, reason: "no_manifest" }
  delete all[normalizedOrigin]
  await writeAll(all)
  return { ok: true }
}

function pruneManifests(all) {
  const entries = Object.entries(all)
  if (entries.length <= MAX_MANIFESTS) return all
  entries.sort(([, a], [, b]) => (a?.updatedAt || 0) - (b?.updatedAt || 0))
  while (entries.length > MAX_MANIFESTS) entries.shift()
  return Object.fromEntries(entries)
}

export const _internals = { normalizeOrigin, freshManifest, pruneManifests, STORAGE_KEY }

/**
 * Test-only reset.
 */
export function _resetForTests() {
  memoryFallback.clear()
}
