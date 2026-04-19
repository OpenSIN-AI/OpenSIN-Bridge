/**
 * sannysoft-probe.js
 * ==================
 *
 * Paste this into the DevTools console on https://bot.sannysoft.com
 * or https://abrahamjuliot.github.io/creepjs/ with the OpenSIN
 * Bridge extension ACTIVE. It collects the same signals those sites
 * evaluate and prints a pass/fail summary plus the raw readings.
 *
 * Expected: every check returns PASS when stealth v2 is loaded.
 *
 * The probe does NOT touch the page DOM or navigate. It only reads
 * `navigator`, `window`, and calls a couple of WebGL getters.
 */

(() => {
  const out = [];
  const pass = (k, v) => out.push({ check: k, status: 'PASS', value: v });
  const fail = (k, v) => out.push({ check: k, status: 'FAIL', value: v });

  // 1. webdriver
  navigator.webdriver === undefined
    ? pass('navigator.webdriver', undefined)
    : fail('navigator.webdriver', navigator.webdriver);

  // 2. plugins length
  (navigator.plugins && navigator.plugins.length > 0)
    ? pass('navigator.plugins.length', navigator.plugins.length)
    : fail('navigator.plugins.length', navigator.plugins && navigator.plugins.length);

  // 3. mimeTypes length
  (navigator.mimeTypes && navigator.mimeTypes.length > 0)
    ? pass('navigator.mimeTypes.length', navigator.mimeTypes.length)
    : fail('navigator.mimeTypes.length', navigator.mimeTypes && navigator.mimeTypes.length);

  // 4. languages
  (Array.isArray(navigator.languages) && navigator.languages.length > 0)
    ? pass('navigator.languages', navigator.languages)
    : fail('navigator.languages', navigator.languages);

  // 5. hardwareConcurrency
  (navigator.hardwareConcurrency > 0)
    ? pass('navigator.hardwareConcurrency', navigator.hardwareConcurrency)
    : fail('navigator.hardwareConcurrency', navigator.hardwareConcurrency);

  // 6. chrome.runtime
  (window.chrome && window.chrome.runtime)
    ? pass('window.chrome.runtime', typeof window.chrome.runtime)
    : fail('window.chrome.runtime', window.chrome && window.chrome.runtime);

  // 7. WebGL vendor/renderer
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl');
    if (gl) {
      const vendor = gl.getParameter(0x9245);
      const renderer = gl.getParameter(0x9246);
      const isFake = /swiftshader|google inc/i.test(String(vendor) + String(renderer));
      isFake
        ? fail('webgl vendor/renderer', { vendor, renderer })
        : pass('webgl vendor/renderer', { vendor, renderer });
    }
  } catch (e) {
    fail('webgl vendor/renderer', 'threw:' + e.message);
  }

  // 8. UA has no HeadlessChrome
  !navigator.userAgent.includes('HeadlessChrome')
    ? pass('userAgent.noHeadless', navigator.userAgent)
    : fail('userAgent.noHeadless', navigator.userAgent);

  // 9. outer dimensions non-zero
  (window.outerWidth > 0 && window.outerHeight > 0)
    ? pass('outerDimensions', { w: window.outerWidth, h: window.outerHeight })
    : fail('outerDimensions', { w: window.outerWidth, h: window.outerHeight });

  // 10. permissions.query notifications is aligned with Notification.permission
  try {
    navigator.permissions.query({ name: 'notifications' }).then((res) => {
      const expected = (typeof Notification !== 'undefined' && Notification.permission) || 'default';
      (res.state === expected)
        ? pass('permissions.notifications', { state: res.state, expected })
        : fail('permissions.notifications', { state: res.state, expected });
      // Second summary dump after async check arrives.
      // eslint-disable-next-line no-console
      console.table(out);
    });
  } catch (e) {
    fail('permissions.notifications', 'threw:' + e.message);
  }

  // 11. Function.prototype.toString native-ness
  try {
    const desc = Object.getOwnPropertyDescriptor(Navigator.prototype, 'webdriver');
    const str = desc && desc.get && desc.get.toString();
    (String(str).includes('[native code]'))
      ? pass('webdriver-getter.toString', 'native-looking')
      : fail('webdriver-getter.toString', str);
  } catch (e) {
    fail('webdriver-getter.toString', 'threw:' + e.message);
  }

  // 12. stealth flag + status API
  (window.__opensin_stealth__ === '2.0.0')
    ? pass('__opensin_stealth__', window.__opensin_stealth__)
    : fail('__opensin_stealth__', window.__opensin_stealth__);

  if (typeof window.__opensin_stealth_status__ === 'function') {
    pass('status API', window.__opensin_stealth_status__());
  } else {
    fail('status API', 'not installed');
  }

  // eslint-disable-next-line no-console
  console.table(out);
  const failed = out.filter((r) => r.status === 'FAIL').length;
  // eslint-disable-next-line no-console
  console.log(
    failed === 0
      ? `[OpenSIN Stealth v2] PASS (${out.length} synchronous checks)`
      : `[OpenSIN Stealth v2] FAIL (${failed}/${out.length} checks failed)`,
  );
})();
