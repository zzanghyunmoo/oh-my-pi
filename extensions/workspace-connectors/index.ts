import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { spawn } from "node:child_process";
import {
  WORKSPACE_MCP_SERVICE_IDS,
  formatWorkspaceMcpUsage,
  parseWorkspaceMcpServiceArgument,
  routeGitHubCliConnector,
  routeWorkspaceMcpConnector,
  type WorkspaceMcpServiceName,
} from "../connector-backend-catalog.js";
import {
  formatRuntimeSafetyPolicyGuidelines,
  getConnectorRuntimeSafetyPolicy,
  getGithubGhCliMutationGuardMessage,
  getToolRuntimeSafetyPolicy,
  isBlockedGithubGhCliInvocation,
  summarizeRuntimeSafetyPolicy,
} from "../runtime-safety-policy-ledger.js";
import {
  clearOAuthState,
  ConnectorAuthRequiredError,
  createOAuthProviderForTransport,
  fetchWithSystemCa,
  formatAuthRequiredMessage,
  getConnectorAuthStatus,
  hasStoredOAuthToken,
  removeAuthFileIfEmpty,
  resolveAccessKey,
  runBrowserOAuthLogin,
  type ConnectorAuthMode,
  type ConnectorAuthStatus,
} from "./auth.js";

type ServiceName = WorkspaceMcpServiceName;
type NotifyLevel = "info" | "error";

interface NotificationContext {
  readonly ui: {
    notify(message: string, level: NotifyLevel): void | Promise<void>;
  };
}

interface WorkspaceMcpListToolsParams {
  readonly service: ServiceName;
}

interface WorkspaceMcpCallToolParams {
  readonly service: ServiceName;
  readonly toolName: string;
  readonly arguments?: unknown;
}

type McpToolArguments = { [key: string]: unknown };

interface GitHubGhCliParams {
  readonly args: string[];
}

interface McpClientResult<T> {
  readonly value: T;
  readonly authMode: ConnectorAuthMode;
}

function parseService(args: string): ServiceName | null {
  return parseWorkspaceMcpServiceArgument(args);
}

function parseOptionalService(args: string): ServiceName[] | null {
  const trimmed = args.trim();
  if (!trimmed) return [...WORKSPACE_MCP_SERVICE_IDS];
  const service = parseService(trimmed);
  return service ? [service] : null;
}

function stringifyMcpContent(result: any): string {
  if (!result) return "";
  const parts: string[] = [];

  if (Array.isArray(result.content)) {
    for (const item of result.content) {
      if (item?.type === "text" && typeof item.text === "string") {
        parts.push(item.text);
      } else {
        parts.push(JSON.stringify(item, null, 2));
      }
    }
  }

  if (result.structuredContent !== undefined) {
    parts.push(`structuredContent:\n${JSON.stringify(result.structuredContent, null, 2)}`);
  }

  if (result.isError) {
    parts.unshift("MCP tool returned isError=true");
  }

  return parts.join("\n\n") || JSON.stringify(result, null, 2);
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    const errno = error as NodeJS.ErrnoException;
    return errno.code ? `${errno.code}: ${error.message}` : error.message;
  }
  return String(error);
}

function isAuthLikeFailure(error: unknown): boolean {
  if (error instanceof ConnectorAuthRequiredError || error instanceof UnauthorizedError) return true;
  if (error instanceof StreamableHTTPError && (error.code === 401 || error.code === 403)) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /\b(401|403|unauthorized|forbidden|authentication required)\b/i.test(message);
}

function accessKeyRejectedMessage(service: ServiceName, envVar: string, error: unknown): string {
  const route = routeWorkspaceMcpConnector(service);
  return `${route.label} access-key fallback via ${envVar} was rejected by the MCP endpoint: ${formatError(error)}. ${route.authGuidance}`;
}

function parseMcpUrl(service: ServiceName): URL {
  const route = routeWorkspaceMcpConnector(service);
  try {
    return new URL(route.mcpUrl);
  } catch (error: unknown) {
    throw new Error(`Invalid ${route.label} MCP URL: ${formatError(error)}`);
  }
}

