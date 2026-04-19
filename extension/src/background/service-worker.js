/**
 * background/service-worker.js — OpenSIN Bridge MV3 entrypoint.
 *
 * Orchestrates:
 *   1. Config load from chrome.storage
 *   2. Logger + state
 *   3. Tool router with all tool modules
 *   4. Transports (WS, Native, external runtime messaging)
 *   5. Lifecycle (alarms keep-alive, action click, install)
 *   6. Per-tab cleanup on close
 */

import { initConfig, CONFIG } from "../core/config.js"
import { createLogger, attachGlobalErrorHandlers } from "../core/logger.js"
import * as State from "../core/state.js"
import { createRouter } from "../core/rpc.js"
import { registerAll } from "../tools/index.js"
import { attach as attachExternal } from "../transports/external.js"
import { create as createWS } from "../transports/ws.js"
import { create as createNative } from "../transports/native.js"
import { initLifecycle } from "../core/lifecycle.js"
import { onTabRemoved } from "../drivers/tabs.js"
import * as Net from "../tools/network.js"
import * as CDP from "../drivers/cdp.js"
import { uuid } from "../core/utils.js"

const log = createLogger("bg")

attachGlobalErrorHandlers()

// Remember when the service worker booted — read by system.health.
globalThis.__bridgeStart = Date.now()

async function bootstrap() {
  log.info("OpenSIN Bridge booting…")

  // CDP relies on global chrome.debugger.onDetach / onEvent routing. This MUST
  // be installed exactly once, before any driver tries to send CDP commands.
  CDP.installCdpListeners()

  await initConfig()
  await State.init()

  let clientId = (await chrome.storage.local.get("opensin:clientId"))["opensin:clientId"]
  if (!clientId) {
    clientId = `cl_${uuid()}`
    await chrome.storage.local.set({ "opensin:clientId": clientId })
  }
  State.patch({ clientId, version: CONFIG.version, bootedAt: Date.now() })

  const router = createRouter()
  registerAll(router)
  log.info(`registered ${router.list().length} tools`)

  attachExternal({ router })

  const ws = createWS({ router, clientId })
  const native = createNative({ router, clientId })

  // Expose control over transports as tools too.
  router.register("transport.ws.start", async () => {
    ws.start()
    return { ok: true }
  })
  router.register("transport.ws.stop", async () => {
    ws.stop()
    return { ok: true }
  })
  router.register("transport.ws.status", async () => ({ status: ws.status }))
  router.register("transport.native.start", async () => {
    native.start()
    return { ok: true }
  })
  router.register("transport.native.stop", async () => {
    native.stop()
    return { ok: true }
  })

  initLifecycle({ ws, native, router })

  // Per-tab cleanup.
  onTabRemoved(async (tabId) => {
    try {
      await CDP.detachAll(tabId)
    } catch {}
    Net.cleanupTab(tabId)
  })

  // Autostart transports based on config.
  if (CONFIG.autostart.ws) ws.start()
  if (CONFIG.autostart.native) native.start()

  globalThis.__opensin = { router, ws, native, state: State }
  State.patch({ ready: true })
  log.info("ready")
}

bootstrap().catch((e) => {
  log.error("bootstrap failed", e)
  State.patch({ ready: false, bootError: e.message })
})
