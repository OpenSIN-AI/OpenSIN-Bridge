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

  // WHY: The bridge loads this helper from multiple runtime surfaces. Re-using an
  // already initialized instance avoids subtle divergence between the extension,
  // tests, and worker execution contexts.
  if (globalScope.__OpenSINDeterministicPrimitives) {
    return;
  }

  // WHY: The registry is the single source of truth for deterministic button
  // families. Each family remains intentionally small so we stop AI guessing for
  // known controls without swallowing unrelated UI.
  const KNOWN_BUTTON_FAMILIES = [
    {
      key: 'save',
      label: 'Save',
      textPatterns: [/\bsave\b/i, /\bsave\s+changes?\b/i, /\bsave\s+profile\b/i],
    },
    {
      key: 'continue',
      label: 'Continue',
      textPatterns: [/\bcontinue\b/i, /\bcontinue\s+to\b/i],
    },
    {
      key: 'submit',
      label: 'Submit',
      textPatterns: [/\bsubmit\b/i, /\bsubmit\s+application\b/i, /\bsubmit\s+profile\b/i],
    },
  ];

  // WHY: Some surfaces hide the visible label in selector/id/location metadata
  // instead of innerText. These site profiles let us recover that intent only in
  // explicitly approved contexts, which prevents selector-based overmatching on
  // unrelated sites.
  const KNOWN_SITE_UI_SHAPES = [
    {
      key: 'prolific-about-you',
      label: 'Prolific About You',
      hostPatterns: [/^app\.prolific\.com$/i],
      pathPatterns: [/^\/about-you(?:\/.*)?$/i],
      buttonShapes: [
        {
          familyKey: 'save',
          rolePatterns: [/^button$/i],
          signalPatterns: [/\bsave\b/i, /save-profile/i, /save-changes/i],
        },
        {
          familyKey: 'continue',
          rolePatterns: [/^button$/i],
          signalPatterns: [/\bcontinue\b/i, /continue-button/i, /about-you.*continue/i],
        },
        {
          familyKey: 'submit',
          rolePatterns: [/^button$/i],
          signalPatterns: [/\bsubmit\b/i, /submit-profile/i, /submit-button/i],
        },
      ],
    },
    {
      key: 'prolific-study-submit',
      label: 'Prolific Study Submit',
      hostPatterns: [/^app\.prolific\.com$/i],
      pathPatterns: [/^\/stud(?:y|ies)(?:\/.*)?$/i, /^\/submissions?(?:\/.*)?$/i],
      buttonShapes: [
        {
          familyKey: 'continue',
          rolePatterns: [/^button$/i],
          signalPatterns: [/\bcontinue\b/i, /continue-button/i, /study.*continue/i],
        },
        {
          familyKey: 'submit',
          rolePatterns: [/^button$/i],
          signalPatterns: [/\bsubmit\b/i, /submit-study/i, /complete-submission/i],
        },
      ],
    },
  ];

  // WHY: Persona rules stay deterministic only where we have explicit approved
  // answers. Every unknown question must still flow through the adaptive engine.
  const PROLIFIC_PERSONA_RULES = [
    {
      key: 'travel_for_business',
      questionPatterns: [
        /travel(?:ling|ing)?\s+for\s+business/i,
        /business\s+travel/i,
      ],
      preferredOptionPatterns: [/^no$/i, /^never$/i, /^nope$/i, /^not\s+applicable$/i],
      answerLabel: 'No',
    },
  ];

  function normalizeText(value) {
    if (typeof value !== 'string') {
      return '';
    }
    return value.replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function normalizeSignalValue(value) {
    return normalizeText(typeof value === 'string' ? value : '');
  }

  function parseUrl(currentUrl) {
    if (typeof currentUrl !== 'string' || !currentUrl.trim()) {
      return null;
    }

    try {
      return new URL(currentUrl);
    } catch (_error) {
      return null;
    }
  }

  function getButtonFamilyByKey(key) {
    return KNOWN_BUTTON_FAMILIES.find((family) => family.key === key) || null;
  }

  function readElementText(candidate) {
    if (!candidate || typeof candidate !== 'object') {
      return '';
    }

    const possibleText = [
      candidate.text,
      candidate.label,
      candidate.name,
      candidate.value,
      candidate.placeholder,
      candidate.description,
      candidate.ariaLabel,
      candidate.title,
    ];

    for (const entry of possibleText) {
      if (typeof entry === 'string' && entry.trim()) {
        return entry;
      }
    }

    return '';
  }

  function readCandidateSignals(candidate) {
    if (!candidate || typeof candidate !== 'object') {
      return [];
    }

    // WHY: Deterministic matching needs a bounded set of signals that can be
    // safely inspected without introducing heuristics hidden somewhere else.
    const rawSignals = [
      candidate.text,
      candidate.label,
      candidate.name,
      candidate.value,
      candidate.placeholder,
      candidate.description,
      candidate.ariaLabel,
      candidate.title,
      candidate.selector,
      candidate.id,
      candidate.className,
      candidate.location,
      candidate.role,
      candidate.tag,
      candidate.type,
    ];

    const signals = [];
    for (const entry of rawSignals) {
      const normalized = normalizeSignalValue(entry);
      if (normalized) {
        signals.push(normalized);
      }
    }

    return Array.from(new Set(signals));
  }

  function getMatchingSiteProfiles(currentUrl) {
    const parsedUrl = parseUrl(currentUrl);
    if (!parsedUrl) {
      return [];
    }

    const host = normalizeSignalValue(parsedUrl.hostname);
    const path = normalizeSignalValue(parsedUrl.pathname);

    return KNOWN_SITE_UI_SHAPES.filter((profile) => {
      const hostMatches = profile.hostPatterns.some((pattern) => pattern.test(host));
      if (!hostMatches) {
        return false;
      }

      return profile.pathPatterns.some((pattern) => pattern.test(path));
    });
  }

  function matchButtonFamily(rawText) {
    const normalized = normalizeText(rawText);
    if (!normalized) {
      return null;
    }

    for (const family of KNOWN_BUTTON_FAMILIES) {
      if (family.textPatterns.some((pattern) => pattern.test(normalized))) {
        return {
          key: family.key,
          label: family.label,
          normalizedText: normalized,
          source: 'text',
        };
      }
    }

    return null;
  }

  function matchSiteSpecificButtonShape(candidate, currentUrl) {
    const signals = readCandidateSignals(candidate);
    if (signals.length === 0) {
      return null;
    }

    const normalizedRole = normalizeSignalValue(candidate?.role || 'button');
    const matchingProfiles = getMatchingSiteProfiles(currentUrl);
    if (matchingProfiles.length === 0) {
      return null;
    }

    for (const profile of matchingProfiles) {
      for (const shape of profile.buttonShapes) {
        const roleMatches = !Array.isArray(shape.rolePatterns)
          || shape.rolePatterns.length === 0
          || shape.rolePatterns.some((pattern) => pattern.test(normalizedRole));
        if (!roleMatches) {
          continue;
        }

        const signalMatches = shape.signalPatterns.some((pattern) => signals.some((signal) => pattern.test(signal)));
        if (!signalMatches) {
          continue;
        }

        const family = getButtonFamilyByKey(shape.familyKey);
        if (!family) {
          continue;
        }

        return {
          key: family.key,
          label: family.label,
          normalizedText: signals[0],
          source: 'site-shape',
          siteProfile: profile.key,
        };
      }
    }

    return null;
  }

  function matchDeterministicButtonCandidate(candidate, currentUrl) {
    const directTextMatch = matchButtonFamily(readElementText(candidate));
    if (directTextMatch) {
      return directTextMatch;
    }

    return matchSiteSpecificButtonShape(candidate, currentUrl);
  }

  function collectDeterministicButtons(buttons, currentUrl) {
    if (!Array.isArray(buttons)) {
      return [];
    }

    const candidates = [];

    buttons.forEach((button, index) => {
      const family = matchDeterministicButtonCandidate(button, currentUrl);
      if (!family) {
        return;
      }

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
        role: typeof button?.role === 'string' ? button.role : 'button',
        location: typeof button?.location === 'string' ? button.location : '',
      });
    });

    return candidates;
  }

  function buildDeterministicPrimitivePayload(domSnapshot, currentUrl) {
    const buttons = collectDeterministicButtons(domSnapshot?.buttons || [], currentUrl);
    return {
      buttons,
      hasKnownButtons: buttons.length > 0,
      knownButtonFamilies: Array.from(new Set(buttons.map((button) => button.family.key))),
      matchedSiteProfiles: Array.from(
        new Set(
          buttons
            .map((button) => button.family.siteProfile)
            .filter((profileKey) => typeof profileKey === 'string' && profileKey)
        )
      ),
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

      return null;
    }

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
      const normalizedRole = normalizeText(ref?.role);
      if (normalizedRole && normalizedRole !== 'button') {
        return false;
      }

      return matchDeterministicButtonCandidate(ref, currentUrl)?.key === requestedFamily.key;
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
    KNOWN_SITE_UI_SHAPES,
    PROLIFIC_PERSONA_RULES,
    normalizeText,
    matchButtonFamily,
    buildDeterministicPrimitivePayload,
    resolveDeterministicButtonAction,
    resolveDeterministicRefByDescription,
    resolveDeterministicPersonaAnswer,
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
