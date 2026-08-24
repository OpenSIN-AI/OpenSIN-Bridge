/**
 * RPC registry + dispatcher.
 *
 * A "tool" is a named async handler that accepts params and returns a JSON
 * response. Tools are registered through a router; the dispatcher enforces
 * input shape, rate limits, concurrency, and error normalisation so every
 * transport (WebSocket, native host, externally_connectable, popup) behaves
 * identically.
 *
 * Two access patterns are supported:
 *
 *   1. Global singleton (legacy style):
 *        import { registerTool, dispatch, listTools } from './rpc.js';
 *
 *   2. Router instance (new style):
 *        import { createRouter } from './rpc.js';
 *        const router = createRouter();
 *        router.register(name, handler, meta);
 *        router.invoke(name, params, ctx);
 *        router.list();
 *
 * Both layer on top of the same underlying implementation.
 */

import { BridgeError, ERROR_CODES, toBridgeError } from './errors.js';
import { RATE_LIMIT } from './config.js';
import { logger } from './logger.js';

const log = logger('rpc');

/**
 * Build a router. Each router has its own registry + rate-limit window.
 */
export function createRouter() {
  const registry = new Map();
  const metadata = new Map();
  const middleware = [];

  const rate = {
    windowStart: Date.now(),
    globalCount: 0,
    perMethod: new Map(),
  };

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

  function register(name, handler, meta = {}) {
    if (typeof name !== 'string' || !name) {
      throw new BridgeError(ERROR_CODES.INVALID_INPUT, 'Tool name must be a non-empty string');
    }
    if (typeof handler !== 'function') {
      throw new BridgeError(
        ERROR_CODES.INVALID_INPUT,
        `Tool handler for ${name} must be a function`,
      );
    }
    if (registry.has(name)) {
      log.debug(`tool re-registered: ${name}`);
    }
    registry.set(name, handler);
    metadata.set(name, {
      name,
      description: typeof meta.description === 'string' ? meta.description : '',
      params: meta.params || meta.paramsSchema || null,
      returns: meta.returns || meta.returnsSchema || null,
      category: meta.category || name.split('.')[0] || 'misc',
    });
  }

  function has(name) {
    return registry.has(name);
  }

  function getHandler(name) {
    return registry.get(name) || null;
  }

  function use(fn) {
    if (typeof fn === 'function') middleware.push(fn);
  }

  async function invoke(name, params, context = {}) {
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

  function list() {
    return Array.from(metadata.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  return { register, has, invoke, list, use, getHandler };
}

// -------- legacy singleton facade --------
const singleton = createRouter();
export const registerTool = singleton.register;
export const hasTool = singleton.has;
export const getTool = singleton.getHandler;
export const dispatch = singleton.invoke;
export const listTools = singleton.list;
export const useMiddleware = singleton.use;
export const defaultRouter = singleton;
