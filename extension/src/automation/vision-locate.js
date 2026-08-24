/**
 * automation/vision-locate.js — high-level visual locate helper.
 *
 * Wraps the raw provider chain in `vision.js` with a JSON-structured prompt
 * and returns pixel coordinates plus confidence. If no viewport info is
 * available, we pass the screenshot as-is — Chrome captures already match the
 * visible viewport.
 */

import { runVision, stripFences } from "./vision.js"
import { BridgeError, ERROR_CODES } from "../core/errors.js"
import { logger } from "../core/logger.js"

const log = logger("vision-locate")

const LOCATE_PROMPT = `You are a precise UI locator. Given a screenshot and an instruction,
respond with ONLY a compact JSON object:
{"x": <int>, "y": <int>, "confidence": <0..1>, "reason": "short"}
where x,y are pixel coordinates INSIDE the visible viewport that target the
centre of the element described. If the element is not visible, respond
{"x": null, "y": null, "confidence": 0, "reason": "not visible"}.`

const TRANSCRIBE_PROMPT = `Transcribe the visible text in the screenshot accurately.
Respond with ONLY JSON: {"text": "<transcript>"}`

function extractJson(text) {
  const cleaned = stripFences(text || "").trim()
  try {
    return JSON.parse(cleaned)
  } catch (_e) {
    // Try to salvage a JSON object substring.
    const match = cleaned.match(/\{[\s\S]*\}/)
    if (!match) return null
    try {
      return JSON.parse(match[0])
    } catch (_e2) {
      return null
    }
  }
}

/**
 * Locate a UI element described by `prompt` inside a screenshot (dataUrl).
 * Returns { x, y, confidence, provider, model } or throws VISION_UNAVAILABLE.
 */
export async function locate({ dataUrl, prompt, region }) {
  if (!dataUrl || !prompt) {
    throw new BridgeError(ERROR_CODES.INVALID_INPUT, "dataUrl and prompt required")
  }
  const base64 = dataUrl.split(",", 2)[1] || dataUrl
  const fullPrompt = region
    ? `${LOCATE_PROMPT}\n\nTarget: ${prompt}\nRegion (px): ${JSON.stringify(region)}`
    : `${LOCATE_PROMPT}\n\nTarget: ${prompt}`

  const { provider, model, text } = await runVision({ base64, prompt: fullPrompt, jsonOutput: true })
  const parsed = extractJson(text)
  if (!parsed || typeof parsed !== "object") {
    log.warn("vision.locate produced non-JSON reply", { provider, model, sample: String(text).slice(0, 200) })
    throw new BridgeError(ERROR_CODES.VISION_UNAVAILABLE, "Vision model returned unparseable response")
  }
  return {
    x: Number.isFinite(parsed.x) ? Math.round(parsed.x) : null,
    y: Number.isFinite(parsed.y) ? Math.round(parsed.y) : null,
    confidence: Number.isFinite(parsed.confidence) ? parsed.confidence : null,
    reason: parsed.reason ?? null,
    text: typeof parsed.text === "string" ? parsed.text : null,
    provider,
    model,
  }
}

/**
 * Pure transcription helper. Separate from locate() so callers don't rely on
 * a coordinate-shaped response.
 */
export async function transcribe({ dataUrl }) {
  if (!dataUrl) throw new BridgeError(ERROR_CODES.INVALID_INPUT, "dataUrl required")
  const base64 = dataUrl.split(",", 2)[1] || dataUrl
  const { provider, model, text } = await runVision({ base64, prompt: TRANSCRIBE_PROMPT, jsonOutput: true })
  const parsed = extractJson(text)
  return { text: parsed?.text ?? "", provider, model }
}
