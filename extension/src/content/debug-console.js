/**
 * debug-console.js — console capture for the debug-trace tool.
 *
 * Runs in the MAIN world at document_start (see manifest.content_scripts).
 * Installs non-enumerable hooks on console.error / console.warn and
 * window.onerror / unhandledrejection, writes structured records into a
 * ring buffer exposed as window.__OPENSIN_DEBUG_CONSOLE__.
 *
 * The buffer is opaque from the page's point of view: the property is
 * non-enumerable, non-writable and non-configurable, and the capture
 * code never references the page's own globals. A page cannot detect
 * the hook via console.error.toString() because we mark the hook with
 * the native-toString trick owned by stealth-main.js (same world —
 * cooperative).
 *
 * The tools/debug.js handler reads __OPENSIN_DEBUG_CONSOLE__ back out via
 * chrome.scripting.executeScript + world: "MAIN".
 */

(() => {
  if (window.__OPENSIN_DEBUG_CONSOLE__) return; // idempotent

  const BUFFER_CAPACITY = 200;
  const buffer = [];
  let seq = 0;

  function record(level, argsArray, source) {
    try {
      // Serialize args defensively. console.error(new Error(...)) is the
      // common case and structuredClone can't ship Error to the SW, so we
      // coerce to { name, message, stack } first.
      const args = Array.prototype.map.call(argsArray, (a) => {
        if (a instanceof Error) {
          return { __error__: true, name: a.name, message: a.message, stack: a.stack };
        }
        if (a === null || a === undefined) return a;
        const t = typeof a;
        if (t === "string" || t === "number" || t === "boolean") return a;
        try {
          // Stringify once, parse back, so we get a clonable tree.
          return JSON.parse(JSON.stringify(a));
        } catch {
          try {
            return String(a);
          } catch {
            return "[unserializable]";
          }
        }
      });

      buffer.push({
        seq: ++seq,
        timestamp: Date.now(),
        level,
        source, // "console" | "window-error" | "unhandledrejection"
        args,
        url: document.location.href,
      });
      if (buffer.length > BUFFER_CAPACITY) buffer.shift();
    } catch {
      // Never let our own bookkeeping crash the page.
    }
  }

  const _origError = console.error;
  const _origWarn = console.warn;

  const patchedError = function () {
    record("error", arguments, "console");
    try {
      return _origError.apply(console, arguments);
    } catch {
      /* noop */
    }
  };
  const patchedWarn = function () {
    record("warn", arguments, "console");
    try {
      return _origWarn.apply(console, arguments);
    } catch {
      /* noop */
    }
  };

  // Try to inherit the stealth-main.js nativeToString marker if it is
  // already loaded. If it is not, our toString will look non-native,
  // but that is a harmless signal — stealth-main covers that anyway.
  try {
    const marker = window.__OPENSIN_STEALTH__ && window.__OPENSIN_STEALTH__.markNative;
    if (typeof marker === "function") {
      marker(patchedError, _origError);
      marker(patchedWarn, _origWarn);
    }
  } catch {
    /* noop */
  }

  console.error = patchedError;
  console.warn = patchedWarn;

  // Global error + promise rejection capture.
  window.addEventListener(
    "error",
    (ev) => {
      record(
        "error",
        [
          {
            message: ev.message,
            filename: ev.filename,
            lineno: ev.lineno,
            colno: ev.colno,
            error: ev.error && {
              name: ev.error.name,
              message: ev.error.message,
              stack: ev.error.stack,
            },
          },
        ],
        "window-error",
      );
    },
    true,
  );

  window.addEventListener(
    "unhandledrejection",
    (ev) => {
      const reason = ev.reason;
      record(
        "error",
        [
          reason instanceof Error
            ? { __error__: true, name: reason.name, message: reason.message, stack: reason.stack }
            : reason,
        ],
        "unhandledrejection",
      );
    },
    true,
  );

  function snapshot(limit) {
    const n = typeof limit === "number" && limit > 0 ? limit : buffer.length;
    return buffer.slice(-n);
  }

  function clear() {
    buffer.length = 0;
    seq = 0;
  }

  // Expose buffer + helpers as a non-enumerable, non-configurable surface.
  // Non-configurable is critical: a hostile page script cannot Object.defineProperty
  // over it, can't delete it, and can't redefine its getter.
  try {
    Object.defineProperty(window, "__OPENSIN_DEBUG_CONSOLE__", {
      value: Object.freeze({
        get capacity() {
          return BUFFER_CAPACITY;
        },
        get size() {
          return buffer.length;
        },
        snapshot,
        clear,
      }),
      enumerable: false,
      writable: false,
      configurable: false,
    });
  } catch {
    // If a prior define call placed something here (should not happen due
    // to the idempotency guard at the top), leave it.
  }
})();
