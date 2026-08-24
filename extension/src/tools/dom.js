/**
 * tools/dom.js — DOM automation tools.
 *
 * Delegates low-level work to the content script (isolated world), which owns
 * element resolution, ref registry, semantic snapshots, and CDP-backed input
 * is fronted by the service worker when required.
 *
 * Exposed tools:
 *   dom.snapshot, dom.click, dom.dblclick, dom.type, dom.fill, dom.select,
 *   dom.hover, dom.press, dom.scroll, dom.scrollIntoView, dom.focus, dom.blur,
 *   dom.getText, dom.getValue, dom.getAttribute, dom.getBoundingClientRect,
 *   dom.evaluate, dom.query, dom.queryAll, dom.screenshot, dom.fullSnapshot
 */

import { invariant } from "../core/errors.js"
import * as Tabs from "../drivers/tabs.js"
import { sendToTab } from "../drivers/tabs.js"

const defaultFrameOpts = ({ frameId = 0 } = {}) => ({ frameId })

function forward(type, extractor = (args) => args) {
  return async (args = {}) => {
    const id = await Tabs.resolveTabId(args.tabId)
    return sendToTab(id, { type, ...extractor(args) }, defaultFrameOpts(args))
  }
}

export function register(router) {
  router.register(
    "dom.snapshot",
    forward("dom.snapshot", ({ mode = "semantic", maxNodes = 2000, includeHidden = false } = {}) => ({
      mode,
      maxNodes,
      includeHidden,
    })),
  )

  router.register(
    "dom.fullSnapshot",
    forward("dom.fullSnapshot", ({ maxNodes = 5000 } = {}) => ({ maxNodes })),
  )

  router.register(
    "dom.click",
    forward("dom.click", (args) => {
      invariant(args.selector || args.ref, "selector or ref required", "INVALID_ARGS")
      return {
        selector: args.selector,
        ref: args.ref,
        button: args.button || "left",
        clickCount: args.clickCount || 1,
        modifiers: args.modifiers || [],
        force: !!args.force,
        human: args.human !== false,
        timeoutMs: args.timeoutMs || 10_000,
      }
    }),
  )

  router.register(
    "dom.dblclick",
    forward("dom.click", (args) => ({
      selector: args.selector,
      ref: args.ref,
      button: "left",
      clickCount: 2,
      modifiers: args.modifiers || [],
      force: !!args.force,
      human: args.human !== false,
      timeoutMs: args.timeoutMs || 10_000,
    })),
  )

  router.register(
    "dom.type",
    forward("dom.type", (args) => {
      invariant(typeof args.text === "string", "text required", "INVALID_ARGS")
      return {
        selector: args.selector,
        ref: args.ref,
        text: args.text,
        delayMs: args.delayMs,
        replace: !!args.replace,
        pressEnter: !!args.pressEnter,
        human: args.human !== false,
        timeoutMs: args.timeoutMs || 10_000,
      }
    }),
  )

  router.register(
    "dom.fill",
    forward("dom.fill", (args) => {
      invariant(args.fields && typeof args.fields === "object", "fields required", "INVALID_ARGS")
      return {
        fields: args.fields,
        submit: !!args.submit,
        human: args.human !== false,
        timeoutMs: args.timeoutMs || 15_000,
      }
    }),
  )

  router.register(
    "dom.select",
    forward("dom.select", (args) => ({
      selector: args.selector,
      ref: args.ref,
      value: args.value,
      label: args.label,
      index: args.index,
      multiple: args.multiple,
    })),
  )

  router.register(
    "dom.hover",
    forward("dom.hover", (args) => ({ selector: args.selector, ref: args.ref })),
  )

  router.register(
    "dom.focus",
    forward("dom.focus", (args) => ({ selector: args.selector, ref: args.ref })),
  )

  router.register(
    "dom.blur",
    forward("dom.blur", (args) => ({ selector: args.selector, ref: args.ref })),
  )

  router.register(
    "dom.press",
    forward("dom.press", (args) => {
      invariant(typeof args.key === "string", "key required", "INVALID_ARGS")
      return {
        key: args.key,
        modifiers: args.modifiers || [],
        selector: args.selector,
        ref: args.ref,
      }
    }),
  )

  router.register(
    "dom.scroll",
    forward("dom.scroll", (args) => ({
      x: args.x,
      y: args.y,
      selector: args.selector,
      ref: args.ref,
      behavior: args.behavior || "smooth",
    })),
  )

  router.register(
    "dom.scrollIntoView",
    forward("dom.scrollIntoView", (args) => ({
      selector: args.selector,
      ref: args.ref,
      block: args.block || "center",
    })),
  )

  router.register(
    "dom.getText",
    forward("dom.getText", (args) => ({ selector: args.selector, ref: args.ref })),
  )

  router.register(
    "dom.getValue",
    forward("dom.getValue", (args) => ({ selector: args.selector, ref: args.ref })),
  )

  router.register(
    "dom.getAttribute",
    forward("dom.getAttribute", (args) => ({
      selector: args.selector,
      ref: args.ref,
      name: args.name,
    })),
  )

  router.register(
    "dom.getBoundingClientRect",
    forward("dom.getBoundingClientRect", (args) => ({
      selector: args.selector,
      ref: args.ref,
    })),
  )

  router.register(
    "dom.query",
    forward("dom.query", (args) => ({ selector: args.selector })),
  )

  router.register(
    "dom.queryAll",
    forward("dom.queryAll", (args) => ({ selector: args.selector, limit: args.limit || 100 })),
  )

  router.register(
    "dom.evaluate",
    forward("dom.evaluate", (args) => ({
      expression: args.expression,
      args: args.args,
      awaitPromise: args.awaitPromise !== false,
      returnByValue: args.returnByValue !== false,
    })),
  )

  router.register("dom.screenshot", async (args = {}) => {
    const { tabId, format = "png", quality = 90, fullPage = false } = args
    const id = await Tabs.resolveTabId(tabId)
    if (!fullPage) {
      const tab = await Tabs.get(id)
      const windowId = tab?.windowId
      const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format, quality })
      return { dataUrl, width: null, height: null }
    }
    // Fullpage capture via CDP Page.captureScreenshot with captureBeyondViewport.
    const CDP = await import("../drivers/cdp.js")
    await CDP.attach(id)
    const res = await CDP.send(id, "Page.captureScreenshot", {
      format,
      quality: format === "jpeg" ? quality : undefined,
      captureBeyondViewport: true,
      fromSurface: true,
    })
    return { dataUrl: `data:image/${format};base64,${res.data}` }
  })
}
