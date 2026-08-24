/**
 * tools/tabs.js — tab lifecycle management tools.
 *
 * Exposed tools:
 *   tabs.list, tabs.get, tabs.create, tabs.activate,
 *   tabs.close, tabs.reload, tabs.duplicate, tabs.move,
 *   tabs.groups.list, tabs.groups.create, tabs.windows.list, tabs.windows.create
 */

import { asError, invariant } from "../core/errors.js"
import * as Tabs from "../drivers/tabs.js"
import { createLogger } from "../core/logger.js"

const log = createLogger("tools.tabs")

function shape(tab) {
  if (!tab) return null
  return {
    id: tab.id,
    windowId: tab.windowId,
    groupId: tab.groupId,
    index: tab.index,
    url: tab.url,
    title: tab.title,
    active: tab.active,
    pinned: tab.pinned,
    audible: tab.audible,
    mutedInfo: tab.mutedInfo,
    status: tab.status,
    favIconUrl: tab.favIconUrl,
  }
}

export function register(router) {
  router.register("tabs.list", async ({ windowId, currentWindow, active } = {}) => {
    const query = {}
    if (typeof windowId === "number") query.windowId = windowId
    if (currentWindow) query.currentWindow = true
    if (typeof active === "boolean") query.active = active
    const tabs = await Tabs.query(query)
    return { tabs: tabs.map(shape) }
  })

  router.register("tabs.get", async ({ tabId } = {}) => {
    const id = await Tabs.resolveTabId(tabId)
    const tab = await Tabs.get(id)
    return { tab: shape(tab) }
  })

  router.register(
    "tabs.create",
    async ({ url, active = true, pinned = false, windowId, index, openerTabId, waitForLoad = false } = {}) => {
      const tab = await Tabs.create({ url, active, pinned, windowId, index, openerTabId })
      if (waitForLoad) {
        await Tabs.waitForComplete(tab.id, 30_000)
      }
      return { tab: shape(await Tabs.get(tab.id)) }
    },
  )

  router.register("tabs.activate", async ({ tabId } = {}) => {
    const id = await Tabs.resolveTabId(tabId)
    await Tabs.update(id, { active: true })
    const tab = await Tabs.get(id)
    if (tab?.windowId) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {})
    return { tab: shape(tab) }
  })

  router.register("tabs.close", async ({ tabIds } = {}) => {
    invariant(Array.isArray(tabIds) && tabIds.length > 0, "tabIds is required", "INVALID_ARGS")
    await Tabs.remove(tabIds)
    return { closed: tabIds.length }
  })

  router.register("tabs.reload", async ({ tabId, bypassCache = false } = {}) => {
    const id = await Tabs.resolveTabId(tabId)
    await Tabs.reload(id, { bypassCache })
    return { ok: true }
  })

  router.register("tabs.duplicate", async ({ tabId } = {}) => {
    const id = await Tabs.resolveTabId(tabId)
    const tab = await chrome.tabs.duplicate(id)
    return { tab: shape(tab) }
  })

  router.register("tabs.move", async ({ tabId, index, windowId } = {}) => {
    const id = await Tabs.resolveTabId(tabId)
    const opts = {}
    if (typeof index === "number") opts.index = index
    if (typeof windowId === "number") opts.windowId = windowId
    const tab = await chrome.tabs.move(id, opts)
    return { tab: shape(Array.isArray(tab) ? tab[0] : tab) }
  })

  router.register("tabs.groups.list", async ({ windowId } = {}) => {
    try {
      const groups = await chrome.tabGroups.query(typeof windowId === "number" ? { windowId } : {})
      return { groups }
    } catch (e) {
      log.warn("tabGroups unavailable", asError(e))
      return { groups: [] }
    }
  })

  router.register("tabs.groups.create", async ({ tabIds, title, color } = {}) => {
    invariant(Array.isArray(tabIds) && tabIds.length > 0, "tabIds required", "INVALID_ARGS")
    const groupId = await chrome.tabs.group({ tabIds })
    const update = {}
    if (title) update.title = title
    if (color) update.color = color
    if (Object.keys(update).length) await chrome.tabGroups.update(groupId, update)
    return { groupId }
  })

  router.register("tabs.windows.list", async () => {
    const wins = await chrome.windows.getAll({ populate: false })
    return { windows: wins }
  })

  router.register("tabs.windows.create", async ({ url, focused = true, incognito = false, type = "normal" } = {}) => {
    const win = await chrome.windows.create({ url, focused, incognito, type })
    return { window: win }
  })
}
