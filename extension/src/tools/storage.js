/**
 * tools/storage.js — localStorage, sessionStorage, indexedDB access.
 *
 * Runs in the page context of the target tab.
 */

import { invariant } from "../core/errors.js"
import * as Tabs from "../drivers/tabs.js"
import { sendToTab } from "../drivers/tabs.js"

function forward(type) {
  return async ({ tabId, frameId = 0, ...payload } = {}) => {
    const id = await Tabs.resolveTabId(tabId)
    return sendToTab(id, { type, ...payload }, { frameId })
  }
}

export function register(router) {
  router.register("storage.local.get", forward("storage.local.get"))
  router.register("storage.local.set", async (args) => {
    invariant(args?.key, "key required", "INVALID_ARGS")
    return forward("storage.local.set")(args)
  })
  router.register("storage.local.remove", forward("storage.local.remove"))
  router.register("storage.local.clear", forward("storage.local.clear"))
  router.register("storage.local.keys", forward("storage.local.keys"))

  router.register("storage.session.get", forward("storage.session.get"))
  router.register("storage.session.set", forward("storage.session.set"))
  router.register("storage.session.remove", forward("storage.session.remove"))
  router.register("storage.session.clear", forward("storage.session.clear"))
  router.register("storage.session.keys", forward("storage.session.keys"))

  router.register("storage.idb.databases", forward("storage.idb.databases"))
  router.register("storage.idb.read", forward("storage.idb.read"))

  router.register("storage.ext.get", async ({ keys, area = "local" } = {}) => {
    const data = await chrome.storage[area].get(keys)
    return { data }
  })

  router.register("storage.ext.set", async ({ data, area = "local" } = {}) => {
    await chrome.storage[area].set(data || {})
    return { ok: true }
  })

  router.register("storage.ext.remove", async ({ keys, area = "local" } = {}) => {
    await chrome.storage[area].remove(keys)
    return { ok: true }
  })
}
