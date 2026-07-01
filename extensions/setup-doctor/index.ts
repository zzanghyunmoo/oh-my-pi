import type {
  ExtensionAPI,
  ExtensionContext,
  InputEvent,
  InputEventResult,
} from "@earendil-works/pi-coding-agent";
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
  formatSetupConnectorList,
  formatWorkspaceMcpUsage,
  getSetupConnectorBackend,
  parseSetupConnectorArgument,
  parseWorkspaceMcpServiceArgument,
  routeGitHubCliConnector,
  routeGitLabCliConnector,
  routeProviderConnector,
  routeWorkspaceMcpConnector,
  type ConnectorBackend,
  type WorkspaceMcpServiceName,
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
  assertConnectorRuntimeReady,
  evaluateConnectorReadiness,
  formatConnectorReadinessReport,
  type ConnectorReadinessReport,
} from "../workspace-connectors/readiness.js";
import {
  getConnectorSetupPath,
  parseConnectorSetupCommand,
  writeConnectorSetupState,
} from "../workspace-connectors/setup-state.js";
import { runBrowserOAuthLogin } from "../workspace-connectors/auth.js";
import {
  formatMcpToolList,
  withMcpClient,
} from "../workspace-connectors/index.js";

const QUOTIO_TIMEOUT_MS = 5000;
const QUOTIO_PROVIDER_ROUTE = routeProviderConnector("quotio");
const LINEAR_CONNECTOR_ROUTE = routeWorkspaceMcpConnector("linear");
const NOTION_CONNECTOR_ROUTE = routeWorkspaceMcpConnector("notion");
const GITHUB_CLI_ROUTE = routeGitHubCliConnector();
const GITLAB_CLI_ROUTE = routeGitLabCliConnector();

type OmpCommandTarget =
  | "help"
  | "palette"
  | "doctor"
  | "connector-setup"
  | "connector-status"
  | "connector-login"
  | "connector-tools"
  | "profile-verify"
  | "profile-apply"
  | "quotio-status"
  | "github-auth"
  | "gitlab-auth";

const OMP_PREFIX_PATTERN = /^\s*(?:omp|oh-my-pi)\s*:\s*(.*)$/i;
const OMP_SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const OMP_SKILL_ALIASES: Readonly<Record<string, string>> = {
  brainstorm: "ce-brainstorm",
  plan: "ce-plan",
  work: "ce-work",
  debug: "ce-debug",
  review: "ce-code-review",
  "code-review": "ce-code-review",
  commit: "ce-commit",
  pr: "ce-commit-push-pr",
  compound: "ce-compound",
  strategy: "ce-strategy",
  simplify: "ce-simplify-code",
  lsp: "lsp-navigation",
  ast: "ast-grep",
  subagents: "pi-subagents",
  ask: "ask-user",
  web: "librarian",
};

const OMP_COMMAND_ALIASES: Readonly<Record<string, OmpCommandTarget>> = {
  "": "help",
  "?": "help",
  help: "help",
  commands: "help",
  palette: "palette",
  doctor: "doctor",
  setup: "connector-setup",
  "connector-setup": "connector-setup",
  status: "connector-status",
  "connector-status": "connector-status",
  login: "connector-login",
  "connector-login": "connector-login",
  tools: "connector-tools",
  "connector-tools": "connector-tools",
  "profile-verify": "profile-verify",
  verify: "profile-verify",
  "profile-apply": "profile-apply",
  apply: "profile-apply",
  quotio: "quotio-status",
  "quotio-status": "quotio-status",
  github: "github-auth",
  "github-auth": "github-auth",
  "gh-auth": "github-auth",
  gitlab: "gitlab-auth",
  "gitlab-auth": "gitlab-auth",
  "glab-auth": "gitlab-auth",
};

type Status = "ok" | "warn" | "error" | "info";
type NotifyLevel = "info" | "error";

interface NotificationContext {
  readonly ui: {
    notify(message: string, level: NotifyLevel): void | Promise<void>;
  };
}

export interface OmpInvocation {
  readonly target: string;
  readonly args: string;
}

export type OmpRoute =
  | { readonly kind: "command"; readonly target: OmpCommandTarget }
  | { readonly kind: "skill"; readonly skillName: string }
  | { readonly kind: "error"; readonly message: string };

export function parseOmpInvocation(text: string): OmpInvocation | null {
  const match = OMP_PREFIX_PATTERN.exec(text);
  if (!match) return null;

  const rest = match[1]?.trim() ?? "";
  if (rest === "") return { target: "", args: "" };

  const [target = "", ...argParts] = rest.split(/\s+/);
  return {
    target: target.toLowerCase(),
    args: argParts.join(" ").trim(),
  };
}

