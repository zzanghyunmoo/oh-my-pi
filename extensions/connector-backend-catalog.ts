export type ConnectorBackendKind = "oauth-mcp" | "cli" | "provider";
export type ConnectorAdapterKind = "mcp-remote-oauth" | "gh-cli" | "pi-provider";

interface ConnectorBackendBase {
  readonly id: string;
  readonly label: string;
  readonly backendKind: ConnectorBackendKind;
  readonly adapterKind: ConnectorAdapterKind;
  readonly description: string;
  readonly authGuidance: string;
  readonly statusGuidance: string;
  readonly fallbackMessage: string;
  readonly exposes: {
    readonly commands?: readonly string[];
    readonly tools?: readonly string[];
    readonly providers?: readonly string[];
  };
}

interface OAuthMcpConnectorBackend extends ConnectorBackendBase {
  readonly backendKind: "oauth-mcp";
  readonly adapterKind: "mcp-remote-oauth";
  readonly mcp: {
    readonly url: string;
    readonly remotePackage: string;
    readonly clientCommand: string;
    readonly transportStrategy: "http-first";
  };
}

interface CliConnectorBackend extends ConnectorBackendBase {
  readonly backendKind: "cli";
  readonly adapterKind: "gh-cli";
  readonly cli: {
    readonly command: "gh";
    readonly readOnlyToolName: "github_gh_cli";
    readonly mutatingSubcommands: readonly string[];
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
  | ProviderConnectorBackend;

export const connectorBackendCatalog = [
  {
    id: "linear",
    label: "Linear",
    backendKind: "oauth-mcp",
    adapterKind: "mcp-remote-oauth",
    description: "Linear workspace access through the hosted OAuth MCP endpoint.",
    authGuidance: "Run /connector-login linear, then follow the browser/terminal OAuth prompts.",
    statusGuidance: "Run /connector-tools linear to confirm authenticated MCP tools are available.",
    fallbackMessage: "If Linear MCP reports an authentication or transport error, rerun /connector-login linear and retry.",
    exposes: {
      commands: ["connector-login", "connector-tools"],
      tools: ["workspace_mcp_list_tools", "workspace_mcp_call_tool"],
    },
    mcp: {
      url: "https://mcp.linear.app/mcp",
      remotePackage: "mcp-remote@latest",
      clientCommand: "mcp-remote-client",
      transportStrategy: "http-first",
    },
  },
  {
    id: "notion",
    label: "Notion",
    backendKind: "oauth-mcp",
    adapterKind: "mcp-remote-oauth",
    description: "Notion workspace access through the hosted OAuth MCP endpoint.",
    authGuidance: "Run /connector-login notion, then follow the browser/terminal OAuth prompts.",
    statusGuidance: "Run /connector-tools notion to confirm authenticated MCP tools are available.",
    fallbackMessage: "If Notion MCP reports an authentication or transport error, rerun /connector-login notion and retry.",
    exposes: {
      commands: ["connector-login", "connector-tools"],
      tools: ["workspace_mcp_list_tools", "workspace_mcp_call_tool"],
    },
    mcp: {
      url: "https://mcp.notion.com/mcp",
      remotePackage: "mcp-remote@latest",
      clientCommand: "mcp-remote-client",
      transportStrategy: "http-first",
    },
  },
  {
    id: "github",
    label: "GitHub",
    backendKind: "cli",
    adapterKind: "gh-cli",
    description: "GitHub access through the user's authenticated gh CLI session.",
    authGuidance: "Run gh auth login if github_gh_cli reports that gh is missing or unauthenticated.",
    statusGuidance: "Run gh auth status --hostname github.com to verify the local GitHub CLI session.",
    fallbackMessage: "If gh fails, check that the gh CLI is installed and authenticated for github.com.",
    exposes: {
      tools: ["github_gh_cli"],
    },
    cli: {
      command: "gh",
      readOnlyToolName: "github_gh_cli",
      mutatingSubcommands: ["create", "edit", "delete", "close", "reopen", "merge", "ready", "lock", "unlock"],
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
export type GitHubCliConnectorBackend = Extract<ConnectorBackend, { readonly id: "github" }>;
export type ProviderConnectorBackendRoute = Extract<ConnectorBackend, { readonly backendKind: "provider" }>;

export const WORKSPACE_MCP_SERVICE_IDS = connectorBackendCatalog
  .filter((backend): backend is WorkspaceMcpConnectorBackend => backend.backendKind === "oauth-mcp")
  .map((backend) => backend.id) as readonly WorkspaceMcpServiceName[];

export function getConnectorBackend(id: ConnectorBackendId): ConnectorBackend {
  for (const backend of connectorBackendCatalog) {
    if (backend.id === id) {
      return backend;
    }
  }
  throw new Error(`Unknown connector backend: ${id}`);
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

export function formatWorkspaceMcpServiceList(): string {
  return WORKSPACE_MCP_SERVICE_IDS.join("|");
}

export function formatWorkspaceMcpUsage(commandName: string): string {
  return `${commandName} ${formatWorkspaceMcpServiceList()}`;
}

export function routeWorkspaceMcpConnector(service: WorkspaceMcpServiceName) {
  const backend = getConnectorBackend(service);
  if (backend.backendKind !== "oauth-mcp") {
    throw new Error(`${backend.label} is not an OAuth MCP connector.`);
  }

  return {
    service: backend.id,
    label: backend.label,
    description: backend.description,
    authGuidance: backend.authGuidance,
    statusGuidance: backend.statusGuidance,
    fallbackMessage: backend.fallbackMessage,
    mcpUrl: backend.mcp.url,
    mcpRemoteArgs: ["-y", backend.mcp.remotePackage, backend.mcp.url, "--transport", backend.mcp.transportStrategy] as const,
    loginArgs: ["-y", "-p", backend.mcp.remotePackage, backend.mcp.clientCommand, backend.mcp.url] as const,
  };
}

export function routeGitHubCliConnector() {
  const backend = getConnectorBackend("github") as GitHubCliConnectorBackend;
  return {
    service: backend.id,
    label: backend.label,
    description: backend.description,
    authGuidance: backend.authGuidance,
    statusGuidance: backend.statusGuidance,
    fallbackMessage: backend.fallbackMessage,
    command: backend.cli.command,
    mutatingSubcommands: backend.cli.mutatingSubcommands,
    mutationGuardMessage: "Refusing potentially mutating gh command from tool. Ask the user for explicit confirmation and run manually if needed.",
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
