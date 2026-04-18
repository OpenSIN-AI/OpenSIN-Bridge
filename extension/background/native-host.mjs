/**
 * Shared native-host constants and validators.
 *
 * This file stays dependency-light so it can be imported by the MV3 service
 * worker and by node-based tests without any Chrome runtime present.
 */
export const NATIVE_HOST_NAME = 'ai.opensin.bridge.host';
export const NATIVE_HOST_CONTEXT = 'authenticated-session';
export const NATIVE_HOST_IDLE_TIMEOUT_MS = 120000;
export const NATIVE_HOST_REQUEST_TIMEOUT_MS = 20000;
export const NATIVE_HOST_ALLOWED_COMMANDS = new Set([
  'ping',
  'get_status',
  'workflow.start',
  'workflow.end',
  'fetch.http',
]);

/**
 * Every native message gets a correlation id so the service worker can map one
 * host response back to the promise that initiated it.
 */
export function createNativeEnvelope({ command, payload = {}, requestId, meta = {} }) {
  if (!NATIVE_HOST_ALLOWED_COMMANDS.has(command)) {
    throw new Error(`Unsupported native host command: ${command}`);
  }

  if (!requestId || typeof requestId !== 'string') {
    throw new Error('requestId is required for native host calls');
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('payload must be an object');
  }

  return {
    command,
    requestId,
    meta: {
      transport: 'native-host',
      timestamp: Date.now(),
      ...meta,
    },
    payload,
  };
}

/**
 * Only a narrow set of methods should flow into the native host because an
 * always-open native port extends MV3 worker lifetime and increases blast
 * radius if the bridge is abused.
 */
export function assertNativeCommandAllowed(command) {
  if (!NATIVE_HOST_ALLOWED_COMMANDS.has(command)) {
    throw new Error(`Command is not approved for native host transport: ${command}`);
  }
}

/**
 * The native host is our fallback path for CSP-restricted authenticated
 * workflows. We keep that intent explicit so call sites can tag logs and docs.
 */
export function buildWorkflowStartPayload({ workflowId, url, tabId, reason = NATIVE_HOST_CONTEXT } = {}) {
  return {
    workflowId,
    url,
    tabId,
    context: reason,
  };
}
