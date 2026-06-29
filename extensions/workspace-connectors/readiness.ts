import {
  getSetupConnectorBackend,
  routeWorkspaceMcpConnector,
  type ConnectorBackend,
  type SetupConnectorBackend,
  type SetupConnectorBackendId,
  type WorkspaceMcpServiceName,
} from "../connector-backend-catalog.js";
import { getConnectorAuthStatus, type ConnectorAuthStatus } from "./auth.js";
import { checkCliAuthStatus, type CliAuthStatus } from "./cli-bridge.js";
import {
  formatSetupStateSummary,
  readConnectorSetupState,
  resolveConnectorSetupSelection,
  type ConnectorSetupState,
} from "./setup-state.js";

export type ConnectorReadinessKind =
  | "not-configured"
  | "ready"
  | "unavailable-by-auth"
  | "hidden-by-mode"
  | "runtime-gated"
  | "setup-only";

export interface AuthPassport {
  readonly service: SetupConnectorBackendId;
  readonly provenance: string;
  readonly ready: boolean;
  readonly ownedState: readonly string[];
  readonly untouchedState: readonly string[];
  readonly guidance: string;
}

export interface ConnectorReadinessEntry {
  readonly service: SetupConnectorBackendId;
  readonly label: string;
  readonly tenant: SetupConnectorBackend["tenant"];
  readonly capabilitySlot: SetupConnectorBackend["capabilitySlot"];
  readonly backendKind: ConnectorBackend["backendKind"];
  readonly readiness: ConnectorReadinessKind;
  readonly selected: boolean;
  readonly authPassport: AuthPassport;
  readonly exposedTools: readonly string[];
  readonly nextAction: string;
}

export interface ConnectorReadinessReport {
  readonly setupState?: ConnectorSetupState;
  readonly entries: readonly ConnectorReadinessEntry[];
}

function oauthPassport(status: ConnectorAuthStatus): AuthPassport {
  const route = routeWorkspaceMcpConnector(status.service);
  let provenance = "no usable OAuth token or access-key fallback";
  if (status.preferredMode === "oauth") {
    provenance = `Pi-managed OAuth state (${status.authPath})`;
  } else if (status.preferredMode === "access-key") {
    provenance = `CWD env fallback present (${status.accessKeyEnvVar})`;
  }
  const ownedState = status.oauthConfigured
    ? [`Pi-managed OAuth state for ${route.label} at ${status.authPath}`]
    : [];
  const untouchedState = [
    `CWD env access keys (${route.accessKeyEnvVars.join("/")})`,
    "browser accounts",
  ];
  return {
    service: status.service,
    provenance,
    ready: status.preferredMode !== undefined,
    ownedState,
    untouchedState,
    guidance: route.authGuidance,
  };
}

function cliPassport(backend: Extract<SetupConnectorBackend, { readonly backendKind: "cli" }>, status: CliAuthStatus): AuthPassport {
  return {
    service: backend.id as SetupConnectorBackendId,
    provenance: status.ready
      ? `${backend.cli.command} CLI authenticated${status.executablePath ? ` (${status.executablePath})` : ""}`
      : `${backend.cli.command} CLI not ready: ${status.summary}`,
    ready: status.ready,
    ownedState: [],
    untouchedState: [`${backend.cli.command} CLI auth/session`, "browser accounts"],
    guidance: backend.authGuidance,
  };
}

function setupOnlyPassport(backend: Extract<SetupConnectorBackend, { readonly backendKind: "setup-only" }>): AuthPassport {
  return {
    service: backend.id as SetupConnectorBackendId,
    provenance: "setup-visible/runtime-gated; no runtime auth route is configured",
    ready: false,
    ownedState: [],
    untouchedState: ["Atlassian browser accounts", "Atlassian API tokens", "CWD env values"],
    guidance: backend.authGuidance,
  };
}

function hiddenPassport(backend: SetupConnectorBackend): AuthPassport {
  return {
    service: backend.id as SetupConnectorBackendId,
    provenance: "hidden by connector setup mode; auth was not probed",
    ready: false,
    ownedState: [],
    untouchedState: ["OAuth state", "CWD env values", "CLI auth/session", "browser accounts"],
    guidance: "Run /connector-setup full or selective with a matching selector to include this connector.",
  };
}

function notConfiguredPassport(backend: SetupConnectorBackend): AuthPassport {
  return {
    service: backend.id as SetupConnectorBackendId,
    provenance: "setup mode not configured; auth was not probed",
    ready: false,
    ownedState: [],
    untouchedState: ["OAuth state", "CWD env values", "CLI auth/session", "browser accounts"],
    guidance: backend.authGuidance,
  };
}

