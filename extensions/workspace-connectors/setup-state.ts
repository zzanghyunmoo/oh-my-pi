import { lstatSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import {
  SETUP_CONNECTOR_IDS,
  connectorBackendCatalog,
  isSetupConnectorBackend,
  isSetupConnectorBackendId,
  type ConnectorCapabilitySlot,
  type ConnectorSetupMode,
  type ConnectorTenant,
  type SetupConnectorBackend,
  type SetupConnectorBackendId,
} from "../connector-backend-catalog.js";

export type ConnectorSetupModeValue = ConnectorSetupMode;
export type ConnectorSetupSelectorKind = "tenant" | "capability" | "service";

export interface ConnectorSetupState {
  readonly version: 1;
  readonly mode: ConnectorSetupModeValue;
  readonly tenants?: readonly ConnectorTenant[];
  readonly capabilities?: readonly ConnectorCapabilitySlot[];
  readonly services?: readonly SetupConnectorBackendId[];
  readonly updatedAt: string;
}

export interface ParsedConnectorSetupCommand {
  readonly state: ConnectorSetupState;
  readonly summary: string;
}

export interface ConnectorSetupParseFailure {
  readonly error: string;
  readonly usage: string;
}

export interface ConnectorSetupResolution {
  readonly selectedIds: readonly SetupConnectorBackendId[];
  readonly hiddenIds: readonly SetupConnectorBackendId[];
  readonly reasonById: Readonly<Record<SetupConnectorBackendId, "selected" | "hidden-by-mode" | "hidden-by-filter">>;
}

const SETUP_STATE_VERSION = 1;
const DEFAULT_SETUP_PATH = join(homedir(), ".pi", "agent", "workspace-connectors-setup.json");
const SETUP_PATH_ENV = "OH_MY_PI_CONNECTOR_SETUP_PATH";
const ALLOW_REPO_SETUP_PATH_ENV = "OH_MY_PI_ALLOW_REPO_SETUP_PATH_FOR_TESTS";
let setupFileQueue: Promise<void> = Promise.resolve();

const TENANTS = new Set<ConnectorTenant>(["personal", "company"]);
const CAPABILITIES = new Set<ConnectorCapabilitySlot>(["issue-tracker", "wiki", "git"]);

function uniqueSorted<T extends string>(values: readonly T[]): readonly T[] {
  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b)) as readonly T[];
}

function isInside(parent: string, child: string): boolean {
  const normalizedParent = resolve(parent);
  const normalizedChild = resolve(child);
  return normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}${sep}`);
}

function validateSetupPath(path: string): void {
  if (!isAbsolute(path)) {
    throw new Error(`${SETUP_PATH_ENV} must resolve to an absolute path.`);
  }

  try {
    if (lstatSync(path).isSymbolicLink()) {
      throw new Error(`Refusing to use symlinked connector setup state path: ${path}`);
    }
  } catch (error: unknown) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code !== "ENOENT") throw error;
  }

  if (process.env[ALLOW_REPO_SETUP_PATH_ENV] !== "true" && isInside(process.cwd(), path)) {
    throw new Error(`Refusing to store connector setup state inside the current repository: ${path}`);
  }
}

export function getConnectorSetupPath(): string {
  const path = process.env[SETUP_PATH_ENV]?.trim() || DEFAULT_SETUP_PATH;
  const resolved = resolve(path);
  validateSetupPath(resolved);
  return resolved;
}

function validateSetupState(value: unknown, path: string): ConnectorSetupState {
  if (!value || typeof value !== "object") {
    throw new Error(`Invalid connector setup state schema at ${path}.`);
  }
  const data = value as Partial<ConnectorSetupState>;
  if (data.version !== SETUP_STATE_VERSION) {
    throw new Error(`Invalid connector setup state version at ${path}.`);
  }
  if (data.mode !== "full" && data.mode !== "selective" && data.mode !== "minimal") {
    throw new Error(`Invalid connector setup mode at ${path}.`);
  }
  if (typeof data.updatedAt !== "string") {
    throw new Error(`Invalid connector setup updatedAt at ${path}.`);
  }
  for (const key of ["tenants", "capabilities", "services"] as const) {
    const values = data[key];
    if (values !== undefined && !Array.isArray(values)) {
      throw new Error(`Invalid connector setup ${key} at ${path}.`);
    }
  }
  if ((data.tenants ?? []).some((tenant) => !TENANTS.has(tenant))) {
    throw new Error(`Invalid connector setup tenant at ${path}.`);
  }
  if ((data.capabilities ?? []).some((capability) => !CAPABILITIES.has(capability))) {
    throw new Error(`Invalid connector setup capability at ${path}.`);
  }
  if ((data.services ?? []).some((service) => !isSetupConnectorBackendId(service))) {
    throw new Error(`Invalid connector setup service at ${path}.`);
  }
  return data as ConnectorSetupState;
}

export async function readConnectorSetupState(): Promise<ConnectorSetupState | undefined> {
  const path = getConnectorSetupPath();
  try {
    const raw = await readFile(path, "utf-8");
    return validateSetupState(JSON.parse(raw), path);
  } catch (error: unknown) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code === "ENOENT") return undefined;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Connector setup state is malformed at ${path}: ${message}. Re-run /connector-setup full, selective, or minimal, or remove the file to reset setup state.`);
  }
}

