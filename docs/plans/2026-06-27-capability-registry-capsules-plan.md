---
date: 2026-06-27
topic: capability-registry-capsules
artifact_type: implementation-plan
status: implemented
---

# Capability Registry + Extension Capsules Plan

## Goal

Add a small typed registry that becomes the source of truth for known oh-my-pi extensions/capabilities without changing the Pi package extension list.

## Scope

- Define a typed `CapabilityCapsule` schema in code.
- Register capsules for `env-loader`, `quotio-provider`, and `workspace-connectors`.
- Capture extension path, toggle env var, env var requirements, exposed commands/tools/providers, safety class, and diagnostic notes.
- Refactor `env-loader` disabled-extension notification to read toggle metadata from the registry.
- Validate with TypeScript using NodeNext module resolution.

## Non-goals

- Do not add a new Pi extension to `package.json`.
- Do not rewrite broad README/setup docs.
- Do not add runtime doctor, profile packs, or secret blueprint behavior in this change.

## Implementation Steps

1. Add `extensions/capability-registry.ts` with types, registry entries, and helper selectors.
2. Import the registry helper from `extensions/env-loader/index.ts` and remove its local toggle table.
3. Run `npm exec tsc -- --noEmit --module NodeNext --moduleResolution NodeNext --target ES2022 --strict extensions/**/*.ts`.
4. Self-review for scope creep, obvious type issues, and package configuration changes.
