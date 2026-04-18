/**
 * ==============================================================================
 * OpenSIN Component: deterministic-primitives.js
 * ==============================================================================
 *
 * DESCRIPTION / BESCHREIBUNG:
 * Shared deterministic primitive helpers for the OpenSIN Bridge runtime.
 *
 * WHY IT EXISTS / WARUM ES EXISTIERT:
 * Known UI targets such as Save / Continue / Submit should never waste time on
 * probabilistic vision or server-side guessing when the runtime can identify the
 * target with a bounded deterministic rule set.
 *
 * ARCHITECTURE / WARUM SO GEBAUT:
 * - This file is intentionally dependency-free so it can run in three places:
 *   1) the MV3 background service worker,
 *   2) browser-side content scripts, and
 *   3) Node-based tests.
 * - We attach the API to globalThis instead of relying on bundling so the same
 *   rule set stays available across the mixed JS environments already present in
 *   this repository.
 * - The rule set is intentionally SMALL and EVIDENCE-BASED. We only codify
 *   primitives that are explicitly requested by issue #12 and local evidence.
 *   Everything else MUST fall back to the adaptive path.
 *
 * CONSEQUENCES / KONSEQUENZEN:
 * If these rules become too broad, the runtime may click or answer the wrong
 * element with high confidence. Because of that, ambiguous matches deliberately
 * return null so the existing adaptive fallback can continue to work.
 * ==============================================================================
 */
