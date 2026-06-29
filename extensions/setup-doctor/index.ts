import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  getCapabilityCapsules,
  getToggleControlledCapabilities,
  type CapabilityCapsule,
} from "../capability-registry.js";
import {
  connectorBackendCatalog,
  routeGitHubCliConnector,
  routeGitLabCliConnector,
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
import {
  evaluateConnectorReadiness,
  formatConnectorReadinessReport,
  type ConnectorReadinessReport,
} from "../workspace-connectors/readiness.js";
import {
  getConnectorSetupPath,
  parseConnectorSetupCommand,
  writeConnectorSetupState,
} from "../workspace-connectors/setup-state.js";

const QUOTIO_TIMEOUT_MS = 5000;
const QUOTIO_PROVIDER_ROUTE = routeProviderConnector("quotio");
const LINEAR_CONNECTOR_ROUTE = routeWorkspaceMcpConnector("linear");
const NOTION_CONNECTOR_ROUTE = routeWorkspaceMcpConnector("notion");
const GITHUB_CLI_ROUTE = routeGitHubCliConnector();
const GITLAB_CLI_ROUTE = routeGitLabCliConnector();

type Status = "ok" | "warn" | "error" | "info";
type NotifyLevel = "info" | "error";

interface NotificationContext {
  readonly ui: {
    notify(message: string, level: NotifyLevel): void | Promise<void>;
  };
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

function formatToggleSummary(): string {
  const toggles = getToggleControlledCapabilities();
  if (toggles.length === 0) return "no toggle-controlled capabilities";
  return toggles
    .map((capsule) => `${capsule.toggleEnvVar}=${describeToggle(capsule.toggleEnvVar)} (${capsule.id})`)
    .join("; ");
}

function formatCapabilitySummary(capsules: readonly CapabilityCapsule[]): string {
  return capsules
    .map((capsule) => {
      const surfaces = [
        ...(capsule.exposes.commands ?? []).map((name) => `/${name}`),
        ...(capsule.exposes.tools ?? []).map((name) => `tool:${name}`),
        ...(capsule.exposes.providers ?? []).map((name) => `provider:${name}`),
      ];
      const activation = capsule.toggleEnvVar ? capsule.toggleEnvVar : "always-on";
      return `${capsule.id}(${activation}, ${capsule.safetyClass}${surfaces.length > 0 ? `, ${surfaces.join("|")}` : ""})`;
    })
    .join("; ");
}

function formatConnectorBackendSummary(backends: readonly ConnectorBackend[]): string {
  return backends
    .map((backend) => `${backend.id}=${backend.backendKind}/${backend.adapterKind}`)
    .join("; ");
}

function formatRuntimeSafetySummary(): string {
  const policyIds = [
    "tool.workspace_mcp_list_tools",
    "tool.workspace_mcp_call_tool",
    "tool.github_gh_cli",
    "tool.gitlab_glab_cli",
    "provider.quotio",
  ] as const;
  return policyIds
    .map((id) => {
      const summary = summarizeRuntimeSafetyPolicy(getRuntimeSafetyPolicy(id));
      return `${summary.targetName}=${summary.accessMode}/${summary.approvalExpectation}`;
    })
    .join("; ");
}

function cliAuthLineFromReadiness(label: string, provenance: string, ready: boolean): string {
  return line(ready ? "ok" : "warn", `${label} CLI auth`, provenance);
}

async function checkQuotioConnectivity(): Promise<string> {
  if (process.env[QUOTIO_PROVIDER_ROUTE.toggleEnvVar] !== "true") {
    return line("info", "Quotio connectivity", `skipped because ${QUOTIO_PROVIDER_ROUTE.toggleEnvVar} is not true`);
  }

  const missing = QUOTIO_PROVIDER_ROUTE.requiredEnvVars.filter((key) => !isSet(key));
  if (missing.length > 0) {
    return line("warn", "Quotio connectivity", `skipped because missing ${missing.join(", ")}`);
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
        return line("warn", "Quotio connectivity", `timed out after ${error.elapsedMs}ms`);
      }
      const authHint = error.kind === "auth" ? " (check QUOTIO_API_KEY)" : "";
      return line("warn", "Quotio connectivity", `${error.kind}: ${error.message}${authHint}`);
    }
    const message = error instanceof Error ? error.message : String(error);
    return line("warn", "Quotio connectivity", `failed — ${message}`);
  }
}

