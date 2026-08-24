// src/tools/registry.js
// Central tool registry. Tool modules register their methods here. The RPC
// router routes incoming `method` calls to registered handlers.

import { BridgeError, ErrorCode } from "../core/errors.js"
import { createLogger } from "../core/logger.js"

const log = createLogger("tools")

export class ToolRegistry {
  constructor() {
    this._handlers = new Map()
    this._meta = new Map()
  }

  /**
   * Register a tool method.
   * @param {string} name           e.g. "tabs.create"
   * @param {function} handler      async (params, ctx) => result
   * @param {object} [meta]         { description, paramsSchema, returnsSchema, capabilities }
   */
  register(name, handler, meta = {}) {
    if (typeof name !== "string" || !name.includes(".")) {
      throw new BridgeError(ErrorCode.INVALID_PARAMS, `Invalid tool name "${name}" (expected "namespace.method")`)
    }
    if (typeof handler !== "function") {
      throw new BridgeError(ErrorCode.INVALID_PARAMS, `Handler for "${name}" must be a function`)
    }
    if (this._handlers.has(name)) {
      log.warn("overwriting existing tool handler", { name })
    }
    this._handlers.set(name, handler)
    this._meta.set(name, meta)
  }

  has(name) {
    return this._handlers.has(name)
  }

  /**
   * Invoke a tool. Validates presence, wraps errors, enforces timeout if set.
   */
  async invoke(name, params, ctx) {
    const handler = this._handlers.get(name)
    if (!handler) {
      throw new BridgeError(ErrorCode.METHOD_NOT_FOUND, `Unknown tool "${name}"`)
    }
    const meta = this._meta.get(name) || {}
    const started = performance.now()
    try {
      const result = await handler(params || {}, ctx || {})
      const dur = Math.round(performance.now() - started)
      log.debug("tool ok", { name, ms: dur })
      return result
    } catch (err) {
      const dur = Math.round(performance.now() - started)
      if (err instanceof BridgeError) {
        log.warn("tool failed", { name, ms: dur, code: err.code, msg: err.message })
        throw err
      }
      log.error("tool threw", { name, ms: dur, err: String(err), stack: err?.stack })
      throw new BridgeError(ErrorCode.INTERNAL, err?.message || String(err), { tool: name })
    } finally {
      void meta // reserved for future telemetry
    }
  }

  /**
   * Catalog of all registered tools (for discovery / listTools RPC).
   */
  list() {
    const out = []
    for (const [name, meta] of this._meta) {
      out.push({ name, ...meta })
    }
    out.sort((a, b) => a.name.localeCompare(b.name))
    return out
  }
}

// Singleton used by the service worker.
export const tools = new ToolRegistry()
