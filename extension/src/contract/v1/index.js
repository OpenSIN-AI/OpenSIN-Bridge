/**
 * OpenSIN-Bridge Contract v1
 * ==========================================================================
 *
 * Versioned, machine-readable contract between the Bridge (Chrome extension
 * + server) and any worker that drives it. Implements the deliverables of
 * issue #69 (worker-repo) on the Bridge side:
 *
 *   - command/event schema (namespaces, params, returns, idempotency)
 *   - idempotent vs non-idempotent action model
 *   - error taxonomy (`transport_error`, `target_gone`, `navigation_aborted`,
 *     `anti_bot_challenge`, ...)
 *   - retry-policy hints separated from business-recovery policy
 *
 * Design choices:
 *
 *   - The contract is data, not code. It is consumed by:
 *       1. `extension/src/tools/contract.js` (exposed as `bridge.contract`)
 *       2. `scripts/validate-bridge-contract.mjs` (CI guard)
 *       3. The worker-side counterpart in heypiggy `bridge_contract.py`
 *   - The contract DOES NOT replace the existing tool registry. It declares
 *     the public surface area the bridge guarantees and how callers should
 *     classify failures.
 *   - Adding a new contract version means: bump VERSION, copy this file to
 *     `extension/src/contract/v2/index.js`, and keep v1 frozen forever.
 *
 * Stability rules:
 *   - Removing a method or namespace is a MAJOR change → new version file.
 *   - Adding a method or making a non-idempotent method idempotent is a
 *     MINOR change → bump `revision`.
 *   - Editing wording / docs only is a PATCH change → no revision bump.
 */

export const VERSION = "opensin.bridge.contract/v1"
export const REVISION = 1

/**
 * Stable error taxonomy. The string codes are part of the public contract
 * and must never be repurposed. Workers branch on these codes to decide
 * between retry, recovery, or abort.
 */
export const ERROR_CODES = Object.freeze({
  // ----- transport / RPC envelope ------------------------------------------
  TRANSPORT_ERROR: "transport_error",
  RPC_INVALID: "rpc_invalid",
  UNKNOWN_METHOD: "unknown_method",
  RATE_LIMITED: "rate_limited",
  TIMEOUT: "timeout",

  // ----- browser surface ----------------------------------------------------
  TARGET_GONE: "target_gone", // tab closed / detached during call
  NAVIGATION_ABORTED: "navigation_aborted",
  NAVIGATION_TIMEOUT: "navigation_timeout",
  CDP_FAILED: "cdp_failed",
  FRAME_DETACHED: "frame_detached",

  // ----- DOM / interaction -------------------------------------------------
  ELEMENT_NOT_FOUND: "element_not_found",
  ELEMENT_NOT_ACTIONABLE: "element_not_actionable",
  POSTCONDITION_FAILED: "postcondition_failed",
  DUPLICATE_ACTION: "duplicate_action",

  // ----- authentication / session ------------------------------------------
  SESSION_INVALID: "session_invalid",
  SESSION_STALE: "session_stale",
  SESSION_LOCKED: "session_locked",
  ORIGIN_NOT_PERMITTED: "origin_not_permitted",

  // ----- adversarial environment -------------------------------------------
  ANTI_BOT_CHALLENGE: "anti_bot_challenge",
  CAPTCHA_REQUIRED: "captcha_required",
  RATE_LIMIT_REMOTE: "rate_limit_remote",

  // ----- bridge internals --------------------------------------------------
  PRECONDITION_FAILED: "precondition_failed",
  UNSUPPORTED: "unsupported",
  INTERNAL_ERROR: "internal_error",
})

/**
 * Retry hints expressed at the contract layer. These are not policies — the
 * worker still owns the final decision — but they tell the worker what kind
 * of failure it just saw.
 *
 *   safe_retry      → idempotent, retry without side effects
 *   recover_then_retry → re-acquire context (session, frame, tab) first
 *   abort           → never retry, escalate to a higher policy
 */
