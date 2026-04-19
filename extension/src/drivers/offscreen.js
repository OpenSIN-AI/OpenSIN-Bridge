/**
 * drivers/offscreen.js — manages the offscreen document for DOM parsing,
 * clipboard, and audio where a DOM is needed in MV3.
 */

import { deadline } from "../core/utils.js"
import { BridgeError } from "../core/errors.js"

const OFFSCREEN_URL = chrome.runtime.getURL("src/offscreen/offscreen.html")

let creating = null

async function ensure() {
  if (!chrome.offscreen) throw new BridgeError("offscreen API not available", "UNSUPPORTED")
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] })
  if (contexts.length > 0) return
  if (creating) return creating
  creating = chrome.offscreen
    .createDocument({
      url: OFFSCREEN_URL,
      reasons: ["CLIPBOARD", "DOM_PARSER"],
      justification: "Clipboard access and DOM parsing for automation tools",
    })
    .finally(() => {
      creating = null
    })
  return creating
}

export async function request(payload, timeoutMs = 10_000) {
  await ensure()
  const resp = await deadline(
    chrome.runtime.sendMessage({ target: "offscreen", ...payload }),
    timeoutMs,
    "offscreen timeout",
  )
  if (resp?.error) throw new BridgeError(resp.error, resp.code || "OFFSCREEN_ERROR")
  return resp
}

export async function close() {
  try {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] })
    if (contexts.length > 0) await chrome.offscreen.closeDocument()
  } catch {}
}
