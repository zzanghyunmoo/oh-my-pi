export type ConnectorTenant = "personal" | "company";
export type ConnectorCapabilitySlot = "issue-tracker" | "wiki" | "git";
export type ConnectorBackendKind = "oauth-mcp" | "cli" | "provider" | "setup-only";
export type ConnectorAdapterKind = "direct-http-oauth" | "gh-cli" | "glab-cli" | "pi-provider" | "atlassian-staged";
export type WorkspaceConnectorAuthStrategyKind = "browser-oauth" | "access-key" | "cli-session" | "setup-guidance";
export type ConnectorSetupMode = "full" | "selective" | "minimal";
export type ConnectorExposureState = "runtime-tool" | "runtime-gated" | "setup-only";
export type ConnectorAuthOwnership = "pi-oauth" | "env-fallback" | "external-cli" | "setup-only";

interface ConnectorBackendBase {
  readonly id: string;
  readonly label: string;
  readonly tenant?: ConnectorTenant;
  readonly capabilitySlot?: ConnectorCapabilitySlot;
  readonly backendKind: ConnectorBackendKind;
  readonly adapterKind: ConnectorAdapterKind;
  readonly description: string;
  readonly authGuidance: string;
  readonly statusGuidance: string;
  readonly fallbackMessage: string;
  readonly setupModes?: readonly ConnectorSetupMode[];
  readonly exposureState?: ConnectorExposureState;
  readonly authOwnership?: readonly ConnectorAuthOwnership[];
  readonly runtimeSafetyPolicyIds?: readonly string[];
  readonly exposes: {
    readonly commands?: readonly string[];
    readonly tools?: readonly string[];
    readonly providers?: readonly string[];
  };
}

export interface WorkspaceConnectorAuthStrategy {
  readonly kind: WorkspaceConnectorAuthStrategyKind;
  readonly envVars?: readonly string[];
  readonly description: string;
}

interface OAuthMcpConnectorBackend extends ConnectorBackendBase {
  readonly backendKind: "oauth-mcp";
  readonly adapterKind: "direct-http-oauth";
  readonly tenant: ConnectorTenant;
  readonly capabilitySlot: ConnectorCapabilitySlot;
  readonly setupModes: readonly ConnectorSetupMode[];
  readonly exposureState: "runtime-tool";
  readonly authOwnership: readonly ("pi-oauth" | "env-fallback")[];
  readonly authStrategies: readonly WorkspaceConnectorAuthStrategy[];
  readonly mcp: {
    readonly url: string;
    readonly transportStrategy: "streamable-http";
  };
  readonly oauth: {
    readonly callbackPort: number;
  };
}

interface CliConnectorBackend extends ConnectorBackendBase {
  readonly backendKind: "cli";
  readonly adapterKind: "gh-cli" | "glab-cli";
  readonly tenant: ConnectorTenant;
  readonly capabilitySlot: ConnectorCapabilitySlot;
  readonly setupModes: readonly ConnectorSetupMode[];
  readonly exposureState: "runtime-tool";
  readonly authOwnership: readonly ["external-cli"];
  readonly authStrategies: readonly WorkspaceConnectorAuthStrategy[];
  readonly cli: {
    readonly command: "gh" | "glab";
    readonly readOnlyToolName: "github_gh_cli" | "gitlab_glab_cli";
    readonly authStatusArgs: readonly string[];
    readonly hostEnvVar?: string;
    readonly defaultHost?: string;
  };
}

interface SetupOnlyConnectorBackend extends ConnectorBackendBase {
  readonly backendKind: "setup-only";
  readonly adapterKind: "atlassian-staged";
  readonly tenant: ConnectorTenant;
  readonly capabilitySlot: ConnectorCapabilitySlot;
  readonly setupModes: readonly ConnectorSetupMode[];
  readonly exposureState: "runtime-gated" | "setup-only";
  readonly authOwnership: readonly ["setup-only"];
  readonly authStrategies: readonly WorkspaceConnectorAuthStrategy[];
  readonly staged: {
    readonly vendor: "atlassian";
    readonly runtimeStatus: "runtime-gated";
  };
}

interface ProviderConnectorBackend extends ConnectorBackendBase {
  readonly backendKind: "provider";
  readonly adapterKind: "pi-provider";
  readonly provider: {
    readonly name: string;
    readonly toggleEnvVar: string;
    readonly requiredEnvVars: readonly string[];
  };
}

export type ConnectorBackendDefinition =
  | OAuthMcpConnectorBackend
  | CliConnectorBackend
  | SetupOnlyConnectorBackend
  | ProviderConnectorBackend;

