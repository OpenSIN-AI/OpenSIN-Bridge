/**
 * ================================================================================
 * DATEI: stealth.js
 * PROJEKT: OpenSIN-Bridge - Stealth Status & Challenge Detection
 * ZWECK: Erkennt Bot-Erkennungsversuche und bewertet die Tarnqualität
 *
 * WICHTIG FÜR ENTWICKLER:
 * Diese Datei ist das FRÜHWARNSYSTEM gegen Bot-Erkennung! Sie erkennt BEVOR
 * eine Blockade stattfindet, ob die Seite Misstrauen schöpft.
 *
 * WAS PASSIERT HIER:
 * 1. stealth.status - Aktueller Status des Stealth-Subsystems
 * 2. stealth.assess - Bewertet die Umgebung (Locale, Timezone, Fingerprint)
 *    - Gibt einen SCORE zurück (nicht nur ja/nein!)
 *    - Score hilft dem Agenten zu entscheiden ob Neustart nötig ist
 * 3. stealth.detectChallenge - Erkennt CAPTCHAs und Challenges
 *    - Cloudflare Turnstile, reCAPTCHA, hCaptcha, DataDome, PerimeterX
 *
 * WARUM SCORE STATT BOOLEAN?
 * - Ein Score von 0.85 bedeutet "leicht verdächtig, aber noch okay"
 * - Ein Score von 0.40 bedeutet "sofortiger Neustart erforderlich"
 * - Boolean wäre zu grob und würde zu viele false positives produzieren
 *
 * ANTI-BOT RELEVANZ:
 * - Erkennt navigator.webdriver BEFORE es zur Blockade kommt
 * - Prüft auf Inkonsistenzen (Timezone vs Locale vs IP)
 * - Überwacht Viewport-Anomalien (Bot-typische Fenstergrößen)
 *
 * ACHTUNG: Diese Datei läuft im Page Context! Keine Extension APIs verwenden!
 * ================================================================================
 */

import * as Tabs from "../drivers/tabs.js"

const ASSESSMENT_SCRIPT = `
(() => {
  const out = {
    locale: { reported: null, expected: null, matches: null },
    timezone: { reported: null },
    viewport: { width: null, height: null, dpr: null, ratio: null, suspicious: false },
    automation: {
      webdriver: !!navigator.webdriver,
      hasChrome: typeof window.chrome === 'object',
      pluginsCount: 0,
      languagesCount: 0,
      hardwareConcurrency: null,
      deviceMemory: null,
      stealthMarker: null,
    },
    coherence: { score: 100, signals: [] },
  };
  try {
    out.locale.reported = navigator.language || null;
    out.locale.expected = navigator.languages && navigator.languages[0] || null;
    out.locale.matches = out.locale.reported === out.locale.expected;
    if (!out.locale.matches) {
      out.coherence.score -= 8;
      out.coherence.signals.push({ kind: 'locale_mismatch', delta: -8 });
    }
  } catch (e) {}
  try {
    out.timezone.reported = Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch (e) {}
  try {
    out.viewport.width = window.innerWidth;
    out.viewport.height = window.innerHeight;
    out.viewport.dpr = window.devicePixelRatio;
    if (window.innerWidth && window.innerHeight) {
      out.viewport.ratio = +(window.innerWidth / window.innerHeight).toFixed(3);
    }
    if (window.innerWidth < 320 || window.innerHeight < 240) {
      out.viewport.suspicious = true;
      out.coherence.score -= 12;
      out.coherence.signals.push({ kind: 'viewport_tiny', delta: -12 });
    }
  } catch (e) {}
  try {
    out.automation.pluginsCount = (navigator.plugins && navigator.plugins.length) || 0;
    out.automation.languagesCount = (navigator.languages && navigator.languages.length) || 0;
    out.automation.hardwareConcurrency = navigator.hardwareConcurrency || null;
    out.automation.deviceMemory = navigator.deviceMemory || null;
    out.automation.stealthMarker = window.__opensin_stealth__ || null;
    if (out.automation.webdriver) {
      out.coherence.score -= 25;
      out.coherence.signals.push({ kind: 'webdriver_true', delta: -25 });
    }
    if (out.automation.pluginsCount === 0) {
      out.coherence.score -= 8;
      out.coherence.signals.push({ kind: 'plugins_empty', delta: -8 });
    }
    if (out.automation.languagesCount === 0) {
      out.coherence.score -= 6;
      out.coherence.signals.push({ kind: 'languages_empty', delta: -6 });
    }
    if (!out.automation.hasChrome) {
      out.coherence.score -= 10;
      out.coherence.signals.push({ kind: 'no_chrome_object', delta: -10 });
    }
  } catch (e) {}
  return out;
})();
`

const CHALLENGE_SCRIPT = `
(() => {
  const html = document.documentElement.outerHTML.slice(0, 200000).toLowerCase();
  return {
    cloudflare: !!document.querySelector('[class*="cf-"], #challenge-running, [class*="cf-im-under-attack"]'),
    turnstile: !!document.querySelector('iframe[src*="turnstile"], [data-sitekey][class*="cf"]'),
    recaptchaV2: !!document.querySelector('iframe[src*="recaptcha/api2"], .g-recaptcha'),
    recaptchaV3: !!document.querySelector('script[src*="recaptcha/api.js"]'),
    hcaptcha: !!document.querySelector('iframe[src*="hcaptcha"], .h-captcha'),
    datadome: html.includes('datadome'),
    perimeterx: html.includes('px-captcha') || html.includes('perimeterx'),
    akamai: html.includes('akam') && html.includes('sensor_data'),
    distil: html.includes('distil_'),
    imperva: html.includes('iv-token') || html.includes('imperva'),
    shape: html.includes('f5_') || html.includes('shape security'),
    rateLimit: /you (have been )?rate.?limited|too many requests|429/i.test(document.body?.innerText?.slice(0, 5000) || ''),
  };
})();
`

export function register(router) {
  router.register(
    "stealth.status",
    async () => ({
      ok: true,
      passive: true,
      version: "stealth-v2",
      // The stealth content script reports status via window.__opensin_stealth__.
      // We do not eagerly inject a probe to avoid being noisy; the assessment
      // tool is the explicit, on-demand path.
      probedAt: new Date().toISOString(),
    }),
    {
      description: "Stealth subsystem status (passive, in-band).",
      category: "stealth",
    },
  )

  router.register(
    "stealth.assess",
    async ({ tabId } = {}) => {
      const id = await Tabs.resolveTabId(tabId)
      const result = await router.invoke("dom.evaluate", { tabId: id, expression: ASSESSMENT_SCRIPT, awaitPromise: false })
      const assessment = result?.result || result || null
      return { tabId: id, assessment }
    },
    {
      description: "Score environment coherence (locale, timezone, viewport, automation markers).",
      category: "stealth",
    },
  )

  router.register(
    "stealth.detectChallenge",
    async ({ tabId } = {}) => {
      const id = await Tabs.resolveTabId(tabId)
      const result = await router.invoke("dom.evaluate", { tabId: id, expression: CHALLENGE_SCRIPT, awaitPromise: false })
      const challenges = result?.result || result || null
      const flagged = Object.entries(challenges || {})
        .filter(([, v]) => !!v)
        .map(([k]) => k)
      return { tabId: id, challenges, flagged, anyFlagged: flagged.length > 0 }
    },
    {
      description: "Detect anti-bot challenges (Cloudflare, Turnstile, reCAPTCHA, hCaptcha, DataDome, ...).",
      category: "stealth",
    },
  )
}

export const _scripts = { ASSESSMENT_SCRIPT, CHALLENGE_SCRIPT }
