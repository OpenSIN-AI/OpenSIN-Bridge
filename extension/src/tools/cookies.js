/**
 * tools/cookies.js — cookie read/write via chrome.cookies.
 */

import { invariant } from "../core/errors.js"

export function register(router) {
  router.register("cookies.get", async ({ url, name, storeId } = {}) => {
    invariant(url && name, "url and name required", "INVALID_ARGS")
    const c = await chrome.cookies.get({ url, name, storeId })
    return { cookie: c }
  })

  router.register("cookies.getAll", async ({ url, domain, name, path, secure, session, storeId } = {}) => {
    const filter = {}
    if (url) filter.url = url
    if (domain) filter.domain = domain
    if (name) filter.name = name
    if (path) filter.path = path
    if (typeof secure === "boolean") filter.secure = secure
    if (typeof session === "boolean") filter.session = session
    if (storeId) filter.storeId = storeId
    const cookies = await chrome.cookies.getAll(filter)
    return { cookies }
  })

  router.register("cookies.set", async (cookie = {}) => {
    invariant(cookie.url, "url required", "INVALID_ARGS")
    const c = await chrome.cookies.set(cookie)
    return { cookie: c }
  })

  router.register("cookies.remove", async ({ url, name, storeId } = {}) => {
    invariant(url && name, "url and name required", "INVALID_ARGS")
    const res = await chrome.cookies.remove({ url, name, storeId })
    return { removed: res }
  })

  router.register("cookies.stores", async () => {
    const stores = await chrome.cookies.getAllCookieStores()
    return { stores }
  })

  router.register("cookies.clearForDomain", async ({ domain, storeId } = {}) => {
    invariant(typeof domain === "string" && domain, "domain required", "INVALID_ARGS")
    const filter = { domain }
    if (storeId) filter.storeId = storeId
    const all = await chrome.cookies.getAll(filter)
    let removed = 0
    for (const c of all) {
      const url = `${c.secure ? "https" : "http"}://${c.domain.replace(/^\./, "")}${c.path || "/"}`
      try {
        await chrome.cookies.remove({ url, name: c.name, storeId: c.storeId })
        removed++
      } catch {
        // Ignore — cookie might already be gone or pinned by the browser.
      }
    }
    return { removed, total: all.length }
  })
}
