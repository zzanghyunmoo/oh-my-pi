import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import {
	getCapabilityCapsules,
	getToggleControlledCapabilities,
	type CapabilityCapsule,
} from "../capability-registry.js";
import {
	connectorBackendCatalog,
	routeProviderConnector,
	routeWorkspaceMcpConnector,
	type ConnectorBackend,
} from "../connector-backend-catalog.js";
import {
	discoverOpenAICompatibleModels,
	ProviderAdapterError,
} from "../provider-adapter-kit/openai-compatible.js";
import {
	getRuntimeSafetyPolicy,
	summarizeRuntimeSafetyPolicy,
} from "../runtime-safety-policy-ledger.js";

const COMMAND_TIMEOUT_MS = 3000;
const QUOTIO_TIMEOUT_MS = 5000;
const QUOTIO_PROVIDER_ROUTE = routeProviderConnector("quotio");
const LINEAR_CONNECTOR_ROUTE = routeWorkspaceMcpConnector("linear");
const NOTION_CONNECTOR_ROUTE = routeWorkspaceMcpConnector("notion");

type Status = "ok" | "warn" | "error" | "info";
type NotifyLevel = "info" | "error";

interface NotificationContext {
	readonly ui: {
		notify(message: string, level: NotifyLevel): void | Promise<void>;
	};
}

interface CommandResult {
	available: boolean;
	code: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	error?: string;
}

function statusIcon(status: Status): string {
	switch (status) {
		case "ok":
			return "✅";
		case "warn":
			return "⚠️";
		case "error":
			return "❌";
		case "info":
			return "ℹ️";
		default:
			return "ℹ️";
	}
}

function line(status: Status, label: string, detail: string): string {
	return `${statusIcon(status)} ${label}: ${detail}`;
}

function getEnvValue(key: string): string {
	return process.env[key]?.trim() ?? "";
}

function isSet(key: string): boolean {
	return getEnvValue(key) !== "";
}

function describeToggle(key: string): string {
	const value = process.env[key];
	if (value === "true") return "enabled (true)";
	if (value === undefined || value.trim() === "") return "disabled (unset)";
	return `disabled (${value}; expected true)`;
}

function envPresenceLine(key: string): string {
	return `${key}=${isSet(key) ? "set" : "missing"}`;
}

function localOnlyPathStatus(path: string): string {
	return `${path} (${existsSync(path) ? "present" : "not present"})`;
}

function summarizeCommandOutput(output: string): string {
	const cleaned = output
		.replace(/github_pat_[A-Za-z0-9_]+/g, "github_pat_…")
		.replace(/gh[pousr]_[A-Za-z0-9_]+/g, "gh*_…")
		.split("\n")
		.map((part) => part.trim())
		.filter(Boolean);

	return cleaned.slice(0, 2).join("; ");
}

function runCommand(
	command: string,
	args: string[],
	timeoutMs: number,
): Promise<CommandResult> {
	return new Promise((resolveResult) => {
		const child = spawn(command, args, { shell: process.platform === "win32" });
		let stdout = "";
		let stderr = "";
		let settled = false;
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
		}, timeoutMs);

		const finish = (
			result: Omit<CommandResult, "stdout" | "stderr" | "timedOut">,
		) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolveResult({ ...result, stdout, stderr, timedOut });
		};

		child.stdout?.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr?.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("error", (error: NodeJS.ErrnoException) => {
			finish({
				available: false,
				code: null,
				error: error.code ?? error.message,
			});
		});
		child.on("exit", (code) => {
			finish({ available: true, code });
		});
	});
}

function formatToggleSummary(): string {
	const toggles = getToggleControlledCapabilities();
	if (toggles.length === 0) return "no toggle-controlled capabilities";
	return toggles
		.map(
			(capsule) =>
				`${capsule.toggleEnvVar}=${describeToggle(capsule.toggleEnvVar)} (${capsule.id})`,
		)
		.join("; ");
}

