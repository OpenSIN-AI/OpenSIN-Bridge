/**
 * tools/vision.js — pixel-space automation helpers.
 *
 * Captures a screenshot, asks the configured vision model (Groq/OpenAI/Gemini
 * via user's own API key or via a relay) to locate an element described in
 * natural language, then clicks at those pixel coordinates with CDP Input.
 */

import { invariant, BridgeError } from "../core/errors.js"
import * as Tabs from "../drivers/tabs.js"
import * as CDP from "../drivers/cdp.js"
import { locate, transcribe } from "../automation/vision-locate.js"

export function register(router) {
  router.register("vision.locate", async ({ tabId, prompt } = {}) => {
    invariant(prompt, "prompt required", "INVALID_ARGS")
    const id = await Tabs.resolveTabId(tabId)
    const tab = await Tabs.get(id)
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" })
    const res = await locate({ dataUrl, prompt })
    return res
  })

  router.register("vision.click", async ({ tabId, prompt, button = "left", human = true } = {}) => {
    invariant(prompt, "prompt required", "INVALID_ARGS")
    const id = await Tabs.resolveTabId(tabId)
    const tab = await Tabs.get(id)
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" })
    const loc = await locate({ dataUrl, prompt })
    if (!loc?.x || !loc?.y) throw new BridgeError("Element not located", "NOT_FOUND")

    await CDP.attach(id)
    // Move + click sequence for realism.
    await CDP.send(id, "Input.dispatchMouseEvent", { type: "mouseMoved", x: loc.x, y: loc.y })
    await CDP.send(id, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: loc.x,
      y: loc.y,
      button,
      clickCount: 1,
    })
    if (human) await new Promise((r) => setTimeout(r, 60 + Math.random() * 80))
    await CDP.send(id, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: loc.x,
      y: loc.y,
      button,
      clickCount: 1,
    })
    return { ok: true, x: loc.x, y: loc.y, confidence: loc.confidence ?? null }
  })

  router.register("vision.read", async ({ tabId } = {}) => {
    const id = await Tabs.resolveTabId(tabId)
    const tab = await Tabs.get(id)
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" })
    const res = await transcribe({ dataUrl })
    return { text: res?.text || "", provider: res?.provider, model: res?.model }
  })
}
