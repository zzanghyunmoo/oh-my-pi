import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
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

interface TerminalHandoffTui {
	stop(): void;
	start(): void;
	requestRender(force?: boolean): void;
}

interface TerminalHandoffComponent {
	render(): string[];
	invalidate(): void;
	dispose?(): void;
}

interface TerminalHandoffContext extends NotificationContext {
	readonly hasUI?: boolean;
	readonly ui: NotificationContext["ui"] & {
		custom?<T>(
			factory: (
				tui: TerminalHandoffTui,
				theme: unknown,
				keybindings: unknown,
				done: (result: T) => void,
			) => TerminalHandoffComponent | Promise<TerminalHandoffComponent>,
		): Promise<T>;
	};
}

type InteractiveLoginResultBase = {
	readonly restoreError?: string;
};

export type InteractiveLoginResult = InteractiveLoginResultBase &
	(
		| { readonly status: "unsupported" }
		| {
				readonly status: "completed";
				readonly code: number | null;
				readonly signal: NodeJS.Signals | null;
		  }
		| { readonly status: "spawn-error"; readonly error: string }
	);

interface InteractiveLoginChildProcess {
	on(event: "error", listener: (error: Error) => void): this;
	on(
		event: "exit",
		listener: (code: number | null, signal: NodeJS.Signals | null) => void,
	): this;
}

type InteractiveLoginSpawnOptions = {
	readonly stdio: "inherit";
	readonly shell: boolean;
	readonly env: NodeJS.ProcessEnv;
};

type InteractiveLoginSpawn = (
	command: string,
	args: string[],
	options: InteractiveLoginSpawnOptions,
) => InteractiveLoginChildProcess;

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

const NODE_USE_SYSTEM_CA_OPTION = "--use-system-ca";
const MCP_REMOTE_ENV_KEYS_TO_INHERIT = [
	"NODE_EXTRA_CA_CERTS",
	"NODE_TLS_REJECT_UNAUTHORIZED",
	"HTTPS_PROXY",
	"HTTP_PROXY",
	"ALL_PROXY",
	"NO_PROXY",
	"https_proxy",
	"http_proxy",
	"all_proxy",
	"no_proxy",
] as const;

function appendNodeOption(
	existingOptions: string | undefined,
	option: string,
): string {
	if (!existingOptions || existingOptions.trim() === "") return option;
	if (existingOptions.split(/\s+/).includes(option)) return existingOptions;
	return `${existingOptions} ${option}`;
}

export function buildMcpRemoteEnvironment(
	baseEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
	const env: Record<string, string> = {};

	for (const key of MCP_REMOTE_ENV_KEYS_TO_INHERIT) {
		const value = baseEnv[key];
		if (value !== undefined && value !== "") {
			env[key] = value;
		}
	}

	if (baseEnv.NODE_OPTIONS !== undefined && baseEnv.NODE_OPTIONS !== "") {
		env.NODE_OPTIONS = baseEnv.NODE_OPTIONS;
	}

	if (process.allowedNodeEnvironmentFlags.has(NODE_USE_SYSTEM_CA_OPTION)) {
		env.NODE_OPTIONS = appendNodeOption(
			env.NODE_OPTIONS,
			NODE_USE_SYSTEM_CA_OPTION,
		);
	}

	return env;
}

function buildInteractiveLoginEnvironment(): NodeJS.ProcessEnv {
	return { ...process.env, ...buildMcpRemoteEnvironment() };
}

function parseService(args: string): ServiceName | null {
	return parseWorkspaceMcpServiceArgument(args);
}

