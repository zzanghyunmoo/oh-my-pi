import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
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

function parseService(args: string): ServiceName | null {
  return parseWorkspaceMcpServiceArgument(args);
}

async function withMcpClient<T>(service: ServiceName, fn: (client: Client) => Promise<T>): Promise<T> {
  const route = routeWorkspaceMcpConnector(service);
  const client = new Client({ name: "pi-workspace-connectors", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: "npx",
    args: [...route.mcpRemoteArgs],
    stderr: "pipe",
  });

  try {
    await client.connect(transport);
    return await fn(client);
  } finally {
    await client.close().catch(() => undefined);
  }
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

function runInteractive(command: string, args: string[]): Promise<{ code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", shell: process.platform === "win32" });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code }));
  });
}

export default function (pi: ExtensionAPI) {
  if (process.env.ENABLE_WORKSPACE_CONNECTORS !== "true") return;
  const loginUsage = formatWorkspaceMcpUsage("/connector-login");
  const toolsUsage = formatWorkspaceMcpUsage("/connector-tools");
  const githubRoute = routeGitHubCliConnector();
  const listToolsPolicy = getToolRuntimeSafetyPolicy("workspace_mcp_list_tools");
  const callToolPolicy = getToolRuntimeSafetyPolicy("workspace_mcp_call_tool");
  const githubGhCliPolicy = getToolRuntimeSafetyPolicy("github_gh_cli");

  pi.on("session_start", async (_event: unknown, ctx: NotificationContext) => {
    ctx.ui.notify(
      `Workspace connectors loaded. Use ${loginUsage}, then tools workspace_mcp_list_tools / workspace_mcp_call_tool. GitHub is available through ${githubRoute.command} when authenticated.`,
      "info",
    );
  });

  pi.registerCommand("connector-login", {
    description: `Login to an OAuth MCP workspace connector: ${loginUsage}`,
    handler: async (args: string, ctx: NotificationContext) => {
      const service = parseService(args);
      if (!service) {
        ctx.ui.notify(`Usage: ${loginUsage}`, "error");
        return;
      }

      const route = routeWorkspaceMcpConnector(service);
      ctx.ui.notify(`Starting ${route.label} OAuth flow. ${route.authGuidance}`, "info");
      const result = await runInteractive("npx", [...route.loginArgs]);

      if (result.code === 0) {
        ctx.ui.notify(`${route.label} login/check completed. ${route.statusGuidance}`, "info");
      } else {
        ctx.ui.notify(`${route.label} login/check exited with code ${result.code}. ${route.fallbackMessage}`, "error");
      }
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
        const tools = await withMcpClient(service, async (client) => (await client.listTools()).tools ?? []);
        const names = tools.map((tool: any) => `- ${tool.name}: ${tool.description ?? ""}`).join("\n");
        ctx.ui.notify(`${route.label} tools:\n${names || "No tools returned."}`, "info");
      } catch (error: any) {
        ctx.ui.notify(`Failed to list ${route.label} tools: ${error?.message ?? String(error)}\n${route.fallbackMessage}`, "error");
      }
    },
  });

  pi.registerTool({
    name: "workspace_mcp_list_tools",
    label: "Workspace MCP: List Tools",
    description: "List available tools from the Linear or Notion OAuth MCP connector.",
    promptSnippet: "workspace_mcp_list_tools: list Linear/Notion MCP connector tools after OAuth login.",
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
        const tools = await withMcpClient(service, async (client) => (await client.listTools()).tools ?? []);
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
            safetyPolicy: summarizeRuntimeSafetyPolicy(listToolsPolicy),
            connectorSafetyPolicy: summarizeRuntimeSafetyPolicy(getConnectorRuntimeSafetyPolicy(service)),
            tools,
          },
        };
      } catch (error: any) {
        throw new Error(`Failed to list ${route.label} tools: ${error?.message ?? String(error)} ${route.fallbackMessage}`);
      }
    },
  });

  pi.registerTool({
    name: "workspace_mcp_call_tool",
    label: "Workspace MCP: Call Tool",
    description: "Call a tool on the Linear or Notion OAuth MCP connector.",
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
        const result = await withMcpClient(service, async (client) =>
          client.callTool({ name: params.toolName, arguments: toolArguments }),
        );

        return {
          content: [{ type: "text", text: stringifyMcpContent(result) }],
          details: {
            service,
            backend: route.description,
            toolName: params.toolName,
            safetyPolicy: summarizeRuntimeSafetyPolicy(callToolPolicy),
            connectorSafetyPolicy: summarizeRuntimeSafetyPolicy(getConnectorRuntimeSafetyPolicy(service)),
            result,
          },
        };
      } catch (error: any) {
        throw new Error(`Failed to call ${route.label} MCP tool ${params.toolName}: ${error?.message ?? String(error)} ${route.fallbackMessage}`);
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
