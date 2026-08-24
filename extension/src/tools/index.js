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
  // Legacy flat names MUST be registered last so they can alias over the
  // canonical dotted handlers.
  aliases(router)
  return router
}