export const RETRY_HINTS = Object.freeze({
  [ERROR_CODES.TRANSPORT_ERROR]: "safe_retry",
  [ERROR_CODES.RPC_INVALID]: "abort",
  [ERROR_CODES.UNKNOWN_METHOD]: "abort",
  [ERROR_CODES.RATE_LIMITED]: "safe_retry",
  [ERROR_CODES.TIMEOUT]: "safe_retry",

  [ERROR_CODES.TARGET_GONE]: "recover_then_retry",
  [ERROR_CODES.NAVIGATION_ABORTED]: "recover_then_retry",
  [ERROR_CODES.NAVIGATION_TIMEOUT]: "safe_retry",
  [ERROR_CODES.CDP_FAILED]: "recover_then_retry",
  [ERROR_CODES.FRAME_DETACHED]: "recover_then_retry",

  [ERROR_CODES.ELEMENT_NOT_FOUND]: "abort",
  [ERROR_CODES.ELEMENT_NOT_ACTIONABLE]: "safe_retry",
  [ERROR_CODES.POSTCONDITION_FAILED]: "abort",
  [ERROR_CODES.DUPLICATE_ACTION]: "abort",

  [ERROR_CODES.SESSION_INVALID]: "recover_then_retry",
  [ERROR_CODES.SESSION_STALE]: "recover_then_retry",
  [ERROR_CODES.SESSION_LOCKED]: "abort",
  [ERROR_CODES.ORIGIN_NOT_PERMITTED]: "abort",

  [ERROR_CODES.ANTI_BOT_CHALLENGE]: "recover_then_retry",
  [ERROR_CODES.CAPTCHA_REQUIRED]: "abort",
  [ERROR_CODES.RATE_LIMIT_REMOTE]: "safe_retry",

  [ERROR_CODES.PRECONDITION_FAILED]: "abort",
  [ERROR_CODES.UNSUPPORTED]: "abort",
  [ERROR_CODES.INTERNAL_ERROR]: "abort",
})

/**
 * Translation table from internal extension BridgeError codes (see
 * `extension/src/core/errors.js`) to the public contract codes. The bridge
 * error taxonomy was grown organically; this table is the single mapping
 * point so downstream callers always see a stable contract code.
 */
export const INTERNAL_TO_CONTRACT = Object.freeze({
  TRANSPORT_ERROR: ERROR_CODES.TRANSPORT_ERROR,
  TIMEOUT: ERROR_CODES.TIMEOUT,
  RATE_LIMITED: ERROR_CODES.RATE_LIMITED,
  UNKNOWN_TOOL: ERROR_CODES.UNKNOWN_METHOD,
  METHOD_NOT_FOUND: ERROR_CODES.UNKNOWN_METHOD,
  INVALID_INPUT: ERROR_CODES.RPC_INVALID,
  INVALID_ARGS: ERROR_CODES.RPC_INVALID,
  PRECONDITION_FAILED: ERROR_CODES.PRECONDITION_FAILED,
  TAB_GONE: ERROR_CODES.TARGET_GONE,
  CDP_FAILED: ERROR_CODES.CDP_FAILED,
  NAVIGATION_FAILED: ERROR_CODES.NAVIGATION_ABORTED,
  NETWORK: ERROR_CODES.TRANSPORT_ERROR,
  NOT_FOUND: ERROR_CODES.ELEMENT_NOT_FOUND,
  UNAUTHORIZED: ERROR_CODES.SESSION_INVALID,
  FORBIDDEN: ERROR_CODES.ORIGIN_NOT_PERMITTED,
  UNSUPPORTED: ERROR_CODES.UNSUPPORTED,
  NATIVE_HOST_UNAVAILABLE: ERROR_CODES.TRANSPORT_ERROR,
  OFFSCREEN_ERROR: ERROR_CODES.INTERNAL_ERROR,
  OFFSCREEN_UNAVAILABLE: ERROR_CODES.UNSUPPORTED,
  VISION_UNAVAILABLE: ERROR_CODES.UNSUPPORTED,
  INTERNAL_ERROR: ERROR_CODES.INTERNAL_ERROR,
})

/**
 * Public namespaces the bridge advertises. Each entry declares whether its
 * methods are read-only (always idempotent) or include mutating operations
 * (need the per-method `idempotent` flag).
 */
export const NAMESPACES = Object.freeze([
  { name: "bridge", category: "meta", description: "Contract, capabilities, evidence." },
  { name: "system", category: "meta", description: "Health, version, capabilities." },
  { name: "tabs", category: "browser", description: "Tab lifecycle." },
  { name: "nav", category: "browser", description: "Navigation primitives." },
  { name: "dom", category: "browser", description: "DOM read + interaction." },
  { name: "cookies", category: "state", description: "Cookie jar." },
  { name: "storage", category: "state", description: "Web storage." },
  { name: "net", category: "browser", description: "Network observation + control." },
  { name: "session", category: "state", description: "Session manifest, restore, invalidate." },
  { name: "behavior", category: "evidence", description: "Behavior timeline." },
  { name: "stealth", category: "browser", description: "Stealth posture + assessment." },
])

