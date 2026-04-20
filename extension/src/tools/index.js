/**
 * tools/index.js — registers every tool module on the global router.
 */

import { register as tabs } from "./tabs.js"
import { register as navigation } from "./navigation.js"
import { register as dom } from "./dom.js"
import { register as cookies } from "./cookies.js"
import { register as storage } from "./storage.js"
import { register as network } from "./network.js"
import { register as session } from "./session.js"
import { register as system } from "./system.js"
import { register as vision } from "./vision.js"
import { register as behavior } from "./behavior.js"
import { register as debug } from "./debug.js"
import { register as contract } from "./contract.js"
import { register as evidence } from "./evidence.js"
import { register as stealth } from "./stealth.js"
import { register as aliases } from "./aliases.js"

export function registerAll(router) {
  tabs(router)
  navigation(router)
  dom(router)
  cookies(router)
  storage(router)
  network(router)
  session(router)
  system(router)
  vision(router)
  behavior(router)
  // debug must be registered BEFORE aliases so that any alias using a
  // namespaced debug.* name resolves to the canonical handler.
  debug(router)
  // Bridge meta surfaces (contract, evidence, stealth) are registered after
  // the underlying tools they compose (dom, behavior, net, ...) so that
  // the evidence bundle can call them through the same router.
  contract(router)
  evidence(router)
  stealth(router)
  // Legacy flat names MUST be registered last so they can alias over the
  // canonical dotted handlers.
  aliases(router)
  return router
}