function formatCapabilitySummary(
	capsules: readonly CapabilityCapsule[],
): string {
	return capsules
		.map((capsule) => {
			const surfaces = [
				...(capsule.exposes.commands ?? []).map((name) => `/${name}`),
				...(capsule.exposes.tools ?? []).map((name) => `tool:${name}`),
				...(capsule.exposes.providers ?? []).map((name) => `provider:${name}`),
			];
			const activation = capsule.toggleEnvVar
				? capsule.toggleEnvVar
				: "always-on";
			return `${capsule.id}(${activation}, ${capsule.safetyClass}${surfaces.length > 0 ? `, ${surfaces.join("|")}` : ""})`;
		})
		.join("; ");
}

function formatConnectorBackendSummary(
	backends: readonly ConnectorBackend[],
): string {
	return backends
		.map(
			(backend) =>
				`${backend.id}=${backend.backendKind}/${backend.adapterKind}`,
		)
		.join("; ");
}

function formatRuntimeSafetySummary(): string {
	const policyIds = [
		"tool.workspace_mcp_list_tools",
		"tool.workspace_mcp_call_tool",
		"tool.github_gh_cli",
		"provider.quotio",
	] as const;
	return policyIds
		.map((id) => {
			const summary = summarizeRuntimeSafetyPolicy(getRuntimeSafetyPolicy(id));
			return `${summary.targetName}=${summary.accessMode}/${summary.approvalExpectation}`;
		})
		.join("; ");
}

async function checkGhAuth(): Promise<string> {
	const result = await runCommand(
		"gh",
		["auth", "status", "--hostname", "github.com"],
		COMMAND_TIMEOUT_MS,
	);

	if (!result.available) {
		return line(
			"warn",
			"GitHub CLI auth",
			`gh not available (${result.error ?? "spawn failed"})`,
		);
	}

	if (result.timedOut) {
		return line(
			"warn",
			"GitHub CLI auth",
			`timed out after ${COMMAND_TIMEOUT_MS}ms`,
		);
	}

	const summary = summarizeCommandOutput(`${result.stdout}\n${result.stderr}`);
	if (result.code === 0) {
		return line("ok", "GitHub CLI auth", summary || "authenticated");
	}

	return line(
		"warn",
		"GitHub CLI auth",
		summary ||
			`not authenticated or unavailable (exit ${result.code}); run gh auth login if needed`,
	);
}

async function checkQuotioConnectivity(): Promise<string> {
	if (process.env[QUOTIO_PROVIDER_ROUTE.toggleEnvVar] !== "true") {
		return line(
			"info",
			"Quotio connectivity",
			`skipped because ${QUOTIO_PROVIDER_ROUTE.toggleEnvVar} is not true`,
		);
	}

	const missing = QUOTIO_PROVIDER_ROUTE.requiredEnvVars.filter(
		(key) => !isSet(key),
	);
	if (missing.length > 0) {
		return line(
			"warn",
			"Quotio connectivity",
			`skipped because missing ${missing.join(", ")}`,
		);
	}

	try {
		const discovery = await discoverOpenAICompatibleModels({
			baseUrl: getEnvValue("QUOTIO_BASE_URL"),
			apiKey: getEnvValue("QUOTIO_API_KEY"),
			timeoutMs: QUOTIO_TIMEOUT_MS,
		});

		return line(
			"ok",
			"Quotio connectivity",
			`connected in ${discovery.elapsedMs}ms; models=${discovery.models.length}`,
		);
	} catch (error: unknown) {
		if (error instanceof ProviderAdapterError) {
			if (error.kind === "timeout") {
				return line(
					"warn",
					"Quotio connectivity",
					`timed out after ${error.elapsedMs}ms`,
				);
			}
			const authHint = error.kind === "auth" ? " (check QUOTIO_API_KEY)" : "";
			return line(
				"warn",
				"Quotio connectivity",
				`${error.kind}: ${error.message}${authHint}`,
			);
		}
		const message = error instanceof Error ? error.message : String(error);
		return line("warn", "Quotio connectivity", `failed — ${message}`);
	}
}

