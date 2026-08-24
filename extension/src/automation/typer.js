/**
 * Typing + selection primitives that operate through CDP so focus/keyboard
 * events look native to page-level JS frameworks.
 */

import * as cdp from '../drivers/cdp.js';
import * as human from './human.js';
import { getRef } from './snapshot.js';
import { BridgeError, ERROR_CODES } from '../core/errors.js';

export async function typeRef(refId, text, { clear = true } = {}) {
  if (typeof text !== 'string') {
    throw new BridgeError(ERROR_CODES.INVALID_INPUT, 'text must be a string');
  }

  const ref = getRef(refId);
  if (!ref) throw new BridgeError(ERROR_CODES.NOT_FOUND, `Unknown ref: ${refId}. Run snapshot first.`);

  await cdp.send(ref.tabId, 'DOM.scrollIntoViewIfNeeded', { backendNodeId: ref.backendDOMNodeId });
  await cdp.send(ref.tabId, 'DOM.focus', { backendNodeId: ref.backendDOMNodeId });

  if (clear) await human.clearInput(ref.tabId);
  await human.typeText(ref.tabId, text);

  return { success: true, ref: refId, text, role: ref.role, name: ref.name };
}

export async function selectRef(refId, { value, index } = {}) {
  if (value === undefined && index === undefined) {
    throw new BridgeError(ERROR_CODES.INVALID_INPUT, 'value or index is required');
  }
  const ref = getRef(refId);
  if (!ref) throw new BridgeError(ERROR_CODES.NOT_FOUND, `Unknown ref: ${refId}. Run snapshot first.`);

  const resolved = await cdp.send(ref.tabId, 'DOM.resolveNode', { backendNodeId: ref.backendDOMNodeId });
  const objectId = resolved?.object?.objectId;
  if (!objectId) throw new BridgeError(ERROR_CODES.CDP_FAILED, 'Failed to resolve DOM node for select');

  const body = value !== undefined
    ? `function(val){ this.value = val; this.dispatchEvent(new Event('input', { bubbles: true })); this.dispatchEvent(new Event('change', { bubbles: true })); return this.value; }`
    : `function(idx){ this.selectedIndex = Number(idx); this.dispatchEvent(new Event('change', { bubbles: true })); return this.value; }`;

  const result = await cdp.send(ref.tabId, 'Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: body,
    arguments: [value !== undefined ? { value: String(value) } : { value: Number(index) }],
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });

  if (result.exceptionDetails) {
    throw new BridgeError(
      ERROR_CODES.CDP_FAILED,
      result.exceptionDetails.exception?.description || 'select failed',
    );
  }

  return { success: true, ref: refId, selectedValue: result.result?.value };
}

export async function hoverRef(refId) {
  const ref = getRef(refId);
  if (!ref) throw new BridgeError(ERROR_CODES.NOT_FOUND, `Unknown ref: ${refId}. Run snapshot first.`);

  const { model } = await cdp.send(ref.tabId, 'DOM.getBoxModel', { backendNodeId: ref.backendDOMNodeId });
  const target = human.pointFromBorder(model.border, 4);
  const settled = await human.hover(ref.tabId, target);
  return { success: true, ref: refId, role: ref.role, name: ref.name, position: settled };
}

export async function pressKey(tabId, key, { modifiers = 0 } = {}) {
  await cdp.send(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, modifiers });
  await cdp.send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, modifiers });
  return { success: true, key, modifiers };
}