export function resolveOmpRoute(invocation: OmpInvocation): OmpRoute {
  const commandTarget = OMP_COMMAND_ALIASES[invocation.target];
  if (commandTarget) return { kind: "command", target: commandTarget };

  const skillName = OMP_SKILL_ALIASES[invocation.target] ?? invocation.target;
  if (!OMP_SKILL_NAME_PATTERN.test(skillName)) {
    return {
      kind: "error",
      message: `Unknown OMP target: ${invocation.target || "<empty>"}`,
    };
  }

  return { kind: "skill", skillName };
}

function formatOmpSkillExpansion(skillName: string, args: string): string {
  return `/skill:${skillName}${args ? ` ${args}` : ""}`;
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
        ...(capsule.exposes.skills ?? []).map((name) => `skill:${name}`),
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

async function buildQuotioStatusReport(): Promise<string> {
  const missing = QUOTIO_PROVIDER_ROUTE.requiredEnvVars.filter((key) => !isSet(key));
  if (missing.length > 0) return `Cannot check Quotio status — missing: ${missing.join(", ")}`;

  try {
    const discovery = await discoverOpenAICompatibleModels({
      baseUrl: getEnvValue("QUOTIO_BASE_URL"),
      apiKey: getEnvValue("QUOTIO_API_KEY"),
      timeoutMs: QUOTIO_TIMEOUT_MS,
    });
    const modelList = discovery.models.map((model) => `  - ${model.id}`).join("\n");
    return `Quotio: Connected (${discovery.elapsedMs}ms), ${discovery.models.length} models:\n${modelList}`;
  } catch (error: unknown) {
    if (error instanceof ProviderAdapterError && error.kind === "timeout") {
      return `Quotio: Timed out after ${error.elapsedMs}ms. Check QUOTIO_BASE_URL.`;
    }
    if (error instanceof ProviderAdapterError && error.kind === "auth") return "Quotio: Auth failed. Check QUOTIO_API_KEY.";
    const message = error instanceof Error ? error.message : String(error);
    return `Quotio: Connection failed — ${message}`;
  }
}

async function buildConnectorToolsReport(service: WorkspaceMcpServiceName): Promise<string> {
  await assertConnectorRuntimeReady(service);
  const route = routeWorkspaceMcpConnector(service);
  const { value: tools, authMode } = await withMcpClient(service, async (client) => {
    const listToolsResult = await client.listTools();
    return listToolsResult.tools ?? [];
  });
  return `${route.label} tools (${authMode}):\n${formatMcpToolList(tools).replace(/^/gm, "- ")}`;
}

async function buildCliAuthReport(service: "github" | "gitlab"): Promise<string> {
  const readiness = await evaluateConnectorReadiness();
  const entry = readiness.entries.find((item) => item.service === service);
  if (!entry) return line("warn", `${service} CLI auth`, "not available in connector readiness");
  const route = service === "github" ? GITHUB_CLI_ROUTE : GITLAB_CLI_ROUTE;
  return cliAuthLineFromReadiness(route.label, entry.authPassport.provenance, entry.authPassport.ready);
}

export function buildOmpNamespaceReport(): string {
  const skillAliases = Object.entries(OMP_SKILL_ALIASES)
    .map(([alias, skill]) => `${alias}→${skill}`)
    .join(", ");

  return [
    "oh-my-pi namespace",
    "",
    "Use `omp: <skill-or-command> [args]` as the user-facing entry point.",
    "Skills expand to Pi skill commands, e.g. `omp: ce-plan docs/foo.md` → `/skill:ce-plan docs/foo.md`.",
    `Convenience skill aliases: ${skillAliases}`,
    "Command aliases: omp: doctor, omp: palette, omp: setup full, omp: status, omp: quotio-status, omp: connector-login linear|notion, omp: connector-tools linear|notion, omp: github-auth, omp: gitlab-auth, omp: profile-verify, omp: profile-apply.",
    "Toggle-controlled aliases still respect ENABLE_QUOTIO and ENABLE_WORKSPACE_CONNECTORS.",
    "Source package names remain visible in doctor/profile output for debugging; users do not need to remember them during normal use.",
  ].join("\n");
}

async function handleOmpCommand(target: OmpCommandTarget, args: string, ctx: ExtensionContext): Promise<void> {
  if (target === "help") {
    await ctx.ui.notify(buildOmpNamespaceReport(), "info");
    return;
  }
  if (target === "palette") {
    await ctx.ui.notify(buildPaletteReport(), "info");
    return;
  }
  if (target === "doctor") {
    await ctx.ui.notify(await buildDoctorReport(), "info");
    return;
  }
  if (target === "connector-setup") {
    const result = await buildConnectorSetupReport(args);
    await ctx.ui.notify(result.message, result.level);
    return;
  }
  if (target === "connector-status") {
    const service = args.trim() === "" ? null : parseSetupConnectorArgument(args);
    if (args.trim() !== "" && !service) {
      await ctx.ui.notify(`Usage: omp: status [${formatSetupConnectorList()}]`, "error");
      return;
    }
    const report = formatConnectorReadinessReport(await evaluateConnectorReadiness());
    await ctx.ui.notify(service ? `${getSetupConnectorBackend(service).label}\n\n${report}` : report, "info");
    return;
  }
  if (target === "profile-verify") {
    await ctx.ui.notify("OMP profile verify: run `npm run profile:verify` from the oh-my-pi repo.", "info");
    return;
  }
  if (target === "profile-apply") {
    await ctx.ui.notify("OMP profile apply: run `npm run profile:apply -- --profile full` from the oh-my-pi repo. It is dry-run only by default.", "info");
    return;
  }
  if (target === "quotio-status") {
    if (process.env[QUOTIO_PROVIDER_ROUTE.toggleEnvVar] !== "true") {
      await ctx.ui.notify(`OMP Quotio alias disabled — set ${QUOTIO_PROVIDER_ROUTE.toggleEnvVar}=true in the CWD .env and reload.`, "error");
      return;
    }
    const report = await buildQuotioStatusReport();
    await ctx.ui.notify(report, report.startsWith("Quotio: Connected") ? "info" : "error");
    return;
  }
  if (target === "github-auth") {
    await ctx.ui.notify(await buildCliAuthReport("github"), "info");
    return;
  }
  if (target === "gitlab-auth") {
    await ctx.ui.notify(await buildCliAuthReport("gitlab"), "info");
    return;
  }

  if (process.env.ENABLE_WORKSPACE_CONNECTORS !== "true") {
    await ctx.ui.notify("OMP workspace connector alias disabled — set ENABLE_WORKSPACE_CONNECTORS=true in the CWD .env and reload.", "error");
    return;
  }

  const service = parseWorkspaceMcpServiceArgument(args);
  if (!service) {
    await ctx.ui.notify(`Usage: omp: ${target} ${formatWorkspaceMcpUsage("").trim()}`, "error");
    return;
  }

  if (target === "connector-login") {
    try {
      await runBrowserOAuthLogin(service, ctx);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.ui.notify(message, "error");
    }
    return;
  }

  try {
    await ctx.ui.notify(await buildConnectorToolsReport(service), "info");
  } catch (error: unknown) {
    const route = routeWorkspaceMcpConnector(service);
    const message = error instanceof Error ? error.message : String(error);
    await ctx.ui.notify(`Failed to list ${route.label} tools: ${message}\n${route.fallbackMessage}`, "error");
  }
}

async function handleOmpInput(event: InputEvent, ctx: ExtensionContext): Promise<InputEventResult> {
  if (event.source === "extension") return { action: "continue" };
  const invocation = parseOmpInvocation(event.text);
  if (!invocation) return { action: "continue" };

  const route = resolveOmpRoute(invocation);
  if (route.kind === "error") {
    await ctx.ui.notify(`${route.message}\n\n${buildOmpNamespaceReport()}`, "error");
    return { action: "handled" };
  }
  if (route.kind === "command") {
    await handleOmpCommand(route.target, invocation.args, ctx);
    return { action: "handled" };
  }
  return {
    action: "transform",
    text: formatOmpSkillExpansion(route.skillName, invocation.args),
    images: event.images,
  };
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
    line("info", "OMP namespace", "use `omp: <skill-or-command> [args]`; run `omp: help` for aliases"),
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
    "- /omp — show OMP namespace help; type `omp: <skill-or-command> [args]` to route through oh-my-pi.",
    "- omp: ce-plan docs/foo.md — expand to /skill:ce-plan docs/foo.md.",
    "- omp: doctor — run setup diagnostics without remembering /oh-my-pi-doctor.",
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
    "- Profile choices: default (base), workspace (Linear/Notion/GitHub), proxy-provider (Quotio), full (workspace + Quotio).",
    "- npm run profile:apply -- --profile proxy-provider — print the optional Quotio provider setup plan.",
    "- npm run profile:apply -- --profile full — print a non-destructive full setup plan.",
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
  pi.on("input", handleOmpInput);

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

  pi.registerCommand("omp", {
    description: "Show oh-my-pi namespace help for `omp: <skill-or-command>` aliases.",
    handler: async (_args: string, ctx: NotificationContext) => {
      ctx.ui.notify(buildOmpNamespaceReport(), "info");
    },
  });
}
