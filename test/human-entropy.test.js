/**
 * ==============================================================================
 * OpenSIN Component: human-entropy.test.js
 * ==============================================================================
 *
 * DESCRIPTION / BESCHREIBUNG:
 * Static regression tests for the extension service worker's human-entropy
 * interaction paths.
 *
 * WHY IT EXISTS / WARUM ES EXISTIERT:
 * Issue #14 showed that one remaining raw instant click path could survive even
 * after partial hardening. These tests lock in the requirement that every
 * relevant click/hover/vision handler routes through the shared human-entropy
 * helpers instead of dispatching deterministic instant clicks inline.
 *
 * RULES / REGELN:
 * 1. Verify helper-based routing, not hand-wavy assumptions.
 * 2. Fail loudly when raw CDP click primitives reappear in handlers.
 * 3. Keep the assertions readable so future coders can extend them safely.
 *
 * CONSEQUENCES / KONSEQUENZEN:
 * If these tests fail, the service worker may have regressed back to bot-like
 * interaction behavior that is easier for anti-automation systems to detect.
 *
 * AUTHOR: SIN-Zeus / A2A Fleet
 * ==============================================================================
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const serviceWorkerPath = path.join(__dirname, '..', 'extension', 'background', 'service_worker.js');
const serviceWorkerSource = fs.readFileSync(serviceWorkerPath, 'utf8');

function sliceBetween(startNeedle, endNeedle) {
  const startIndex = serviceWorkerSource.indexOf(startNeedle);
  assert.notStrictEqual(startIndex, -1, `Missing start needle: ${startNeedle}`);

  const endIndex = endNeedle
    ? serviceWorkerSource.indexOf(endNeedle, startIndex)
    : serviceWorkerSource.length;

  assert.notStrictEqual(endIndex, -1, `Missing end needle: ${endNeedle}`);
  return serviceWorkerSource.slice(startIndex, endIndex);
}

describe('human entropy interaction hardening', () => {
  it('keeps raw CDP mouse press/release primitives inside the shared helper only', () => {
    const pressedMatches = serviceWorkerSource.match(/type:\s*'mousePressed'/g) || [];
    const releasedMatches = serviceWorkerSource.match(/type:\s*'mouseReleased'/g) || [];
    const movedMatches = serviceWorkerSource.match(/type:\s*'mouseMoved'/g) || [];

    // WHY: The shared helper is the single allowed place where low-level CDP
    // mouse events should exist. Any additional occurrences usually mean a new,
    // unreviewed raw click path slipped into a handler.
    assert.strictEqual(pressedMatches.length, 1, 'Expected exactly one shared mousePressed helper path');
    assert.strictEqual(releasedMatches.length, 1, 'Expected exactly one shared mouseReleased helper path');
    assert.strictEqual(movedMatches.length, 1, 'Expected exactly one shared mouseMoved helper path');
  });

  it('routes DOM click handlers through the shared page-context entropy helper', () => {
    const clickElementBlock = sliceBetween("reg('click_element'", "reg('type_text'");
    const shadowClickBlock = sliceBetween("reg('click_shadow_element'", "// --- IFRAME INTERACTION");
    const turnstileBlock = sliceBetween("reg('bypass_cloudflare_turnstile'", "// --- CAPTCHA DETECTION");
    const recaptchaBlock = sliceBetween("reg('solve_recaptcha_checkbox'", "// --- IFRAME INTERACTION");

    for (const [name, block] of [
      ['click_element', clickElementBlock],
      ['click_shadow_element', shadowClickBlock],
      ['bypass_cloudflare_turnstile', turnstileBlock],
      ['solve_recaptcha_checkbox', recaptchaBlock],
    ]) {
      assert.match(block, /runHumanEntropyDomInteraction/, `${name} must use the shared DOM entropy helper`);
      assert.doesNotMatch(block, /\.click\(\)|mousePressed|mouseReleased/, `${name} must not inline raw click primitives`);
    }
  });

  it('routes iframe and visual handlers through shared entropy-aware helpers', () => {
    const iframeBlock = sliceBetween("reg('interact_iframe'", "// --- COOKIE PERSISTENCE");
    const hoverRefBlock = sliceBetween("reg('hover_ref'", "// TOOL REGISTRATION: screenshot_annotated");
    const visionClickBlock = sliceBetween("reg('vision_click'", "// --- Vision Type");
    const visionTypeBlock = sliceBetween("reg('vision_type'", "// --- Vision Extract");
    const cdpStrategyBlock = sliceBetween('async function executeCdpMouseStrategy', 'async function executeDomClickStrategy');

    assert.match(iframeBlock, /runHumanEntropyDomInteraction/, 'Iframe click path must use the DOM entropy helper');
    assert.match(hoverRefBlock, /humanEntropyHoverCdp/, 'hover_ref must use the shared hover helper');
    assert.match(visionClickBlock, /humanEntropyClickCdp/, 'vision_click must use the shared click helper');
    assert.match(visionTypeBlock, /humanEntropyClickCdp/, 'vision_type must use the shared click helper');
    assert.match(cdpStrategyBlock, /humanEntropyClickCdp/, 'Observed reference clicks must use the shared CDP click helper');

    assert.doesNotMatch(visionClickBlock, /mousePressed|mouseReleased|mouseMoved/, 'vision_click must not inline raw CDP mouse events');
    assert.doesNotMatch(visionTypeBlock, /mousePressed|mouseReleased|mouseMoved/, 'vision_type must not inline raw CDP mouse events');
    assert.doesNotMatch(hoverRefBlock, /mouseMoved/, 'hover_ref must not inline raw CDP movement');
  });
});