async function buildDoctorReport(): Promise<string> {
  const cwd = process.cwd();
  const envPath = resolve(cwd, ".env");
  const quotioEnvSummary = QUOTIO_PROVIDER_ROUTE.requiredEnvVars.map(envPresenceLine).join(", ");
  const localOnlyPaths = [
    resolve(cwd, ".env"),
    resolve(cwd, ".mcp-auth"),
    resolve(cwd, ".pi"),
    resolve(cwd, "auth.json"),
    resolve(cwd, "sessions"),
    resolve(homedir(), ".pi", "agent", "auth.json"),
    resolve(homedir(), ".pi", "agent", "sessions"),
    getConnectorSetupPath(),
  ];

  const [quotioConnectivity, readinessResult] = await Promise.all([
    checkQuotioConnectivity(),
    evaluateConnectorReadiness().catch((error: unknown): Error => error instanceof Error ? error : new Error(String(error))),
  ]) as [string, ConnectorReadinessReport | Error];
  const connectorReadiness = readinessResult instanceof Error
    ? line("warn", "Connector readiness", readinessResult.message)
    : formatConnectorReadinessReport(readinessResult);
  const githubEntry = readinessResult instanceof Error ? undefined : readinessResult.entries.find((entry) => entry.service === "github");
  const gitlabEntry = readinessResult instanceof Error ? undefined : readinessResult.entries.find((entry) => entry.service === "gitlab");
  const ghAuth = githubEntry
    ? cliAuthLineFromReadiness(GITHUB_CLI_ROUTE.label, githubEntry.authPassport.provenance, githubEntry.authPassport.ready)
    : line("warn", "GitHub CLI auth", "not available in connector readiness");
  const glabAuth = gitlabEntry
    ? cliAuthLineFromReadiness(GITLAB_CLI_ROUTE.label, gitlabEntry.authPassport.provenance, gitlabEntry.authPassport.ready)
    : line("warn", "GitLab CLI auth", "not available in connector readiness");

  return [
    "oh-my-pi setup doctor",
    "",
    line(existsSync(envPath) ? "ok" : "warn", "CWD .env", existsSync(envPath) ? `found at ${envPath}` : `not found at ${envPath}`),
    line("info", "Capability registry", formatCapabilitySummary(getCapabilityCapsules())),
    line("info", "Extension toggles", formatToggleSummary()),
    line("info", "Connector backend catalog", formatConnectorBackendSummary(connectorBackendCatalog)),
    line("info", "Runtime safety ledger", formatRuntimeSafetySummary()),
    line(QUOTIO_PROVIDER_ROUTE.requiredEnvVars.every((key) => isSet(key)) ? "ok" : "warn", "Quotio env", quotioEnvSummary),
    quotioConnectivity,
    ghAuth,
    glabAuth,
    line("info", "Connector readiness", connectorReadiness.replace(/\n/g, " | ")),
    line("info", "Local-only reminders", localOnlyPaths.map(localOnlyPathStatus).join("; ")),
    "",
    "Keep local-only files out of commits: .env, .mcp-auth, .pi/, auth.json, sessions/, ~/.pi/agent/auth.json, ~/.pi/agent/sessions/, ~/.pi/agent/workspace-connectors-auth.json, ~/.pi/agent/workspace-connectors-setup.json.",
  ].join("\n");
}