async function withMcpClient<T>(
	service: ServiceName,
	fn: (client: Client) => Promise<T>,
): Promise<T> {
	const route = routeWorkspaceMcpConnector(service);
	const client = new Client({
		name: "pi-workspace-connectors",
		version: "0.1.0",
	});
	const transport = new StdioClientTransport({
		command: "npx",
		args: [...route.mcpRemoteArgs],
		env: buildMcpRemoteEnvironment(),
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
		parts.push(
			`structuredContent:\n${JSON.stringify(result.structuredContent, null, 2)}`,
		);
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

function emptyHandoffComponent(): TerminalHandoffComponent {
	return { render: () => [], invalidate: () => undefined };
}

type UsableTerminalHandoffContext = TerminalHandoffContext & {
	readonly hasUI: true;
	readonly ui: NotificationContext["ui"] & {
		custom<T>(
			factory: (
				tui: TerminalHandoffTui,
				theme: unknown,
				keybindings: unknown,
				done: (result: T) => void,
			) => TerminalHandoffComponent | Promise<TerminalHandoffComponent>,
		): Promise<T>;
	};
};

function canUseTerminalHandoff(
	ctx: TerminalHandoffContext,
): ctx is UsableTerminalHandoffContext {
	return ctx.hasUI === true && typeof ctx.ui.custom === "function";
}

export function runInteractiveLogin(
	command: string,
	args: string[],
	ctx: TerminalHandoffContext,
	spawnImpl: InteractiveLoginSpawn = spawn as InteractiveLoginSpawn,
): Promise<InteractiveLoginResult> {
	if (!canUseTerminalHandoff(ctx)) {
		return Promise.resolve({ status: "unsupported" });
	}

	return ctx.ui
		.custom<InteractiveLoginResult>((tui, _theme, _keybindings, done) => {
			let settled = false;
			let tuiStopped = false;

			const finish = (result: InteractiveLoginResult) => {
				if (settled) return;
				settled = true;

				let restoreError: string | undefined;
				if (tuiStopped) {
					try {
						tui.start();
						tui.requestRender(true);
					} catch (error: unknown) {
						restoreError = formatError(error);
					}
				}

				done(restoreError ? { ...result, restoreError } : result);
			};

			try {
				tui.stop();
				tuiStopped = true;
				const child = spawnImpl(command, args, {
					stdio: "inherit",
					shell: process.platform === "win32",
					env: buildInteractiveLoginEnvironment(),
				});
				child.on("error", (error) =>
					finish({ status: "spawn-error", error: formatError(error) }),
				);
				child.on("exit", (code, signal) =>
					finish({ status: "completed", code, signal: signal ?? null }),
				);
			} catch (error: unknown) {
				finish({ status: "spawn-error", error: formatError(error) });
			}

			return emptyHandoffComponent();
		})
		.catch((error: unknown) => ({
			status: "spawn-error",
			error: formatError(error),
		}));
}

function describeExitResult(
	result: Extract<InteractiveLoginResult, { status: "completed" }>,
): string {
	if (result.signal) return `signal ${result.signal}`;
	if (result.code !== null) return `code ${result.code}`;
	return "no exit code";
}

type WorkspaceMcpRoute = ReturnType<typeof routeWorkspaceMcpConnector>;

export function formatLoginFallbackMessage(route: WorkspaceMcpRoute): string {
	return `${route.fallbackMessage} External shell fallback: ${route.loginShellCommand}. After it completes, restart Pi or run ${route.statusGuidance}`;
}

export function formatInteractiveLoginResultNotification(
	route: WorkspaceMcpRoute,
	result: InteractiveLoginResult,
): { level: NotifyLevel; message: string } {
	const restoreNote = result.restoreError
		? ` TUI restore reported: ${result.restoreError}.`
		: "";

	if (result.status === "unsupported") {
		return {
			level: "error",
			message: `${route.label} OAuth login requires an interactive Pi TUI terminal handoff. ${formatLoginFallbackMessage(route)}`,
		};
	}

	if (result.status === "spawn-error") {
		return {
			level: "error",
			message: `${route.label} login/check could not start: ${result.error}.${restoreNote} ${formatLoginFallbackMessage(route)}`,
		};
	}

	if (result.code === 0) {
		return {
			level: "info",
			message: `${route.label} login/check completed.${restoreNote} ${route.statusGuidance}`,
		};
	}

	return {
		level: "error",
		message: `${route.label} login/check exited with ${describeExitResult(result)}.${restoreNote} ${formatLoginFallbackMessage(route)}`,
	};
}

export default function (pi: ExtensionAPI) {
	if (process.env.ENABLE_WORKSPACE_CONNECTORS !== "true") return;
	const loginUsage = formatWorkspaceMcpUsage("/connector-login");
	const toolsUsage = formatWorkspaceMcpUsage("/connector-tools");
	const githubRoute = routeGitHubCliConnector();
	const listToolsPolicy = getToolRuntimeSafetyPolicy(
		"workspace_mcp_list_tools",
	);
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
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const service = parseService(args);
			if (!service) {
				ctx.ui.notify(`Usage: ${loginUsage}`, "error");
				return;
			}

			const route = routeWorkspaceMcpConnector(service);
			if (canUseTerminalHandoff(ctx)) {
				ctx.ui.notify(
					`Starting ${route.label} OAuth flow. Pi will temporarily hand the terminal to the OAuth CLI. ${route.authGuidance}`,
					"info",
				);
			}
			const result = await runInteractiveLogin(
				"npx",
				[...route.loginArgs],
				ctx,
			);
			const notification = formatInteractiveLoginResultNotification(
				route,
				result,
			);
			ctx.ui.notify(notification.message, notification.level);
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
				const tools = await withMcpClient(
					service,
					async (client) => (await client.listTools()).tools ?? [],
				);
				const names = tools
					.map((tool: any) => `- ${tool.name}: ${tool.description ?? ""}`)
					.join("\n");
				ctx.ui.notify(
					`${route.label} tools:\n${names || "No tools returned."}`,
					"info",
				);
			} catch (error: any) {
				ctx.ui.notify(
					`Failed to list ${route.label} tools: ${error?.message ?? String(error)}\n${route.fallbackMessage}`,
					"error",
				);
			}
		},
	});

	pi.registerTool({
		name: "workspace_mcp_list_tools",
		label: "Workspace MCP: List Tools",
		description:
			"List available tools from the Linear or Notion OAuth MCP connector.",
		promptSnippet:
			"workspace_mcp_list_tools: list Linear/Notion MCP connector tools after OAuth login.",
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
				const tools = await withMcpClient(
					service,
					async (client) => (await client.listTools()).tools ?? [],
				);
				return {
					content: [
						{
							type: "text",
							text:
								tools
									.map((tool: any) => `${tool.name}: ${tool.description ?? ""}`)
									.join("\n") || "No tools returned.",
						},
					],
					details: {
						service,
						backend: route.description,
						safetyPolicy: summarizeRuntimeSafetyPolicy(listToolsPolicy),
						connectorSafetyPolicy: summarizeRuntimeSafetyPolicy(
							getConnectorRuntimeSafetyPolicy(service),
						),
						tools,
					},
				};
			} catch (error: any) {
				throw new Error(
					`Failed to list ${route.label} tools: ${error?.message ?? String(error)} ${route.fallbackMessage}`,
				);
			}
		},
	});

	pi.registerTool({
		name: "workspace_mcp_call_tool",
		label: "Workspace MCP: Call Tool",
		description: "Call a tool on the Linear or Notion OAuth MCP connector.",
		promptSnippet:
			"workspace_mcp_call_tool: call a Linear/Notion MCP tool by name with JSON arguments.",
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
			arguments: Type.Optional(
				Type.Any({ description: "JSON object passed as MCP tool arguments." }),
			),
		}),
		async execute(_toolCallId: string, params: WorkspaceMcpCallToolParams) {
			const service = params.service;
			const route = routeWorkspaceMcpConnector(service);
			const toolArguments: McpToolArguments =
				typeof params.arguments === "object" &&
				params.arguments !== null &&
				!Array.isArray(params.arguments)
					? (params.arguments as McpToolArguments)
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
						connectorSafetyPolicy: summarizeRuntimeSafetyPolicy(
							getConnectorRuntimeSafetyPolicy(service),
						),
						result,
					},
				};
			} catch (error: any) {
				throw new Error(
					`Failed to call ${route.label} MCP tool ${params.toolName}: ${error?.message ?? String(error)} ${route.fallbackMessage}`,
				);
			}
		},
	});

	pi.registerTool({
		name: "github_gh_cli",
		label: `${githubRoute.label}: gh CLI`,
		description: `${githubRoute.description} Intended for safe GitHub read commands.`,
		promptSnippet:
			"github_gh_cli: use the user's gh auth login session for GitHub read-only queries.",
		promptGuidelines: [
			githubRoute.authGuidance,
			"Use github_gh_cli for GitHub access when the user wants login-based GitHub integration without API keys.",
			"github_gh_cli is intended for read-only gh commands. Ask for confirmation before proposing any GitHub mutation.",
			...formatRuntimeSafetyPolicyGuidelines(githubGhCliPolicy),
		],
		parameters: Type.Object({
			args: Type.Array(Type.String(), {
				description:
					"Arguments passed to gh. Examples: ['repo','list','OWNER'], ['issue','list','--repo','OWNER/REPO'].",
			}),
		}),
		async execute(
			_toolCallId: string,
			params: GitHubGhCliParams,
			signal: AbortSignal,
		) {
			const args = params.args;
			if (isBlockedGithubGhCliInvocation(args)) {
				throw new Error(getGithubGhCliMutationGuardMessage());
			}

			const output = await new Promise<{
				code: number | null;
				stdout: string;
				stderr: string;
			}>((resolve, reject) => {
				const child = spawn(githubRoute.command, args, {
					shell: process.platform === "win32",
					signal,
				});
				let stdout = "";
				let stderr = "";
				child.stdout?.on("data", (chunk) => (stdout += chunk.toString()));
				child.stderr?.on("data", (chunk) => (stderr += chunk.toString()));
				child.on("error", reject);
				child.on("exit", (code) => resolve({ code, stdout, stderr }));
			});

			if (output.code !== 0) {
				throw new Error(
					`${githubRoute.fallbackMessage} ${githubRoute.command} exited with code ${output.code}: ${output.stderr || output.stdout}`,
				);
			}

			return {
				content: [
					{
						type: "text",
						text:
							output.stdout ||
							output.stderr ||
							`${githubRoute.command} command completed with no output.`,
					},
				],
				details: {
					args,
					safetyPolicy: summarizeRuntimeSafetyPolicy(githubGhCliPolicy),
					connectorSafetyPolicy: summarizeRuntimeSafetyPolicy(
						getConnectorRuntimeSafetyPolicy("github"),
					),
					stdout: output.stdout,
					stderr: output.stderr,
				},
			};
		},
	});
}