const CONNECTOR_SETUP_MODES = ["full", "selective"] as const;

export const connectorBackendCatalog = [
  {
    id: "linear",
    label: "Linear",
    tenant: "personal",
    capabilitySlot: "issue-tracker",
    backendKind: "oauth-mcp",
    adapterKind: "direct-http-oauth",
    description: "Linear workspace access through the hosted OAuth MCP endpoint, with access-key fallback when configured.",
    authGuidance: "Run /connector-login linear for browser OAuth, or set LINEAR_API_KEY for access-key fallback.",
    statusGuidance: "Run /connector-tools linear to confirm authenticated MCP tools are available.",
    fallbackMessage: "If Linear MCP reports an authentication or transport error, rerun /connector-login linear or set LINEAR_API_KEY and retry.",
    setupModes: CONNECTOR_SETUP_MODES,
    exposureState: "runtime-tool",
    authOwnership: ["pi-oauth", "env-fallback"],
    runtimeSafetyPolicyIds: ["connector.linear", "tool.workspace_mcp_list_tools", "tool.workspace_mcp_call_tool"],
    exposes: {
      commands: ["connector-login", "connector-status", "connector-logout", "connector-tools"],
      tools: ["workspace_mcp_list_tools", "workspace_mcp_call_tool"],
    },
    authStrategies: [
      {
        kind: "browser-oauth",
        description: "Preferred: direct browser OAuth with local loopback callback and locally stored OAuth tokens.",
      },
      {
        kind: "access-key",
        envVars: ["LINEAR_API_KEY"],
        description: "Fallback: send the configured Linear API key as a bearer token to the MCP endpoint when OAuth tokens are unavailable.",
      },
    ],
    mcp: {
      url: "https://mcp.linear.app/mcp",
      transportStrategy: "streamable-http",
    },
    oauth: {
      callbackPort: 3334,
    },
  },
  {
    id: "notion",
    label: "Notion",
    tenant: "personal",
    capabilitySlot: "wiki",
    backendKind: "oauth-mcp",
    adapterKind: "direct-http-oauth",
    description: "Notion workspace access through the hosted OAuth MCP endpoint, with access-key fallback when configured.",
    authGuidance: "Run /connector-login notion for browser OAuth, or set NOTION_API_KEY/NOTION_TOKEN for access-key fallback.",
    statusGuidance: "Run /connector-tools notion to confirm authenticated MCP tools are available.",
    fallbackMessage: "If Notion MCP reports an authentication or transport error, rerun /connector-login notion or set NOTION_API_KEY/NOTION_TOKEN and retry.",
    setupModes: CONNECTOR_SETUP_MODES,
    exposureState: "runtime-tool",
    authOwnership: ["pi-oauth", "env-fallback"],
    runtimeSafetyPolicyIds: ["connector.notion", "tool.workspace_mcp_list_tools", "tool.workspace_mcp_call_tool"],
    exposes: {
      commands: ["connector-login", "connector-status", "connector-logout", "connector-tools"],
      tools: ["workspace_mcp_list_tools", "workspace_mcp_call_tool"],
    },
    authStrategies: [
      {
        kind: "browser-oauth",
        description: "Preferred: direct browser OAuth with local loopback callback and locally stored OAuth tokens.",
      },
      {
        kind: "access-key",
        envVars: ["NOTION_API_KEY", "NOTION_TOKEN"],
        description: "Fallback: send the configured Notion integration token as a bearer token to the MCP endpoint when OAuth tokens are unavailable.",
      },
    ],
    mcp: {
      url: "https://mcp.notion.com/mcp",
      transportStrategy: "streamable-http",
    },
    oauth: {
      callbackPort: 3335,
    },
  },
  {
    id: "github",
    label: "GitHub",
    tenant: "personal",
    capabilitySlot: "git",
    backendKind: "cli",
    adapterKind: "gh-cli",
    description: "GitHub access through the user's authenticated gh CLI session.",
    authGuidance: "Run gh auth login outside Pi if github_gh_cli reports that gh is missing or unauthenticated.",
    statusGuidance: "Run gh auth status --hostname github.com outside Pi to verify the local GitHub CLI session.",
    fallbackMessage: "If gh fails, check that the gh CLI is installed and authenticated for github.com.",
    setupModes: CONNECTOR_SETUP_MODES,
    exposureState: "runtime-tool",
    authOwnership: ["external-cli"],
    runtimeSafetyPolicyIds: ["connector.github-gh-cli", "tool.github_gh_cli"],
    exposes: {
      tools: ["github_gh_cli"],
    },
    authStrategies: [
      {
        kind: "cli-session",
        description: "Use the user's existing gh CLI session; oh-my-pi never stores GitHub CLI credentials.",
      },
    ],
    cli: {
      command: "gh",
      readOnlyToolName: "github_gh_cli",
      authStatusArgs: ["auth", "status", "--hostname", "github.com"],
      defaultHost: "github.com",
    },
  },
  {
    id: "gitlab",
    label: "GitLab",
    tenant: "company",
    capabilitySlot: "git",
    backendKind: "cli",
    adapterKind: "glab-cli",
    description: "GitLab access through the user's authenticated glab CLI session.",
    authGuidance: "Run glab auth login outside Pi if gitlab_glab_cli reports that glab is missing or unauthenticated.",
    statusGuidance: "Run glab auth status outside Pi, optionally with GITLAB_HOST or --hostname, to verify the local GitLab CLI session.",
    fallbackMessage: "If glab fails, check that the glab CLI is installed and authenticated for the target GitLab host.",
    setupModes: CONNECTOR_SETUP_MODES,
    exposureState: "runtime-tool",
    authOwnership: ["external-cli"],
    runtimeSafetyPolicyIds: ["connector.gitlab-glab-cli", "tool.gitlab_glab_cli"],
    exposes: {
      tools: ["gitlab_glab_cli"],
    },
    authStrategies: [
      {
        kind: "cli-session",
        description: "Use the user's existing glab CLI session; oh-my-pi never stores GitLab CLI credentials.",
      },
    ],
    cli: {
      command: "glab",
      readOnlyToolName: "gitlab_glab_cli",
      authStatusArgs: ["auth", "status"],
      hostEnvVar: "GITLAB_HOST",
    },
  },
  {
    id: "jira",
    label: "Jira",
    tenant: "company",
    capabilitySlot: "issue-tracker",
    backendKind: "setup-only",
    adapterKind: "atlassian-staged",
    description: "Company issue tracker capability for Atlassian Jira; setup-visible until a non-interactive runtime auth route is selected.",
    authGuidance: "Jira is setup-visible but runtime-gated. Choose and validate a non-interactive Atlassian auth route before enabling tools.",
    statusGuidance: "Jira readiness is currently runtime-gated; no Jira runtime tool is registered by oh-my-pi yet.",
    fallbackMessage: "Jira runtime access is not enabled yet. Use /connector-setup full or selective setup status for staged guidance.",
    setupModes: CONNECTOR_SETUP_MODES,
    exposureState: "runtime-gated",
    authOwnership: ["setup-only"],
    runtimeSafetyPolicyIds: ["connector.jira-staged"],
    exposes: {},
    authStrategies: [
      {
        kind: "setup-guidance",
        description: "Setup-visible only. Runtime tools stay gated until non-interactive Atlassian auth is designed.",
      },
    ],
    staged: {
      vendor: "atlassian",
      runtimeStatus: "runtime-gated",
    },
  },
  {
    id: "confluence",
    label: "Confluence",
    tenant: "company",
    capabilitySlot: "wiki",
    backendKind: "setup-only",
    adapterKind: "atlassian-staged",
    description: "Company wiki capability for Atlassian Confluence; setup-visible until a non-interactive runtime auth route is selected.",
    authGuidance: "Confluence is setup-visible but runtime-gated. Choose and validate a non-interactive Atlassian auth route before enabling tools.",
    statusGuidance: "Confluence readiness is currently runtime-gated; no Confluence runtime tool is registered by oh-my-pi yet.",
    fallbackMessage: "Confluence runtime access is not enabled yet. Use /connector-setup full or selective setup status for staged guidance.",
    setupModes: CONNECTOR_SETUP_MODES,
    exposureState: "runtime-gated",
    authOwnership: ["setup-only"],
    runtimeSafetyPolicyIds: ["connector.confluence-staged"],
    exposes: {},
    authStrategies: [
      {
        kind: "setup-guidance",
        description: "Setup-visible only. Runtime tools stay gated until non-interactive Atlassian auth is designed.",
      },
    ],
    staged: {
      vendor: "atlassian",
      runtimeStatus: "runtime-gated",
    },
  },
  {
    id: "quotio",
    label: "Quotio",
    backendKind: "provider",
    adapterKind: "pi-provider",
    description: "Provider-backed LiteLLM/OpenAI-compatible model integration; not an MCP connector.",
    authGuidance: "Set ENABLE_QUOTIO=true plus QUOTIO_BASE_URL and QUOTIO_API_KEY in the CWD .env file.",
    statusGuidance: "Run /quotio-status after enabling the Quotio provider extension.",
    fallbackMessage: "If Quotio fails, verify QUOTIO_BASE_URL, QUOTIO_API_KEY, and proxy connectivity.",
    exposes: {
      commands: ["quotio-status"],
      providers: ["quotio"],
    },
    provider: {
      name: "quotio",
      toggleEnvVar: "ENABLE_QUOTIO",
      requiredEnvVars: ["QUOTIO_BASE_URL", "QUOTIO_API_KEY"],
    },
  },
] as const satisfies readonly ConnectorBackendDefinition[];