async function getPassport(backend: SetupConnectorBackend): Promise<AuthPassport> {
  if (backend.backendKind === "oauth-mcp") {
    return oauthPassport(await getConnectorAuthStatus(backend.id as WorkspaceMcpServiceName));
  }
  if (backend.backendKind === "cli") {
    return cliPassport(backend, await checkCliAuthStatus(backend.id));
  }
  return setupOnlyPassport(backend);
}

function readinessFor(backend: SetupConnectorBackend, selected: boolean, passport: AuthPassport, setupState: ConnectorSetupState | undefined): ConnectorReadinessKind {
  if (!setupState) {
    return passport.ready ? "ready" : "not-configured";
  }
  if (!selected) return "hidden-by-mode";
  if (backend.backendKind === "setup-only") {
    return backend.exposureState === "runtime-gated" ? "runtime-gated" : "setup-only";
  }
  return passport.ready ? "ready" : "unavailable-by-auth";
}

function nextActionFor(backend: SetupConnectorBackend, readiness: ConnectorReadinessKind, passport: AuthPassport): string {
  switch (readiness) {
    case "ready":
      return backend.statusGuidance;
    case "hidden-by-mode":
      return "Hidden by the selected connector setup mode. Run /connector-setup full or selective with a matching selector to include it.";
    case "runtime-gated":
    case "setup-only":
      return backend.statusGuidance;
    case "not-configured":
      return `Run /connector-setup full, selective, or minimal to record desired connector setup. ${passport.guidance}`;
    case "unavailable-by-auth":
      return passport.guidance;
    default:
      return passport.guidance;
  }
}

async function evaluateConnectorEntry(id: SetupConnectorBackendId, setupState: ConnectorSetupState | undefined): Promise<ConnectorReadinessEntry> {
  const resolution = resolveConnectorSetupSelection(setupState);
  const backend = getSetupConnectorBackend(id);
  const selected = setupState ? resolution.reasonById[id] === "selected" : false;
  const passport = !setupState ? notConfiguredPassport(backend) : selected ? await getPassport(backend) : hiddenPassport(backend);
  const readiness = readinessFor(backend, selected, passport, setupState);
  return {
    service: id,
    label: backend.label,
    tenant: backend.tenant,
    capabilitySlot: backend.capabilitySlot,
    backendKind: backend.backendKind,
    readiness,
    selected,
    authPassport: passport,
    exposedTools: "tools" in backend.exposes ? backend.exposes.tools ?? [] : [],
    nextAction: nextActionFor(backend, readiness, passport),
  };
}

export async function evaluateConnectorReadiness(setupStateInput?: ConnectorSetupState | undefined): Promise<ConnectorReadinessReport> {
  const setupState = setupStateInput ?? await readConnectorSetupState();
  const resolution = resolveConnectorSetupSelection(setupState);
  const entries = await Promise.all(
    [...resolution.selectedIds, ...resolution.hiddenIds].map((id) => evaluateConnectorEntry(id, setupState)),
  );
  return { setupState, entries };
}

function iconFor(readiness: ConnectorReadinessKind): string {
  switch (readiness) {
    case "ready":
      return "✅";
    case "hidden-by-mode":
      return "🙈";
    case "runtime-gated":
    case "setup-only":
      return "🚧";
    case "unavailable-by-auth":
      return "⚠️";
    case "not-configured":
      return "ℹ️";
    default:
      return "ℹ️";
  }
}

export function formatConnectorReadinessReport(report: ConnectorReadinessReport): string {
  return [
    "Connector setup readiness",
    "",
    formatSetupStateSummary(report.setupState),
    "",
    ...report.entries.map((entry) => {
      const tools = entry.exposedTools.length > 0 ? ` tools=${entry.exposedTools.join(",")}` : " tools=none";
      return `${iconFor(entry.readiness)} ${entry.label} (${entry.tenant}/${entry.capabilitySlot}): ${entry.readiness}; auth=${entry.authPassport.provenance};${tools}; next=${entry.nextAction}`;
    }),
  ].join("\n");
}

export async function getConnectorRuntimeReadiness(service: SetupConnectorBackendId, setupStateInput?: ConnectorSetupState | undefined): Promise<ConnectorReadinessEntry> {
  const setupState = setupStateInput ?? await readConnectorSetupState();
  return evaluateConnectorEntry(service, setupState);
}

export async function assertConnectorRuntimeReady(service: SetupConnectorBackendId): Promise<ConnectorReadinessEntry> {
  const entry = await getConnectorRuntimeReadiness(service);
  if (entry.readiness === "ready") return entry;
  throw new Error(`${entry.label} connector is ${entry.readiness}. ${entry.nextAction}`);
}
