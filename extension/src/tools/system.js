/**
 * tools/system.js — extension and runtime info.
 */

import { CONFIG } from "../core/config.js"
import * as State from "../core/state.js"

export function register(router) {
  router.register("system.ping", async () => ({ ok: true, t: Date.now() }))

  router.register("system.version", async () => {
    const manifest = chrome.runtime.getManifest()
    return { version: manifest.version, name: manifest.name, bridge: CONFIG.version }
  })

  router.register("system.capabilities", async () => {
    const manifest = chrome.runtime.getManifest()
    return {
      version: CONFIG.version,
      manifestVersion: manifest.manifest_version,
      permissions: manifest.permissions || [],
      hostPermissions: manifest.host_permissions || [],
      tools: router.list(),
    }
  })

  router.register("system.health", async () => {
    return State.health()
  })

  router.register("system.clipboard.read", async () => {
    // Offscreen document required to read clipboard in MV3.
    const offscreen = await import("../drivers/offscreen.js")
    return offscreen.request({ type: "clipboard.read" })
  })

  router.register("system.clipboard.write", async ({ text } = {}) => {
    const offscreen = await import("../drivers/offscreen.js")
    return offscreen.request({ type: "clipboard.write", text })
  })

  router.register(
    "system.notify",
    async ({ title = "OpenSIN Bridge", message = "", iconUrl, type = "basic" } = {}) => {
      // chrome.notifications needs an absolute URL. Default to the packaged
      // 128px icon (filename must match manifest.json -> icons).
      const resolved = iconUrl || chrome.runtime.getURL("icons/icon128.png")
      return new Promise((resolve, reject) => {
        try {
          chrome.notifications.create("", { type, iconUrl: resolved, title, message }, (id) => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message))
            else resolve({ id })
          })
        } catch (e) {
          reject(e)
        }
      })
    },
  )

  router.register("system.downloads.start", async ({ url, filename, saveAs = false } = {}) => {
    const id = await chrome.downloads.download({ url, filename, saveAs })
    return { downloadId: id }
  })

  router.register("system.downloads.list", async (query = {}) => {
    const items = await chrome.downloads.search(query)
    return { items }
  })
}