async function withSetupFileQueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = setupFileQueue.then(fn, fn);
  setupFileQueue = run.then(() => undefined, () => undefined);
  return run;
}

export async function writeConnectorSetupState(state: ConnectorSetupState): Promise<void> {
  const path = getConnectorSetupPath();
  validateSetupState(state, path);
  await withSetupFileQueue(async () => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    try {
      if (lstatSync(path).isSymbolicLink()) {
        throw new Error(`Refusing to overwrite symlinked connector setup state path: ${path}`);
      }
    } catch (error: unknown) {
      const errno = error as NodeJS.ErrnoException;
      if (errno.code !== "ENOENT") throw error;
    }
    const tempPath = `${path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(tempPath, path);
  });
}

function usage(): string {
  return [
    "Usage:",
    "  /connector-setup full",
    "  /connector-setup minimal",
    "  /connector-setup selective tenant:company capability:git",
    "  /connector-setup selective service:linear service:notion",
    `Services: ${SETUP_CONNECTOR_IDS.join("|")}`,
    "Selectors: tenant:personal|company capability:issue-tracker|wiki|git service:<connector>",
  ].join("\n");
}

function parseList(value: string): string[] {
  return value.split(",").map((part) => part.trim().toLowerCase()).filter(Boolean);
}

function makeState(mode: ConnectorSetupModeValue, values: {
  tenants?: readonly ConnectorTenant[];
  capabilities?: readonly ConnectorCapabilitySlot[];
  services?: readonly SetupConnectorBackendId[];
} = {}): ConnectorSetupState {
  return {
    version: SETUP_STATE_VERSION,
    mode,
    tenants: values.tenants && values.tenants.length > 0 ? uniqueSorted(values.tenants) : undefined,
    capabilities: values.capabilities && values.capabilities.length > 0 ? uniqueSorted(values.capabilities) : undefined,
    services: values.services && values.services.length > 0 ? uniqueSorted(values.services) : undefined,
    updatedAt: new Date().toISOString(),
  };
}

function failure(error: string): ConnectorSetupParseFailure {
  return { error, usage: usage() };
}

export function parseConnectorSetupCommand(args: string): ParsedConnectorSetupCommand | ConnectorSetupParseFailure {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const mode = tokens.shift()?.toLowerCase();
  if (mode === "full") {
    if (tokens.length > 0) return failure("Full setup does not accept selectors.");
    return { state: makeState("full"), summary: "Full connector setup selected." };
  }
  if (mode === "minimal") {
    if (tokens.length > 0) return failure("Minimal setup does not accept selectors.");
    return { state: makeState("minimal"), summary: "Minimal connector setup selected; issue-tracker, wiki, and git capabilities are intentionally excluded." };
  }
  if (mode !== "selective") {
    return failure("Choose full, selective, or minimal setup.");
  }
  if (tokens.length === 0) {
    return failure("Selective setup requires at least one tenant, capability, or service selector.");
  }

  const tenants: ConnectorTenant[] = [];
  const capabilities: ConnectorCapabilitySlot[] = [];
  const services: SetupConnectorBackendId[] = [];
  const seenRaw = new Set<string>();
  for (const token of tokens) {
    const normalized = token.toLowerCase();
    if (seenRaw.has(normalized)) continue;
    seenRaw.add(normalized);
    const [kind, rawValue, ...rest] = normalized.split(":");
    if (!kind || !rawValue || rest.length > 0) {
      return failure(`Invalid selector: ${token}`);
    }
    for (const value of parseList(rawValue)) {
      if (kind === "tenant") {
        if (!TENANTS.has(value as ConnectorTenant)) return failure(`Unknown tenant selector: ${value}`);
        tenants.push(value as ConnectorTenant);
      } else if (kind === "capability") {
        if (!CAPABILITIES.has(value as ConnectorCapabilitySlot)) return failure(`Unknown capability selector: ${value}`);
        capabilities.push(value as ConnectorCapabilitySlot);
      } else if (kind === "service") {
        if (!isSetupConnectorBackendId(value)) return failure(`Unknown connector service selector: ${value}`);
        services.push(value);
      } else {
        return failure(`Unknown selector kind: ${kind}`);
      }
    }
  }

  if (services.length > 0 && (tenants.length > 0 || capabilities.length > 0)) {
    return failure("Service selectors cannot be mixed with tenant or capability selectors; use one style per selective setup command.");
  }

  const state = makeState("selective", { tenants, capabilities, services });
  const resolution = resolveConnectorSetupSelection(state);
  if (resolution.selectedIds.length === 0) {
    return failure("Selective setup matched no connectors; adjust tenant, capability, or service selectors.");
  }

  return {
    state,
    summary: `Selective connector setup selected: ${resolution.selectedIds.join(", ")}.`,
  };
}

export function getSetupConnectorBackends(): readonly SetupConnectorBackend[] {
  return connectorBackendCatalog.filter((backend): backend is SetupConnectorBackend => isSetupConnectorBackend(backend));
}

export function connectorMatchesSetupState(backend: SetupConnectorBackend, state: ConnectorSetupState | undefined): boolean {
  if (!state) return true;
  if (state.mode === "minimal") return false;
  if (state.mode === "full") return backend.setupModes.includes("full");
  if (state.services && state.services.length > 0) return state.services.includes(backend.id as SetupConnectorBackendId);
  if (state.tenants && state.tenants.length > 0 && !state.tenants.includes(backend.tenant)) return false;
  if (state.capabilities && state.capabilities.length > 0 && !state.capabilities.includes(backend.capabilitySlot)) return false;
  return backend.setupModes.includes("selective");
}

export function resolveConnectorSetupSelection(state: ConnectorSetupState | undefined): ConnectorSetupResolution {
  const backends = getSetupConnectorBackends();
  const selectedIds: SetupConnectorBackendId[] = [];
  const hiddenIds: SetupConnectorBackendId[] = [];
  const reasonById: Partial<Record<SetupConnectorBackendId, "selected" | "hidden-by-mode" | "hidden-by-filter">> = {};

  for (const backend of backends) {
    const id = backend.id as SetupConnectorBackendId;
    const selected = connectorMatchesSetupState(backend, state);
    if (selected) {
      selectedIds.push(id);
      reasonById[id] = "selected";
    } else {
      hiddenIds.push(id);
      reasonById[id] = state?.mode === "minimal" ? "hidden-by-mode" : "hidden-by-filter";
    }
  }

  return { selectedIds, hiddenIds, reasonById: reasonById as Readonly<Record<SetupConnectorBackendId, "selected" | "hidden-by-mode" | "hidden-by-filter">> };
}

export function formatSetupStateSummary(state: ConnectorSetupState | undefined): string {
  if (!state) return "No connector setup mode has been selected yet. Run /connector-setup full, selective, or minimal.";
  if (state.mode === "full") return `Connector setup mode: full (updated ${state.updatedAt})`;
  if (state.mode === "minimal") return `Connector setup mode: minimal — issue-tracker, wiki, and git are intentionally excluded (updated ${state.updatedAt})`;
  const selectors = [
    ...(state.tenants ?? []).map((tenant) => `tenant:${tenant}`),
    ...(state.capabilities ?? []).map((capability) => `capability:${capability}`),
    ...(state.services ?? []).map((service) => `service:${service}`),
  ];
  return `Connector setup mode: selective ${selectors.join(" ")} (updated ${state.updatedAt})`;
}
