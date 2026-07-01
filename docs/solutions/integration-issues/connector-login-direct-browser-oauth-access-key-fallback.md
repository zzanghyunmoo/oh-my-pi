---
title: "Workspace connector login should use direct browser OAuth with access-key fallback"
date: 2026-06-29
category: integration-issues
module: workspace-connectors
problem_type: integration_issue
component: authentication
symptoms:
  - "/connector-login could freeze or hang Pi because an external OAuth CLI owned terminal I/O"
  - "mcp-remote-client could fail on hosted MCP endpoints with SELF_SIGNED_CERT_IN_CHAIN unless Node used system CAs"
  - "Agent tool calls needed a clear auth-needed error instead of opening browsers or blocking"
root_cause: wrong_api
resolution_type: code_fix
severity: high
related_components:
  - connector-backend-catalog
  - setup-doctor
  - runtime-safety-policy-ledger
tags:
  - workspace-connectors
  - connector-login
  - oauth
  - mcp
  - access-key
  - pi-tui
  - linear
  - notion
---

# Workspace connector login should use direct browser OAuth with access-key fallback

## Problem

`/connector-login linear|notion` was implemented as a terminal handoff to `mcp-remote-client`. That made connector authentication depend on an external interactive CLI owning the same terminal as Pi's TUI, which could hang, freeze input, or leave users without a reliable non-interactive tool path.

## Symptoms

- Running `/connector-login` inside Pi could appear to hang or corrupt TUI input/rendering because the OAuth CLI and Pi both wanted terminal ownership.
- A timeout-only fix did not address the deeper coupling: the command still delegated auth lifecycle, token storage, transport choice, and browser interaction to a separate process.
- Linear MCP could fail with `SELF_SIGNED_CERT_IN_CHAIN` unless Node used the system certificate store.
- `workspace_mcp_list_tools` and `workspace_mcp_call_tool` needed to fail clearly when auth was missing, not open a browser or wait for user consent during a tool call.

## What Didn't Work

- **Only adding a timeout to the shell-out.** A timeout could stop one stuck process, but the architecture still depended on a child CLI, terminal handoff, and CLI-managed auth state.
- **Suspending and restarting the Pi TUI around `mcp-remote-client`.** The earlier plan made terminal ownership safer, but still preserved the brittle boundary: authentication remained an interactive subprocess instead of a first-class connector flow.
- **Relying on `mcp-remote-client` defaults for hosted MCP endpoints.** In local testing, Linear's hosted MCP endpoint needed Node system CAs; without that, the external CLI could fail with `SELF_SIGNED_CERT_IN_CHAIN`.
- **Letting tool calls initiate login.** Agent tools must be non-interactive. They should use existing credentials or return a clear auth-needed error with setup guidance.

## Solution

Move workspace connector auth into the Pi extension itself:

1. Model Linear and Notion as `direct-http-oauth` connectors in the connector backend catalog.
2. Use the MCP SDK's `StreamableHTTPClientTransport` directly instead of shelling out to `mcp-remote-client` for normal runtime.
3. Implement a browser OAuth flow with a local `127.0.0.1` callback server and an `OAuthClientProvider` backed by a local auth store.
4. Store OAuth state outside the repo at `~/.pi/agent/workspace-connectors-auth.json`, with `OH_MY_PI_CONNECTOR_AUTH_PATH` for local override.
5. Try auth in this order for tool calls: stored OAuth token first, then service-specific access-key environment variables.
6. Keep tools non-interactive: list/call tools never open browsers; they return auth guidance when neither OAuth nor access-key auth works.

The catalog now declares connector auth strategy explicitly:

```ts
export type ConnectorAdapterKind = "direct-http-oauth" | "gh-cli" | "pi-provider";
export type WorkspaceConnectorAuthStrategyKind = "browser-oauth" | "access-key";

// Linear example
{
  id: "linear",
  adapterKind: "direct-http-oauth",
  authGuidance: "Run /connector-login linear for browser OAuth, or set LINEAR_API_KEY for access-key fallback.",
  authStrategies: [
    { kind: "browser-oauth", description: "Preferred: direct browser OAuth..." },
    { kind: "access-key", envVars: ["LINEAR_API_KEY"], description: "Fallback..." },
  ],
  mcp: {
    url: "https://mcp.linear.app/mcp",
    transportStrategy: "streamable-http",
  },
  oauth: { callbackPort: 3334 },
}
```

The command path opens the browser and waits for the callback directly:

