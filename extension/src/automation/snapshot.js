/**
 * ================================================================================
 * DATEI: snapshot.js
 * PROJEKT: OpenSIN-Bridge - Accessibility Tree Snapshot System
 * ZWECK: Erstellt deterministische Referenzkarten für Agenten
 *
 * WICHTIG FÜR ENTWICKLER:
 * Diese Datei ist das RÜCKGRAT der Element-Identifikation! Ohne sie können
 * Agenten keine Elemente zuverlässig anklicken oder beschreiben.
 *
 * WAS PASSIERT HIER:
 * 1. Liest den Accessibility Tree von Chrome (barrierefreie Struktur)
 * 2. Weist jedem interaktiven Element eine stabile "@e<N>" Referenz zu
 * 3. Diese Referenzen bleiben auch bei React/Vue Re-renders stabil
 * 4. Alte Handles werden automatisch ungültig bei neuem Snapshot
 *
 * WARUM NICHT CSS SELECTORS?
 * - CSS Selectors brechen bei dynamischen Apps sofort (Klassen ändern sich)
 * - XPath ist zu langsam und fragil
 * - Accessibility Tree ist SEMANTISCH und STABIL
 *
 * ANTI-BOT RELEVANZ:
 * - Schnelle Element-Lokalisierung ohne wiederholtes DOM-Scanning
 * - Vermeidet verdächtige "document.querySelectorAll" Aufrufe
 * - Nutzt native Chrome APIs (unauffällig)
 *
 * ACHTUNG: Änderungen an der Ref-Generierung brechen ALLE bestehenden Agenten!
 * Das Format "@e<N>" MUSS konsistent bleiben!
 * ================================================================================
 */

import * as cdp from '../drivers/cdp.js';
import { getTab } from '../drivers/tabs.js';
import { SNAPSHOT } from '../core/config.js';
import { BridgeError, ERROR_CODES } from '../core/errors.js';
import { logger } from '../core/logger.js';

const log = logger('snapshot');

// Globale Map aller aktiven Referenzen: "@e1" -> {tabId, backendDOMNodeId, ...}
// WICHTIG: Wird bei jedem Tab-Snapshot zurückgesetzt!
const refs = new Map();
let refCounter = 0;
let lastSnapshot = null;

function resetRefsFor(tabId) {
  for (const [key, value] of refs) {
    if (value.tabId === tabId) refs.delete(key);
  }
}

function readProperty(node, name) {
  return node.properties?.find((p) => p.name === name)?.value?.value;
}

function formatNode(node, depth) {
  const role = node.role?.value || '';
  const name = node.name?.value || '';
  const value = node.value?.value || '';
  const desc = node.description?.value || '';
  const checked = readProperty(node, 'checked');
  const disabled = readProperty(node, 'disabled');
  const required = readProperty(node, 'required');
  const expanded = readProperty(node, 'expanded');

  if (SNAPSHOT.skipRoles.has(role) && !name) return null;
  if (!role && !name) return null;

  const interactive = SNAPSHOT.interactiveRoles.has(role);
  const structural = SNAPSHOT.structuralRoles.has(role);
  if (!interactive && !structural && !name) return null;

  const indent = '  '.repeat(depth);
  let refTag = '';

  if (interactive && node.backendDOMNodeId) {
    refCounter += 1;
    const refId = `@e${refCounter}`;
    refs.set(refId, {
      refId,
      tabId: node._tabId,
      backendDOMNodeId: node.backendDOMNodeId,
      nodeId: node.nodeId,
      role,
      name,
    });
    refTag = ` ${refId}`;
  }

  let line = `${indent}[${role}${refTag}]`;
  if (name) line += ` "${name}"`;
  if (value) line += ` value="${value}"`;
  if (desc) line += ` desc="${desc}"`;
  if (checked !== undefined) line += ` checked=${checked}`;
  if (disabled) line += ' disabled';
  if (required) line += ' required';
  if (expanded !== undefined) line += ` expanded=${expanded}`;
  return line;
}

function buildTree(nodes, tabId) {
  const byId = new Map();
  for (const node of nodes) {
    node._tabId = tabId;
    byId.set(node.nodeId, node);
  }

  const lines = [];
  function walk(nodeId, depth) {
    const node = byId.get(nodeId);
    if (!node) return;
    if (node.ignored?.value) {
      for (const childId of node.childIds || []) walk(childId, depth);
      return;
    }
    const formatted = formatNode(node, depth);
    const nextDepth = formatted !== null ? depth + 1 : depth;
    if (formatted !== null) lines.push(formatted);
    for (const childId of node.childIds || []) walk(childId, nextDepth);
  }

  if (nodes.length > 0) walk(nodes[0].nodeId, 0);
  return lines.join('\n');
}

export async function captureAccessibilityTree(tabId) {
  const { nodes } = await cdp.send(tabId, 'Accessibility.getFullAXTree', {});
  resetRefsFor(tabId);
  refCounter = 0;
  const tree = buildTree(nodes, tabId);
  return { tree, refCount: refs.size };
}

export async function captureScreenshot(tabId, { format = 'png', quality } = {}) {
  const params = { format, fromSurface: true };
  if (quality) params.quality = quality;
  const result = await cdp.send(tabId, 'Page.captureScreenshot', params);
  return `data:image/${format};base64,${result.data}`;
}

export async function capture(tabId, { includeScreenshot = false } = {}) {
  if (!Number.isInteger(tabId)) {
    throw new BridgeError(ERROR_CODES.INVALID_INPUT, 'tabId required');
  }

  const tab = await getTab(tabId);
  const { tree, refCount } = await captureAccessibilityTree(tabId);
  const snapshot = {
    tree,
    refCount,
    tabId,
    url: tab?.url || null,
    title: tab?.title || null,
    timestamp: Date.now(),
  };

  if (includeScreenshot) {
    try {
      snapshot.screenshotDataUrl = await captureScreenshot(tabId);
    } catch (error) {
      log.warn('screenshot failed', { message: error?.message });
    }
  }

  lastSnapshot = snapshot;
  return snapshot;
}

export function getRef(refId) {
  return refs.get(refId) || null;
}

export function listRefs(tabId) {
  const out = [];
  for (const value of refs.values()) {
    if (!tabId || value.tabId === tabId) out.push({ ...value });
  }
  return out;
}

export function getLastSnapshot() {
  return lastSnapshot;
}

export function setLastSnapshot(snapshot) {
  lastSnapshot = snapshot;
}
