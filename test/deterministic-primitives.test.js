const assert = require('node:assert/strict');
const path = require('node:path');
const { describe, it } = require('node:test');

// The helper is intentionally written without build tooling so it can be loaded
// directly in Node tests, the MV3 service worker, and browser-side scripts.
require(path.join(__dirname, '..', 'extension', 'shared', 'deterministic-primitives.js'));

const deterministicPrimitives = globalThis.__OpenSINDeterministicPrimitives;

describe('OpenSIN deterministic primitives', () => {
  it('exposes the shared runtime helper and registries', () => {
    assert.ok(deterministicPrimitives);
    assert.equal(typeof deterministicPrimitives.buildDeterministicPrimitivePayload, 'function');
    assert.equal(typeof deterministicPrimitives.resolveDeterministicButtonAction, 'function');
    assert.equal(typeof deterministicPrimitives.resolveDeterministicRefByDescription, 'function');
    assert.equal(typeof deterministicPrimitives.resolveDeterministicPersonaAnswer, 'function');
    assert.ok(Array.isArray(deterministicPrimitives.KNOWN_BUTTON_FAMILIES));
    assert.ok(Array.isArray(deterministicPrimitives.KNOWN_SITE_UI_SHAPES));
    assert.ok(deterministicPrimitives.KNOWN_SITE_UI_SHAPES.some((profile) => profile.key === 'prolific-about-you'));
  });

  it('builds deterministic button metadata for known visible buttons only', () => {
    const payload = deterministicPrimitives.buildDeterministicPrimitivePayload({
      buttons: [
        { text: 'Save changes', selector: '#save-profile', visible: true },
        { text: 'Ignore me', selector: '#ignore', visible: true },
        { text: 'Submit', selector: '#hidden-submit', visible: false },
      ],
    }, 'https://app.prolific.com/about-you');

    assert.equal(payload.hasKnownButtons, true);
    assert.deepEqual(payload.knownButtonFamilies, ['save']);
    assert.deepEqual(payload.matchedSiteProfiles, []);
    assert.equal(payload.buttons.length, 1);
    assert.equal(payload.buttons[0].selector, '#save-profile');
    assert.equal(payload.buttons[0].family.key, 'save');
    assert.equal(payload.buttons[0].family.source, 'text');
  });

  it('matches known Prolific button shapes even when visible text is missing', () => {
    const payload = deterministicPrimitives.buildDeterministicPrimitivePayload({
      buttons: [
        {
          text: '',
          selector: 'button[data-testid="about-you-continue-button"]',
          id: 'about-you-continue-button',
          role: 'button',
          visible: true,
        },
      ],
    }, 'https://app.prolific.com/about-you');

    assert.equal(payload.hasKnownButtons, true);
    assert.deepEqual(payload.knownButtonFamilies, ['continue']);
    assert.deepEqual(payload.matchedSiteProfiles, ['prolific-about-you']);
    assert.equal(payload.buttons[0].family.key, 'continue');
    assert.equal(payload.buttons[0].family.source, 'site-shape');
    assert.equal(payload.buttons[0].family.siteProfile, 'prolific-about-you');
  });

  it('returns a deterministic click when one known button is uniquely available', () => {
    const action = deterministicPrimitives.resolveDeterministicButtonAction({
      buttons: [
        { text: 'Continue', selector: '#continue', visible: true },
      ],
    }, 'https://app.prolific.com/about-you', '');

    assert.deepEqual(action, {
      action: 'click',
      selector: '#continue',
      deterministic: true,
      primitive: {
        key: 'continue',
        label: 'Continue',
        normalizedText: 'continue',
        source: 'text',
      },
      matchedText: 'Continue',
    });
  });

  it('routes known site-specific button shapes without adaptive inference', () => {
    const action = deterministicPrimitives.resolveDeterministicButtonAction({
      buttons: [
        {
          text: '',
          selector: 'button[data-testid="about-you-continue-button"]',
          id: 'about-you-continue-button',
          role: 'button',
          visible: true,
        },
      ],
    }, 'https://app.prolific.com/about-you', '');

    assert.deepEqual(action, {
      action: 'click',
      selector: 'button[data-testid="about-you-continue-button"]',
      deterministic: true,
      primitive: {
        key: 'continue',
        label: 'Continue',
        normalizedText: 'button[data-testid="about-you-continue-button"]',
        source: 'site-shape',
        siteProfile: 'prolific-about-you',
      },
      matchedText: '',
    });
  });

  it('refuses to guess when multiple deterministic buttons are present without a target', () => {
    const action = deterministicPrimitives.resolveDeterministicButtonAction({
      buttons: [
        { text: 'Save', selector: '#save', visible: true },
        { text: 'Continue', selector: '#continue', visible: true },
      ],
    }, 'https://app.prolific.com/about-you', '');

    assert.equal(action, null);
  });

  it('preserves the fallback when a site-specific shape appears on an unapproved site', () => {
    const action = deterministicPrimitives.resolveDeterministicButtonAction({
      buttons: [
        {
          text: '',
          selector: 'button[data-testid="about-you-continue-button"]',
          id: 'about-you-continue-button',
          role: 'button',
          visible: true,
        },
      ],
    }, 'https://example.com/about-you', '');

    assert.equal(action, null);
  });

  it('resolves explicit ref-based button clicks without using vision', () => {
    const match = deterministicPrimitives.resolveDeterministicRefByDescription(
      'Please click submit',
      [
        { ref: '@e1', role: 'button', name: 'Submit profile' },
        { ref: '@e2', role: 'button', name: 'Cancel' },
      ],
      'https://app.prolific.com/about-you'
    );

    assert.deepEqual(match, {
      ref: '@e1',
      role: 'button',
      name: 'Submit profile',
      currentUrl: 'https://app.prolific.com/about-you',
      deterministic: true,
      primitive: {
        key: 'submit',
        label: 'Submit',
        normalizedText: 'please click submit',
        source: 'text',
      },
    });
  });

  it('returns a deterministic Prolific persona answer for travel-for-business questions', () => {
    const answer = deterministicPrimitives.resolveDeterministicPersonaAnswer(
      'How often do you travel for business?',
      ['Yes', 'No', 'Prefer not to say'],
      'https://app.prolific.com/studies/123'
    );

    assert.deepEqual(answer, {
      answer: 'No',
      confidence: 1,
      deterministic: true,
      primitive: {
        key: 'travel_for_business',
        label: 'No',
      },
    });
  });

  it('preserves the adaptive fallback for unknown persona questions', () => {
    const answer = deterministicPrimitives.resolveDeterministicPersonaAnswer(
      'What is your favorite database?',
      ['PostgreSQL', 'SQLite'],
      'https://app.prolific.com/studies/123'
    );

    assert.equal(answer, null);
  });
});
