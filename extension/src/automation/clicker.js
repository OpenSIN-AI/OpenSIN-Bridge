/**
 * Multi-strategy clicker + verifier.
 *
 * Real-world click reliability is a noisy problem. The clicker tries strategies
 * in a deterministic order, capturing before/after snapshots so the caller can
 * prove the click actually changed the page. Strategies:
 *
 *   1. `cdp_mouse`  - CDP pointer events (most realistic; survives overlays)
 *   2. `dom_click`  - synthetic MouseEvents + HTMLElement.click() (handles
 *                    React synthetic handlers, even when CDP is blocked)
 *   3. `dom_dispatch` - synthetic MouseEvents only (last-resort dispatch path)
 *
 * Evidence (DOM diff, URL/title change, pixel-level visual delta) is stored
 * and retrievable via getInteractionProof().
 */

import * as cdp from '../drivers/cdp.js';
import * as human from './human.js';
import { capture, getRef, setLastSnapshot } from './snapshot.js';
import { SNAPSHOT } from '../core/config.js';
import { BridgeError, ERROR_CODES } from '../core/errors.js';
import { sleep, cheapHash } from '../core/utils.js';
import { logger } from '../core/logger.js';

const log = logger('clicker');

const proofs = new Map();
let proofCounter = 0;

function summarizeDom(tree) {
  if (typeof tree !== 'string') return { lines: 0, hash: '' };
  return { lines: tree.split('\n').filter(Boolean).length, hash: cheapHash(tree) };
}

function diffDom(beforeTree, afterTree) {
  if (beforeTree === afterTree) return { changed: false, addedCount: 0, removedCount: 0 };
  const beforeLines = new Set(beforeTree.split('\n'));
  const afterLines = new Set(afterTree.split('\n'));
  let added = 0;
  let removed = 0;
  for (const line of afterLines) if (!beforeLines.has(line)) added += 1;
  for (const line of beforeLines) if (!afterLines.has(line)) removed += 1;
  return { changed: added > 0 || removed > 0, addedCount: added, removedCount: removed };
}

function diffVisual(before, after, minRatio) {
  if (!before || !after) return null;
  if (before === after) return { changed: false, ratio: 0 };
  const lengthDelta = Math.abs(before.length - after.length);
  const ratio = before.length === 0 ? 1 : lengthDelta / before.length;
  return {
    changed: ratio >= minRatio,
    ratio: Number(ratio.toFixed(6)),
    beforeHash: cheapHash(before.slice(0, 4096)),
    afterHash: cheapHash(after.slice(0, 4096)),
  };
}

async function executeCdpMouse(ref) {
  const { model } = await cdp.send(ref.tabId, 'DOM.getBoxModel', { backendNodeId: ref.backendDOMNodeId });
  if (!model) throw new BridgeError(ERROR_CODES.CDP_FAILED, 'DOM.getBoxModel returned no model');
  const target = human.pointFromBorder(model.border);
  const settled = await human.click(ref.tabId, target);
  return { success: true, strategy: 'cdp_mouse', position: settled };
}

const DOM_CLICK_FN = `async function(){
  const element = this;
  if (!element) return { success: false, reason: 'missing-element' };
  const rect = typeof element.getBoundingClientRect === 'function' ? element.getBoundingClientRect() : null;
  if (!rect || rect.width <= 0 || rect.height <= 0) return { success: false, reason: 'invalid-rect' };
  if (typeof element.scrollIntoView === 'function') element.scrollIntoView({ block: 'center', inline: 'center' });
  if (typeof element.focus === 'function') element.focus({ preventScroll: true });

  const centerX = (rect.left + rect.right) / 2;
  const centerY = (rect.top + rect.bottom) / 2;
  const jitterX = Math.min(5, Math.max(1, rect.width / 4));
  const jitterY = Math.min(5, Math.max(1, rect.height / 4));
  const destination = {
    x: Math.round(centerX + (Math.random() * 2 - 1) * jitterX),
    y: Math.round(centerY + (Math.random() * 2 - 1) * jitterY),
  };

  const send = (type, extra = {}) => element.dispatchEvent(new MouseEvent(type, {
    bubbles: true, cancelable: true, composed: true,
    clientX: destination.x, clientY: destination.y,
    button: extra.button ?? 0, buttons: extra.buttons ?? 0, detail: extra.detail ?? 1,
  }));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  send('mouseover');
  await sleep(24 + Math.random() * 48);
  send('mousedown', { buttons: 1 });
  await sleep(55 + Math.random() * 95);
  send('mouseup');
  await sleep(18 + Math.random() * 42);
  if (typeof element.click === 'function') element.click();
  else send('click');

  return { success: true, strategy: 'dom_click', tagName: element.tagName || null, textPreview: (element.innerText || element.textContent || '').trim().slice(0, 120) };
}`;

const DOM_DISPATCH_FN = DOM_CLICK_FN.replace('if (typeof element.click === \'function\') element.click();\n  else send(\'click\');', "send('click');").replace('dom_click', 'dom_dispatch');

async function executeDomStrategy(ref, functionDeclaration) {
  const resolved = await cdp.send(ref.tabId, 'DOM.resolveNode', { backendNodeId: ref.backendDOMNodeId });
  const objectId = resolved?.object?.objectId;
  if (!objectId) throw new BridgeError(ERROR_CODES.CDP_FAILED, 'Failed to resolve target DOM node');

  const result = await cdp.send(ref.tabId, 'Runtime.callFunctionOn', {
    objectId,
    functionDeclaration,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });

  if (result.exceptionDetails) {
    throw new BridgeError(
      ERROR_CODES.CDP_FAILED,
      result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'DOM click failed',
    );
  }

  return result.result?.value || { success: true };
}