function buildPaletteReport(): string {
  return [
    "oh-my-pi commands",
    "",
    "- /connector-setup full — record full connector setup intent for personal Linear/Notion/GitHub and company Jira/Confluence/GitLab.",
    "- /connector-setup selective tenant:company capability:git — record selective setup intent by tenant/capability.",
    "- /connector-setup minimal — intentionally hide issue-tracker, wiki, and git connector affordances.",
    "- /oh-my-pi-doctor — run read-only setup diagnostics for local env, capability registry, connector catalog, provider checks, gh/glab auth, safety policies, readiness, and local-only paths.",
    "- /oh-my-pi — show this lightweight command palette.",
    "- /quotio-status — check Quotio models when ENABLE_QUOTIO=true and Quotio env is configured.",
    "- /connector-login linear|notion — start direct browser OAuth when ENABLE_WORKSPACE_CONNECTORS=true; OAuth tokens are stored locally outside the repo.",
    "- /connector-status [service] — show connector setup readiness plus OAuth/access-key status.",
    "- /connector-logout <service|tenant:personal|tenant:company|capability:git> [--confirm] — preview first; clears only Pi-managed OAuth state when confirmed.",
    "- /connector-tools linear|notion — list connector tools after OAuth login or access-key env setup.",
    `- GitHub CLI — ${GITHUB_CLI_ROUTE.statusGuidance}; tool: github_gh_cli read-only allowlist.`,
    `- GitLab CLI — ${GITLAB_CLI_ROUTE.statusGuidance}; tool: gitlab_glab_cli read-only allowlist.`,
    "- Jira/Confluence — setup-visible for company issue tracker/wiki, runtime-gated until a non-interactive Atlassian auth route is selected.",
    `- Access-key fallback — set ${LINEAR_CONNECTOR_ROUTE.accessKeyEnvVars.join("/")} for Linear or ${NOTION_CONNECTOR_ROUTE.accessKeyEnvVars.join("/")} for Notion in the CWD .env when browser OAuth is unavailable.`,
    `- Legacy external OAuth debug only — ${LINEAR_CONNECTOR_ROUTE.legacyMcpRemoteLoginShellCommand} or ${NOTION_CONNECTOR_ROUTE.legacyMcpRemoteLoginShellCommand}.`,
    "- npm run profile:verify — verify commit-safe profile pack and deterministic lock receipt.",
    "- npm run profile:apply -- --profile full — print a non-destructive profile setup plan.",
    "",
    "Tip: CWD .env is loaded by env-loader before other oh-my-pi extensions. /connector-setup is available even before ENABLE_WORKSPACE_CONNECTORS=true.",
  ].join("\n");
}

async function buildConnectorSetupReport(args: string): Promise<{ message: string; level: NotifyLevel }> {
  const parsed = parseConnectorSetupCommand(args);
  if ("error" in parsed) {
    return { message: `${parsed.error}\n\n${parsed.usage}`, level: "error" };
  }
  await writeConnectorSetupState(parsed.state);
  const readiness = await evaluateConnectorReadiness(parsed.state);
  const toggleNote = process.env.ENABLE_WORKSPACE_CONNECTORS === "true"
    ? "Workspace connector extension is enabled."
    : "Workspace connector extension is not enabled yet; add ENABLE_WORKSPACE_CONNECTORS=true in the CWD .env to expose runtime connector commands/tools.";
  return {
    message: [parsed.summary, toggleNote, "", formatConnectorReadinessReport(readiness)].join("\n"),
    level: "info",
  };
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("oh-my-pi-doctor", {
    description: "Run read-only oh-my-pi setup diagnostics for env toggles, provider/connectors, safety policies, gh auth, and local-only paths.",
    handler: async (_args: string, ctx: NotificationContext) => {
      ctx.ui.notify(await buildDoctorReport(), "info");
    },
  });

  pi.registerCommand("connector-setup", {
    description: "Configure connector setup intent: full, selective, or minimal. Always available as a non-secret setup bootstrap command.",
    handler: async (args: string, ctx: NotificationContext) => {
      const result = await buildConnectorSetupReport(args);
      ctx.ui.notify(result.message, result.level);
    },
  });

  pi.registerCommand("oh-my-pi", {
    description: "Show the lightweight oh-my-pi command palette and setup help.",
    handler: async (_args: string, ctx: NotificationContext) => {
      ctx.ui.notify(buildPaletteReport(), "info");
    },
  });
}
