import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import workspaceConnectorsExtension from "./index.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { routeWorkspaceMcpConnector } from "../connector-backend-catalog.js";
import {
  clearOAuthState,
  getConnectorAuthPath,
  getConnectorAuthStatus,
  removeAuthFileIfEmpty,
  resolveAccessKey,
} from "./auth.js";

type RegisteredCommand = { handler: (args: string, ctx: unknown) => Promise<void> | void };

async function withTempAuthPath<T>(fn: (path: string) => Promise<T> | T): Promise<T> {
  const previous = process.env.OH_MY_PI_CONNECTOR_AUTH_PATH;
  const dir = await mkdtemp(join(tmpdir(), "oh-my-pi-connectors-"));
  const path = join(dir, "auth.json");
  process.env.OH_MY_PI_CONNECTOR_AUTH_PATH = path;
  try {
    return await fn(path);
  } finally {
    if (previous === undefined) {
      delete process.env.OH_MY_PI_CONNECTOR_AUTH_PATH;
    } else {
      process.env.OH_MY_PI_CONNECTOR_AUTH_PATH = previous;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

function registerExtension() {
  const previousToggle = process.env.ENABLE_WORKSPACE_CONNECTORS;
  process.env.ENABLE_WORKSPACE_CONNECTORS = "true";
  const commands = new Map<string, RegisteredCommand>();
  const tools: string[] = [];
  const pi = {
    on: () => undefined,
    registerCommand: (name: string, options: unknown) => {
      commands.set(name, options as RegisteredCommand);
    },
    registerTool: (definition: { name: string }) => {
      tools.push(definition.name);
    },
  } as unknown as ExtensionAPI;

  try {
    workspaceConnectorsExtension(pi);
  } finally {
    if (previousToggle === undefined) {
      delete process.env.ENABLE_WORKSPACE_CONNECTORS;
    } else {
      process.env.ENABLE_WORKSPACE_CONNECTORS = previousToggle;
    }
  }

  return { commands, tools };
}

test("connector catalog uses direct OAuth with access-key fallback metadata", () => {
  const linear = routeWorkspaceMcpConnector("linear");
  const notion = routeWorkspaceMcpConnector("notion");

  assert.equal(linear.transportStrategy, "streamable-http");
  assert.deepEqual(linear.accessKeyEnvVars, ["LINEAR_API_KEY"]);
  assert.equal(linear.oauth.callbackPort, 3334);
  assert.match(linear.authGuidance, /browser OAuth/);
  assert.match(linear.legacyMcpRemoteLoginShellCommand, /mcp-remote-client/);

  assert.deepEqual(notion.accessKeyEnvVars, ["NOTION_API_KEY", "NOTION_TOKEN"]);
  assert.equal(notion.oauth.callbackPort, 3335);
});

test("resolveAccessKey follows service-specific env fallback order", () => {
  const previousLinear = process.env.LINEAR_API_KEY;
  const previousNotionApi = process.env.NOTION_API_KEY;
  const previousNotionToken = process.env.NOTION_TOKEN;

  try {
    process.env.LINEAR_API_KEY = "lin_test";
    delete process.env.NOTION_API_KEY;
    process.env.NOTION_TOKEN = "notion_fallback";

    assert.deepEqual(resolveAccessKey("linear"), { envVar: "LINEAR_API_KEY", value: "lin_test" });
    assert.deepEqual(resolveAccessKey("notion"), { envVar: "NOTION_TOKEN", value: "notion_fallback" });

    process.env.NOTION_API_KEY = "notion_primary";
    assert.deepEqual(resolveAccessKey("notion"), { envVar: "NOTION_API_KEY", value: "notion_primary" });
  } finally {
    if (previousLinear === undefined) delete process.env.LINEAR_API_KEY;
    else process.env.LINEAR_API_KEY = previousLinear;
    if (previousNotionApi === undefined) delete process.env.NOTION_API_KEY;
    else process.env.NOTION_API_KEY = previousNotionApi;
    if (previousNotionToken === undefined) delete process.env.NOTION_TOKEN;
    else process.env.NOTION_TOKEN = previousNotionToken;
  }
});

test("auth status reports local auth path, OAuth tokens, and access-key mode", async () => {
  await withTempAuthPath(async (path) => {
    const previousLinear = process.env.LINEAR_API_KEY;
    process.env.LINEAR_API_KEY = "lin_test";
    await writeFile(path, JSON.stringify({
      version: 1,
      services: {
        linear: {
          oauth: {
            tokens: {
              access_token: "oauth_access",
              refresh_token: "oauth_refresh",
              token_type: "Bearer",
            },
          },
        },
      },
    }));

    try {
      const status = await getConnectorAuthStatus("linear");
      assert.equal(getConnectorAuthPath(), path);
      assert.equal(status.oauthTokenPresent, true);
      assert.equal(status.oauthRefreshTokenPresent, true);
      assert.equal(status.accessKeyConfigured, true);
      assert.equal(status.preferredMode, "oauth");
    } finally {
      if (previousLinear === undefined) delete process.env.LINEAR_API_KEY;
      else process.env.LINEAR_API_KEY = previousLinear;
    }
  });
});

test("clearOAuthState removes stored OAuth data without touching access-key env", async () => {
  await withTempAuthPath(async (path) => {
    await writeFile(path, JSON.stringify({
      version: 1,
      services: {
        linear: {
          oauth: {
            tokens: {
              access_token: "oauth_access",
              token_type: "Bearer",
            },
          },
        },
      },
    }));

    await clearOAuthState("linear");
    await removeAuthFileIfEmpty();

    await assert.rejects(() => readFile(path, "utf-8"));
  });
});

test("extension registers direct-auth commands and connector tools", () => {
  const { commands, tools } = registerExtension();

  assert.ok(commands.has("connector-login"));
  assert.ok(commands.has("connector-status"));
  assert.ok(commands.has("connector-logout"));
  assert.ok(commands.has("connector-tools"));
  assert.deepEqual(tools.sort(), ["github_gh_cli", "workspace_mcp_call_tool", "workspace_mcp_list_tools"].sort());
});

test("connector-login invalid service preserves usage output without starting auth", async () => {
  const { commands } = registerExtension();
  const notifications: Array<{ message: string; level: string | undefined }> = [];
  const command = commands.get("connector-login");
  assert.ok(command);

  await command.handler("jira", {
    ui: {
      notify: (message: string, level?: string) => notifications.push({ message, level }),
    },
  });

  assert.deepEqual(notifications, [{ message: "Usage: /connector-login linear|notion", level: "error" }]);
});

test("connector-status supports all-services summary without network calls", async () => {
  await withTempAuthPath(async () => {
    const { commands } = registerExtension();
    const notifications: Array<{ message: string; level: string | undefined }> = [];
    const command = commands.get("connector-status");
    assert.ok(command);

    await command.handler("", {
      ui: {
        notify: (message: string, level?: string) => notifications.push({ message, level }),
      },
    });

    assert.equal(notifications.length, 1);
    assert.equal(notifications[0]?.level, "info");
    assert.match(notifications[0]?.message ?? "", /Linear/);
    assert.match(notifications[0]?.message ?? "", /Notion/);
    assert.match(notifications[0]?.message ?? "", /not authenticated/);
  });
});
