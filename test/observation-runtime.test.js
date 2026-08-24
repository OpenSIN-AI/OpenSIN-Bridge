/**
 * ==============================================================================
 * OpenSIN Component: observation-runtime.test.js
 * ==============================================================================
 *
 * DESCRIPTION / BESCHREIBUNG:
 * Regression tests for the self-healing observation heuristics.
 *
 * WHY IT EXISTS / WARUM ES EXISTIERT:
 * The runtime makes retry decisions from these helpers. If the helpers regress,
 * the bridge would either miss silent no-op clicks or fire unnecessary fallback
 * strategies. The tests lock down the intended heuristics without needing a live
 * Chrome session.
 * ==============================================================================
 */

const test = require('node:test');
const assert = require('node:assert/strict');

async function loadRuntime() {
  return import('../extension/background/observation-runtime.mjs');
}

test('buildDomDiff reports added and removed accessibility lines', async () => {
  const { buildDomDiff } = await loadRuntime();
  const diff = buildDomDiff('[button] "Apply"\n[text] "Old"', '[button] "Apply"\n[text] "New"');

  assert.equal(diff.changed, true);
  assert.equal(diff.addedCount, 1);
  assert.equal(diff.removedCount, 1);
  assert.deepEqual(diff.addedPreview, ['[text] "New"']);
  assert.deepEqual(diff.removedPreview, ['[text] "Old"']);
});

test('buildVisualDiff treats checksum drift as visual change even when lengths match', async () => {
  const { buildVisualDiff } = await loadRuntime();
  const before = 'data:image/png;base64,AAAAABBBBB';
  const after = 'data:image/png;base64,AAAAACCCCC';
  const diff = buildVisualDiff(before, after, 0.5);

  assert.equal(diff.changed, true);
  assert.equal(diff.diffRatio, 0);
  assert.equal(diff.checksumChanged, true);
});

test('evaluateObservation marks unchanged DOM plus unchanged image as no-op', async () => {
  const { evaluateObservation } = await loadRuntime();
  const assessment = evaluateObservation({
    strategy: 'cdp_mouse',
    beforeSnapshot: {
      tree: '[button] "Continue"',
      screenshotDataUrl: 'data:image/png;base64,AAAAABBBBB',
      url: 'https://example.test/a',
      title: 'Before',
      timestamp: 1,
      tabId: 1,
      refCount: 1,
    },
    afterSnapshot: {
      tree: '[button] "Continue"',
      screenshotDataUrl: 'data:image/png;base64,AAAAABBBBB',
      url: 'https://example.test/a',
      title: 'Before',
      timestamp: 2,
      tabId: 1,
      refCount: 1,
    },
  });

  assert.equal(assessment.noOp, true);
  assert.equal(assessment.changed, false);
  assert.deepEqual(assessment.signals, ['no-op']);
});

test('summarizeProof reports fallback activation and successful recovery', async () => {
  const { summarizeProof } = await loadRuntime();
  const proof = summarizeProof({
    proofId: 'proof-7',
    createdAt: '2026-04-10T00:00:00.000Z',
    ref: { refId: '@e1', role: 'button', name: 'Continue' },
    attempts: [
      {
        strategy: 'cdp_mouse',
        durationMs: 120,
        fallbackTriggered: false,
        execution: { success: true },
        assessment: { noOp: true, changed: false },
      },
      {
        strategy: 'dom_click',
        durationMs: 95,
        fallbackTriggered: true,
        execution: { success: true },
        assessment: { noOp: false, changed: true },
      },
    ],
  });

  assert.equal(proof.fallbackTriggered, true);
  assert.equal(proof.noOpDetected, true);
  assert.equal(proof.successfulStrategy, 'dom_click');
  assert.equal(proof.finalChanged, true);
});
