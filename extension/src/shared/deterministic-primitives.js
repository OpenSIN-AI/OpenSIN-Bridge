/**
 * Shared deterministic primitive rules.
 *
 * This module is dependency-free so it runs in the MV3 service worker, in
 * content scripts, and in Node tests. Rules are deliberately narrow: only
 * explicitly sanctioned UI patterns ever match. Anything ambiguous must fall
 * through to the adaptive (vision / server) path.
 */

const KNOWN_BUTTON_FAMILIES = [
  { key: 'save', label: 'Save', patterns: [/\bsave\b/, /\bsave\s+changes?\b/, /\bsave\s+profile\b/] },
  { key: 'continue', label: 'Continue', patterns: [/\bcontinue\b/, /\bcontinue\s+to\b/] },
  { key: 'submit', label: 'Submit', patterns: [/\bsubmit\b/, /\bsubmit\s+application\b/, /\bsubmit\s+profile\b/] },
  { key: 'next', label: 'Next', patterns: [/\bnext\b/, /\bnext\s+step\b/] },
];

const PROLIFIC_PERSONA_RULES = [
  {
    key: 'travel_for_business',
    questionPatterns: [/travel(?:ling|ing)?\s+for\s+business/i, /business\s+travel/i],
    preferredOptionPatterns: [/^no$/i, /^never$/i, /^nope$/i, /^not\s+applicable$/i],
    answerLabel: 'No',
  },
];

function normalizeText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function readElementText(candidate) {
  if (!candidate || typeof candidate !== 'object') return '';
  const priority = [candidate.text, candidate.label, candidate.name, candidate.value, candidate.placeholder, candidate.description];
  for (const entry of priority) {
    if (typeof entry === 'string' && entry.trim()) return entry;
  }
  return '';
}

export function matchButtonFamily(rawText) {
  const normalized = normalizeText(rawText);
  if (!normalized) return null;
  for (const family of KNOWN_BUTTON_FAMILIES) {
    if (family.patterns.some((pattern) => pattern.test(normalized))) {
      return { key: family.key, label: family.label, normalizedText: normalized };
    }
  }
  return null;
}

export function collectDeterministicButtons(buttons, currentUrl = '') {
  if (!Array.isArray(buttons)) return [];
  const result = [];
  buttons.forEach((button, index) => {
    const family = matchButtonFamily(readElementText(button));
    if (!family) return;
    if (button?.visible === false) return;
    result.push({
      index,
      selector: typeof button?.selector === 'string' ? button.selector : null,
      text: readElementText(button),
      visible: button?.visible !== false,
      currentUrl: typeof currentUrl === 'string' ? currentUrl : '',
      family,
    });
  });
  return result;
}

export function buildDeterministicPayload(domSnapshot, currentUrl = '') {
  const buttons = collectDeterministicButtons(domSnapshot?.buttons || [], currentUrl);
  return {
    buttons,
    hasKnownButtons: buttons.length > 0,
    knownButtonFamilies: Array.from(new Set(buttons.map((button) => button.family.key))),
  };
}

export function resolveDeterministicButtonAction(domSnapshot, currentUrl, targetText = '') {
  const buttons = collectDeterministicButtons(domSnapshot?.buttons || [], currentUrl);
  if (buttons.length === 0) return null;

  const requested = matchButtonFamily(targetText);
  if (requested) {
    const matches = buttons.filter((button) => button.family.key === requested.key);
    if (matches.length === 1 && matches[0].selector) {
      return {
        action: 'click',
        selector: matches[0].selector,
        deterministic: true,
        primitive: matches[0].family,
        matchedText: matches[0].text,
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

export function resolveDeterministicRefByDescription(description, refs, currentUrl = '') {
  const requested = matchButtonFamily(description);
  if (!requested || !Array.isArray(refs)) return null;

  const matches = refs.filter((ref) => {
    const role = normalizeText(ref?.role);
    if (role && role !== 'button') return false;
    return matchButtonFamily(readElementText(ref))?.key === requested.key;
  });

  if (matches.length !== 1) return null;
  return {
    ref: matches[0].ref || matches[0].refId,
    role: matches[0].role,
    name: readElementText(matches[0]),
    currentUrl,
    deterministic: true,
    primitive: requested,
  };
}

export function resolveDeterministicPersonaAnswer(questionText, options, currentUrl = '') {
  const normalized = normalizeText(questionText);
  if (!normalized || !Array.isArray(options) || options.length === 0) return null;
  if (!normalizeText(currentUrl).includes('prolific')) return null;

  for (const rule of PROLIFIC_PERSONA_RULES) {
    if (!rule.questionPatterns.some((pattern) => pattern.test(normalized))) continue;

    const match = options.find((option) => {
      const label = normalizeText(typeof option === 'string' ? option : option?.label || option?.text || '');
      return rule.preferredOptionPatterns.some((pattern) => pattern.test(label));
    });
    if (!match) return null;

    return {
      answer: typeof match === 'string' ? match : match?.label || match?.text || null,
      confidence: 1,
      deterministic: true,
      primitive: { key: rule.key, label: rule.answerLabel },
    };
  }
  return null;
}

export { KNOWN_BUTTON_FAMILIES, PROLIFIC_PERSONA_RULES, normalizeText };
