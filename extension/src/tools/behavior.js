/**
 * Behavior tools stub — human-like interaction patterns.
 */
export function register(router) {
  router.register("behavior.delay", async () => ({ ok: true }));
  router.register("behavior.scroll", async () => ({ ok: true }));
  router.register("behavior.hover", async () => ({ ok: true }));
}
