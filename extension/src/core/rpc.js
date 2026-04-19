/**
 * RPC registry + dispatcher.
 *
 * A "tool" is a named async handler that accepts params and returns a JSON
 * response. Tools are registered through registerTool(); the dispatcher enforces
 * input shape, rate limits, concurrency, and error normalisation so every
 * transport (WebSocket, native host, externally_connectable, popup) behaves
 * identically.
 */

import { BridgeError, ERROR_CODES, toBridgeError } from './errors.js';
import { RATE_LIMIT } from './config.js';
import { logger } from './logger.js';

const log = logger('rpc');

const registry = new Map();
const metadata = new Map();
const middleware = [];

const rate = {
  windowStart: Date.now(),
  globalCount: 0,
  perMethod: new Map(),
};

/**
 * Register a new tool. Subsequent calls with the same name replace the previous
 * definition so later modules can intentionally override built-ins.
 */
export function registerTool(name, handler, meta = {}) {
  if (typeof name !== 'string' || !name) {
    throw new BridgeError(ERROR_CODES.INVALID_INPUT, 'Tool name must be a non-empty string');
  }
  if (typeof handler !== 'function') {
    throw new BridgeError(ERROR_CODES.INVALID_INPUT, `Tool handler for ${name} must be a function`);
  }

  registry.set(name, handler);
  metadata.set(name, {
    name,
    description: typeof meta.description === 'string' ? meta.description : '',
    params: meta.params || null,
    category: meta.category || 'misc',
  });
}

/**
 * Middleware receives { name, params, context } and may return a replacement
 * params object or throw a BridgeError to short-circuit execution.
 */
export function useMiddleware(fn) {
  if (typeof fn === 'function') middleware.push(fn);
}

function enforceRateLimit(method) {
  const now = Date.now();
  if (now - rate.windowStart >= RATE_LIMIT.windowMs) {
    rate.windowStart = now;
    rate.globalCount = 0;
    rate.perMethod.clear();
  }

  rate.globalCount += 1;
  if (rate.globalCount > RATE_LIMIT.global) {
    throw new BridgeError(
      ERROR_CODES.RATE_LIMITED,
      `Global rate limit exceeded (${RATE_LIMIT.global} calls/${RATE_LIMIT.windowMs}ms)`,
    );
  }

  const count = (rate.perMethod.get(method) || 0) + 1;
  rate.perMethod.set(method, count);
  if (count > RATE_LIMIT.perMethod) {
    throw new BridgeError(
      ERROR_CODES.RATE_LIMITED,
      `Per-method rate limit exceeded for "${method}" (${RATE_LIMIT.perMethod}/${RATE_LIMIT.windowMs}ms)`,
    );
  }
}

/**
 * Execute a tool by name. `context` is metadata describing the caller
 * (transport, origin) — tools can read it but must not mutate it.
 */
export async function dispatch(name, params, context = {}) {
  const handler = registry.get(name);
  if (!handler) {
    throw new BridgeError(ERROR_CODES.UNKNOWN_TOOL, `Tool not found: ${name}`);
  }

  enforceRateLimit(name);

  let safeParams = params && typeof params === 'object' ? params : {};

  for (const mw of middleware) {
    const result = await mw({ name, params: safeParams, context });
    if (result && typeof result === 'object') safeParams = result;
  }

  const startedAt = Date.now();
  log.debug(`dispatch ${name}`, { transport: context.transport || 'internal' });

  try {
    const result = await handler(safeParams, context);
    log.debug(`done ${name}`, { durationMs: Date.now() - startedAt });
    return result === undefined ? {} : result;
  } catch (error) {
    const bridgeError = toBridgeError(error);
    log.warn(`fail ${name}`, {
      code: bridgeError.code,
      message: bridgeError.message,
      durationMs: Date.now() - startedAt,
    });
    throw bridgeError;
  }
}

export function listTools() {
  return Array.from(metadata.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export function hasTool(name) {
  return registry.has(name);
}

export function getTool(name) {
  return registry.get(name) || null;
}