async function runStrategy(ref, strategy) {
  try {
    await cdp.send(ref.tabId, 'DOM.scrollIntoViewIfNeeded', { backendNodeId: ref.backendDOMNodeId });
  } catch (_error) {
    // Some elements cannot be scrolled (e.g. detached nodes). Continue anyway.
  }

  if (strategy === 'cdp_mouse') return executeCdpMouse(ref);
  if (strategy === 'dom_click') return executeDomStrategy(ref, DOM_CLICK_FN);
  if (strategy === 'dom_dispatch') return executeDomStrategy(ref, DOM_DISPATCH_FN);
  throw new BridgeError(ERROR_CODES.INVALID_INPUT, `Unknown strategy: ${strategy}`);
}

function storeProof(proof) {
  proofCounter += 1;
  const proofId = `proof-${proofCounter}`;
  const stored = { ...proof, proofId };
  proofs.set(proofId, stored);
  while (proofs.size > SNAPSHOT.maxStoredProofs) {
    const oldest = proofs.keys().next().value;
    if (!oldest) break;
    proofs.delete(oldest);
  }
  return stored;
}

function summarizeProof(proof) {
  const attempts = (proof.attempts || []).map((attempt) => ({
    strategy: attempt.strategy,
    durationMs: attempt.durationMs,
    fallbackTriggered: attempt.fallbackTriggered,
    assessment: attempt.assessment,
    error: attempt.execution?.error || null,
  }));
  const last = attempts[attempts.length - 1] || null;
  return {
    proofId: proof.proofId,
    ref: proof.ref,
    attempts,
    fallbackTriggered: attempts.some((attempt) => attempt.fallbackTriggered),
    noOpDetected: attempts.some((attempt) => !attempt.assessment?.changed),
    finalChanged: !!last?.assessment?.changed,
    strategiesTried: attempts.map((attempt) => attempt.strategy),
    createdAt: proof.createdAt,
  };
}

/**
 * Perform a ref-targeted click with self-verifying evidence. Returns an
 * operator-friendly summary plus a `proofId` for drilling into attempts.
 */
export async function clickRef(refId, {
  strategies = ['cdp_mouse', 'dom_click', 'dom_dispatch'],
  settleDelayMs = SNAPSHOT.settleDelayMs,
  minVisualChangeRatio = SNAPSHOT.minVisualChangeRatio,
} = {}) {
  const ref = getRef(refId);
  if (!ref) throw new BridgeError(ERROR_CODES.NOT_FOUND, `Unknown ref: ${refId}. Run snapshot first.`);

  const attempts = [];
  let before = await capture(ref.tabId, { includeScreenshot: true });
  setLastSnapshot(before);

  for (let index = 0; index < strategies.length; index += 1) {
    const strategy = strategies[index];
    const startedAt = Date.now();
    let execution = null;
    try {
      execution = await runStrategy(ref, strategy);
    } catch (error) {
      execution = { success: false, error: error.message, strategy };
    }

    if (settleDelayMs > 0) await sleep(settleDelayMs);

    const after = await capture(ref.tabId, { includeScreenshot: true });
    const domDiff = diffDom(before.tree, after.tree);
    const visualDiff = diffVisual(before.screenshotDataUrl, after.screenshotDataUrl, minVisualChangeRatio);
    const urlChanged = before.url !== after.url;
    const titleChanged = before.title !== after.title;
    const assessment = {
      changed: domDiff.changed || !!visualDiff?.changed || urlChanged || titleChanged,
      domDiff,
      visualDiff,
      urlChanged,
      titleChanged,
      beforeSummary: summarizeDom(before.tree),
      afterSummary: summarizeDom(after.tree),
    };

    attempts.push({
      strategy,
      fallbackTriggered: index > 0,
      durationMs: Date.now() - startedAt,
      execution,
      assessment,
      artifacts: { before, after },
    });

    before = after;
    setLastSnapshot(after);

    if (!execution?.error && assessment.changed) break;
  }

  const storedProof = storeProof({
    createdAt: new Date().toISOString(),
    ref: { refId, role: ref.role, name: ref.name, tabId: ref.tabId },
    attempts,
  });
  const summary = summarizeProof(storedProof);
  const lastAttempt = attempts[attempts.length - 1];

  log.info('click_ref', {
    refId,
    finalChanged: summary.finalChanged,
    strategiesTried: summary.strategiesTried,
    noOpDetected: summary.noOpDetected,
  });

  return {
    success: summary.finalChanged,
    ref: refId,
    role: ref.role,
    name: ref.name,
    proofId: storedProof.proofId,
    proof: summary,
    noOpDetected: summary.noOpDetected,
    fallbackTriggered: summary.fallbackTriggered,
    strategiesTried: summary.strategiesTried,
    ...(lastAttempt?.execution?.error ? { error: lastAttempt.execution.error } : {}),
  };
}

export function getInteractionProof(proofId, { includeArtifacts = false } = {}) {
  const proof = proofs.get(proofId);
  if (!proof) throw new BridgeError(ERROR_CODES.NOT_FOUND, `Unknown proofId: ${proofId}`);

  if (!includeArtifacts) return summarizeProof(proof);
  return {
    ...summarizeProof(proof),
    attempts: proof.attempts.map((attempt) => ({
      strategy: attempt.strategy,
      durationMs: attempt.durationMs,
      fallbackTriggered: attempt.fallbackTriggered,
      assessment: attempt.assessment,
      execution: attempt.execution,
      artifacts: attempt.artifacts,
    })),
  };
}