/**
 * Per-method declarations. Only methods that are part of the v1 contract
 * appear here; legacy aliases stay outside the contract intentionally.
 *
 * Schema (per entry):
 *   name           string  — fully qualified tool name (`namespace.method`)
 *   idempotent     boolean — true when retrying with same params is safe
 *   mutates        boolean — true when the method changes browser state
 *   description    string  — short human description
 *   params         object  — JSON-schema-ish hint (optional fields shown as `?`)
 *   returns        object  — return shape hint
 *   raises         array   — contract error codes the method may raise
 */
export const METHODS = Object.freeze([
  // ----- bridge meta --------------------------------------------------------
  m("bridge.contract", true, false, "Return the active bridge contract.", {}, { contract: "object" }, []),
  m("bridge.evidenceBundle", true, false,
    "Assemble a forensic evidence bundle (screenshot, DOM snapshot, console, network, command history).",
    { tabId: "?number", traceId: "?string", includeScreenshot: "?boolean", maxNetworkEvents: "?number" },
    { bundle: "object" },
    [ERROR_CODES.TARGET_GONE, ERROR_CODES.CDP_FAILED, ERROR_CODES.INTERNAL_ERROR],
  ),

  // ----- system -------------------------------------------------------------
  m("system.health", true, false, "Bridge health snapshot.", {}, { ok: "boolean" }, []),
  m("system.version", true, false, "Bridge version + protocol info.", {}, { version: "string" }, []),
  m("system.capabilities", true, false, "Discovery: list of registered tools.", {}, { tools: "array" }, []),
  m("system.ping", true, false, "Liveness probe.", {}, { pong: "boolean" }, []),

  // ----- tabs ---------------------------------------------------------------
  m("tabs.list", true, false, "List open tabs.", {}, { tabs: "array" }, []),
  m("tabs.get", true, false, "Get a single tab by id.", { tabId: "number" }, { tab: "object" }, [ERROR_CODES.TARGET_GONE]),
  m("tabs.create", false, true, "Create a new tab.", { url: "string", active: "?boolean" }, { tab: "object" }, [ERROR_CODES.RPC_INVALID]),
  m("tabs.close", false, true, "Close one or more tabs.", { tabIds: "array<number>" }, { ok: "boolean" }, []),
  m("tabs.activate", true, true, "Activate a tab. Idempotent: same tabId twice is harmless.", { tabId: "number" }, { ok: "boolean" }, [ERROR_CODES.TARGET_GONE]),
  m("tabs.reload", false, true, "Reload tab.", { tabId: "?number" }, { ok: "boolean" }, [ERROR_CODES.TARGET_GONE]),

  // ----- navigation ---------------------------------------------------------
  m("nav.goto", false, true, "Navigate the active tab. Not idempotent: SPAs may build different state per navigation.", { url: "string", tabId: "?number", waitUntil: "?string", timeoutMs: "?number" }, { url: "string" }, [ERROR_CODES.NAVIGATION_ABORTED, ERROR_CODES.NAVIGATION_TIMEOUT, ERROR_CODES.RPC_INVALID]),
  m("nav.back", false, true, "Go back in history.", { tabId: "?number" }, { ok: "boolean" }, [ERROR_CODES.TARGET_GONE]),
  m("nav.forward", false, true, "Go forward in history.", { tabId: "?number" }, { ok: "boolean" }, [ERROR_CODES.TARGET_GONE]),
  m("nav.reload", false, true, "Reload tab.", { tabId: "?number" }, { ok: "boolean" }, [ERROR_CODES.TARGET_GONE]),
  m("nav.waitForSelector", true, false, "Wait until a selector resolves.", { selector: "string", state: "?string", timeoutMs: "?number" }, { ok: "boolean" }, [ERROR_CODES.TIMEOUT, ERROR_CODES.ELEMENT_NOT_FOUND]),

  // ----- dom (read-only is idempotent, mutating is NOT) ---------------------
  m("dom.snapshot", true, false, "Accessibility snapshot of the page.", { mode: "?string", maxNodes: "?number" }, { snapshot: "object" }, [ERROR_CODES.TARGET_GONE]),
  m("dom.resolve", true, false,
    "Resolve one or more candidate elements by role + accessible name + ancestor hints. Returns ranked matches with stable refs and ambiguity flag.",
    { role: "?string", name: "?string", nameMatch: "?string", ancestor: "?object", testId: "?string", attributes: "?object", visibleOnly: "?boolean", limit: "?number" },
    { matches: "array", ambiguous: "boolean" },
    [ERROR_CODES.TARGET_GONE, ERROR_CODES.ELEMENT_NOT_FOUND],
  ),
  m("dom.waitForSelector", true, false,
    "Wait until a selector matches in the given state (attached|visible|hidden|detached). Idempotent polling.",
    { selector: "string", state: "?string", timeoutMs: "?number" },
    { ok: "boolean" },
    [ERROR_CODES.TIMEOUT, ERROR_CODES.TARGET_GONE],
  ),
  m("dom.fullSnapshot", true, false, "Full observation snapshot with screenshot.", { maxNodes: "?number" }, { snapshot: "object" }, [ERROR_CODES.TARGET_GONE, ERROR_CODES.CDP_FAILED]),
  m("dom.click", false, true, "Click a referenced or selected element.", { selector: "?string", ref: "?string" }, { ok: "boolean", proofId: "?string" }, [ERROR_CODES.ELEMENT_NOT_FOUND, ERROR_CODES.ELEMENT_NOT_ACTIONABLE, ERROR_CODES.POSTCONDITION_FAILED, ERROR_CODES.DUPLICATE_ACTION]),
  m("dom.type", false, true, "Type text into an element.", { selector: "?string", ref: "?string", text: "string" }, { ok: "boolean" }, [ERROR_CODES.ELEMENT_NOT_FOUND, ERROR_CODES.ELEMENT_NOT_ACTIONABLE]),
  m("dom.fill", false, true, "Fill many fields at once.", { fields: "object" }, { ok: "boolean" }, [ERROR_CODES.ELEMENT_NOT_FOUND]),
  m("dom.select", false, true, "Select option in a <select>.", { selector: "?string", value: "?string|array" }, { ok: "boolean" }, [ERROR_CODES.ELEMENT_NOT_FOUND]),
  m("dom.getText", true, false, "Read text content.", { selector: "?string", ref: "?string" }, { text: "string" }, [ERROR_CODES.ELEMENT_NOT_FOUND]),
  m("dom.getAttribute", true, false, "Read attribute.", { selector: "?string", name: "string" }, { value: "string|null" }, [ERROR_CODES.ELEMENT_NOT_FOUND]),
  m("dom.evaluate", false, false, "Evaluate JS expression in the page. Not idempotent: side effects allowed.", { expression: "string", args: "?array" }, { result: "any" }, [ERROR_CODES.RPC_INVALID]),
  m("dom.screenshot", true, false, "Capture screenshot of the active tab.", { fullPage: "?boolean", format: "?string" }, { dataUrl: "string" }, [ERROR_CODES.CDP_FAILED]),

  // ----- cookies + storage --------------------------------------------------
  m("cookies.getAll", true, false, "Read cookies.", { domain: "?string" }, { cookies: "array" }, []),
  m("cookies.set", true, true, "Set a cookie. Idempotent for same key.", { cookie: "object" }, { ok: "boolean" }, [ERROR_CODES.RPC_INVALID]),
  m("cookies.remove", true, true, "Remove a cookie.", { url: "string", name: "string" }, { ok: "boolean" }, []),
  m("cookies.clearForDomain", false, true, "Clear all cookies for a domain.", { domain: "string" }, { ok: "boolean" }, []),
  m("storage.local.get", true, false, "Read localStorage.", { keys: "?array" }, { data: "object" }, []),
  m("storage.local.set", true, true, "Write localStorage.", { data: "object" }, { ok: "boolean" }, [ERROR_CODES.RPC_INVALID]),
  m("storage.local.clear", false, true, "Clear localStorage.", {}, { ok: "boolean" }, []),

  // ----- network ------------------------------------------------------------
  m("net.events", true, false, "Read recent network events.", { since: "?number", limit: "?number" }, { events: "array" }, []),
  m("net.observe", true, true, "Start network observation.", {}, { ok: "boolean" }, []),
  m("net.stop", true, true, "Stop network observation + clear buffer.", {}, { ok: "boolean" }, []),
  m("net.block", true, true, "Block URL patterns.", { urlPatterns: "array" }, { ok: "boolean" }, [ERROR_CODES.RPC_INVALID]),

  // ----- session ------------------------------------------------------------
  m("session.capture", true, false, "Capture current browser session.", { includeStorage: "?boolean", includeCookies: "?boolean" }, { snapshot: "object" }, []),
  m("session.restore", false, true, "Restore a captured session.", { snapshot: "object", mode: "?string" }, { ok: "boolean" }, [ERROR_CODES.RPC_INVALID, ERROR_CODES.SESSION_INVALID]),
  m("session.manifest", true, false, "Build a session manifest with TTL, origin scope, last-known-good and invalidation reason.", { origin: "?string", tabId: "?number", ttlSeconds: "?number" }, { manifest: "object" }, []),
  m("session.invalidate", true, true, "Mark the active session manifest invalid with classified reason.", { reason: "string", origin: "?string" }, { ok: "boolean" }, [ERROR_CODES.RPC_INVALID]),
  m("session.lastKnownGood", true, false, "Return the most recent known-good session manifest for an origin.", { origin: "string" }, { manifest: "object|null" }, []),
  m("session.health", true, false, "Probe the active session against an origin.", { origin: "string", probeUrl: "?string" }, { health: "object" }, [ERROR_CODES.SESSION_INVALID, ERROR_CODES.SESSION_STALE]),

  // ----- behavior ----------------------------------------------------------
  m("behavior.start", true, true, "Start a behavior recording session.", { scope: "?string", tabId: "?number" }, { ok: "boolean" }, []),
  m("behavior.stop", true, true, "Stop the behavior recording session.", {}, { ok: "boolean" }, []),
  m("behavior.status", true, false, "Behavior recorder status.", {}, { recording: "boolean" }, []),
  m("behavior.list", true, false, "List recorded behavior sessions.", {}, { sessions: "array" }, []),
  m("behavior.get", true, false, "Get a single recorded behavior session.", { sessionId: "string" }, { session: "object" }, [ERROR_CODES.ELEMENT_NOT_FOUND]),

  // ----- stealth ------------------------------------------------------------
  m("stealth.status", true, false, "Stealth subsystem status.", {}, { status: "object" }, []),
  m("stealth.assess", true, false,
    "Score environment coherence (locale, timezone, viewport, fingerprint, anti-bot signals).",
    { tabId: "?number" },
    { assessment: "object" },
    [ERROR_CODES.TARGET_GONE, ERROR_CODES.CDP_FAILED],
  ),
  m("stealth.detectChallenge", true, false,
    "Detect anti-bot challenges (Cloudflare, Turnstile, reCAPTCHA, hCaptcha, DataDome, ...) on the active page.",
    { tabId: "?number" },
    { challenges: "object" },
    [ERROR_CODES.TARGET_GONE],
  ),
])