async function connectWithTransport<T>(
  transport: StreamableHTTPClientTransport,
  authMode: ConnectorAuthMode,
  fn: (client: Client) => Promise<T>,
): Promise<McpClientResult<T>> {
  const client = new Client({ name: "pi-workspace-connectors", version: "0.2.0" });
  try {
    await client.connect(transport);
    return { value: await fn(client), authMode };
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function connectWithOAuth<T>(service: ServiceName, fn: (client: Client) => Promise<T>): Promise<McpClientResult<T>> {
  return connectWithTransport(new StreamableHTTPClientTransport(parseMcpUrl(service), {
    authProvider: createOAuthProviderForTransport(service),
    fetch: fetchWithSystemCa,
  }), "oauth", fn);
}

async function connectWithAccessKey<T>(service: ServiceName, accessKey: { envVar: string; value: string }, fn: (client: Client) => Promise<T>): Promise<McpClientResult<T>> {
  return connectWithTransport(new StreamableHTTPClientTransport(parseMcpUrl(service), {
    fetch: fetchWithSystemCa,
    requestInit: {
      headers: {
        Authorization: `Bearer ${accessKey.value}`,
      },
    },
  }), "access-key", fn);
}

async function withMcpClient<T>(service: ServiceName, fn: (client: Client) => Promise<T>): Promise<McpClientResult<T>> {
  const oauthTokenPresent = await hasStoredOAuthToken(service);
  const accessKey = resolveAccessKey(service);
  let oauthError: unknown;

  if (oauthTokenPresent) {
    try {
      return await connectWithOAuth(service, fn);
    } catch (error: unknown) {
      oauthError = error;
      if (!isAuthLikeFailure(error)) throw error;
      if (!accessKey) throw new ConnectorAuthRequiredError(formatAuthRequiredMessage(service));
    }
  }

  if (accessKey) {
    try {
      return await connectWithAccessKey(service, accessKey, fn);
    } catch (error: unknown) {
      if (isAuthLikeFailure(error)) {
        throw new ConnectorAuthRequiredError(accessKeyRejectedMessage(service, accessKey.envVar, error));
      }
      throw error;
    }
  }

  if (oauthError) throw oauthError;
  throw new ConnectorAuthRequiredError(formatAuthRequiredMessage(service));
}

function formatStatusLine(status: ConnectorAuthStatus): string {
  const route = routeWorkspaceMcpConnector(status.service);
  const oauth = status.oauthTokenPresent
    ? `OAuth token stored${status.oauthRefreshTokenPresent ? "+refresh" : ""}`
    : status.oauthConfigured
      ? "OAuth client registered but no token"
      : "OAuth not configured";
  const access = status.accessKeyConfigured
    ? `access key set (${status.accessKeyEnvVar})`
    : `access key missing (${route.accessKeyEnvVars.join("/")})`;
  const preferred = status.preferredMode ? `preferred=${status.preferredMode}` : "not authenticated";
  return `- ${route.label}: ${preferred}; ${oauth}; ${access}`;
}

async function formatStatusReport(services: readonly ServiceName[]): Promise<string> {
  const statuses = await Promise.all(services.map((service) => getConnectorAuthStatus(service)));
  return [
    "Workspace connector auth status",
    "",
    ...statuses.map(formatStatusLine),
    "",
    `Auth file: ${statuses[0]?.authPath ?? "not initialized"}`,
  ].join("\n");
}

export default function (pi: ExtensionAPI) {
  if (process.env.ENABLE_WORKSPACE_CONNECTORS !== "true") return;
  const loginUsage = formatWorkspaceMcpUsage("/connector-login");
  const toolsUsage = formatWorkspaceMcpUsage("/connector-tools");
  const statusUsage = `${formatWorkspaceMcpUsage("/connector-status")} (or /connector-status for all)`;
  const logoutUsage = formatWorkspaceMcpUsage("/connector-logout");
  const githubRoute = routeGitHubCliConnector();
  const listToolsPolicy = getToolRuntimeSafetyPolicy("workspace_mcp_list_tools");
  const callToolPolicy = getToolRuntimeSafetyPolicy("workspace_mcp_call_tool");
  const githubGhCliPolicy = getToolRuntimeSafetyPolicy("github_gh_cli");

  pi.on("session_start", async (_event: unknown, ctx: NotificationContext) => {
    ctx.ui.notify(
      `Workspace connectors loaded. Browser OAuth: ${loginUsage}; status: /connector-status; tools: workspace_mcp_list_tools / workspace_mcp_call_tool. GitHub is available through ${githubRoute.command} when authenticated.`,
      "info",
    );
  });

  pi.registerCommand("connector-login", {
    description: `Browser OAuth login for a workspace connector, with access-key fallback guidance: ${loginUsage}`,
    handler: async (args: string, ctx: NotificationContext) => {
      const service = parseService(args);
      if (!service) {
        ctx.ui.notify(`Usage: ${loginUsage}`, "error");
        return;
      }

      try {
        await runBrowserOAuthLogin(service, ctx);
      } catch (error: unknown) {
        ctx.ui.notify(formatError(error), "error");
      }
    },
  });

  pi.registerCommand("connector-status", {
    description: `Show workspace connector authentication status: ${statusUsage}`,
    handler: async (args: string, ctx: NotificationContext) => {
      const services = parseOptionalService(args);
      if (!services) {
        ctx.ui.notify(`Usage: ${statusUsage}`, "error");
        return;
      }
      ctx.ui.notify(await formatStatusReport(services), "info");
    },
  });

  pi.registerCommand("connector-logout", {
    description: `Clear locally stored OAuth credentials for a connector: ${logoutUsage}`,
    handler: async (args: string, ctx: NotificationContext) => {
      const service = parseService(args);
      if (!service) {
        ctx.ui.notify(`Usage: ${logoutUsage}`, "error");
        return;
      }

      await clearOAuthState(service);
      await removeAuthFileIfEmpty();
      ctx.ui.notify(`${routeWorkspaceMcpConnector(service).label} OAuth credentials cleared. Access-key env vars, if set, are unchanged.`, "info");
    },
  });

  pi.registerCommand("connector-tools", {
    description: `List tools from a connector: ${toolsUsage}`,
    handler: async (args: string, ctx: NotificationContext) => {
      const service = parseService(args);
      if (!service) {
        ctx.ui.notify(`Usage: ${toolsUsage}`, "error");
        return;
      }

      const route = routeWorkspaceMcpConnector(service);
      try {
        const { value: tools, authMode } = await withMcpClient(service, async (client) => (await client.listTools()).tools ?? []);
        const names = tools.map((tool: any) => `- ${tool.name}: ${tool.description ?? ""}`).join("\n");
        ctx.ui.notify(`${route.label} tools (${authMode}):\n${names || "No tools returned."}`, "info");
      } catch (error: unknown) {
        ctx.ui.notify(`Failed to list ${route.label} tools: ${formatError(error)}`, "error");
      }
    },
  });

  pi.registerTool({
    name: "workspace_mcp_list_tools",
    label: "Workspace MCP: List Tools",
    description: "List available tools from the Linear or Notion connector. Uses stored browser OAuth first, then configured access-key fallback.",
    promptSnippet: "workspace_mcp_list_tools: list Linear/Notion connector tools after /connector-login or access-key env setup.",
    promptGuidelines: [
      "Use workspace_mcp_list_tools before calling an unfamiliar Linear or Notion MCP tool.",
      `If a Linear or Notion connector reports authentication errors, use the catalog guidance: ${WORKSPACE_MCP_SERVICE_IDS.map((service) => routeWorkspaceMcpConnector(service).authGuidance).join(" ")}`,
      ...formatRuntimeSafetyPolicyGuidelines(listToolsPolicy),
    ],
    parameters: Type.Object({
      service: Type.Union([Type.Literal("linear"), Type.Literal("notion")], {
        description: "Workspace service to inspect.",
      }),
    }),
    async execute(_toolCallId: string, params: WorkspaceMcpListToolsParams) {
      const service = params.service;
      const route = routeWorkspaceMcpConnector(service);
      try {
        const { value: tools, authMode } = await withMcpClient(service, async (client) => (await client.listTools()).tools ?? []);
        return {
          content: [
            {
              type: "text",
              text: tools.map((tool: any) => `${tool.name}: ${tool.description ?? ""}`).join("\n") || "No tools returned.",
            },
          ],
          details: {
            service,
            backend: route.description,
            authMode,
            safetyPolicy: summarizeRuntimeSafetyPolicy(listToolsPolicy),
            connectorSafetyPolicy: summarizeRuntimeSafetyPolicy(getConnectorRuntimeSafetyPolicy(service)),
            tools,
          },
        };
      } catch (error: unknown) {
        throw new Error(`Failed to list ${route.label} tools: ${formatError(error)}`);
      }
    },
  });

  pi.registerTool({
    name: "workspace_mcp_call_tool",
    label: "Workspace MCP: Call Tool",
    description: "Call a tool on the Linear or Notion connector. Uses stored browser OAuth first, then configured access-key fallback.",
    promptSnippet: "workspace_mcp_call_tool: call a Linear/Notion MCP tool by name with JSON arguments.",
    promptGuidelines: [
      "Use workspace_mcp_call_tool only after identifying the exact tool name and argument schema from workspace_mcp_list_tools or user-provided context.",
      "Before using workspace_mcp_call_tool for destructive writes, ask the user for confirmation unless they explicitly requested the change.",
      ...formatRuntimeSafetyPolicyGuidelines(callToolPolicy),
    ],
    parameters: Type.Object({
      service: Type.Union([Type.Literal("linear"), Type.Literal("notion")], {
        description: "Workspace service to call.",
      }),
      toolName: Type.String({ description: "Exact MCP tool name to call." }),
      arguments: Type.Optional(Type.Any({ description: "JSON object passed as MCP tool arguments." })),
    }),
    async execute(_toolCallId: string, params: WorkspaceMcpCallToolParams) {
      const service = params.service;
      const route = routeWorkspaceMcpConnector(service);
      const toolArguments: McpToolArguments =
        typeof params.arguments === "object" && params.arguments !== null && !Array.isArray(params.arguments)
          ? params.arguments as McpToolArguments
          : {};
      try {
        const { value: result, authMode } = await withMcpClient(service, async (client) =>
          client.callTool({ name: params.toolName, arguments: toolArguments }),
        );

        return {
          content: [{ type: "text", text: stringifyMcpContent(result) }],
          details: {
            service,
            backend: route.description,
            authMode,
            toolName: params.toolName,
            safetyPolicy: summarizeRuntimeSafetyPolicy(callToolPolicy),
            connectorSafetyPolicy: summarizeRuntimeSafetyPolicy(getConnectorRuntimeSafetyPolicy(service)),
            result,
          },
        };
      } catch (error: unknown) {
        throw new Error(`Failed to call ${route.label} MCP tool ${params.toolName}: ${formatError(error)}`);
      }
    },
  });

  pi.registerTool({
    name: "github_gh_cli",
    label: `${githubRoute.label}: gh CLI`,
    description: `${githubRoute.description} Intended for safe GitHub read commands.`,
    promptSnippet: "github_gh_cli: use the user's gh auth login session for GitHub read-only queries.",
    promptGuidelines: [
      githubRoute.authGuidance,
      "Use github_gh_cli for GitHub access when the user wants login-based GitHub integration without API keys.",
      "github_gh_cli is intended for read-only gh commands. Ask for confirmation before proposing any GitHub mutation.",
      ...formatRuntimeSafetyPolicyGuidelines(githubGhCliPolicy),
    ],
    parameters: Type.Object({
      args: Type.Array(Type.String(), {
        description: "Arguments passed to gh. Examples: ['repo','list','OWNER'], ['issue','list','--repo','OWNER/REPO'].",
      }),
    }),
    async execute(_toolCallId: string, params: GitHubGhCliParams, signal: AbortSignal) {
      const args = params.args;
      if (isBlockedGithubGhCliInvocation(args)) {
        throw new Error(getGithubGhCliMutationGuardMessage());
      }

      const output = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(githubRoute.command, args, { shell: process.platform === "win32", signal });
        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", (chunk) => (stdout += chunk.toString()));
        child.stderr?.on("data", (chunk) => (stderr += chunk.toString()));
        child.on("error", reject);
        child.on("exit", (code) => resolve({ code, stdout, stderr }));
      });

      if (output.code !== 0) {
        throw new Error(`${githubRoute.fallbackMessage} ${githubRoute.command} exited with code ${output.code}: ${output.stderr || output.stdout}`);
      }

      return {
        content: [{ type: "text", text: output.stdout || output.stderr || `${githubRoute.command} command completed with no output.` }],
        details: {
          args,
          safetyPolicy: summarizeRuntimeSafetyPolicy(githubGhCliPolicy),
          connectorSafetyPolicy: summarizeRuntimeSafetyPolicy(getConnectorRuntimeSafetyPolicy("github")),
          stdout: output.stdout,
          stderr: output.stderr,
        },
      };
    },
  });
}