export type ConnectorBackend = (typeof connectorBackendCatalog)[number];
export type ConnectorBackendId = ConnectorBackend["id"];
export type WorkspaceMcpConnectorBackend = Extract<ConnectorBackend, { readonly backendKind: "oauth-mcp" }>;
export type WorkspaceMcpServiceName = WorkspaceMcpConnectorBackend["id"];
export type CliConnectorBackendRoute = Extract<ConnectorBackend, { readonly backendKind: "cli" }>;
export type GitHubCliConnectorBackend = Extract<ConnectorBackend, { readonly id: "github" }>;
export type GitLabCliConnectorBackend = Extract<ConnectorBackend, { readonly id: "gitlab" }>;
export type SetupOnlyConnectorBackendRoute = Extract<ConnectorBackend, { readonly backendKind: "setup-only" }>;
export type ProviderConnectorBackendRoute = Extract<ConnectorBackend, { readonly backendKind: "provider" }>;
export type SetupConnectorBackend = WorkspaceMcpConnectorBackend | CliConnectorBackendRoute | SetupOnlyConnectorBackendRoute;
export type SetupConnectorBackendId = SetupConnectorBackend["id"];

export const WORKSPACE_MCP_SERVICE_IDS = connectorBackendCatalog.flatMap((backend) =>
  backend.backendKind === "oauth-mcp" ? [backend.id] : [],
) as readonly WorkspaceMcpServiceName[];

