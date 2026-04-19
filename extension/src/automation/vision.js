/**
 * Vision client: multi-provider fallback chain.
 *
 * Zero hard-coded keys. API keys come from chrome.storage.local via core/state.
 * Callers pick semantic functions (describePage, findElement) instead of poking
 * at the provider layer directly.
 */

import { VISION } from '../core/config.js';
import { getVisionKeys } from '../core/state.js';
import { BridgeError, ERROR_CODES } from '../core/errors.js';
import { executeInTab } from '../drivers/tabs.js';
import * as cdp from '../drivers/cdp.js';
import { logger } from '../core/logger.js';
import { captureScreenshot } from './snapshot.js';

const log = logger('vision');

function stripFences(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed.startsWith('```')) return trimmed;
  return trimmed.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/, '').trim();
}

async function callGemini({ model, base64, prompt, apiKey, jsonOutput }) {
  const url = VISION.endpoints.gemini.replace('{model}', encodeURIComponent(model)).replace('{apiKey}', apiKey);
  const body = {
    contents: [{ parts: [{ inlineData: { mimeType: 'image/png', data: base64 } }, { text: prompt }] }],
  };
  if (jsonOutput) body.generationConfig = { responseMimeType: 'application/json' };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`gemini ${response.status}: ${text.slice(0, 200)}`);
  }
  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || null;
}

async function callGroq({ model, base64, prompt, apiKey, jsonOutput }) {
  const body = {
    model,
    max_tokens: 4096,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:image/png;base64,${base64}` } },
          { type: 'text', text: prompt },
        ],
      },
    ],
  };
  if (jsonOutput) body.response_format = { type: 'json_object' };

  const response = await fetch(VISION.endpoints.groq, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`groq ${response.status}: ${text.slice(0, 200)}`);
  }
  const data = await response.json();
  return data.choices?.[0]?.message?.content || null;
}

/**
 * Run the fallback chain until a provider returns a non-empty result.
 */
export async function runVision({ base64, prompt, jsonOutput = false }) {
  const keys = getVisionKeys();
  if (!keys.gemini && !keys.groq) {
    throw new BridgeError(
      ERROR_CODES.VISION_UNAVAILABLE,
      'No vision API keys configured. Set them via the options page or set_vision_keys tool.',
    );
  }

  const errors = [];
  for (const entry of VISION.chain) {
    const apiKey = keys[entry.provider];
    if (!apiKey) continue;
    try {
      const text = entry.provider === 'gemini'
        ? await callGemini({ model: entry.model, base64, prompt, apiKey, jsonOutput })
        : await callGroq({ model: entry.model, base64, prompt, apiKey, jsonOutput });
      if (!text) {
        errors.push({ provider: entry.provider, model: entry.model, error: 'empty response' });
        continue;
      }
      log.info('vision ok', { provider: entry.provider, model: entry.model });
      return { provider: entry.provider, model: entry.model, text };
    } catch (error) {
      errors.push({ provider: entry.provider, model: entry.model, error: String(error?.message || error).slice(0, 200) });
      log.warn('vision miss', { provider: entry.provider, model: entry.model, message: error?.message });
    }
  }

  throw new BridgeError(ERROR_CODES.VISION_UNAVAILABLE, 'All vision providers failed', { errors });
}

/**
 * Convenience: take a fresh screenshot + run a JSON-producing prompt.
 */
export async function runVisionOnTab(tabId, prompt, { jsonOutput = true } = {}) {
  const dataUrl = await captureScreenshot(tabId, { format: 'png' });
  const base64 = dataUrl.split(',', 2)[1] || dataUrl;
  return runVision({ base64, prompt, jsonOutput });
}

export async function getViewport(tabId) {
  try {
    const result = await executeInTab(tabId, () => ({
      w: window.innerWidth,
      h: window.innerHeight,
      dpr: window.devicePixelRatio,
    }), []);
    if (result) return result;
  } catch (_error) {
    // ignore and fall through to CDP
  }
  try {
    const response = await cdp.send(tabId, 'Runtime.evaluate', {
      expression: 'JSON.stringify({ w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio })',
      returnByValue: true,
    });
    return JSON.parse(response.result?.value || '{}');
  } catch (_error) {
    return { w: 1920, h: 1080, dpr: 1 };
  }
}

export { stripFences };
