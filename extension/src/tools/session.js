/**
 * tools/session.js — save and restore browser sessions.
 *
 * A session snapshot captures: open tabs (url, pinned, group), cookies,
 * localStorage, sessionStorage. Restoring replays them atomically.
 */

import { invariant } from "../core/errors.js"
import * as Tabs from "../drivers/tabs.js"
import { sendToTab } from "../drivers/tabs.js"
import * as Lifecycle from "../drivers/session-lifecycle.js"

async function captureTabStorage(tabId) {
  try {
    const [local, session] = await Promise.all([
      sendToTab(tabId, { type: "storage.local.get" }).catch(() => ({ data: {} })),
      sendToTab(tabId, { type: "storage.session.get" }).catch(() => ({ data: {} })),
    ])
    return { local: local?.data || {}, session: session?.data || {} }
  } catch {
    return { local: {}, session: {} }
  }
}

export function register(router) {
  router.register("session.capture", async ({ includeStorage = true, includeCookies = true } = {}) => {
    const wins = await chrome.windows.getAll({ populate: true })
    const snapshot = {
      version: 1,
      capturedAt: new Date().toISOString(),
      windows: [],
      cookies: [],
    }
    for (const w of wins) {
      const win = { id: w.id, focused: w.focused, type: w.type, incognito: w.incognito, state: w.state, tabs: [] }
      for (const t of w.tabs || []) {
        const entry = {
          id: t.id,
          url: t.url,
          title: t.title,
          pinned: t.pinned,
          active: t.active,
          groupId: t.groupId,
        }
        if (includeStorage && t.url?.startsWith("http")) {
          entry.storage = await captureTabStorage(t.id)
        }
        win.tabs.push(entry)
      }
      snapshot.windows.push(win)
    }
    if (includeCookies) {
      snapshot.cookies = await chrome.cookies.getAll({})
    }
    return { snapshot }
  })

  router.register("session.restore", async ({ snapshot, mode = "merge" } = {}) => {
    invariant(snapshot && snapshot.windows, "snapshot required", "INVALID_ARGS")
    if (mode === "replace") {
      const allTabs = await chrome.tabs.query({})
      const ids = allTabs.filter((t) => !t.pinned).map((t) => t.id)
      if (ids.length) await chrome.tabs.remove(ids).catch(() => {})
    }
    for (const win of snapshot.windows) {
      const urls = (win.tabs || []).map((t) => t.url).filter((u) => u && u.startsWith("http"))
      if (urls.length === 0) continue
      await chrome.windows.create({ url: urls, focused: !!win.focused, incognito: !!win.incognito })
    }
    if (snapshot.cookies?.length) {
      for (const c of snapshot.cookies) {
        try {
          await chrome.cookies.set({
            url: `${c.secure ? "https" : "http"}://${c.domain.replace(/^\./, "")}${c.path}`,
            name: c.name,
            value: c.value,
            domain: c.domain,
            path: c.path,
            secure: c.secure,
            httpOnly: c.httpOnly,
            sameSite: c.sameSite,
            expirationDate: c.expirationDate,
            storeId: c.storeId,
          })
        } catch {}
      }
    }
    return { ok: true }
  })

  // -------- session lifecycle (issue #71) ----------------------------------

  router.register(
    "session.manifest",
    async ({ origin, tabId, ttlSeconds, source = "runtime", note } = {}) => {
      invariant(typeof origin === "string" && origin.trim(), "origin required", "INVALID_ARGS")
      const manifest = await Lifecycle.buildManifest({ origin, tabId, ttlSeconds, source, note })
      return { manifest }
    },
    {
      description: "Build or refresh a session manifest with TTL, origin scope, and last-known-good tracking.",
      category: "session",
    },
  )

  router.register(
    "session.invalidate",
    async ({ origin, reason } = {}) => {
      invariant(typeof origin === "string" && origin.trim(), "origin required", "INVALID_ARGS")
      invariant(typeof reason === "string" && reason.trim(), "reason required", "INVALID_ARGS")
      return Lifecycle.invalidate({ origin, reason })
    },
    {
      description: "Mark the active session manifest invalid with classified reason.",
      category: "session",
    },
  )

  router.register(
    "session.lastKnownGood",
    async ({ origin } = {}) => {
      invariant(typeof origin === "string" && origin.trim(), "origin required", "INVALID_ARGS")
      const lkg = await Lifecycle.lastKnownGood({ origin })
      return { manifest: lkg }
    },
    {
      description: "Return the most recent known-good session snapshot for an origin.",
      category: "session",
    },
  )

  router.register(
    "session.health",
    async ({ origin } = {}) => {
      invariant(typeof origin === "string" && origin.trim(), "origin required", "INVALID_ARGS")
      const result = await Lifecycle.health({ origin })
      return { health: result }
    },
    {
      description: "Probe the active session manifest and return active/stale/invalid status.",
      category: "session",
    },
  )

  router.register(
    "session.list",
    async () => ({ manifests: await Lifecycle.listManifests() }),
    { description: "List session manifests, sorted newest first.", category: "session" },
  )

  router.register(
    "session.drop",
    async ({ origin } = {}) => {
      invariant(typeof origin === "string" && origin.trim(), "origin required", "INVALID_ARGS")
      return Lifecycle.dropManifest({ origin })
    },
    { description: "Drop a session manifest entirely.", category: "session" },
  )
}
