# Secret Blueprint + Secret References

This directory contains the committed, secret-free baseline for recreating local oh-my-pi capabilities on another machine.

## Committed artifacts

- `secret-references.schema.json` — JSON Schema for commit-safe secret/reference metadata.
- `oh-my-pi.secret-blueprint.json` — current oh-my-pi blueprint instance. It records names, intent, boundaries, and recreation steps only.

These files may mention environment variable names and package install specs, but they must not include actual tokens, OAuth state, local endpoint values, or copied `.env` content.

## Local-only artifacts

Do not commit these files or values:

- `.env` and `.env.*` — CWD environment files read by `extensions/env-loader`.
- `QUOTIO_BASE_URL` values — local endpoint/private network configuration.
- `QUOTIO_API_KEY` values — API keys for the configured Quotio/OpenAI-compatible proxy.
- `.mcp-auth/` — remote MCP OAuth/cache state.
- `.pi/` — local Pi session/OAuth state that can be generated while using connectors.
- `~/.pi/agent/auth.json` — Pi agent authentication material outside this repository.

## Current environment contract

| Name | Capability | Boundary | Recreate locally |
|---|---|---|---|
| `ENABLE_QUOTIO` | `extensions/quotio-provider` | Commit name/intent only | Set to `true` in local CWD `.env` when this machine should register Quotio. |
| `ENABLE_WORKSPACE_CONNECTORS` | `extensions/workspace-connectors` | Commit name/intent only | Set to `true` in local CWD `.env` when this machine should expose Linear/Notion connector commands/tools. |
| `QUOTIO_BASE_URL` | `extensions/quotio-provider` | Never commit value | Add the local proxy endpoint to CWD `.env` or another local environment source. |
| `QUOTIO_API_KEY` | `extensions/quotio-provider` | Never commit value | Add the local API key to CWD `.env` or another local environment source. |

The env-loader reads the current working directory's `.env` and overrides existing `process.env` values. Keep the real file next to the project or workspace where Pi is launched, not in the committed package.

## OAuth state boundaries

Linear and Notion connector authentication is per-machine. The committed blueprint records only the services and login commands:

```text
/connector-login linear
/connector-login notion
```

The OAuth/session state created by those flows is local-only. Depending on the runtime and `mcp-remote` behavior, state may be stored in local auth/cache locations such as `.mcp-auth/`, `.pi/`, or home-directory auth stores. Recreate it by running the login command on each machine instead of copying state between machines.

## Package/profile intent

The blueprint records package/profile intent without changing this PR's runtime extension list:

- `git:github.com/zzanghyunmoo/oh-my-pi` — the core package represented by this repository.
- `npm:pi-clear` — recent manual package signal from `pi install npm:pi-clear`; recorded as intent only.

Future profile/lockfile work can consume this intent. This PR intentionally does not add a new Pi extension in `package.json`.

## Recreate on another machine

1. Install oh-my-pi:

   ```bash
   pi install git:github.com/zzanghyunmoo/oh-my-pi
   # or, for a private/SSH checkout:
   pi install git:git@github.com:zzanghyunmoo/oh-my-pi
   ```

2. If the local profile should include the manual package signal, install pi-clear:

   ```bash
   pi install npm:pi-clear
   ```

3. Create a local CWD `.env` file with only the capabilities needed on that machine:

   ```bash
   ENABLE_QUOTIO=true
   ENABLE_WORKSPACE_CONNECTORS=true
   QUOTIO_BASE_URL=<local-quotio-openai-compatible-base-url>
   QUOTIO_API_KEY=<local-quotio-api-key>
   ```

4. Start/reload Pi from that CWD.
5. If workspace connectors are enabled, run `/connector-login linear` and/or `/connector-login notion` on that machine.