async function buildDoctorReport(): Promise<string> {
	const cwd = process.cwd();
	const envPath = resolve(cwd, ".env");
	const quotioEnvSummary = QUOTIO_PROVIDER_ROUTE.requiredEnvVars
		.map(envPresenceLine)
		.join(", ");
	const localOnlyPaths = [
		resolve(cwd, ".env"),
		resolve(cwd, ".mcp-auth"),
		resolve(cwd, ".pi"),
		resolve(cwd, "auth.json"),
		resolve(cwd, "sessions"),
		resolve(homedir(), ".pi", "agent", "auth.json"),
		resolve(homedir(), ".pi", "agent", "sessions"),
	];

	const [quotioConnectivity, ghAuth] = await Promise.all([
		checkQuotioConnectivity(),
		checkGhAuth(),
	]);

	return [
		"oh-my-pi setup doctor",
		"",
		line(
			existsSync(envPath) ? "ok" : "warn",
			"CWD .env",
			existsSync(envPath) ? `found at ${envPath}` : `not found at ${envPath}`,
		),
		line(
			"info",
			"Capability registry",
			formatCapabilitySummary(getCapabilityCapsules()),
		),
		line("info", "Extension toggles", formatToggleSummary()),
		line(
			"info",
			"Connector backend catalog",
			formatConnectorBackendSummary(connectorBackendCatalog),
		),
		line("info", "Runtime safety ledger", formatRuntimeSafetySummary()),
		line(
			QUOTIO_PROVIDER_ROUTE.requiredEnvVars.every((key) => isSet(key))
				? "ok"
				: "warn",
			"Quotio env",
			quotioEnvSummary,
		),
		quotioConnectivity,
		ghAuth,
		line(
			"info",
			"Local-only reminders",
			localOnlyPaths.map(localOnlyPathStatus).join("; "),
		),
		"",
		"Keep local-only files out of commits: .env, .mcp-auth, .pi/, auth.json, sessions/, ~/.pi/agent/auth.json, ~/.pi/agent/sessions/.",
	].join("\n");
}

function buildPaletteReport(): string {
	return [
		"oh-my-pi commands",
		"",
		"- /oh-my-pi-doctor — run read-only setup diagnostics for local env, capability registry, connector catalog, provider checks, gh auth, safety policies, and local-only paths.",
		"- /oh-my-pi — show this lightweight command palette.",
		"- /quotio-status — check Quotio models when ENABLE_QUOTIO=true and Quotio env is configured.",
		"- /connector-login linear|notion — start workspace connector OAuth when ENABLE_WORKSPACE_CONNECTORS=true; Pi temporarily hands the terminal to the OAuth CLI.",
		"- /connector-tools linear|notion — list connector tools after login.",
		`- Connector login fallback — from a normal shell run \`${LINEAR_CONNECTOR_ROUTE.loginShellCommand}\` or \`${NOTION_CONNECTOR_ROUTE.loginShellCommand}\`, then restart Pi and run /connector-tools.`,
		"- npm run profile:verify — verify commit-safe profile pack and deterministic lock receipt.",
		"- Profile choices: default (base), workspace (Linear/Notion/GitHub), proxy-provider (Quotio), full (workspace + Quotio).",
		"- npm run profile:apply -- --profile proxy-provider — print the optional Quotio provider setup plan.",
		"- npm run profile:apply -- --profile full — print a non-destructive full setup plan.",
		"",
		"Tip: CWD .env is loaded by env-loader before other oh-my-pi extensions.",
	].join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("oh-my-pi-doctor", {
		description:
			"Run read-only oh-my-pi setup diagnostics for env toggles, provider/connectors, safety policies, gh auth, and local-only paths.",
		handler: async (_args: string, ctx: NotificationContext) => {
			ctx.ui.notify(await buildDoctorReport(), "info");
		},
	});

	pi.registerCommand("oh-my-pi", {
		description:
			"Show the lightweight oh-my-pi command palette and setup help.",
		handler: async (_args: string, ctx: NotificationContext) => {
			ctx.ui.notify(buildPaletteReport(), "info");
		},
	});
}
