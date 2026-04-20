/**
 * tools/contract.js — exposes the bridge contract over RPC.
 *
 * Implements the Bridge-side counterpart of worker issue #69: a single
 * authoritative document that lists every contract method, its idempotency
 * model, expected error codes, and retry hints. Workers call
 * `bridge.contract` once at boot and store the response, so they can
 * branch on stable contract codes instead of free-form error strings.
 */

import { buildContract, findMethod, isIdempotent, toContractCode, VERSION, REVISION } from "../contract/v1/index.js"

export function register(router) {
  router.register(
    "bridge.contract",
    async () => buildContract(),
    {
      description: "Return the active OpenSIN-Bridge contract (schema, errors, idempotency, retry hints).",
      category: "bridge",
    },
  )

  router.register(
    "bridge.contract.method",
    async ({ name } = {}) => {
      const entry = findMethod(name)
      return { name, found: !!entry, method: entry || null }
    },
    {
      description: "Return contract metadata for a single method.",
      category: "bridge",
    },
  )

  router.register(
    "bridge.contract.translate",
    async ({ internalCode } = {}) => ({
      internalCode: internalCode || null,
      contractCode: toContractCode(internalCode),
    }),
    {
      description: "Translate an internal BridgeError code to its public contract code.",
      category: "bridge",
    },
  )

  router.register(
    "bridge.contract.idempotent",
    async ({ name } = {}) => ({ name, idempotent: isIdempotent(name) }),
    {
      description: "Report whether a contract method is safe to retry.",
      category: "bridge",
    },
  )

  router.register(
    "bridge.contract.version",
    async () => ({ version: VERSION, revision: REVISION }),
    {
      description: "Return the current contract version + revision.",
      category: "bridge",
    },
  )
}
