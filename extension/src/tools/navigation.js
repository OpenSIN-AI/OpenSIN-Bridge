/**
 * tools/navigation.js — navigation, waits, history, load-state.
 *
 * Exposed tools:
 *   nav.goto, nav.back, nav.forward, nav.reload,
 *   nav.waitForLoad, nav.waitForURL, nav.waitForSelector, nav.waitForNetworkIdle
 */

import { BridgeError, invariant } from "../core/errors.js"
import * as Tabs from "../drivers/tabs.js"
import * as CDP from "../drivers/cdp.js"
import { sendToTab } from "../drivers/tabs.js"
import { deadline, sleep } from "../core/utils.js"

export function register(router) {
  router.register(
    "nav.goto",
    async ({ tabId, url, waitUntil = "load", timeoutMs = 30_000, referrer } = {}) => {
      invariant(typeof url === "string" && url.length > 0, "url required", "INVALID_ARGS")
      const id = await Tabs.resolveTabId(tabId)

      // Use CDP Page.navigate so we get a frameId and can wait for lifecycle events.
      let frameId
      try {
        await CDP.attach(id)
        const res = await CDP.send(id, "Page.navigate", { url, referrer: referrer ?? undefined })
        if (res?.errorText) throw new BridgeError(res.errorText, "NAVIGATION_FAILED")
        frameId = res?.frameId
      } catch {
        // Fallback to tabs.update if debugger attach denied.
        await chrome.tabs.update(id, { url })
      }

      if (waitUntil === "none") return { ok: true, tabId: id }
      if (waitUntil === "load" || waitUntil === "complete") {
        await Tabs.waitForComplete(id, timeoutMs)
      } else if (waitUntil === "domcontentloaded") {
        await deadline(
          new Promise((resolve) => {
            const listener = (tid, info) => {
              if (tid === id && (info.status === "loading" || info.status === "complete")) {
                chrome.tabs.onUpdated.removeListener(listener)
                resolve()
              }
            }
            chrome.tabs.onUpdated.addListener(listener)
          }),
          timeoutMs,
          "navigation (domcontentloaded) timed out",
        )
      } else if (waitUntil === "networkidle") {
        await Tabs.waitForComplete(id, timeoutMs)
        // Let content settle briefly (heuristic network-idle).
        await sleep(400)
      }

      const tab = await Tabs.get(id)
      return { ok: true, tabId: id, url: tab?.url, title: tab?.title, frameId }
    },
  )

  router.register("nav.back", async ({ tabId } = {}) => {
    const id = await Tabs.resolveTabId(tabId)
    await chrome.tabs.goBack(id).catch(async () => {
      await sendToTab(id, { type: "nav.back" }).catch(() => {})
    })
    return { ok: true }
  })

  router.register("nav.forward", async ({ tabId } = {}) => {
    const id = await Tabs.resolveTabId(tabId)
    await chrome.tabs.goForward(id).catch(async () => {
      await sendToTab(id, { type: "nav.forward" }).catch(() => {})
    })
    return { ok: true }
  })

  router.register("nav.reload", async ({ tabId, bypassCache = false } = {}) => {
    const id = await Tabs.resolveTabId(tabId)
    await Tabs.reload(id, { bypassCache })
    return { ok: true }
  })

  router.register("nav.waitForLoad", async ({ tabId, timeoutMs = 30_000 } = {}) => {
    const id = await Tabs.resolveTabId(tabId)
    await Tabs.waitForComplete(id, timeoutMs)
    const tab = await Tabs.get(id)
    return { ok: true, url: tab?.url }
  })

  router.register(
    "nav.waitForURL",
    async ({ tabId, match, timeoutMs = 30_000, pollMs = 150 } = {}) => {
      invariant(match, "match required (string or regex string)", "INVALID_ARGS")
      const id = await Tabs.resolveTabId(tabId)
      const re = match instanceof RegExp ? match : new RegExp(match)
      const start = Date.now()
      while (Date.now() - start < timeoutMs) {
        const tab = await Tabs.get(id)
        if (tab?.url && re.test(tab.url)) return { ok: true, url: tab.url }
        await sleep(pollMs)
      }
      throw new BridgeError("nav.waitForURL timeout", "TIMEOUT")
    },
  )

  router.register(
    "nav.waitForSelector",
    async ({ tabId, selector, state = "visible", timeoutMs = 10_000 } = {}) => {
      const id = await Tabs.resolveTabId(tabId)
      invariant(typeof selector === "string", "selector required", "INVALID_ARGS")
      const res = await sendToTab(id, {
        type: "dom.waitForSelector",
        selector,
        state,
        timeoutMs,
      })
      return res
    },
  )

  router.register(
    "nav.waitForNetworkIdle",
    async ({ tabId, idleMs = 500, timeoutMs = 15_000 } = {}) => {
      const id = await Tabs.resolveTabId(tabId)
      // Simple heuristic: wait for tab complete then idle period.
      await Tabs.waitForComplete(id, timeoutMs)
      await sleep(idleMs)
      return { ok: true }
    },
  )
}