export const SETUP_CONNECTOR_IDS = connectorBackendCatalog.flatMap((backend) =>
  isSetupConnectorBackend(backend) ? [backend.id] : [],
) as readonly SetupConnectorBackendId[];

export function isSetupConnectorBackend(backend: ConnectorBackend): backend is SetupConnectorBackend {
  return backend.backendKind === "oauth-mcp" || backend.backendKind === "cli" || backend.backendKind === "setup-only";
}

export function getConnectorBackend(id: ConnectorBackendId): ConnectorBackend {
  for (const backend of connectorBackendCatalog) {
    if (backend.id === id) {
      return backend;
    }
  }
  throw new Error(`Unknown connector backend: ${id}`);
}

export function getSetupConnectorBackend(id: SetupConnectorBackendId): SetupConnectorBackend {
  const backend = getConnectorBackend(id);
  if (!isSetupConnectorBackend(backend)) {
    throw new Error(`${backend.label} is not a setup connector.`);
  }
  return backend;
}

export function isConnectorBackendId(value: string): value is ConnectorBackendId {
  return connectorBackendCatalog.some((backend) => backend.id === value);
}

export function isSetupConnectorBackendId(value: string): value is SetupConnectorBackendId {
  return SETUP_CONNECTOR_IDS.some((id) => id === value);
}

export function isWorkspaceMcpServiceName(value: string): value is WorkspaceMcpServiceName {
  for (const service of WORKSPACE_MCP_SERVICE_IDS) {
    if (service === value) {
      return true;
    }
  }
  return false;
}

export function parseWorkspaceMcpServiceArgument(args: string): WorkspaceMcpServiceName | null {
  const service = args.trim().split(/\s+/)[0]?.toLowerCase();
  return service && isWorkspaceMcpServiceName(service) ? service : null;
}

export function parseSetupConnectorArgument(args: string): SetupConnectorBackendId | null {
  const service = args.trim().split(/\s+/)[0]?.toLowerCase();
  return service && isSetupConnectorBackendId(service) ? service : null;
}

export function formatWorkspaceMcpServiceList(): string {
  return WORKSPACE_MCP_SERVICE_IDS.join("|");
}

export function formatSetupConnectorList(): string {
  return SETUP_CONNECTOR_IDS.join("|");
}

export function formatWorkspaceMcpUsage(commandName: string): string {
  return `${commandName} ${formatWorkspaceMcpServiceList()}`;
}

const SHELL_SAFE_TOKEN = /^[A-Za-z0-9_/:@%+=.,-]+$/;

