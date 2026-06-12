import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn } from "node:child_process";

const SERVICES = {
  linear: {
    label: "Linear",
    url: "https://mcp.linear.app/mcp",
  },
  notion: {
    label: "Notion",
    url: "https://mcp.notion.com/mcp",
  },
} as const;

type ServiceName = keyof typeof SERVICES;

function isServiceName(value: string): value is ServiceName {
  return value === "linear" || value === "notion";
}

function parseService(args: string): ServiceName | null {
  const service = args.trim().split(/\s+/)[0]?.toLowerCase();
  return service && isServiceName(service) ? service : null;
}

async function withMcpClient<T>(service: ServiceName, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: "pi-workspace-connectors", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["-y", "mcp-remote@latest", SERVICES[service].url, "--transport", "http-first"],
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
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify(
      "Workspace connectors loaded. Use /connector-login linear|notion, then tools workspace_mcp_list_tools / workspace_mcp_call_tool.",
      "info",
    );
  });

  pi.registerCommand("connector-login", {
    description: "Login to an OAuth MCP workspace connector: /connector-login linear|notion",
    handler: async (args, ctx) => {
      const service = parseService(args);
      if (!service) {
        ctx.ui.notify("Usage: /connector-login linear|notion", "error");
        return;
      }

      ctx.ui.notify(`Starting ${SERVICES[service].label} OAuth flow. Follow the browser/terminal prompts.`, "info");
      const result = await runInteractive("npx", [
        "-y",
        "-p",
        "mcp-remote@latest",
        "mcp-remote-client",
        SERVICES[service].url,
      ]);

      if (result.code === 0) {
        ctx.ui.notify(`${SERVICES[service].label} login/check completed.`, "info");
      } else {
        ctx.ui.notify(`${SERVICES[service].label} login/check exited with code ${result.code}.`, "error");
      }
    },
  });

  pi.registerCommand("connector-tools", {
    description: "List tools from a connector: /connector-tools linear|notion",
    handler: async (args, ctx) => {
      const service = parseService(args);
      if (!service) {
        ctx.ui.notify("Usage: /connector-tools linear|notion", "error");
        return;
      }

      try {
        const tools = await withMcpClient(service, async (client) => (await client.listTools()).tools ?? []);
        const names = tools.map((tool: any) => `- ${tool.name}: ${tool.description ?? ""}`).join("\n");
        ctx.ui.notify(`${SERVICES[service].label} tools:\n${names || "No tools returned."}`, "info");
      } catch (error: any) {
        ctx.ui.notify(`Failed to list ${SERVICES[service].label} tools: ${error?.message ?? String(error)}`, "error");
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
      "If a Linear or Notion connector reports authentication errors, ask the user to run /connector-login linear or /connector-login notion.",
    ],
    parameters: Type.Object({
      service: Type.Union([Type.Literal("linear"), Type.Literal("notion")], {
        description: "Workspace service to inspect.",
      }),
    }),
    async execute(_toolCallId, params) {
      const service = params.service as ServiceName;
      const tools = await withMcpClient(service, async (client) => (await client.listTools()).tools ?? []);
      return {
        content: [
          {
            type: "text",
            text: tools.map((tool: any) => `${tool.name}: ${tool.description ?? ""}`).join("\n") || "No tools returned.",
          },
        ],
        details: { service, tools },
      };
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
    ],
    parameters: Type.Object({
      service: Type.Union([Type.Literal("linear"), Type.Literal("notion")], {
        description: "Workspace service to call.",
      }),
      toolName: Type.String({ description: "Exact MCP tool name to call." }),
      arguments: Type.Optional(Type.Any({ description: "JSON object passed as MCP tool arguments." })),
    }),
    async execute(_toolCallId, params) {
      const service = params.service as ServiceName;
      const result = await withMcpClient(service, async (client) =>
        client.callTool({ name: params.toolName, arguments: params.arguments ?? {} }),
      );

      return {
        content: [{ type: "text", text: stringifyMcpContent(result) }],
        details: { service, toolName: params.toolName, result },
      };
    },
  });

  pi.registerTool({
    name: "github_gh_cli",
    label: "GitHub: gh CLI",
    description: "Run safe GitHub read commands through the authenticated gh CLI session.",
    promptSnippet: "github_gh_cli: use the user's gh auth login session for GitHub read-only queries.",
    promptGuidelines: [
      "Use github_gh_cli for GitHub access when the user wants login-based GitHub integration without API keys.",
      "github_gh_cli is intended for read-only gh commands. Ask for confirmation before proposing any GitHub mutation.",
    ],
    parameters: Type.Object({
      args: Type.Array(Type.String(), {
        description: "Arguments passed to gh. Examples: ['repo','list','OWNER'], ['issue','list','--repo','OWNER/REPO'].",
      }),
    }),
    async execute(_toolCallId, params, signal) {
      const args = params.args as string[];
      const mutating = new Set(["create", "edit", "delete", "close", "reopen", "merge", "ready", "lock", "unlock"]);
      if (args.some((arg) => mutating.has(arg))) {
        throw new Error("Refusing potentially mutating gh command from tool. Ask the user for explicit confirmation and run manually if needed.");
      }

      const output = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn("gh", args, { shell: process.platform === "win32", signal });
        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", (chunk) => (stdout += chunk.toString()));
        child.stderr?.on("data", (chunk) => (stderr += chunk.toString()));
        child.on("error", reject);
        child.on("exit", (code) => resolve({ code, stdout, stderr }));
      });

      if (output.code !== 0) {
        throw new Error(`gh exited with code ${output.code}: ${output.stderr || output.stdout}`);
      }

      return {
        content: [{ type: "text", text: output.stdout || output.stderr || "gh command completed with no output." }],
        details: { args, stdout: output.stdout, stderr: output.stderr },
      };
    },
  });
}
