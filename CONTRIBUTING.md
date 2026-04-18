# Contributing to OpenSIN-Bridge

## Scope first

This repository is for the **shared browser bridge layer**.

Put the change here when it affects:
- bridge contracts and transport
- authenticated browser/session access
- extension ↔ server interaction surfaces
- bridge resilience, replay, or capability mapping

Do **not** put the change here when it belongs to:
- a worker-specific automation policy
- monetization/business logic for a single downstream agent
- marketing/docs canon

## Workflow

1. Branch from the latest `main`.
2. Keep changes shared-bridge scoped.
3. Run the relevant bridge test or validation commands.
4. Include exact commands and evidence in the PR.