```ts
export async function runBrowserOAuthLogin(service, ctx, options = {}) {
  const route = routeWorkspaceMcpConnector(service);
  const callbackServer = await startOAuthCallbackServer(service, route.oauth.callbackPort, timeoutMs);
  const provider = new StoredOAuthClientProvider(service, callbackServer.redirectUrl, async (authorizationUrl) => {
    const opened = openBrowser(authorizationUrl.toString());
    await ctx.ui.notify(
      `${route.label} browser OAuth started${opened ? "" : " (automatic browser open may have failed)"}. If needed, open this URL manually:\n${authorizationUrl}`,
      "info",
    );
  });

  const initial = await auth(provider, { serverUrl: route.mcpUrl, fetchFn: fetchWithSystemCa });
  if (initial !== "AUTHORIZED") {
    const callback = await callbackServer.waitForCallback();
    await auth(provider, {
      serverUrl: route.mcpUrl,
      authorizationCode: callback.code,
      fetchFn: fetchWithSystemCa,
    });
  }
}
```

The tool runtime uses one lifecycle helper and chooses OAuth before access-key fallback:

```ts
async function withMcpClient<T>(service: ServiceName, fn: (client: Client) => Promise<T>) {
  const oauthTokenPresent = await hasStoredOAuthToken(service);
  const accessKey = resolveAccessKey(service);

  if (oauthTokenPresent) {
    try {
      return await connectWithOAuth(service, fn);
    } catch (error) {
      if (!isAuthLikeFailure(error)) throw error;
      if (!accessKey) throw new ConnectorAuthRequiredError(formatAuthRequiredMessage(service));
    }
  }

  if (accessKey) return await connectWithAccessKey(service, accessKey, fn);
  throw new ConnectorAuthRequiredError(formatAuthRequiredMessage(service));
}
```

The HTTP fetch wrapper avoids the observed certificate failure and prevents indefinite network hangs by using Node HTTPS with system CAs and a default timeout.

## Why This Works

The root cause was the wrong integration boundary. `/connector-login` treated a Pi extension command as a wrapper around a separate interactive OAuth CLI, but the rest of the connector runtime needed deterministic, non-interactive access to MCP credentials.

Direct SDK integration makes the boundary explicit:

- Pi owns the user-facing login command, status command, logout command, and notifications.
- The MCP SDK owns OAuth protocol mechanics through `OAuthClientProvider` and `StreamableHTTPClientTransport`.
- The auth store owns only local connector credentials and stays outside git.
- Runtime tool calls reuse existing auth only; they do not initiate user-interactive OAuth.
- Access-key fallback is visible in the catalog and setup docs, so browser OAuth failure has a deterministic next path.

This also removes the TUI contention entirely: the browser flow does not require Pi to stop rendering or hand terminal input to a child process.

## Prevention

- Prefer in-process SDK transports for extension-owned connector lifecycles. Shell out only for explicit debug or legacy fallback paths.
- Keep interactive login commands separate from agent tool execution. Tools should use existing credentials or fail fast with setup guidance.
- Store local auth state outside the repo and include the path in status output so users can diagnose without exposing secrets.
- Declare auth strategies in the connector catalog, not in scattered command strings.
- Include tests for auth metadata, access-key resolution order, status output, logout cleanup, command/tool registration, invalid service handling, and all-service status summaries.
- Smoke-test hosted MCP endpoints with the same fetch path the runtime uses; certificate behavior can differ between Node fetch, shell CLIs, and SDK transports.

Verification used for this fix:

```bash
npm run test:workspace-connectors
```

Result: 7/7 workspace connector tests passed.

Additional checks:

- Touched-file LSP diagnostics returned 0 errors.
- `fetchWithSystemCa('https://mcp.linear.app/mcp')` reached the expected `401 Unauthorized` response without `SELF_SIGNED_CERT_IN_CHAIN`.
- Live `workspace_mcp_list_tools` / `workspace_mcp_call_tool` calls successfully listed Linear tools and fetched Notion `self` after browser login.

## Related Issues

- `docs/plans/2026-06-27-001-fix-connector-login-tui-recovery-plan.md` — earlier plan for a safer TUI handoff; superseded by the direct browser OAuth architecture.
- `docs/plans/2026-06-27-connector-backend-catalog-adapter-router-plan.md` — catalog/router groundwork that made connector auth strategy single-sourcing possible.
- `docs/solutions/workflow/local-pi-distribution-parallel-prs.md` — related local-only secret/OAuth-state and connector safety boundaries, but not the same bug or solution.
