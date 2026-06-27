---
date: 2026-06-27
topic: secret-blueprint-references
source: docs/plans/2026-06-27-oh-my-pi-local-pi-distribution-parallel-work-plan.md
artifact_type: implementation-plan
status: implemented
---

# Secret Blueprint + Secret References implementation plan

## Goal

Create a versionable, secret-free baseline that tells another machine which oh-my-pi toggles, environment variables, OAuth states, and manual package/profile intents must be recreated locally without committing actual credentials or local state.

## Scope

- Add JSON schema and blueprint artifacts under `docs/blueprints/`.
- Cover current capabilities only: Quotio provider, workspace connectors, Linear/Notion OAuth state, and the `pi install npm:pi-clear` manual package signal.
- Document committed vs local-only boundaries and a machine recreation flow.
- Keep runtime behavior and `package.json` unchanged for this PR; only allow narrow type-only fixes if validation exposes blockers.

## Implementation steps

1. Define a commit-safe JSON schema for secret/reference metadata.
2. Add the oh-my-pi blueprint instance with env/toggle/secret intent and package/profile intent.
3. Add operator documentation that maps committed artifacts to local `.env`, OAuth auth stores, and install commands.
4. Add a narrow ignore rule for local Pi state if needed to prevent accidental OAuth/session artifacts from being staged.
5. Validate JSON parsing and run a focused TypeScript check only if TypeScript files change.