function m(name, idempotent, mutates, description, params, returns, raises) {
  return Object.freeze({
    name,
    idempotent,
    mutates,
    description,
    params,
    returns,
    raises,
    retryHint: idempotent ? "safe_retry" : "abort",
  })
}

/**
 * Build the public contract object. Returned by `bridge.contract`.
 */
export function buildContract() {
  return {
    version: VERSION,
    revision: REVISION,
    generatedAt: new Date().toISOString(),
    namespaces: NAMESPACES,
    methods: METHODS,
    errorCodes: Object.values(ERROR_CODES),
    retryHints: RETRY_HINTS,
    internalToContract: INTERNAL_TO_CONTRACT,
    notes: {
      idempotency:
        "An idempotent method is safe to retry with the same params after a transient failure. Non-idempotent methods MUST NOT be blindly retried; the worker has to decide based on postconditions.",
      retryHints:
        "`safe_retry` allows a fast loop with backoff; `recover_then_retry` requires the worker to re-acquire context (session, frame, tab); `abort` requires escalation.",
      stability:
        "Within v1 the bridge guarantees no method or error code is removed. Additions bump `revision`.",
    },
  }
}

/**
 * Lookup helper for tools/middleware: given an internal BridgeError code,
 * return the public contract code. Falls back to INTERNAL_ERROR.
 */
export function toContractCode(internalCode) {
  if (typeof internalCode !== "string") return ERROR_CODES.INTERNAL_ERROR
  return INTERNAL_TO_CONTRACT[internalCode] || ERROR_CODES.INTERNAL_ERROR
}

/**
 * Lookup the contract entry for a public method name.
 */
export function findMethod(name) {
  if (typeof name !== "string") return null
  return METHODS.find((entry) => entry.name === name) || null
}

/**
 * Returns true if calling the given method twice with the same params is
 * safe. Used by the worker-side retry loop.
 */
export function isIdempotent(name) {
  const entry = findMethod(name)
  return !!entry?.idempotent
}
