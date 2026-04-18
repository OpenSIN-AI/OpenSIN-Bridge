/**
 * ==============================================================================
 * OpenSIN Component: observation-runtime.mjs
 * ==============================================================================
 *
 * DESCRIPTION / BESCHREIBUNG:
 * Pure observation and verification helpers for self-healing browser actions.
 *
 * WHY IT EXISTS / WARUM ES EXISTIERT:
 * The bridge runtime must decide whether an interaction really changed the page
 * or whether the browser silently did nothing. Keeping the comparison logic in a
 * dedicated module gives the service worker a clean boundary: the worker gathers
 * browser evidence, this module scores that evidence.
 *
 * CONSEQUENCES / KONSEQUENZEN:
 * If these heuristics are wrong, the runtime either retries too aggressively or
 * accepts silent no-op interactions as success. Both cases create flaky agent
 * behavior, so the helpers stay deterministic and side-effect free.
 * ==============================================================================
 */

export const OBSERVATION_DEFAULTS = Object.freeze({
  settleDelayMs: 250,
  minVisualChangeRatio: 0.001,
  maxStoredProofs: 20,
  maxPreviewItems: 25,
});

function normalizeString(value) {
  return typeof value === 'string' ? value : '';
}

export function stripDataUrlPrefix(dataUrl) {
  const raw = normalizeString(dataUrl);
  const commaIndex = raw.indexOf(',');
  return commaIndex >= 0 ? raw.slice(commaIndex + 1) : raw;
}

function sampleSignature(content) {
  const normalized = normalizeString(content);
  if (!normalized) {
    return { length: 0, sampledLength: 0, checksum: 0 };
  }

  const sampleWindow = Math.min(48, normalized.length);
  const stride = Math.max(1, Math.floor(normalized.length / sampleWindow));
  let checksum = 0;
  let sampledLength = 0;

  for (let index = 0; index < normalized.length && sampledLength < sampleWindow; index += stride) {
    checksum = (checksum * 33 + normalized.charCodeAt(index)) % 2147483647;
    sampledLength += 1;
  }

  return {
    length: normalized.length,
    sampledLength,
    checksum,
  };
}

export function buildDomDiff(previousTree, currentTree, maxItems = OBSERVATION_DEFAULTS.maxPreviewItems) {
  const previousLines = normalizeString(previousTree)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const currentLines = normalizeString(currentTree)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const previousSet = new Set(previousLines);
  const currentSet = new Set(currentLines);
  const added = currentLines.filter((line) => !previousSet.has(line));
  const removed = previousLines.filter((line) => !currentSet.has(line));

  return {
    changed: added.length > 0 || removed.length > 0,
    addedCount: added.length,
    removedCount: removed.length,
    addedPreview: added.slice(0, maxItems),
    removedPreview: removed.slice(0, maxItems),
    previousLineCount: previousLines.length,
    currentLineCount: currentLines.length,
  };
}

export function buildVisualDiff(previousDataUrl, currentDataUrl, minChangeRatio = OBSERVATION_DEFAULTS.minVisualChangeRatio) {
  const previousContent = stripDataUrlPrefix(previousDataUrl);
  const currentContent = stripDataUrlPrefix(currentDataUrl);
  const previousSignature = sampleSignature(previousContent);
  const currentSignature = sampleSignature(currentContent);
  const longestLength = Math.max(previousSignature.length, currentSignature.length, 1);
  const lengthDelta = Math.abs(previousSignature.length - currentSignature.length);
  const diffRatio = lengthDelta / longestLength;
  const checksumChanged = previousSignature.checksum !== currentSignature.checksum;
  const changed = diffRatio >= minChangeRatio || checksumChanged;

  return {
    changed,
    diffRatio,
    lengthDelta,
    previousLength: previousSignature.length,
    currentLength: currentSignature.length,
    previousChecksum: previousSignature.checksum,
    currentChecksum: currentSignature.checksum,
    checksumChanged,
    threshold: minChangeRatio,
  };
}

export function summarizeSnapshot(snapshot) {
  const safeSnapshot = snapshot || {};
  const treeLineCount = normalizeString(safeSnapshot.tree)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .length;

  return {
    tabId: safeSnapshot.tabId ?? null,
    timestamp: safeSnapshot.timestamp ?? null,
    url: safeSnapshot.url ?? null,
    title: safeSnapshot.title ?? null,
    refCount: safeSnapshot.refCount ?? null,
    treeLineCount,
    screenshotLength: stripDataUrlPrefix(safeSnapshot.screenshotDataUrl).length,
  };
}

export function evaluateObservation({
  beforeSnapshot,
  afterSnapshot,
  strategy,
  minVisualChangeRatio = OBSERVATION_DEFAULTS.minVisualChangeRatio,
} = {}) {
  const domDiff = buildDomDiff(beforeSnapshot?.tree, afterSnapshot?.tree);
  const visualDiff = buildVisualDiff(
    beforeSnapshot?.screenshotDataUrl,
    afterSnapshot?.screenshotDataUrl,
    minVisualChangeRatio,
  );
  const urlChanged = normalizeString(beforeSnapshot?.url) !== normalizeString(afterSnapshot?.url);
  const titleChanged = normalizeString(beforeSnapshot?.title) !== normalizeString(afterSnapshot?.title);
  const changed = domDiff.changed || visualDiff.changed || urlChanged || titleChanged;

  const signals = [];
  if (domDiff.changed) signals.push('dom-diff');
  if (visualDiff.changed) signals.push('visual-diff');
  if (urlChanged) signals.push('url-change');
  if (titleChanged) signals.push('title-change');
  if (signals.length === 0) signals.push('no-op');

  return {
    strategy: strategy || 'unknown',
    changed,
    noOp: !changed,
    signals,
    urlChanged,
    titleChanged,
    domDiff,
    visualDiff,
    before: summarizeSnapshot(beforeSnapshot),
    after: summarizeSnapshot(afterSnapshot),
  };
}

export function summarizeAttempts(attempts = []) {
  return attempts.map((attempt) => ({
    strategy: attempt.strategy,
    durationMs: attempt.durationMs,
    fallbackTriggered: !!attempt.fallbackTriggered,
    execution: attempt.execution,
    assessment: attempt.assessment,
  }));
}

export function summarizeProof(proof) {
  const attempts = Array.isArray(proof?.attempts) ? proof.attempts : [];
  const successfulAttempt = attempts.find((attempt) => attempt?.assessment?.changed && !attempt?.execution?.error) || null;
  const finalAttempt = attempts[attempts.length - 1] || null;

  return {
    proofId: proof?.proofId ?? null,
    createdAt: proof?.createdAt ?? null,
    ref: proof?.ref ?? null,
    strategyCount: attempts.length,
    fallbackTriggered: attempts.length > 1,
    noOpDetected: attempts.some((attempt) => attempt?.assessment?.noOp),
    successfulStrategy: successfulAttempt?.strategy || null,
    finalStrategy: finalAttempt?.strategy || null,
    finalChanged: !!finalAttempt?.assessment?.changed,
    attempts: summarizeAttempts(attempts),
  };
}
