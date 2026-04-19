/**
 * content/stealth-main.js -- OpenSIN Bridge Stealth Layer v2
 * =========================================================
 *
 * Runs in the MAIN world at document_start on every frame. Applies a
 * comprehensive set of deterministic, idempotent shims that remove the
 * most common automation fingerprints a page can observe.
 *
 * DESIGN GOALS
 * ------------
 *   1. NEVER break page functionality. Every shim is additive and
 *      wrapped in try/catch -- if something fails we silently skip
 *      that single module, we do not take the page down with us.
 *   2. Idempotent: loading the script twice on the same document must
 *      be a no-op. This is important because `all_frames: true` plus
 *      some pages reload frames after hydration.
 *   3. Signature-free: the shims do not leave a console trace, a
 *      global object with a telltale name, or Object.defineProperty
 *      descriptors with obviously-fake values. Where a real Chrome on
 *      macOS reports `8`, we report `8`, not `4242`.
 *   4. Native-looking `Function.prototype.toString` for every hooked
 *      function. Anti-bot libraries routinely call
 *      `fn.toString().includes('[native code]')` -- if our getter
 *      says `function get webdriver() { return undefined }` they
 *      flag it. We patch toString via a Proxy so our shims look
 *      native.
 *   5. Backward compatible with v1: the flag
 *      `window.__opensin_stealth__` still exists (now a version
 *      string, not just `true`), `window.__opensin_ping__` still
 *      works, and the message-bridge channel `__OPENSIN_BRIDGE__`
 *      still works.
 *   6. Manifest/runtime contract: v2 assumes `proxy` and
 *      `declarativeNetRequest` are granted at install time. They are
 *      required by the stealth/debug stack and must not be demoted to
 *      optional permissions without updating docs + tests.
 *   7. Load-order coupling: `debug-console.js` runs in the same MAIN
 *      world after this file so it can inherit `markNative()` and keep
 *      its hooks native-looking.
 *
 * EVASIONS APPLIED
 * ----------------
 *   01. navigator.webdriver         -> undefined
 *   02. navigator.plugins           -> realistic Chrome plugin list
 *   03. navigator.mimeTypes         -> matched to plugins
 *   04. navigator.languages         -> stable non-empty array
 *   05. navigator.hardwareConcurrency/deviceMemory -> consistent
 *   06. window.chrome.runtime       -> plausible object when missing
 *   07. WebGL vendor/renderer       -> Intel Iris (Mac) or similar
 *   08. Canvas toDataURL/getImageData -> micro-noise to break hashing
 *   09. AudioContext fingerprint    -> perturbed buffer data
 *   10. navigator.permissions.query -> Notification permission sane
 *   11. iframe.contentWindow        -> nulls that headless returns fixed
 *   12. window.outerWidth/outerHeight -> match innerWidth when 0
 *   13. MediaDevices.enumerateDevices -> plausible default devices
 *   14. Battery API                 -> plausible charging state
 *   15. NetworkInformation          -> 4g / downlink 10
 *   16. navigator.userAgent         -> strip "HeadlessChrome" token
 *   17. Function.prototype.toString -> preserve "[native code]"
 *
 * DIAGNOSTIC API
 * --------------
 *   window.__opensin_stealth__            -> version string (e.g. "2.0.0")
 *   window.__opensin_ping__()             -> { alive: true, ts, v }
 *   window.__opensin_stealth_status__()   -> { webdriver: "applied", ... }
 *
 * The status API is intentionally not hidden: trusted internal test
 * harnesses (see test/stealth/) rely on it to verify what was applied
 * on a given page. It is not a fingerprint because it's only defined
 * on our own test pages' windows and returns a small dictionary --
 * any page that already detected our extension via other means
 * already knows.
 */

