# OpenSIN-Bridge Boundaries

## Role
`OpenSIN-Bridge` owns the authenticated browser bridge, thin-client extension contract, and server-side bridge protocol for OpenSIN.

## This repo should own
- extension ↔ server bridge contracts
- authenticated session transport and native-host fallback
- bridge-side DOM extraction and interaction protocol
- bridge-specific anti-fragility, replay, and capability mapping layers

## This repo must not own
- worker-specific monetization logic
- general product or marketing site ownership
- canonical docs or architecture SSOT
- domain-specific agent business rules that belong in downstream worker repos

## Hard rules
- Keep changes scoped to shared bridge infrastructure.
- Move worker/platform-specific business logic back to the owning repos.
- Keep the bridge reusable across multiple downstream agents and products.
