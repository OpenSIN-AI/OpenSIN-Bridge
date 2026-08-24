/**
 * tools/behavior.js — behavior recording (user actions) for replay and
 * training.
 */

import * as Store from "../drivers/behavior-store.js"

export function register(router) {
  router.register("behavior.start", async ({ scope = "tab", tabId } = {}) => {
    await Store.start({ scope, tabId })
    return { ok: true }
  })

  router.register("behavior.stop", async () => {
    await Store.stop()
    return { ok: true }
  })

  router.register("behavior.status", async () => Store.status())

  router.register("behavior.list", async () => {
    const sessions = await Store.listSessions()
    return { sessions }
  })

  router.register("behavior.get", async ({ sessionId } = {}) => {
    const session = await Store.getSession(sessionId)
    return { session }
  })

  router.register("behavior.delete", async ({ sessionId } = {}) => {
    await Store.deleteSession(sessionId)
    return { ok: true }
  })

  router.register("behavior.clear", async () => {
    await Store.clear()
    return { ok: true }
  })
}