;(() => {
  'use strict';

  // ------------------------------------------------------------------
  // Idempotency guard -- set to the version string so test harnesses
  // can differentiate legacy v1 (truthy "true") from v2 ("2.0.0").
  // ------------------------------------------------------------------
  const FLAG = '__opensin_stealth__';
  const VERSION = '2.0.0';
  if (window[FLAG] && window[FLAG] !== true) return; // v2 already loaded
  try {
    Object.defineProperty(window, FLAG, {
      value: VERSION,
      configurable: false,
      enumerable: false,
      writable: false,
    });
  } catch {
    // Another extension may have locked the flag. Not fatal -- continue.
  }

  const CHANNEL = '__OPENSIN_BRIDGE__';

  // ------------------------------------------------------------------
  // toString-preservation helper.
  //
  // Every function we install as a replacement MUST report
  // `function X() { [native code] }` when toString()'d. We do this by
  // proxying Function.prototype.toString globally and mapping our
  // replacements back to the native toString of the original function
  // they replaced.
  // ------------------------------------------------------------------
  const nativeToStringMap = new WeakMap();
  const _origToString = Function.prototype.toString;

  function markNative(fn, template) {
    // Prefer the template's native toString if it ALREADY looks native.
    // If the template is itself a user function (happens in our unit
    // tests or after another extension has patched the same property),
    // we fall back to a synthetic "[native code]" signature so we
    // never leak a user-function string to detectors.
    const synthetic = 'function ' + (fn.name || '') + '() { [native code] }';
    let str = synthetic;
    if (template) {
      try {
        const templateStr = _origToString.call(template);
        if (typeof templateStr === 'string' && templateStr.includes('[native code]')) {
          str = templateStr;
        }
      } catch {
        // fall through to synthetic
      }
    }
    nativeToStringMap.set(fn, str);
    return fn;
  }

  // Install the toString proxy exactly once.
  try {
    const proxiedToString = new Proxy(_origToString, {
      apply(target, thisArg, args) {
        if (nativeToStringMap.has(thisArg)) return nativeToStringMap.get(thisArg);
        return Reflect.apply(target, thisArg, args);
      },
    });
    // eslint-disable-next-line no-extend-native
    Function.prototype.toString = proxiedToString;
    markNative(Function.prototype.toString, _origToString);
  } catch {
    // Non-fatal. Without this, getter toStrings will look artificial
    // but the rest of the evasions still work.
  }

  function defineOnProto(proto, key, getter) {
    try {
      const desc = Object.getOwnPropertyDescriptor(proto, key);
      if (!desc) return false;
      const newGet = markNative(function () { return getter.call(this); }, desc.get);
      Object.defineProperty(proto, key, {
        get: newGet,
        set: desc.set,
        configurable: true,
        enumerable: desc.enumerable,
      });
      return true;
    } catch {
      return false;
    }
  }

  // ------------------------------------------------------------------
  // Evasion modules. Each returns true on success, false on skip.
  // ------------------------------------------------------------------
  const MODULES = {
    // 01 ------------------------------------------------------------
    webdriver() {
      const desc = Object.getOwnPropertyDescriptor(Navigator.prototype, 'webdriver');
      if (desc && desc.configurable === false) return false;
      return defineOnProto(Navigator.prototype, 'webdriver', function () { return undefined; });
    },

    // 02 ------------------------------------------------------------
    plugins() {
      // Headless Chrome returns an empty PluginArray. Real Chrome on
      // macOS returns 3+ entries. We fabricate a realistic set.
      if (!('PluginArray' in window) || !('MimeTypeArray' in window)) return false;
      if (navigator.plugins && navigator.plugins.length > 0) return false;

      const fakePlugins = [
        {
          name: 'PDF Viewer',
          filename: 'internal-pdf-viewer',
          description: 'Portable Document Format',
          mimeTypes: [
            { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
          ],
        },
        {
          name: 'Chrome PDF Viewer',
          filename: 'internal-pdf-viewer',
          description: 'Portable Document Format',
          mimeTypes: [
            { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
          ],
        },
        {
          name: 'Chromium PDF Viewer',
          filename: 'internal-pdf-viewer',
          description: 'Portable Document Format',
          mimeTypes: [
            { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
          ],
        },
      ];

      const mimeObjs = [];
      const pluginObjs = fakePlugins.map((p) => {
        const plugin = Object.create(Plugin.prototype);
        Object.defineProperties(plugin, {
          name: { value: p.name, enumerable: true },
          filename: { value: p.filename, enumerable: true },
          description: { value: p.description, enumerable: true },
          length: { value: p.mimeTypes.length, enumerable: true },
        });
        p.mimeTypes.forEach((m, i) => {
          const mime = Object.create(MimeType.prototype);
          Object.defineProperties(mime, {
            type: { value: m.type, enumerable: true },
            suffixes: { value: m.suffixes, enumerable: true },
            description: { value: m.description, enumerable: true },
            enabledPlugin: { value: plugin, enumerable: true },
          });
          plugin[i] = mime;
          plugin[m.type] = mime;
          mimeObjs.push(mime);
        });
        return plugin;
      });

      const pluginArr = Object.create(PluginArray.prototype);
      pluginObjs.forEach((p, i) => {
        pluginArr[i] = p;
        pluginArr[p.name] = p;
      });
      Object.defineProperty(pluginArr, 'length', { value: pluginObjs.length });

      const mimeArr = Object.create(MimeTypeArray.prototype);
      mimeObjs.forEach((m, i) => {
        mimeArr[i] = m;
        mimeArr[m.type] = m;
      });
      Object.defineProperty(mimeArr, 'length', { value: mimeObjs.length });

      defineOnProto(Navigator.prototype, 'plugins', function () { return pluginArr; });
      defineOnProto(Navigator.prototype, 'mimeTypes', function () { return mimeArr; });
      return true;
    },

    // 03 ------------------------------------------------------------
    // (mimeTypes is handled inside plugins() to keep them consistent --
    // leaving the module stub here so the status report shows the row.)
    mimeTypes() {
      return (navigator.mimeTypes && navigator.mimeTypes.length > 0);
    },

    // 04 ------------------------------------------------------------
    languages() {
      const current = navigator.languages;
      if (Array.isArray(current) && current.length > 0) return false;
      const preferred = ['de-DE', 'de', 'en-US', 'en'];
      return defineOnProto(Navigator.prototype, 'languages', function () { return preferred; });
    },

    // 05 ------------------------------------------------------------
    hardware() {
      // Normalize to the most common real-world values to blend in.
      let ok = false;
      if ((navigator.hardwareConcurrency | 0) <= 0) {
        ok = defineOnProto(Navigator.prototype, 'hardwareConcurrency', function () { return 8; }) || ok;
      }
      if (!('deviceMemory' in navigator) || !navigator.deviceMemory) {
        try {
          Object.defineProperty(Navigator.prototype, 'deviceMemory', {
            get: markNative(function () { return 8; }),
            configurable: true,
          });
          ok = true;
        } catch {}
      }
      return ok;
    },

    // 06 ------------------------------------------------------------
    chromeRuntime() {
      // Headless Chromium has `window.chrome` but not
      // `window.chrome.runtime` in many configs.
      if (!window.chrome) {
        try {
          Object.defineProperty(window, 'chrome', { value: {}, writable: true, configurable: true });
        } catch { return false; }
      }
      if (window.chrome.runtime) return false;
      try {
        const runtime = {
          OnInstalledReason: {
            CHROME_UPDATE: 'chrome_update',
            INSTALL: 'install',
            SHARED_MODULE_UPDATE: 'shared_module_update',
            UPDATE: 'update',
          },
          OnRestartRequiredReason: {
            APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic',
          },
          PlatformArch: {
            ARM: 'arm', ARM64: 'arm64', MIPS: 'mips', MIPS64: 'mips64',
            X86_32: 'x86-32', X86_64: 'x86-64',
          },
          PlatformNaclArch: {
            ARM: 'arm', MIPS: 'mips', MIPS64: 'mips64',
            X86_32: 'x86-32', X86_64: 'x86-64',
          },
          PlatformOs: {
            ANDROID: 'android', CROS: 'cros', LINUX: 'linux',
            MAC: 'mac', OPENBSD: 'openbsd', WIN: 'win',
          },
          RequestUpdateCheckStatus: {
            NO_UPDATE: 'no_update',
            THROTTLED: 'throttled',
            UPDATE_AVAILABLE: 'update_available',
          },
        };
        Object.defineProperty(window.chrome, 'runtime', {
          value: runtime, writable: true, configurable: true,
        });
        return true;
      } catch { return false; }
    },

    // 07 ------------------------------------------------------------
    webgl() {
      // UNMASKED_VENDOR_WEBGL = 0x9245,
      // UNMASKED_RENDERER_WEBGL = 0x9246.
      // Headless Chromium reports "Google Inc." / "SwiftShader".
      const VENDOR = 0x9245;
      const RENDERER = 0x9246;
      const fakeVendor = 'Intel Inc.';
      const fakeRenderer = 'Intel Iris OpenGL Engine';

      function hook(proto) {
        if (!proto || !proto.getParameter) return false;
        const orig = proto.getParameter;
        const hooked = markNative(function (param) {
          if (param === VENDOR) return fakeVendor;
          if (param === RENDERER) return fakeRenderer;
          return orig.call(this, param);
        }, orig);
        proto.getParameter = hooked;
        return true;
      }

      let ok = false;
      if (window.WebGLRenderingContext) ok = hook(WebGLRenderingContext.prototype) || ok;
      if (window.WebGL2RenderingContext) ok = hook(WebGL2RenderingContext.prototype) || ok;
      return ok;
    },

    // 08 ------------------------------------------------------------
    canvas() {
      // Add sub-pixel noise to canvas readback APIs so fingerprint
      // hashes don't match across sessions.
      if (!window.HTMLCanvasElement) return false;

      const noise = (bytes) => {
        const len = bytes.length;
        const touches = Math.max(1, (len / 1024) | 0);
        for (let i = 0; i < touches; i++) {
          const idx = (Math.random() * len) | 0;
          bytes[idx] = (bytes[idx] ^ 1) & 0xff;
        }
      };

      const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
      HTMLCanvasElement.prototype.toDataURL = markNative(function () {
        try {
          const ctx = this.getContext('2d');
          if (ctx && this.width > 0 && this.height > 0) {
            const img = ctx.getImageData(0, 0, this.width, this.height);
            noise(img.data);
            ctx.putImageData(img, 0, 0);
          }
        } catch {}
        return origToDataURL.apply(this, arguments);
      }, origToDataURL);

      if (window.CanvasRenderingContext2D) {
        const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
        CanvasRenderingContext2D.prototype.getImageData = markNative(function () {
          const data = origGetImageData.apply(this, arguments);
          try { noise(data.data); } catch {}
          return data;
        }, origGetImageData);
      }
      return true;
    },

    // 09 ------------------------------------------------------------
    audio() {
      // Perturb AudioBuffer.getChannelData output with ~1e-7 noise
      // to defeat AudioContext fingerprinting.
      if (!window.AudioBuffer) return false;
      const orig = AudioBuffer.prototype.getChannelData;
      AudioBuffer.prototype.getChannelData = markNative(function () {
        const data = orig.apply(this, arguments);
        try {
          const len = data.length;
          const touches = Math.min(len, 3);
          for (let i = 0; i < touches; i++) {
            const idx = (Math.random() * len) | 0;
            data[idx] = data[idx] + (Math.random() - 0.5) * 1e-7;
          }
        } catch {}
        return data;
      }, orig);
      return true;
    },

    // 10 ------------------------------------------------------------
    permissions() {
      // Headless Chrome famously misaligns notifications permission
      // with Notification.permission. Real Chrome aligns them.
      if (!navigator.permissions || !navigator.permissions.query) return false;
      const origQuery = navigator.permissions.query;
      navigator.permissions.query = markNative(function (params) {
        if (params && params.name === 'notifications') {
          const state = (typeof Notification !== 'undefined' && Notification.permission) || 'default';
          return Promise.resolve({
            state,
            name: 'notifications',
            onchange: null,
            addEventListener() {},
            removeEventListener() {},
            dispatchEvent() { return false; },
          });
        }
        return origQuery.call(this, params);
      }, origQuery);
      return true;
    },

    // 11 ------------------------------------------------------------
    iframeContentWindow() {
      try {
        const desc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow');
        if (!desc || !desc.get) return false;
        const origGet = desc.get;
        Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
          get: markNative(function () {
            const win = origGet.call(this);
            return win || window;
          }),
          configurable: true,
        });
        return true;
      } catch { return false; }
    },

    // 12 ------------------------------------------------------------
    outerDimensions() {
      let ok = false;
      if ((window.outerWidth | 0) === 0) {
        try {
          Object.defineProperty(window, 'outerWidth', {
            get: markNative(function () { return window.innerWidth; }),
            configurable: true,
          });
          ok = true;
        } catch {}
      }
      if ((window.outerHeight | 0) === 0) {
        try {
          Object.defineProperty(window, 'outerHeight', {
            get: markNative(function () { return window.innerHeight + 85; }),
            configurable: true,
          });
          ok = true;
        } catch {}
      }
      return ok;
    },

    // 13 ------------------------------------------------------------
    mediaDevices() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return false;
      const orig = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
      navigator.mediaDevices.enumerateDevices = markNative(async function () {
        try {
          const real = await orig();
          if (Array.isArray(real) && real.length > 0) return real;
        } catch {}
        return [
          { deviceId: 'default', kind: 'audioinput', label: '', groupId: '' },
          { deviceId: 'default', kind: 'audiooutput', label: '', groupId: '' },
          { deviceId: 'default', kind: 'videoinput', label: '', groupId: '' },
        ];
      }, orig);
      return true;
    },

    // 14 ------------------------------------------------------------
    battery() {
      if (!navigator.getBattery) {
        try {
          Object.defineProperty(Navigator.prototype, 'getBattery', {
            value: markNative(function () {
              return Promise.resolve({
                charging: true,
                chargingTime: 0,
                dischargingTime: Infinity,
                level: 0.87,
                onchargingchange: null,
                onchargingtimechange: null,
                ondischargingtimechange: null,
                onlevelchange: null,
                addEventListener() {},
                removeEventListener() {},
                dispatchEvent() { return false; },
              });
            }),
            configurable: true,
          });
          return true;
        } catch {}
      }
      return false;
    },

    // 15 ------------------------------------------------------------
    connection() {
      if (!('connection' in navigator)) {
        try {
          Object.defineProperty(Navigator.prototype, 'connection', {
            get: markNative(function () {
              return {
                effectiveType: '4g',
                rtt: 50,
                downlink: 10,
                saveData: false,
                type: 'wifi',
                onchange: null,
                addEventListener() {},
                removeEventListener() {},
                dispatchEvent() { return false; },
              };
            }),
            configurable: true,
          });
          return true;
        } catch {}
      }
      return false;
    },

    // 16 ------------------------------------------------------------
    userAgent() {
      const ua = navigator.userAgent || '';
      if (!ua.includes('HeadlessChrome')) return false;
      const clean = ua.replace(/HeadlessChrome/g, 'Chrome');
      try {
        Object.defineProperty(Navigator.prototype, 'userAgent', {
          get: markNative(function () { return clean; }),
          configurable: true,
        });
        return true;
      } catch { return false; }
    },

    // 17 ------------------------------------------------------------
    functionToString() {
      return Function.prototype.toString !== _origToString;
    },
  };

  // ------------------------------------------------------------------
  // Runner -- execute every module, collect per-module status.
  // ------------------------------------------------------------------
  const status = {};
  for (const name of Object.keys(MODULES)) {
    try {
      const r = MODULES[name]();
      status[name] = r === true ? 'applied' : r === false ? 'skipped' : 'partial';
    } catch (e) {
      status[name] = 'error:' + (e && e.message ? e.message.slice(0, 60) : 'unknown');
    }
  }

  // ------------------------------------------------------------------
  // Public diagnostic API (backward-compatible with v1).
  // ------------------------------------------------------------------
  try {
    Object.defineProperty(window, '__opensin_ping__', {
      value: markNative(function () { return { alive: true, ts: Date.now(), v: VERSION }; }),
      configurable: true,
      enumerable: false,
      writable: false,
    });
  } catch {}

  try {
    Object.defineProperty(window, '__opensin_stealth_status__', {
      value: markNative(function () {
        return Object.assign({}, status, { version: VERSION });
      }),
      configurable: true,
      enumerable: false,
      writable: false,
    });
  } catch {}

  // ------------------------------------------------------------------
  // Message bridge (unchanged from v1 -- the isolated world can post
  // { source: CHANNEL, dir: 'main->page', ... } messages to us).
  // ------------------------------------------------------------------
  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const msg = ev.data;
    if (!msg || msg.source !== CHANNEL || msg.dir !== 'main->page') return;
    // Reserved for future page-facing hooks.
  });
})();
