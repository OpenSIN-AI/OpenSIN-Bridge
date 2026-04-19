/**
 * Typed error taxonomy for the bridge.
 *
 * Every failure the RPC layer surfaces to callers must be a BridgeError with a
 * stable `code`. Callers can branch on those codes; operators see consistent
 * diagnostic output. Unknown thrown values are wrapped in INTERNAL_ERROR.
 */

export const ERROR_CODES = Object.freeze({
  INVALID_INPUT: 'INVALID_INPUT',
  UNKNOWN_TOOL: 'UNKNOWN_TOOL',
  RATE_LIMITED: 'RATE_LIMITED',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  PRECONDITION_FAILED: 'PRECONDITION_FAILED',
  TIMEOUT: 'TIMEOUT',
  CDP_FAILED: 'CDP_FAILED',
  TAB_GONE: 'TAB_GONE',
  NATIVE_HOST_UNAVAILABLE: 'NATIVE_HOST_UNAVAILABLE',
  VISION_UNAVAILABLE: 'VISION_UNAVAILABLE',
  TRANSPORT_ERROR: 'TRANSPORT_ERROR',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
});

export class BridgeError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = 'BridgeError';
    this.code = ERROR_CODES[code] ? code : ERROR_CODES.INTERNAL_ERROR;
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

export function assert(condition, code, message, data) {
  if (!condition) throw new BridgeError(code, message, data);
}

export function invalid(message, data) {
  throw new BridgeError(ERROR_CODES.INVALID_INPUT, message, data);
}