function shellQuote(value: string): string {
  if (value === "") return "''";
  if (SHELL_SAFE_TOKEN.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function formatShellCommand(command: string, args: readonly string[]): string {
  return [command, ...args].map(shellQuote).join(" ");
}

export function routeWorkspaceMcpConnector(service: WorkspaceMcpServiceName) {
  const backend = getConnectorBackend(service);
  if (backend.backendKind !== "oauth-mcp") {
    throw new Error(`${backend.label} is not an OAuth MCP connector.`);
  }

  const accessKeyEnvVars = backend.authStrategies
    .flatMap((strategy) => strategy.kind === "access-key" ? strategy.envVars ?? [] : []);
  const legacyMcpRemoteLoginArgs = ["-y", "-p", "mcp-remote@latest", "mcp-remote-client", backend.mcp.url] as const;

  return {
    service: backend.id,
    label: backend.label,
    tenant: backend.tenant,
    capabilitySlot: backend.capabilitySlot,
    description: backend.description,
    authGuidance: backend.authGuidance,
    statusGuidance: backend.statusGuidance,
    fallbackMessage: backend.fallbackMessage,
    setupModes: backend.setupModes,
    exposureState: backend.exposureState,
    authOwnership: backend.authOwnership,
    runtimeSafetyPolicyIds: backend.runtimeSafetyPolicyIds ?? [],
    mcpUrl: backend.mcp.url,
    transportStrategy: backend.mcp.transportStrategy,
    authStrategies: backend.authStrategies,
    accessKeyEnvVars,
    oauth: backend.oauth,
    legacyMcpRemoteLoginShellCommand: formatShellCommand("npx", legacyMcpRemoteLoginArgs),
  };
}

export function routeCliConnector(id: CliConnectorBackendRoute["id"]) {
  const backend = getConnectorBackend(id);
  if (backend.backendKind !== "cli") {
    throw new Error(`${backend.label} is not a CLI connector.`);
  }

  return {
    service: backend.id,
    label: backend.label,
    tenant: backend.tenant,
    capabilitySlot: backend.capabilitySlot,
    description: backend.description,
    authGuidance: backend.authGuidance,
    statusGuidance: backend.statusGuidance,
    fallbackMessage: backend.fallbackMessage,
    setupModes: backend.setupModes,
    exposureState: backend.exposureState,
    authOwnership: backend.authOwnership,
    runtimeSafetyPolicyIds: backend.runtimeSafetyPolicyIds ?? [],
    command: backend.cli.command,
    readOnlyToolName: backend.cli.readOnlyToolName,
    authStatusArgs: backend.cli.authStatusArgs,
    hostEnvVar: "hostEnvVar" in backend.cli ? backend.cli.hostEnvVar : undefined,
    defaultHost: "defaultHost" in backend.cli ? backend.cli.defaultHost : undefined,
  };
}

export function routeGitHubCliConnector() {
  return routeCliConnector("github") as ReturnType<typeof routeCliConnector> & { service: "github"; command: "gh" };
}

export function routeGitLabCliConnector() {
  return routeCliConnector("gitlab") as ReturnType<typeof routeCliConnector> & { service: "gitlab"; command: "glab" };
}

export function routeSetupOnlyConnector(id: SetupOnlyConnectorBackendRoute["id"]) {
  const backend = getConnectorBackend(id);
  if (backend.backendKind !== "setup-only") {
    throw new Error(`${backend.label} is not a setup-only connector.`);
  }

  return {
    service: backend.id,
    label: backend.label,
    tenant: backend.tenant,
    capabilitySlot: backend.capabilitySlot,
    description: backend.description,
    authGuidance: backend.authGuidance,
    statusGuidance: backend.statusGuidance,
    fallbackMessage: backend.fallbackMessage,
    setupModes: backend.setupModes,
    exposureState: backend.exposureState,
    authOwnership: backend.authOwnership,
    runtimeSafetyPolicyIds: backend.runtimeSafetyPolicyIds ?? [],
    runtimeStatus: backend.staged.runtimeStatus,
    vendor: backend.staged.vendor,
  };
}

export function routeProviderConnector(id: ProviderConnectorBackendRoute["id"]) {
  const backend = getConnectorBackend(id);
  if (backend.backendKind !== "provider") {
    throw new Error(`${backend.label} is not a provider-backed connector.`);
  }

  return {
    service: backend.id,
    label: backend.label,
    description: backend.description,
    authGuidance: backend.authGuidance,
    statusGuidance: backend.statusGuidance,
    fallbackMessage: backend.fallbackMessage,
    providerName: backend.provider.name,
    toggleEnvVar: backend.provider.toggleEnvVar,
    requiredEnvVars: backend.provider.requiredEnvVars,
  };
}
