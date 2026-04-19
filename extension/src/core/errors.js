/**
 * Typed error taxonomy for the bridge.
 *
 * Every failure the RPC layer surfaces to callers must be a BridgeError with a
 * stable `code`. Callers can branch on those codes; operators see consistent
 * diagnostic output.
 *
 * The constructor tolerates two calling conventions so older call sites keep
 * working:
 *   new BridgeError(code, message, data?)      // preferred
 *   new BridgeError(message, code, data?)      // also accepted
 * It inspects the arguments: the one that matches a known code wins as code.
 */

export const ERROR_CODES = Object.freeze({
  INVALID_INPUT: 'INVALID_INPUT',
  INVALID_ARGS: 'INVALID_INPUT', // alias
  UNKNOWN_TOOL: 'UNKNOWN_TOOL',
  METHOD_NOT_FOUND: 'UNKNOWN_TOOL', // alias
  RATE_LIMITED: 'RATE_LIMITED',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  PRECONDITION_FAILED: 'PRECONDITION_FAILED',
  TIMEOUT: 'TIMEOUT',
  CDP_FAILED: 'CDP_FAILED',
  TAB_GONE: 'TAB_GONE',
  NATIVE_HOST_UNAVAILABLE: 'NATIVE_HOST_UNAVAILABLE',
  OFFSCREEN_ERROR: 'OFFSCREEN_ERROR',
  OFFSCREEN_UNAVAILABLE: 'OFFSCREEN_UNAVAILABLE',
  UNSUPPORTED: 'UNSUPPORTED',
  NAVIGATION_FAILED: 'NAVIGATION_FAILED',
  NETWORK: 'NETWORK',
  VISION_UNAVAILABLE: 'VISION_UNAVAILABLE',
  TRANSPORT_ERROR: 'TRANSPORT_ERROR',
  INTERNAL: 'INTERNAL_ERROR', // alias
  INTERNAL_ERROR: 'INTERNAL_ERROR',
});

// Alias export to match the second (PascalCase enum-style) convention used in
// some tool modules.
export const ErrorCode = ERROR_CODES;

const KNOWN_CODES = new Set(Object.values(ERROR_CODES));

function isKnownCode(value) {
  return typeof value === 'string' && KNOWN_CODES.has(value);
}

export class BridgeError extends Error {
  constructor(a, b, data) {
    // Figure out which arg is the code. Both orders are accepted.
    let code;
    let message;
    if (isKnownCode(a)) {
      code = a;
      message = typeof b === 'string' ? b : String(b ?? code);
    } else if (isKnownCode(b)) {
      code = b;
      message = typeof a === 'string' ? a : String(a ?? code);
    } else if (typeof a === 'string' && typeof b === 'string') {
      // Neither matches a known code — best effort: prefer upper-snake as code.
      if (/^[A-Z_]+$/.test(b) && !/^[A-Z_]+$/.test(a)) {
        code = b;
        message = a;
      } else if (/^[A-Z_]+$/.test(a) && !/^[A-Z_]+$/.test(b)) {
        code = a;
        message = b;
      } else {
        code = ERROR_CODES.INTERNAL_ERROR;
        message = a;
      }
    } else {
      code = ERROR_CODES.INTERNAL_ERROR;
      message = typeof a === 'string' ? a : 'Unknown error';
    }

    super(message);
    this.name = 'BridgeError';
    this.code = code;
    if (data !== undefined) this.data = data;
  }

  toJSON() {
    const envelope = { error: { code: this.code, message: this.message } };
    if (this.data !== undefined) envelope.error.data = this.data;
    return envelope;
  }
}

/**
 * Wrap any thrown value into a BridgeError. Keeps BridgeError instances as-is.
 */
export function toBridgeError(value, fallbackCode = ERROR_CODES.INTERNAL_ERROR) {
  if (value instanceof BridgeError) return value;
  if (value instanceof Error) {
    return new BridgeError(fallbackCode, value.message || String(value));
  }
  return new BridgeError(fallbackCode, typeof value === 'string' ? value : 'Unknown error');
}

/**
 * Alias used throughout the tools modules.
 */
export function asError(value) {
  return toBridgeError(value);
}

export function assert(condition, code, message, data) {
  if (!condition) throw new BridgeError(code, message, data);
}

/**
 * invariant(condition, message, code = INVALID_INPUT, data?)
 *   — conventional call used by tool modules. The code arg is optional and
 *   defaults to INVALID_INPUT. Arg-order tolerant: if arg 3 isn't a known
 *   code, we treat arg 2 as the code.
 */
export function invariant(condition, message, code = ERROR_CODES.INVALID_INPUT, data) {
  if (condition) return;
  let finalCode = code;
  let finalMessage = message;
  if (!isKnownCode(finalCode) && isKnownCode(finalMessage)) {
    finalCode = finalMessage;
    finalMessage = code;
  }
  if (!isKnownCode(finalCode)) finalCode = ERROR_CODES.INVALID_INPUT;
  throw new BridgeError(finalCode, finalMessage || 'Invariant violated', data);
}

export function invalid(message, data) {
  throw new BridgeError(ERROR_CODES.INVALID_INPUT, message, data);
}