(function initOpenSINDeterministicPrimitives(globalScope) {
  'use strict';

  // Guard against double-initialisation because this file can be loaded by both
  // content scripts and tests more than once in the same process.
  if (globalScope.__OpenSINDeterministicPrimitives) {
    return;
  }

  // The button families are intentionally tiny. The issue explicitly called out
  // Save / Continue / Submit, so we codify those three families and do not add
  // speculative extras such as Back / Cancel / Skip.
  const KNOWN_BUTTON_FAMILIES = [
    {
      key: 'save',
      label: 'Save',
      // We match whole words plus common suffix forms such as "Save changes" so
      // we cover real buttons while avoiding unrelated words.
      patterns: [/\bsave\b/, /\bsave\s+changes?\b/, /\bsave\s+profile\b/],
    },
    {
      key: 'continue',
      label: 'Continue',
      patterns: [/\bcontinue\b/, /\bcontinue\s+to\b/],
    },
    {
      key: 'submit',
      label: 'Submit',
      patterns: [/\bsubmit\b/, /\bsubmit\s+application\b/, /\bsubmit\s+profile\b/],
    },
  ];

  // The Prolific-specific rules stay deliberately narrow. The issue reference
  // only provides one concrete example (travel for business), so we codify that
  // example and keep the data structure extensible for future proven rules.
  const PROLIFIC_PERSONA_RULES = [
    {
      key: 'travel_for_business',
      // Multiple phrasings are accepted because real survey copy is noisy.
      questionPatterns: [
        /travel(?:ling|ing)?\s+for\s+business/i,
        /business\s+travel/i,
      ],
      // The deterministic answer is only safe when an explicit negative option
      // is actually present in the survey options.
      preferredOptionPatterns: [/^no$/i, /^never$/i, /^nope$/i, /^not\s+applicable$/i],
      answerLabel: 'No',
    },
  ];

  function normalizeText(value) {
    if (typeof value !== 'string') {
      return '';
    }

    // We collapse whitespace and lowercase because DOM text frequently contains
    // inconsistent spacing, line breaks, and casing noise.
    return value.replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function readElementText(candidate) {
    if (!candidate || typeof candidate !== 'object') {
      return '';
    }

    // DOM snapshots can describe the visible label in several places depending
    // on the source: textContent, value, label, name, placeholder, etc. We read
    // them in a stable order so matching behaves consistently across runtimes.
    const possibleText = [
      candidate.text,
      candidate.label,
      candidate.name,
      candidate.value,
      candidate.placeholder,
      candidate.description,
    ];

    for (const entry of possibleText) {
      if (typeof entry === 'string' && entry.trim()) {
        return entry;
      }
    }

    return '';
  }

  function matchButtonFamily(rawText) {
    const normalized = normalizeText(rawText);
    if (!normalized) {
      return null;
    }

    for (const family of KNOWN_BUTTON_FAMILIES) {
      if (family.patterns.some((pattern) => pattern.test(normalized))) {
        return {
          key: family.key,
          label: family.label,
          normalizedText: normalized,
        };
      }
    }

    return null;
  }

  function collectDeterministicButtons(buttons, currentUrl) {
    if (!Array.isArray(buttons)) {
      return [];
    }

    const candidates = [];

    buttons.forEach((button, index) => {
      const family = matchButtonFamily(readElementText(button));
      if (!family) {
        return;
      }

      // Hidden buttons stay excluded because deterministic clicking should only
      // target controls that the current page actually exposes to the user.
      if (button && Object.prototype.hasOwnProperty.call(button, 'visible') && button.visible === false) {
        return;
      }

      candidates.push({
        index,
        selector: typeof button?.selector === 'string' ? button.selector : null,
        text: readElementText(button),
        visible: button?.visible !== false,
        currentUrl: typeof currentUrl === 'string' ? currentUrl : '',
        family,
      });
    });

    return candidates;
  }

  function buildDeterministicPrimitivePayload(domSnapshot, currentUrl) {
    const buttons = collectDeterministicButtons(domSnapshot?.buttons || [], currentUrl);

    // This payload is intentionally descriptive. The consumer decides whether the
    // page state is deterministic enough to act immediately.
    return {
      buttons,
      hasKnownButtons: buttons.length > 0,
      knownButtonFamilies: Array.from(new Set(buttons.map((button) => button.family.key))),
    };
  }

  function resolveDeterministicButtonAction(domSnapshot, currentUrl, targetText) {
    const buttons = collectDeterministicButtons(domSnapshot?.buttons || [], currentUrl);
    if (buttons.length === 0) {
      return null;
    }

    const requestedFamily = matchButtonFamily(targetText || '');
    if (requestedFamily) {
      const familyMatches = buttons.filter((button) => button.family.key === requestedFamily.key);
      if (familyMatches.length === 1 && familyMatches[0].selector) {
        return {
          action: 'click',
          selector: familyMatches[0].selector,
          deterministic: true,
          primitive: familyMatches[0].family,
          matchedText: familyMatches[0].text,
        };
      }

      // Multiple equally plausible targets should fall back to the adaptive path
      // rather than guessing which deterministic candidate is correct.
      return null;
    }

    // When no explicit target was requested we only auto-click if the page has a
    // single safe deterministic candidate. More than one candidate is ambiguous.
    if (buttons.length === 1 && buttons[0].selector) {
      return {
        action: 'click',
        selector: buttons[0].selector,
        deterministic: true,
        primitive: buttons[0].family,
        matchedText: buttons[0].text,
      };
    }

    return null;
  }

  function resolveDeterministicRefByDescription(description, refs, currentUrl) {
    const requestedFamily = matchButtonFamily(description || '');
    if (!requestedFamily || !Array.isArray(refs)) {
      return null;
    }

    const matches = refs.filter((ref) => {
      // We only click interactive button-ish nodes here because this resolver is
      // meant to bypass vision for obvious click targets, not for arbitrary text.
      const normalizedRole = normalizeText(ref?.role);
      if (normalizedRole && normalizedRole !== 'button') {
        return false;
      }

      return matchButtonFamily(readElementText(ref))?.key === requestedFamily.key;
    });

    if (matches.length !== 1) {
      return null;
    }

    return {
      ref: matches[0].ref,
      role: matches[0].role,
      name: readElementText(matches[0]),
      currentUrl: typeof currentUrl === 'string' ? currentUrl : '',
      deterministic: true,
      primitive: requestedFamily,
    };
  }

  function resolveDeterministicPersonaAnswer(questionText, options, currentUrl) {
    const normalizedQuestion = normalizeText(questionText);
    if (!normalizedQuestion || !Array.isArray(options) || options.length === 0) {
      return null;
    }

    const isProlificContext = normalizeText(currentUrl || '').includes('prolific');
    if (!isProlificContext) {
      return null;
    }

    for (const rule of PROLIFIC_PERSONA_RULES) {
      const matchesQuestion = rule.questionPatterns.some((pattern) => pattern.test(normalizedQuestion));
      if (!matchesQuestion) {
        continue;
      }

      const matchedOption = options.find((option) => {
        const normalizedOption = normalizeText(typeof option === 'string' ? option : option?.label || option?.text || '');
        return rule.preferredOptionPatterns.some((pattern) => pattern.test(normalizedOption));
      });

      // If the preferred option is not present, we deliberately decline to act.
      if (!matchedOption) {
        return null;
      }

      return {
        answer: typeof matchedOption === 'string' ? matchedOption : matchedOption?.label || matchedOption?.text || null,
        confidence: 1,
        deterministic: true,
        primitive: {
          key: rule.key,
          label: rule.answerLabel,
        },
      };
    }

    return null;
  }

  globalScope.__OpenSINDeterministicPrimitives = {
    KNOWN_BUTTON_FAMILIES,
    PROLIFIC_PERSONA_RULES,
    normalizeText,
    matchButtonFamily,
    buildDeterministicPrimitivePayload,
    resolveDeterministicButtonAction,
    resolveDeterministicRefByDescription,
    resolveDeterministicPersonaAnswer,
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
