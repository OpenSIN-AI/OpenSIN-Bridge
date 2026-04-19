/**
 * Human-entropy primitives shared by every interaction strategy.
 *
 * Anti-bot systems fingerprint trajectories and per-event timing; a pointer
 * that teleports to the exact geometric centre of every button is the first
 * thing a scoring model flags. These helpers add bounded jitter so sequential
 * interactions look like a noisy human cursor.
 */

import * as cdp from '../drivers/cdp.js';
import { HUMAN } from '../core/config.js';
import { sleep, randomBetween, randomInt, clamp } from '../core/utils.js';

const pointerState = new Map();

/**
 * Pick a landing point from a CDP DOM.getBoxModel `border` polygon.
 */
export function pointFromBorder(border, maxJitterPx = HUMAN.pointerJitterPx) {
  const xs = [border[0], border[2], border[4], border[6]];
  const ys = [border[1], border[3], border[5], border[7]];
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const width = Math.max(1, maxX - minX);
  const height = Math.max(1, maxY - minY);
  const centerX = minX + width / 2;
  const centerY = minY + height / 2;
  const jitterX = Math.min(maxJitterPx, Math.max(1, width / 4));
  const jitterY = Math.min(maxJitterPx, Math.max(1, height / 4));

  return {
    x: Math.round(clamp(centerX + randomBetween(-jitterX, jitterX), minX + 1, maxX - 1)),
    y: Math.round(clamp(centerY + randomBetween(-jitterY, jitterY), minY + 1, maxY - 1)),
    bounds: { minX, maxX, minY, maxY },
  };
}

function startPoint(tabId, target) {
  const last = pointerState.get(tabId);
  if (last) return { x: last.x, y: last.y };
  return {
    x: Math.round(target.x + randomBetween(-36, 36)),
    y: Math.round(target.y + randomBetween(-24, 24)),
  };
}

/**
 * Move the CDP pointer along a short approach path.
 */
export async function movePointer(tabId, target) {
  const start = startPoint(tabId, target);
  const steps = randomInt(HUMAN.pointerApproachSteps.min, HUMAN.pointerApproachSteps.max);
  const { bounds } = target;

  for (let step = 1; step <= steps; step += 1) {
    const progress = step / steps;
    const residual = 2.5 * (1 - progress);
    const x = Math.round(start.x + (target.x - start.x) * progress + randomBetween(-residual, residual));
    const y = Math.round(start.y + (target.y - start.y) * progress + randomBetween(-residual, residual));
    const point = {
      x: clamp(x, Math.min(bounds.minX, start.x) - 48, Math.max(bounds.maxX, start.x) + 48),
      y: clamp(y, Math.min(bounds.minY, start.y) - 48, Math.max(bounds.maxY, start.y) + 48),
    };

    await cdp.send(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: point.x,
      y: point.y,
    });
    pointerState.set(tabId, point);
    await sleep(randomInt(HUMAN.perStepDelayMs.min, HUMAN.perStepDelayMs.max));
  }

  pointerState.set(tabId, { x: target.x, y: target.y });
  return { x: target.x, y: target.y };
}

export async function hover(tabId, target) {
  const settled = await movePointer(tabId, target);
  await sleep(randomInt(80, 180));
  return settled;
}

export async function click(tabId, target, { button = 'left' } = {}) {
  const settled = await movePointer(tabId, target);

  await sleep(randomInt(HUMAN.preClickDelayMs.min, HUMAN.preClickDelayMs.max));
  await cdp.send(tabId, 'Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: settled.x,
    y: settled.y,
    button,
    clickCount: 1,
  });

  await sleep(randomInt(HUMAN.pressHoldMs.min, HUMAN.pressHoldMs.max));
  await cdp.send(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: settled.x,
    y: settled.y,
    button,
    clickCount: 1,
  });

  await sleep(randomInt(HUMAN.postReleaseMs.min, HUMAN.postReleaseMs.max));
  return settled;
}

/**
 * Insert text with timing that looks like actual keystrokes.
 */
export async function typeText(tabId, text, { delayMs = null } = {}) {
  if (!text) return;
  for (const char of String(text)) {
    await cdp.send(tabId, 'Input.insertText', { text: char });
    const interval = delayMs != null
      ? delayMs
      : randomInt(HUMAN.keystrokeDelayMs.min, HUMAN.keystrokeDelayMs.max);
    await sleep(interval);
  }
}

export function forgetPointer(tabId) {
  pointerState.delete(tabId);
}

/**
 * Select-all + backspace for CDP-targeted inputs.
 */
export async function clearInput(tabId) {
  const modifiers = 2; // Ctrl on all platforms for CDP dispatch
  await cdp.send(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers });
  await cdp.send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers });
  await cdp.send(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace' });
  await cdp.send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace' });
}
