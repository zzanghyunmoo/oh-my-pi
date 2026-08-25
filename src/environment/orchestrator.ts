import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  resolve,
} from "node:path";

import {
  loadCatalogBundle,
  validateContractDocument,
} from "../catalog/load.js";
import type {
  CatalogBundle,
  CodexMarketplaceAddon,
  DefaultRuntimeAddon,
  EnvironmentProfile,
  OpenCodePackageAddon,
  OperatingSystem,
  PackageInstaller,
  PlatformId,
} from "../catalog/types.js";
import {
  isAgentId,
  isCapabilityId,
  isPackageId,
  WORKFLOW_CAPABILITY_IDS,
  type AgentId,
  type CapabilityId,
  type PackageId,
} from "../domain/catalog.js";
import { resolveDesiredState } from "../domain/desired-state.js";
import type { RuntimeAddonPin } from "../domain/desired-state.js";
import {
  isCapabilitySet,
  isEnvironmentInstanceId,
  type CapabilitySet,
  type EnvironmentInstance,
  type EnvironmentInstanceId,
  type ToolRoute,
} from "../domain/environment-instance.js";
import { installSelectedAgents } from "../install/agents.js";
import {
  assessLspReadiness,
  loadCapabilityProvenance,
  type OfficialCapabilityLock,
} from "../install/capabilities.js";
import { loadRuntimeAdapters } from "../install/descriptors.js";
import {
  hashManagedDirectory,
  inspectManagedRuntimePayload,
  materializeManagedRuntimePayload,
  observeManagedPath,
  type ManagedRuntimePayload,
} from "../install/managed-payload.js";
import { createNodeAgentAcquisitionOperations } from "../install/node-acquisition.js";
import {
  inspectOfficialClaudeMarketplace,
  type OfficialMarketplaceInspection,
  type VerifiedOfficialPlugin,
} from "../install/official-marketplace.js";
import {
  createOfficialMarketplaceGitOperations,
  inspectOfficialMarketplaceRuntimeAdapter,
  inspectOfficialMarketplaceSnapshot,
  materializeOfficialMarketplaceRuntimeAdapter,
  materializeOfficialMarketplaceSnapshot,
  materializeOfficialMarketplaceSnapshotFromDirectory,
  officialMarketplaceRuntimeAdapter,
  officialMarketplaceSnapshot as createOfficialMarketplaceSnapshot,
  plannedOfficialMarketplaceRuntimeAdapter,
  type OfficialMarketplaceRuntimeAdapter,
  type OfficialMarketplaceSnapshot,
} from "../install/official-marketplace-acquisition.js";
import {
  codexAddonSnapshot,
  createRuntimeAddonGitOperations,
  inspectCodexAddonSnapshot,
  inspectOpenCodeAddonSnapshot,
  inspectRuntimeAddonArchive,
  materializeCodexAddonSnapshotFromArchive,
  materializeOpenCodeAddonSnapshotFromArchive,
  openCodeAddonSnapshot,
  verifyCodexAddonGitMarketplace,
  type CodexAddonSnapshot,
  type OpenCodeAddonSnapshot,
  type RuntimeAddonGitOperations,
} from "../install/runtime-addon-acquisition.js";
import {
  planPackageInstallations,
  type PackageInstallPlanEntry,
} from "../install/packages.js";
import type {
  ApplyRecoveryRecord,
  ManagedStateReceipt,
} from "../ports/state.js";
import { HARNESS_VERSION } from "../package-version.js";
import {
  applyExactPlan,
  recoverPendingApply,
  StalePreviewError,
  type ApplyDependencies,
  type ApplyResult,
} from "../planning/apply.js";
import type {
  ApplyPlan,
  ObservedPreimage,
  PlanAction,
  PlanPreflight,
} from "../planning/actions.js";
import { createApplyPlan } from "../planning/preview.js";
import type {
  RuntimeAdapterDescriptor,
} from "../runtime/adapter.js";
import { FileStateStore } from "../state/receipt.js";
import {
  resolveTrustedInvocation,
  type TrustedInvocation,
} from "../tools/invoke.js";
import {
  atomicWriteFile,
  assertSafeManagedRootPath,
  findTrustedExecutable,
  isPathStrictlyWithin,
  observeRegularFile,
  readBoundedRegularFile,
  resolveStateRoot,
  sha256Bytes,
  sha256File,
  stableJson,
} from "./filesystem.js";
import {
  claudeOfficialMarketplaceReady,
  claudeManagedPluginVersion,
  claudeRegistrationReady,
  codexMarketplaceAddonReady,
  codexRegistrationReady,
  inspectCodexMarketplaceAddon,
  inspectClaudeOfficialMarketplaceRegistration,
  inspectClaudeOfficialPluginRegistration,
  inspectClaudeManagedRuntimeRegistration,
  inspectCodexManagedRuntimeRegistration,
  inspectOpenCodeManagedRuntimeRegistration,
  managedRuntimeRegistrationDisposition,
  inspectOpenCodeSkillRegistration,
  inspectOpenCodePackageAddon,
  openCodeSkillsReady,
  openCodeConfigPath,
  openCodePackageAddonResolved,
  openCodeRegistrationReady,
  planOpenCodeSkillRegistrations,
  registerClaudeOfficialMarketplace,
  registerClaudeOfficialPlugin,
  registerClaudeRuntime,
  registerCodexRuntime,
  registerCodexMarketplaceAddon,
  registerOpenCodePackageAddon,
  registerOpenCodeSkills,
  registerOpenCodeRuntime,
  type ManagedRuntimeRegistrationDisposition,
  type ClaudeManagedNativeRegistration,
  type OpenCodeManagedRuntimeRegistrationState,
  type OpenCodeSkillRegistration,
  type CodexMarketplaceAddonRegistration,
} from "./native-registration.js";
import {
  inspectAgent,
  inspectCompositionAgent,
  managedRuntimePath,
  plannedAgentOperation,
  type AgentEnvironmentStatus,
} from "./runtime-policy.js";

const RECONCILER_ACTION_ID = "omh-reconciler";
const MARKER_SCHEMA_VERSION = "2.0.0";
const MAX_NATIVE_OUTPUT_BYTES = 4 * 1024 * 1024;

export type EnvironmentReadiness =
  | "ready"
  | "ready-with-optional-gaps"
  | "preview"
  | "blocked"
  | "partial-unready"
  | "stale-preview"
  | "unconfigured"
  | "unverifiable";

export interface CapabilityEnvironmentStatus {
  readonly id: string;
  readonly runtimeId: AgentId;
  readonly state: "ready" | "pending" | "unsupported" | "unverifiable";
  readonly sourceId: string;
  readonly detail?: string;
}

export interface RuntimeAddonEnvironmentStatus {
  readonly agentId: "codex" | "opencode";
  readonly detail: string;
  readonly fingerprint: string;
  readonly id: "omo";
  readonly state: "conflict" | "installable" | "ready" | "unverifiable";
  readonly version: string;
}

export interface EnvironmentPreview {
  readonly schemaVersion: "2.0.0";
  readonly kind: "environment-preview";
  readonly stateRoot: string;
  readonly receiptPath: string;
  readonly profileId: string;
  readonly catalogRevision: string;
  readonly selectedAgents: readonly AgentId[];
  readonly agents: readonly AgentEnvironmentStatus[];
  readonly packages: readonly PackageInstallPlanEntry[];
  readonly capabilities: readonly CapabilityEnvironmentStatus[];
  readonly addons: readonly RuntimeAddonEnvironmentStatus[];
  readonly preflights: readonly PlanPreflight[];
  readonly optionalGaps: readonly string[];
  readonly blockers: readonly string[];
  readonly plan: ApplyPlan | null;
  readonly digest: string | null;
  readonly readiness: "preview" | "blocked";
  readonly remediation: string;
  readonly instanceId: EnvironmentInstanceId | null;
}

export interface EnvironmentStatus {
  readonly schemaVersion: "2.0.0";
  readonly kind: "environment-status";
  readonly readiness: EnvironmentReadiness;
  readonly stateRoot: string;
  readonly receiptPath: string;
  readonly profileId: string | null;
  readonly catalogRevision: string | null;
  readonly currentCatalogRevision: string;
  readonly selectedAgents: readonly AgentId[];
  readonly agents: readonly AgentEnvironmentStatus[];
  readonly packages: readonly PackageInstallPlanEntry[];
  readonly capabilities: readonly CapabilityEnvironmentStatus[];
  readonly addons: readonly RuntimeAddonEnvironmentStatus[];
  readonly optionalGaps: readonly string[];
  readonly blockers: readonly string[];
  readonly claudeMilestoneReady: boolean;
  readonly v2ParityReady: boolean;
  readonly remediation: readonly string[];
  readonly instanceId: EnvironmentInstanceId | null;
  readonly planDigest: string | null;
  readonly receiptFingerprint: string | null;
}

export interface EnvironmentSelection {
  readonly profileId: string;
  readonly selectedAgents?: readonly string[];
  readonly selectedPackages?: readonly string[];
  readonly stateRoot?: string;
  readonly capabilitySet?: CapabilitySet;
  readonly clean?: boolean;
  readonly distribution?: "Ubuntu";
  readonly target?: EnvironmentInstanceId;
  readonly toolRoute?: "wsl-ubuntu";
  readonly toolRouteReceiptFingerprint?: string;
  readonly toolRouteFailure?: string;
  readonly toolRoutes?: readonly ToolRoute[];
  readonly selectedCapabilities?: readonly string[];
}

export interface EnvironmentOrchestratorOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly repositoryRoot: string;
  readonly cwd?: string;
  readonly os?: NodeJS.Platform;
  readonly arch?: string;
  readonly now?: () => Date;
  readonly runCommand?: (
    command: string,
    args: readonly string[],
    options: {
      readonly cwd?: string;
      readonly env: NodeJS.ProcessEnv;
    },
  ) => string;
  readonly inspectPackageVersion?: (
    executablePath: string,
    packageId: PackageId,
  ) => string | null;
}

interface EnvironmentModel {
  readonly catalog: CatalogBundle;
  readonly profile: EnvironmentProfile;
  readonly stateRoot: string;
  readonly receiptPath: string;
  readonly platformId: PlatformId;
  readonly os: OperatingSystem;
  readonly adapters: readonly RuntimeAdapterDescriptor[];
  readonly selectedAgents: readonly AgentId[];
  readonly agents: readonly AgentEnvironmentStatus[];
  readonly packages: readonly PackageInstallPlanEntry[];
  readonly capabilities: readonly CapabilityEnvironmentStatus[];
  readonly managedPayload: ManagedRuntimePayload;
  readonly officialMarketplace: OfficialMarketplaceInspection;
  readonly officialMarketplaceAdapter: OfficialMarketplaceRuntimeAdapter | null;
  readonly officialMarketplaceLock: OfficialCapabilityLock;
  readonly officialMarketplaceSnapshot: OfficialMarketplaceSnapshot | null;
  readonly officialMarketplaceGitPath: string | null;
  readonly officialMarketplaceExternalSource: string | null;
  readonly openCodeSkills: readonly OpenCodeSkillRegistration[];
  readonly runtimeAddons: readonly RuntimeAddonModel[];
  readonly desired: ReturnType<typeof resolveDesiredState>;
  readonly clean: boolean;
  readonly currentReceipt: ManagedStateReceipt | null;
  readonly receiptFailure: string | null;
  readonly toolRouteRequested: boolean;
  readonly toolRouteFailure: string | null;
}

interface RuntimeAddonModelBase {
  readonly fingerprint: string;
  readonly status: RuntimeAddonEnvironmentStatus;
}

interface OpenCodeRuntimeAddonModel extends RuntimeAddonModelBase {
  readonly addon: OpenCodePackageAddon;
  readonly agentId: "opencode";
  readonly kind: "opencode-package";
  readonly nativeState: "collision" | "missing" | "previous" | "ready";
  readonly snapshot: OpenCodeAddonSnapshot;
  readonly sourceArchivePath: string | null;
}

interface CodexRuntimeAddonModel extends RuntimeAddonModelBase {
  readonly addon: CodexMarketplaceAddon;
  readonly agentId: "codex";
  readonly gitOperations: RuntimeAddonGitOperations | null;
  readonly kind: "codex-marketplace";
  readonly nativeState: {
    readonly marketplace: "collision" | "missing" | "ready";
    readonly plugin: "collision" | "missing" | "ready";
  };
  readonly snapshot: CodexAddonSnapshot;
  readonly sourceArchivePath: string | null;
}

type RuntimeAddonModel =
  | CodexRuntimeAddonModel
  | OpenCodeRuntimeAddonModel;

interface Marker {
  readonly schemaVersion: "2.0.0";
  readonly kind: "environment-action-marker";
  readonly actionId: string;
  readonly catalogRevision: string;
  readonly target: string;
  readonly identity?: string;
}

function runtimePlatform(
  os: NodeJS.Platform,
  architecture: string,
): { readonly os: OperatingSystem; readonly platformId: PlatformId } {
  if (!["darwin", "linux", "win32"].includes(os)) {
    throw new Error(`unsupported operating system: ${os}`);
  }
  const arch = architecture === "x64"
    ? "x64"
    : architecture === "arm64"
      ? "arm64"
      : null;
  if (arch === null) throw new Error(`unsupported architecture: ${architecture}`);
  return {
    os: os as OperatingSystem,
    platformId: `${os}-${arch}` as PlatformId,
  };
}

function profileFrom(catalog: CatalogBundle, profileId: string): EnvironmentProfile {
  const profile = catalog.profiles.find(({ id }) => id === profileId);
  if (!profile) throw new Error(`unknown released profile: ${profileId}`);
  return profile;
}

function selectedPackageIds(
  profile: EnvironmentProfile,
  override: readonly string[] | undefined,
): readonly PackageId[] {
  const requested = override
    ?? [...profile.packages.required, ...profile.packages.optional];
  if (profile.compositionOnly === true && requested.length > 0) {
    throw new Error("composition profiles must not select CLI packages");
  }
  const unique = new Set<PackageId>();
  for (const id of requested) {
    if (!isPackageId(id)) throw new Error(`unsupported package: ${id}`);
    if (unique.has(id)) throw new Error(`duplicate selected package: ${id}`);
    unique.add(id);
  }
  return [...unique];
}

function packageModel(
  catalog: CatalogBundle,
  profile: EnvironmentProfile,
  selected: readonly PackageId[],
  os: OperatingSystem,
  env: NodeJS.ProcessEnv,
  cwd: string,
  inspectVersion?: (path: string, id: PackageId) => string | null,
): readonly PackageInstallPlanEntry[] {
  const resolvePackageInvocation = (commands: readonly string[]) => {
    for (const command of commands) {
      const invocation = resolveTrustedInvocation([command], {
        env,
        platform: os,
        workspace: cwd,
      });
      if (invocation) return invocation;
    }
    return undefined;
  };
  return planPackageInstallations({
    packages: catalog.packages.packages,
    profile,
    os,
    findExecutable(commands) {
      return resolvePackageInvocation(commands)?.executablePath ?? null;
    },
    hasInstaller(command) {
      return resolvePackageInvocation([command]) !== undefined;
    },
    inspectVersion(path, id) {
      if (inspectVersion) return inspectVersion(path, id);
      const entry = catalog.packages.packages.find((candidate) =>
        candidate.id === id);
      if (!entry) return null;
      const invocation = resolvePackageInvocation(entry.executables);
      if (!invocation || invocation.executablePath !== path) return null;
      return inspectInvocationVersion(invocation, env, cwd);
    },
  }).filter(({ id }) => selected.includes(id));
}

function routePackageModel(
  packages: readonly PackageInstallPlanEntry[],
  routes: readonly ToolRoute[],
): readonly PackageInstallPlanEntry[] {
  const routed = new Map(routes.map((route) => [route.packageId, route]));
  return packages.map((entry) => {
    const route = routed.get(entry.id);
    if (route === undefined) return entry;
    const guidance =
      `${entry.displayName} executes through the receipt-bound ${
        route.targetInstanceId
      } route (${route.receiptFingerprint.slice(0, 12)}).`;
    return {
      authenticationGuidance:
        `${entry.authenticationGuidance} Authentication remains owned by ${
          route.targetInstanceId
        } and is never copied to Windows.`,
      description: entry.description,
      displayName: entry.displayName,
      executables: entry.executables,
      ...(entry.expectedVersion === undefined
        ? {}
        : { expectedVersion: entry.expectedVersion }),
      guidance,
      id: entry.id,
      installGuidance: guidance,
      required: entry.required,
      status: "installed-unconfigured" as const,
    };
  });
}

function inspectInvocationVersion(
  invocation: TrustedInvocation,
  env: NodeJS.ProcessEnv,
  cwd: string,
): string | null {
  const result = spawnSync(
    invocation.command,
    [...invocation.argsPrefix, "--version"],
    {
      cwd,
      encoding: "utf8",
      env,
      maxBuffer: 64 * 1024,
      shell: false,
      timeout: 5_000,
      windowsHide: true,
    },
  );
  if (result.error || result.status !== 0) return null;
  const match = `${result.stdout}\n${result.stderr}`.match(
    /(?:^|[^0-9])([0-9]+\.[0-9]+\.[0-9]+)(?:[^0-9]|$)/u,
  );
  return match?.[1] ?? null;
}

function capabilityModel(
  catalog: CatalogBundle,
  selectedCapabilities: readonly CapabilityId[],
  selectedAgents: readonly AgentId[],
  officialMarketplace: OfficialMarketplaceInspection,
  os: OperatingSystem,
  env: NodeJS.ProcessEnv,
  cwd: string,
): readonly CapabilityEnvironmentStatus[] {
  const byId = new Map(
    catalog.capabilities.capabilities.map((entry) => [entry.id, entry]),
  );
  return selectedAgents.flatMap((runtimeId) =>
    selectedCapabilities.map((id) => {
      const capability = byId.get(id);
      if (!capability) throw new Error(`unknown profile capability: ${id}`);
      const readiness = capability.runtimeReadiness[runtimeId];
      if (readiness.state === "unsupported") {
        return {
          detail: `${readiness.sourceId}: runtime adapter does not expose this capability`,
          id,
          runtimeId,
          sourceId: readiness.sourceId,
          state: "unsupported" as const,
        };
      }
      if (
        runtimeId === "claude-code"
        && readiness.packaging === "official-plugin"
        && (
          officialMarketplace.state !== "ready"
          || !officialMarketplace.plugins.some(
            ({ capabilityId }) => capabilityId === id,
          )
        )
      ) {
        return {
          detail: officialMarketplace.detail,
          id,
          runtimeId,
          sourceId: readiness.sourceId,
          state: "unverifiable" as const,
        };
      }
      if (capability.kind === "lsp") {
        const lsp = assessLspReadiness(capability, {
          agentPluginConfigured: readiness.state === "ready",
          findExecutable: (command) =>
            findTrustedExecutable(command, { cwd, env }),
          os,
        });
        if (!lsp.ready) {
          return {
            detail: `${lsp.state}: ${lsp.requiredExecutables.join(", ")}`,
            id,
            runtimeId,
            sourceId: readiness.sourceId,
            state: lsp.state === "unsupported"
              ? "unsupported" as const
              : "unverifiable" as const,
          };
        }
      }
      return {
        id,
        runtimeId,
        sourceId: readiness.sourceId,
        state: readiness.state,
      };
    })
  );
}

function runtimeAddonFingerprint(addon: DefaultRuntimeAddon): string {
  return sha256Bytes(stableJson(addon));
}

function runtimeAddonArchive(
  repositoryRoot: string,
  relativePath: string,
  expectedSha256: string,
): string | null {
  const path = resolve(repositoryRoot, relativePath);
  if (!isPathStrictlyWithin(repositoryRoot, path)) return null;
  return inspectRuntimeAddonArchive(path, expectedSha256) ? path : null;
}

function isOpenCodePackageAddon(
  addon: DefaultRuntimeAddon,
): addon is OpenCodePackageAddon {
  return addon.registration.kind === "opencode-package";
}

function isCodexMarketplaceAddon(
  addon: DefaultRuntimeAddon,
): addon is CodexMarketplaceAddon {
  return addon.registration.kind === "codex-marketplace";
}

function runtimeAddonPin(model: RuntimeAddonModel): RuntimeAddonPin {
  return {
    agentId: model.agentId,
    fingerprint: model.fingerprint,
    id: model.addon.id,
    kind: model.kind,
    version: model.addon.version,
  };
}

function codexAddonNativeRegistration(
  model: CodexRuntimeAddonModel,
): CodexMarketplaceAddonRegistration {
  return {
    manifestPath: model.addon.registration.manifestPath,
    manifestSha256: model.addon.registration.manifestSha256,
    marketplaceName: model.addon.registration.marketplaceName,
    marketplaceRoot: model.snapshot.root,
    pluginContentSha256: model.addon.registration.pluginContentSha256,
    pluginPath: model.addon.registration.pluginPath,
    repository: model.addon.registration.repository,
    selector: model.addon.registration.selector,
    version: model.addon.version,
  };
}

function buildRuntimeAddonModels(
  catalog: CatalogBundle,
  selectedAgents: readonly AgentId[],
  agents: readonly AgentEnvironmentStatus[],
  stateRoot: string,
  options: ReturnType<typeof normalizedOptions>,
): readonly RuntimeAddonModel[] {
  const agentCatalog = new Map(
    catalog.agents.agents.map((agent) => [agent.id, agent]),
  );
  return selectedAgents.flatMap((agentId): readonly RuntimeAddonModel[] => {
    const entry = agentCatalog.get(agentId);
    if (entry === undefined) {
      throw new Error(`missing selected agent catalog entry: ${agentId}`);
    }
    return entry.defaultAddons.map((addon): RuntimeAddonModel => {
      const fingerprint = runtimeAddonFingerprint(addon);
      if (isOpenCodePackageAddon(addon)) {
        const snapshot = openCodeAddonSnapshot(addon, stateRoot);
        const snapshotReady = inspectOpenCodeAddonSnapshot(addon, stateRoot);
        const sourceArchivePath = runtimeAddonArchive(
          options.repositoryRoot,
          addon.registration.snapshotArchivePath,
          addon.registration.snapshotArchiveSha256,
        );
        const nativeState = inspectOpenCodePackageAddon(
          {
            packageName: addon.registration.packageName,
            previousSpec: addon.registration.spec,
            spec: snapshot.spec,
          },
          options.env,
          options.os,
        );
        let state: RuntimeAddonEnvironmentStatus["state"];
        let detail: string;
        if (nativeState === "collision") {
          state = "conflict";
          detail =
            "OpenCode contains a legacy, duplicate, or differently pinned OMO package";
        } else if (!snapshotReady && sourceArchivePath === null) {
          state = "unverifiable";
          detail = "the reviewed OpenCode OMO snapshot and archive are unavailable";
        } else if (snapshotReady && nativeState === "ready") {
          state = "ready";
          detail = `${snapshot.spec} is registered exactly`;
        } else {
          state = "installable";
          detail = `${snapshot.spec} can be registered additively`;
        }
        return {
          addon,
          agentId: "opencode",
          fingerprint,
          kind: "opencode-package",
          nativeState,
          snapshot,
          sourceArchivePath,
          status: {
            agentId: "opencode",
            detail,
            fingerprint,
            id: addon.id,
            state,
            version: addon.version,
          },
        };
      }
      if (!isCodexMarketplaceAddon(addon)) {
        throw new Error("unsupported default add-on registration");
      }
      const snapshot = codexAddonSnapshot(addon, stateRoot);
      const sourceArchivePath = runtimeAddonArchive(
        options.repositoryRoot,
        addon.registration.snapshotArchivePath,
        addon.registration.snapshotArchiveSha256,
      );
      const gitPath = findTrustedExecutable("git", {
        cwd: options.cwd,
        env: options.env,
        platform: options.os,
      });
      const gitOperations = gitPath === null
        ? null
        : createRuntimeAddonGitOperations(
            gitPath,
            (command, args, environment) =>
              runCommand(command, args, { ...options, env: environment }),
            options.env,
          );
      const selectedAgent = agents.find(({ id }) => id === "codex");
      const executable = selectedAgent?.state === "ready"
        ? selectedAgent.executablePath
        : null;
      const registration = {
        manifestPath: addon.registration.manifestPath,
        manifestSha256: addon.registration.manifestSha256,
        marketplaceName: addon.registration.marketplaceName,
        marketplaceRoot: snapshot.root,
        pluginContentSha256: addon.registration.pluginContentSha256,
        pluginPath: addon.registration.pluginPath,
        repository: addon.registration.repository,
        selector: addon.registration.selector,
        version: addon.version,
      };
      const nativeState = executable === null
        ? { marketplace: "missing" as const, plugin: "missing" as const }
        : inspectCodexMarketplaceAddon(
            executable,
            registration,
            (root) =>
              gitOperations !== null
              && verifyCodexAddonGitMarketplace(
                root,
                addon,
                gitOperations,
              ),
            (command, args) => runCommand(command, args, options),
          );
      const partial =
        (nativeState.marketplace === "ready")
        !== (nativeState.plugin === "ready");
      const conflict =
        nativeState.marketplace === "collision"
        || nativeState.plugin === "collision"
        || partial;
      const sourceAvailable =
        inspectCodexAddonSnapshot(addon, stateRoot)
        || sourceArchivePath !== null;
      const ready =
        nativeState.marketplace === "ready"
        && nativeState.plugin === "ready";
      const state = conflict
        ? "conflict" as const
        : ready
          ? "ready" as const
          : sourceAvailable
            ? "installable" as const
            : "unverifiable" as const;
      return {
        addon,
        agentId: "codex",
        fingerprint,
        gitOperations,
        kind: "codex-marketplace",
        nativeState,
        snapshot,
        sourceArchivePath,
        status: {
          agentId: "codex",
          detail: conflict
            ? "Codex contains a partial, duplicate, or differently pinned OMO registration"
            : ready
              ? `${addon.registration.selector} ${addon.version} is registered exactly`
              : sourceAvailable
                ? `${addon.registration.selector} ${addon.version} can be acquired and registered`
                : "the reviewed embedded or managed Codex OMO snapshot is required",
          fingerprint,
          id: addon.id,
          state,
          version: addon.version,
        },
      };
    });
  });
}

function buildModel(
  selection: EnvironmentSelection,
  options: Required<
    Pick<EnvironmentOrchestratorOptions, "env" | "repositoryRoot" | "cwd" | "os" | "arch">
  > & Pick<
    EnvironmentOrchestratorOptions,
    "inspectPackageVersion" | "runCommand"
  >,
): EnvironmentModel {
  const catalog = loadCatalogBundle(options.repositoryRoot);
  const profile = profileFrom(catalog, selection.profileId);
  const stateRoot = resolveStateRoot(
    selection.stateRoot,
    options.env,
    selection.target,
  );
  const { os, platformId } = runtimePlatform(options.os, options.arch);
  const platformArch = platformId.endsWith("-arm64") ? "arm64" : "x64";
  let instance: EnvironmentInstance | undefined;
  if (selection.target === "windows-native") {
    if (os !== "win32") {
      throw new Error("windows-native target must execute on win32");
    }
    instance = {
      id: "windows-native",
      platform: { arch: platformArch, os: "win32" },
      stateRoot,
      transport: "local",
    };
  } else if (selection.target === "wsl-ubuntu") {
    if (os !== "linux") {
      throw new Error("wsl-ubuntu target must execute inside Linux");
    }
    instance = {
      distribution: selection.distribution ?? "Ubuntu",
      id: "wsl-ubuntu",
      platform: { arch: platformArch, os: "linux" },
      stateRoot,
      transport: "wsl",
    };
  }
  const selectedPackages = selectedPackageIds(profile, selection.selectedPackages);
  const capabilitySet = selection.capabilitySet ?? "profile";
  const selectedCapabilities = (
    selection.selectedCapabilities
    ?? profile.capabilities.filter((id) =>
      capabilitySet === "profile"
        || (WORKFLOW_CAPABILITY_IDS as readonly string[]).includes(id)
    )
  ).map((id) => {
    if (!isCapabilityId(id)) {
      throw new Error(`unsupported selected capability: ${id}`);
    }
    return id;
  });
  let toolRoutes: readonly ToolRoute[] = selection.toolRoutes ?? [];
  if (selection.toolRoute !== undefined && selection.toolRoutes === undefined) {
    if (instance?.id !== "windows-native") {
      throw new Error("tool routes require the windows-native target");
    }
    if (selection.toolRouteReceiptFingerprint !== undefined) {
      toolRoutes = selectedPackages.map((packageId) => ({
        packageId,
        receiptFingerprint: selection.toolRouteReceiptFingerprint!,
        targetInstanceId: selection.toolRoute!,
      }));
    }
  }
  const desired = resolveDesiredState(
    profile,
    selection.selectedAgents,
    instance === undefined
      ? undefined
      : {
          capabilitySet,
          instance,
          selectedCapabilities,
          selectedPackages,
          toolRoutes,
        },
  );
  const adapters = loadRuntimeAdapters(options.repositoryRoot, catalog)
    .filter(({ id }) => desired.selectedAgents.includes(id));
  const adapterById = new Map(adapters.map((entry) => [entry.id, entry]));
  const agents = desired.selectedAgents.map((id) => {
    const adapter = adapterById.get(id);
    if (!adapter) throw new Error(`missing runtime adapter: ${id}`);
    return profile.compositionOnly === true
      ? inspectCompositionAgent(
          adapter,
          platformId,
          options.env,
          options.cwd,
        )
      : inspectAgent(
          adapter,
          stateRoot,
          platformId,
          options.env,
          options.cwd,
        );
  });
  const runtimeAddons = buildRuntimeAddonModels(
    catalog,
    desired.selectedAgents,
    agents,
    stateRoot,
    options,
  );
  const desiredWithAddons = {
    ...desired,
    runtimeAddons: runtimeAddons.map(runtimeAddonPin),
  };
  const nativePackages = packageModel(
    catalog,
    profile,
    selectedPackages,
    os,
    options.env,
    options.cwd,
    options.inspectPackageVersion,
  );
  const packages = routePackageModel(nativePackages, toolRoutes);
  const officialMarketplaceLock =
    loadCapabilityProvenance(options.repositoryRoot).official;
  let officialMarketplaceSnapshot: OfficialMarketplaceSnapshot | null = null;
  let officialMarketplaceAdapter: OfficialMarketplaceRuntimeAdapter | null =
    null;
  let officialMarketplaceGitPath: string | null = null;
  let officialMarketplaceExternalSource: string | null = null;
  let officialMarketplace: OfficialMarketplaceInspection = {
    detail: "Claude Code is not selected",
    plugins: [],
    root: null,
    state: "unverifiable",
  };
  if (desired.selectedAgents.includes("claude-code")) {
    officialMarketplaceSnapshot = createOfficialMarketplaceSnapshot(
      officialMarketplaceLock,
      stateRoot,
    );
    officialMarketplaceAdapter = officialMarketplaceRuntimeAdapter(
      officialMarketplaceLock,
      stateRoot,
    );
    const adapterInspection = inspectOfficialMarketplaceRuntimeAdapter(
      officialMarketplaceLock,
      stateRoot,
    );
    if (adapterInspection.state === "ready") {
      officialMarketplace = adapterInspection;
    } else if (existsSync(officialMarketplaceAdapter.root)) {
      officialMarketplace = adapterInspection;
    } else {
      const snapshotInspection = inspectOfficialMarketplaceSnapshot(
        officialMarketplaceLock,
        stateRoot,
      );
      const externalInspection = inspectOfficialClaudeMarketplace(
        officialMarketplaceLock,
        options.env,
      );
      officialMarketplaceExternalSource =
        externalInspection.state === "ready"
          ? externalInspection.root
          : null;
      officialMarketplaceGitPath = findTrustedExecutable("git", {
        cwd: options.cwd,
        env: options.env,
        platform: options.os,
      });
      const sourceAvailable =
        snapshotInspection.state === "ready"
        || (
          !existsSync(officialMarketplaceSnapshot.root)
          && (
            officialMarketplaceExternalSource !== null
            || officialMarketplaceGitPath !== null
          )
        );
      officialMarketplace = sourceAvailable
        ? plannedOfficialMarketplaceRuntimeAdapter(
            officialMarketplaceLock,
            stateRoot,
          )
        : {
            detail: existsSync(officialMarketplaceSnapshot.root)
              ? snapshotInspection.detail
              : [
                  externalInspection.detail,
                  "trusted Git is required to acquire the reviewed Claude marketplace",
                ].join("; "),
            plugins: [],
            root: officialMarketplaceAdapter.root,
            state: "unverifiable",
          };
    }
  }
  const managedPayload = inspectManagedRuntimePayload(
    options.repositoryRoot,
    stateRoot,
  );
  const openCodeSkills = desired.selectedAgents.includes("opencode")
    ? planOpenCodeSkillRegistrations(
        options.repositoryRoot,
        selectedCapabilities.filter((id) =>
          (WORKFLOW_CAPABILITY_IDS as readonly string[]).includes(id)
        ),
        options.env,
        options.os,
      )
    : [];
  let currentReceipt: ManagedStateReceipt | null = null;
  let receiptFailure: string | null = null;
  if (selection.clean === true) {
    try {
      currentReceipt = readReceipt(
        join(stateRoot, "receipts", "environment.json"),
        options.repositoryRoot,
      );
    } catch (error) {
      receiptFailure = error instanceof Error ? error.message : String(error);
    }
  }
  return {
    adapters,
    agents,
    capabilities: capabilityModel(
      catalog,
      selectedCapabilities,
      desired.selectedAgents,
      officialMarketplace,
      os,
      options.env,
      options.cwd,
    ),
    catalog,
    os,
    packages,
    managedPayload,
    officialMarketplace,
    officialMarketplaceAdapter,
    officialMarketplaceExternalSource,
    officialMarketplaceGitPath,
    officialMarketplaceLock,
    officialMarketplaceSnapshot,
    openCodeSkills,
    runtimeAddons,
    desired: desiredWithAddons,
    clean: selection.clean ?? false,
    currentReceipt,
    receiptFailure,
    toolRouteFailure: selection.toolRoute === undefined
      ? null
      : selection.toolRouteFailure
        ?? (
          selection.toolRouteReceiptFingerprint === undefined
            ? "wsl-ubuntu does not have a ready receipt"
            : null
        ),
    toolRouteRequested: selection.toolRoute !== undefined,
    platformId,
    profile,
    receiptPath: join(stateRoot, "receipts", "environment.json"),
    selectedAgents: desired.selectedAgents,
    stateRoot,
  };
}

function ownedContentMatches(
  ownership: ManagedStateReceipt["ownership"][number],
): boolean {
  if (!existsSync(ownership.target)) return true;
  try {
    return ownership.kind === "directory"
      ? hashManagedDirectory(ownership.target) === ownership.digest
      : sha256File(ownership.target) === ownership.digest;
  } catch {
    return false;
  }
}

function ownedTargetStaysWithinStateRoot(
  stateRoot: string,
  target: string,
): boolean {
  try {
    if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
      return false;
    }
    const parent = assertSafeManagedRootPath(
      dirname(target),
      "managed ownership parent",
    );
    return isPathStrictlyWithin(
      stateRoot,
      join(parent, basename(target)),
    );
  } catch {
    return false;
  }
}

function cleanPreflights(model: EnvironmentModel): PlanPreflight[] {
  if (!model.clean) return [];
  if (model.receiptFailure !== null) {
    return [{
      detail: model.receiptFailure,
      id: "clean:receipt",
      required: true,
      status: "unverifiable",
    }];
  }
  if (model.currentReceipt === null) {
    return [{
      detail: "no prior receipt-owned artifacts exist",
      id: "clean:receipt",
      required: true,
      status: "ready",
    }];
  }
  const instance = model.currentReceipt.desiredState.instance;
  if (
    instance !== undefined
    && instance.id !== model.desired.instance?.id
  ) {
    return [{
      detail: "the prior receipt belongs to another environment instance",
      id: "clean:instance",
      required: true,
      status: "unverifiable",
    }];
  }
  return model.currentReceipt.ownership
    .filter(({ scope }) => scope === "managed")
    .map((ownership) => {
      const safe = ownedTargetStaysWithinStateRoot(
        model.stateRoot,
        ownership.target,
      );
      const exact = safe && ownedContentMatches(ownership);
      return {
        detail: !safe
          ? "managed ownership target escapes the selected instance root"
          : exact
            ? "managed ownership is exact or already absent"
            : "managed ownership content drifted",
        id: `clean:${ownership.id}`,
        required: true,
        status: exact ? "ready" as const : "unverifiable" as const,
      };
    });
}

function markerFor(
  actionId: string,
  catalogRevision: string,
  target: string,
  identity?: string,
): string {
  const marker: Marker = {
    actionId,
    catalogRevision,
    kind: "environment-action-marker",
    schemaVersion: MARKER_SCHEMA_VERSION,
    target,
    ...(identity === undefined ? {} : { identity }),
  };
  return `${stableJson(marker)}\n`;
}

function packageMarkerPath(stateRoot: string, id: string): string {
  return join(stateRoot, "markers", "packages", `${id}.json`);
}

function runtimeMarkerPath(stateRoot: string, id: AgentId): string {
  return join(stateRoot, "markers", "runtimes", `${id}.json`);
}

function compositionAgentTarget(
  stateRoot: string,
  id: AgentId,
): string {
  return join(stateRoot, "external", "agents", id);
}

function compositionNodeTarget(stateRoot: string): string {
  return join(stateRoot, "external", "runtime", "node");
}

interface ExactReceiptManagedPayloadIdentity {
  readonly digest: string;
  readonly root: string;
}

type ReceiptManagedPayloadDisposition =
  | { readonly state: "unmanaged" }
  | { readonly state: "invalid" }
  | {
      readonly identity: ExactReceiptManagedPayloadIdentity;
      readonly state: "current" | "previous";
    };

function exactReceiptManagedPayloadIdentity(
  model: EnvironmentModel,
): ExactReceiptManagedPayloadIdentity | null {
  if (!model.clean || model.currentReceipt === null) return null;
  const payloadOwnership = model.currentReceipt.ownership.filter(
    ({ id, kind, scope }) =>
      id === "plugin:runtime-package"
      && kind === "directory"
      && scope === "managed",
  );
  const ownership = payloadOwnership[0];
  if (
    payloadOwnership.length !== 1
    || ownership === undefined
    || !existsSync(ownership.target)
    || !ownedTargetStaysWithinStateRoot(model.stateRoot, ownership.target)
    || !ownedContentMatches(ownership)
  ) {
    return null;
  }
  return { digest: ownership.digest, root: ownership.target };
}

function receiptManagedPayloadDisposition(
  model: EnvironmentModel,
  runtimeId: AgentId,
): ReceiptManagedPayloadDisposition {
  if (!hasManagedNativeRuntimeOwnership(model, runtimeId)) {
    return { state: "unmanaged" };
  }
  const identity = exactReceiptManagedPayloadIdentity(model);
  if (identity === null) return { state: "invalid" };
  return {
    identity,
    state: resolve(identity.root) === resolve(model.managedPayload.activeRoot)
      ? "current"
      : "previous",
  };
}

function previousManagedPayloadIdentity(
  model: EnvironmentModel,
  runtimeId: AgentId,
): ExactReceiptManagedPayloadIdentity | null {
  const disposition = receiptManagedPayloadDisposition(model, runtimeId);
  return disposition.state === "previous" ? disposition.identity : null;
}

function hasManagedNativeRuntimeOwnership(
  model: EnvironmentModel,
  runtimeId: AgentId,
): boolean {
  return model.clean
    && model.currentReceipt !== null
    && model.currentReceipt.ownership.filter(
      ({ id, kind, scope }) =>
        id === `runtime:${runtimeId}:native`
        && kind === "registration"
        && scope === "managed",
    ).length === 1;
}

function claudeNativeRegistration(
  activeRoot: string,
  receiptPath: string,
  expectedVersion: string,
  previousActiveRoot?: string,
): ClaudeManagedNativeRegistration {
  return {
    activeRoot,
    expectedVersion,
    ...(previousActiveRoot === undefined
      ? {}
      : {
          previousActiveRoot,
          previousExpectedVersion: claudeManagedPluginVersion(
            previousActiveRoot,
          ),
        }),
    receiptPath,
  };
}

function capabilityMarkerPath(
  stateRoot: string,
  runtimeId: AgentId,
  id: string,
): string {
  return join(stateRoot, "markers", "capabilities", runtimeId, `${id}.json`);
}

function runtimeAddonMarkerPath(
  stateRoot: string,
  runtimeId: "codex" | "opencode",
  id: "omo" | "omo-source",
): string {
  return join(stateRoot, "markers", "addons", runtimeId, `${id}.json`);
}

function receiptOwnershipMatches(
  receipt: ManagedStateReceipt,
  id: string,
  kind: ManagedStateReceipt["ownership"][number]["kind"],
  target: string,
  digest: string,
): boolean {
  const matches = receipt.ownership.filter(
    (entry) => entry.id === id && entry.kind === kind,
  );
  return matches.length === 1
    && matches[0]?.target === target
    && matches[0]?.digest === digest;
}

function actionPreimage(action: PlanAction): ObservedPreimage {
  const preimageTarget = action.payload?.preimageTarget;
  const observedTarget = action.payload?.observedTarget;
  const target = typeof preimageTarget === "string"
    ? preimageTarget
    : typeof observedTarget === "string"
      ? observedTarget
      : action.target;
  return action.payload?.ownershipKind === "directory"
      || action.payload?.observedTargetKind === "directory"
    ? observeManagedPath(target)
    : observeRegularFile(target);
}

function nativeObservedTarget(
  runtimeId: AgentId,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  marker: string,
): string {
  return runtimeId === "opencode"
    ? openCodeConfigPath(env, platform)
    : marker;
}

function describeOpenCodeNativeRegistration(
  state: OpenCodeManagedRuntimeRegistrationState,
  hasPrevious: boolean,
): string {
  switch (state) {
    case "collision":
      return "OpenCode configuration has a malformed, duplicate, or foreign oh-my-harness registration";
    case "previous":
      return "OpenCode registration exactly matches the prior managed payload";
    case "ready":
      return "OpenCode registration exactly matches the current managed payload";
    case "missing":
      return hasPrevious
        ? "OpenCode prior managed registration is missing"
        : "OpenCode registration can be installed additively";
  }
}

function describeCommandNativeRegistration(
  runtimeName: "Claude" | "Codex",
  disposition: ManagedRuntimeRegistrationDisposition,
  hasPrevious: boolean,
): string {
  if (hasPrevious) {
    return disposition === "ready"
      ? `${runtimeName} registration exactly matches the prior managed payload`
      : `${runtimeName} registration no longer matches the prior managed payload`;
  }
  switch (disposition) {
    case "ready":
      return `${runtimeName} registration exactly matches the current managed payload`;
    case "missing":
      return `${runtimeName} registration can be installed additively`;
    case "collision":
      return `${runtimeName} registration is malformed, partial, duplicate, foreign, or missing from its prior managed payload`;
  }
}

function nativeRuntimePreflights(
  model: EnvironmentModel,
  options: ReturnType<typeof normalizedOptions>,
): PlanPreflight[] {
  return model.selectedAgents.flatMap((runtimeId): PlanPreflight[] => {
    const receiptPayload = receiptManagedPayloadDisposition(model, runtimeId);
    const previousActiveRoot = receiptPayload.state === "previous"
      ? receiptPayload.identity.root
      : null;
    if (receiptPayload.state === "invalid") {
      const runtimeName = runtimeId === "claude-code"
        ? "Claude"
        : runtimeId === "codex"
          ? "Codex"
          : "OpenCode";
      return [{
        detail: `${runtimeName} registration no longer has an exact receipt-owned prior payload`,
        id: `native-registration:${runtimeId}`,
        required: true,
        status: "unverifiable",
      }];
    }
    if (runtimeId === "opencode") {
      const state = inspectOpenCodeManagedRuntimeRegistration(
        {
          activeRoot: model.managedPayload.activeRoot,
          ...(previousActiveRoot === null ? {} : { previousActiveRoot }),
        },
        options.env,
        options.os,
      );
      const accepted = state === "ready"
        || (previousActiveRoot === null && state === "missing")
        || (previousActiveRoot !== null && state === "previous");
      return [{
        detail: describeOpenCodeNativeRegistration(
          state,
          previousActiveRoot !== null,
        ),
        id: "native-registration:opencode",
        required: true,
        status: accepted ? "ready" : "unverifiable",
      }];
    }

    const agent = model.agents.find(({ id }) => id === runtimeId);
    if (agent?.state !== "ready" || agent.executablePath === null) return [];
    const executable = agent.executablePath;
    const nativeRun = (command: string, args: readonly string[]) =>
      runCommand(command, args, options);
    let observation;
    try {
      observation = runtimeId === "claude-code"
        ? inspectClaudeManagedRuntimeRegistration(
            executable,
            claudeNativeRegistration(
              previousActiveRoot ?? model.managedPayload.activeRoot,
              model.receiptPath,
              previousActiveRoot === null
                ? HARNESS_VERSION
                : claudeManagedPluginVersion(previousActiveRoot),
            ),
            nativeRun,
          )
        : inspectCodexManagedRuntimeRegistration(
            executable,
            {
              activeRoot: previousActiveRoot ?? model.managedPayload.activeRoot,
              receiptPath: model.receiptPath,
            },
            nativeRun,
          );
    } catch {
      observation = { marketplace: "collision", plugin: "collision" } as const;
    }
    const disposition = managedRuntimeRegistrationDisposition(observation);
    const accepted = previousActiveRoot === null
      ? disposition !== "collision"
      : disposition === "ready";
    const runtimeName = runtimeId === "claude-code" ? "Claude" : "Codex";
    return [{
      detail: describeCommandNativeRegistration(
        runtimeName,
        disposition,
        previousActiveRoot !== null,
      ),
      id: `native-registration:${runtimeId}`,
      required: true,
      status: accepted ? "ready" : "unverifiable",
    }];
  });
}

function preflights(
  model: EnvironmentModel,
  options: ReturnType<typeof normalizedOptions>,
): PlanPreflight[] {
  if (
    model.profile.compositionOnly === true
    && model.selectedAgents.length === 0
  ) {
    return [];
  }
  return [
    {
      detail:
        `managed runtime payload ${model.managedPayload.digest} is locally reproducible`,
      id: "plugin:runtime-package",
      required: true,
      status: "ready",
    },
    ...model.agents.map((agent): PlanPreflight => ({
      id: `agent:${agent.id}`,
      required: true,
      status: agent.state === "unsupported"
        ? "unsupported"
        : model.profile.compositionOnly === true && agent.state !== "ready"
          ? "unverifiable"
          : "ready",
      detail: agent.detail,
    })),
    ...model.packages.map((entry): PlanPreflight => ({
      id: `package:${entry.id}`,
      required: entry.required,
      status: entry.status === "unsupported"
        ? (entry.required ? "unsupported" : "optional-gap")
        : entry.status === "manager-missing"
          ? (entry.required ? "unverifiable" : "optional-gap")
          : entry.status === "installed-unconfigured"
            ? "ready"
            : "ready",
      detail: entry.guidance ?? entry.installGuidance,
    })),
    ...model.capabilities.map((entry): PlanPreflight => ({
      id: `capability:${entry.runtimeId}:${entry.id}`,
      required: true,
      status: entry.state === "ready"
        ? "ready"
        : entry.state === "unsupported"
          ? "unsupported"
          : "unverifiable",
      detail: entry.detail ?? `${entry.sourceId}: ${entry.state}`,
    })),
    ...(model.selectedAgents.includes("claude-code")
      ? [{
          detail: model.officialMarketplace.detail,
          id: "marketplace:claude-code:official",
          required: true,
          status: model.officialMarketplace.state === "ready"
            ? "ready" as const
            : "unverifiable" as const,
        }]
      : []),
    ...model.openCodeSkills.map((registration): PlanPreflight => {
      const state = inspectOpenCodeSkillRegistration(registration);
      return {
        detail: state === "collision"
          ? "OpenCode native skill path contains user-owned or drifted content"
          : state === "ready"
            ? "OpenCode native skill already matches reviewed content"
            : "OpenCode native skill can be installed additively",
        id: `skill:opencode:${registration.id}`,
        required: true,
        status: state === "collision"
          ? "unverifiable" as const
          : "ready" as const,
      };
    }),
    ...model.runtimeAddons.map(({ status }): PlanPreflight => ({
      detail: status.detail,
      id: `addon:${status.agentId}:${status.id}`,
      required: true,
      status:
        status.state === "conflict" || status.state === "unverifiable"
          ? "unverifiable"
          : "ready",
    })),
    ...nativeRuntimePreflights(model, options),
    ...cleanPreflights(model),
    ...(model.toolRouteRequested
      ? [{
          detail: model.toolRouteFailure
            ?? "wsl-ubuntu receipt dependency is ready",
          id: "route:wsl-ubuntu",
          required: true,
          status: model.toolRouteFailure === null
            ? "ready" as const
            : "unverifiable" as const,
        }]
      : []),
  ];
}

function planActions(
  model: EnvironmentModel,
  options: Required<
    Pick<EnvironmentOrchestratorOptions, "env" | "os" | "repositoryRoot">
  >,
): PlanAction[] {
  if (
    model.profile.compositionOnly === true
    && model.selectedAgents.length === 0
  ) {
    return [];
  }
  const reconcilerSource = resolve(
    options.repositoryRoot,
    "dist",
    "cli",
    "main.js",
  );
  const reconcilerDigest = sha256File(reconcilerSource);
  const reconcilerTarget = join(
    model.managedPayload.activeRoot,
    "dist",
    "cli",
    "main.js",
  );
  const actions: PlanAction[] = [];
  for (const addon of model.runtimeAddons) {
    if (addon.kind === "opencode-package") {
      if (
        !inspectOpenCodeAddonSnapshot(addon.addon, model.stateRoot)
        && addon.sourceArchivePath === null
      ) {
        throw new Error("reviewed OpenCode OMO archive is unavailable");
      }
      actions.push({
        id: "addon:opencode:omo:source",
        kind: "acquire",
        payload: {
          contentDigest: addon.snapshot.digest,
          fingerprint: addon.fingerprint,
          operation: "acquire-opencode-addon-snapshot",
          ownershipKind: "directory",
          ownershipScope: "managed",
          packageName: addon.addon.registration.packageName,
          snapshotArchivePath: addon.addon.registration.snapshotArchivePath,
          snapshotArchiveSha256:
            addon.addon.registration.snapshotArchiveSha256,
          version: addon.addon.version,
        },
        preimage: observeManagedPath(addon.snapshot.root),
        required: true,
        target: addon.snapshot.root,
      });
      continue;
    }
    actions.push({
      id: "addon:codex:omo:source",
      kind: "acquire",
      payload: {
        contentDigest: addon.snapshot.digest,
        fingerprint: addon.fingerprint,
        operation: "acquire-codex-addon-snapshot",
        ownershipKind: "directory",
        ownershipScope: "managed",
        snapshotArchivePath: addon.addon.registration.snapshotArchivePath,
        snapshotArchiveSha256:
          addon.addon.registration.snapshotArchiveSha256,
      },
      preimage: observeManagedPath(addon.snapshot.root),
      required: true,
      target: addon.snapshot.root,
    });
  }
  actions.push(
    {
      id: "omh-node",
      kind: "write",
      payload: {
        contentDigest: sha256File(process.execPath),
        operation: "verify-file",
        ownershipKind: "file",
        ownershipScope: "external",
      },
      preimage: observeRegularFile(process.execPath),
      required: true,
      target: compositionNodeTarget(model.stateRoot),
    },
    {
      id: "plugin:runtime-package",
      kind: "acquire",
      payload: {
        contentDigest: model.managedPayload.digest,
        operation: "materialize-runtime-package",
        ownershipKind: "directory",
        ownershipScope: "managed",
        repairSource: model.managedPayload.storeRoot,
        receiptIdentity: {
          digest: reconcilerDigest,
          id: RECONCILER_ACTION_ID,
          kind: "file",
          scope: "external",
          target: reconcilerTarget,
        },
      },
      preimage: observeManagedPath(model.managedPayload.activeRoot),
      required: true,
      target: model.managedPayload.activeRoot,
    },
  );
  const adapterById = new Map(model.adapters.map((entry) => [entry.id, entry]));
  for (const agent of model.agents) {
    const adapter = adapterById.get(agent.id);
    const artifact = adapter?.platforms.find(({ platformId }) =>
      platformId === model.platformId);
    if (!adapter || !artifact) continue;
    const target = model.profile.compositionOnly === true
        && agent.ownership === "external"
      ? compositionAgentTarget(model.stateRoot, agent.id)
      : agent.state === "ready" && agent.executablePath !== null
        ? agent.executablePath
        : managedRuntimePath(model.stateRoot, adapter, model.platformId);
    actions.push({
      id: `agent:${agent.id}`,
      kind: "acquire",
      payload: {
        agentId: agent.id,
        operation: plannedAgentOperation(model.profile, agent),
        ownershipKind: "executable",
        ownershipScope: agent.ownership === "external" ? "external" : "managed",
        sourceDigest: agent.executableDigest ?? artifact.executable.sha256,
      },
      preimage: observeRegularFile(target),
      required: true,
      target,
    });
  }
  for (const entry of model.packages) {
    if (
      entry.status !== "installable"
      && entry.status !== "version-drift"
    ) {
      continue;
    }
    const target = packageMarkerPath(model.stateRoot, entry.id);
    const content = markerFor(`package:${entry.id}`, model.catalog.revision, target);
    actions.push({
      id: `package:${entry.id}`,
      kind: "acquire",
      payload: {
        content,
        contentDigest: sha256Bytes(content),
        operation: "install-package",
        ownershipKind: "file",
        ownershipScope: "managed",
        packageId: entry.id,
      },
      preimage: observeRegularFile(target),
      required: entry.required,
      target,
    });
  }
  if (model.selectedAgents.includes("claude-code")) {
    if (
      model.officialMarketplace.state !== "ready"
      || model.officialMarketplaceSnapshot === null
      || model.officialMarketplaceAdapter === null
    ) {
      throw new Error("verified Claude official marketplace is unavailable");
    }
    actions.push({
      id: "marketplace:claude-code:source",
      kind: "acquire",
      payload: {
        contentDigest: model.officialMarketplaceSnapshot.digest,
        operation: "acquire-claude-official-marketplace",
        ownershipKind: "directory",
        ownershipScope: "managed",
        ...(model.officialMarketplaceGitPath === null
          ? {}
          : { gitPath: model.officialMarketplaceGitPath }),
        ...(model.officialMarketplaceExternalSource === null
          ? {}
          : { externalSource: model.officialMarketplaceExternalSource }),
      },
      preimage: observeManagedPath(model.officialMarketplaceSnapshot.root),
      required: true,
      target: model.officialMarketplaceSnapshot.root,
    });
    actions.push({
      id: "marketplace:claude-code:runtime-adapter",
      kind: "acquire",
      payload: {
        contentDigest: model.officialMarketplaceAdapter.digest,
        operation: "materialize-claude-official-adapter",
        ownershipKind: "directory",
        ownershipScope: "managed",
      },
      preimage: observeManagedPath(model.officialMarketplaceAdapter.root),
      required: true,
      target: model.officialMarketplaceAdapter.root,
    });
    const marketplaceActionId =
      "runtime:claude-code:official-marketplace";
    const marketplaceTarget = capabilityMarkerPath(
      model.stateRoot,
      "claude-code",
      "official-marketplace",
    );
    const marketplaceContent = markerFor(
      marketplaceActionId,
      model.catalog.revision,
      marketplaceTarget,
      model.officialMarketplaceAdapter.digest,
    );
    actions.push({
      id: marketplaceActionId,
      kind: "register",
      payload: {
        content: marketplaceContent,
        contentDigest: sha256Bytes(marketplaceContent),
        marketplaceName: model.officialMarketplaceAdapter.name,
        marketplaceRoot: model.officialMarketplaceAdapter.root,
        operation: "register-claude-official-marketplace",
        ownershipKind: "registration",
        ownershipScope: "managed",
      },
      preimage: observeRegularFile(marketplaceTarget),
      required: true,
      target: marketplaceTarget,
    });
    for (const plugin of model.officialMarketplace.plugins.filter(
      ({ capabilityId }) =>
        model.desired.selectedCapabilities?.some(
          (id) => id === capabilityId,
        ) ?? model.profile.capabilities.some((id) => id === capabilityId),
    )) {
      const actionId = `capability:claude-code:${plugin.capabilityId}`;
      const target = capabilityMarkerPath(
        model.stateRoot,
        "claude-code",
        plugin.capabilityId,
      );
      const content = markerFor(
        actionId,
        model.catalog.revision,
        target,
        plugin.pathTree,
      );
      actions.push({
        id: actionId,
        kind: "register",
        payload: {
          capabilityId: plugin.capabilityId,
          content,
          contentDigest: sha256Bytes(content),
          operation: "register-claude-official",
          ownershipKind: "registration",
          ownershipScope: "managed",
          pathTree: plugin.pathTree,
          selector: plugin.selector,
        },
        preimage: observeRegularFile(target),
        required: true,
        target,
      });
    }
  }
  for (const registration of model.openCodeSkills) {
    const actionId = `capability:opencode:${registration.id}`;
    const target = capabilityMarkerPath(
      model.stateRoot,
      "opencode",
      registration.id,
    );
    const content = markerFor(
      actionId,
      model.catalog.revision,
      target,
      registration.digest,
    );
    actions.push({
      id: actionId,
      kind: "register",
      payload: {
        capabilityId: registration.id,
        content,
        contentDigest: sha256Bytes(content),
        observedTarget: registration.target,
        observedTargetKind: "directory",
        operation: "register-opencode-skill",
        ownershipKind: "registration",
        ownershipScope: "managed",
        skillDigest: registration.digest,
      },
      preimage: observeManagedPath(registration.target),
      required: true,
      target,
    });
  }
  for (const runtimeId of model.selectedAgents) {
    const target = runtimeMarkerPath(model.stateRoot, runtimeId);
    const content = markerFor(
      `runtime:${runtimeId}:native`,
      model.catalog.revision,
      target,
    );
    const observedTarget = nativeObservedTarget(
      runtimeId,
      options.env,
      options.os,
      target,
    );
    const previousPayload = previousManagedPayloadIdentity(model, runtimeId);
    actions.push({
      id: `runtime:${runtimeId}:native`,
      kind: "register",
      payload: {
        content,
        contentDigest: sha256Bytes(content),
        nodePath: compositionNodeTarget(model.stateRoot),
        observedTarget,
        operation: "register-runtime",
        ownershipKind: "registration",
        ownershipScope: "managed",
        ...(previousPayload === null
          ? {}
          : {
              previousActiveRoot: previousPayload.root,
              previousPayloadDigest: previousPayload.digest,
            }),
        receiptPath: model.receiptPath,
        runtimeId,
      },
      preimage: observeRegularFile(observedTarget),
      required: true,
      target,
    });
  }
  for (const addon of model.runtimeAddons) {
    const target = runtimeAddonMarkerPath(
      model.stateRoot,
      addon.agentId,
      "omo",
    );
    const actionId = `addon:${addon.agentId}:omo`;
    const content = markerFor(
      actionId,
      model.catalog.revision,
      target,
      addon.fingerprint,
    );
    if (addon.kind === "opencode-package") {
      actions.push({
        id: actionId,
        kind: "register",
        payload: {
          content,
          contentDigest: sha256Bytes(content),
          fingerprint: addon.fingerprint,
          observedTarget: openCodeConfigPath(options.env, options.os),
          operation: "register-opencode-addon",
          ownershipKind: "registration",
          ownershipScope: "managed",
          packageName: addon.addon.registration.packageName,
          previousSpec: addon.addon.registration.spec,
          preimageTarget: target,
          spec: addon.snapshot.spec,
        },
        preimage: observeRegularFile(target),
        required: true,
        target,
      });
      continue;
    }
    actions.push({
      id: actionId,
      kind: "register",
      payload: {
        content,
        contentDigest: sha256Bytes(content),
        fingerprint: addon.fingerprint,
        marketplaceRoot: addon.snapshot.root,
        operation: "register-codex-addon",
        ownershipKind: "registration",
        ownershipScope: "managed",
        selector: addon.addon.registration.selector,
      },
      preimage: observeRegularFile(target),
      required: true,
      target,
    });
  }
  if (model.clean && model.currentReceipt !== null) {
    const replacementTargets = new Set(actions.map(({ target }) => resolve(target)));
    for (const ownership of model.currentReceipt.ownership) {
      if (
        ownership.scope !== "managed"
        || !existsSync(ownership.target)
        || replacementTargets.has(resolve(ownership.target))
        || (
          ownership.repairSource !== undefined
          && resolve(ownership.repairSource) === resolve(ownership.target)
        )
      ) {
        continue;
      }
      actions.push({
        id: `clean:${ownership.id}`,
        kind: "remove",
        payload: {
          contentDigest: ownership.digest,
          operation: "remove-owned",
          ownershipKind: ownership.kind,
          ownershipScope: "managed",
        },
        preimage: observeManagedPath(ownership.target),
        required: true,
        target: ownership.target,
      });
    }
  }
  return actions;
}

function observedState(
  model: EnvironmentModel,
  actions: readonly PlanAction[],
  env: NodeJS.ProcessEnv,
): Readonly<Record<string, unknown>> {
  return {
    addons: model.runtimeAddons.map(({ status }) => status),
    agents: model.profile.compositionOnly === true
      ? model.agents.map((agent) => ({
          ...agent,
          ...(agent.executablePath === null
            ? {}
            : {
                executablePath: compositionAgentTarget(
                  model.stateRoot,
                  agent.id,
                ),
              }),
        }))
      : model.agents,
    packages: model.packages,
    native: Object.fromEntries(
      model.selectedAgents.map((runtimeId) => {
        const marker = runtimeMarkerPath(model.stateRoot, runtimeId);
        const observedTarget = nativeObservedTarget(
          runtimeId,
          env,
          model.os,
          marker,
        );
        return [runtimeId, {
          marker: observeRegularFile(marker),
          observedTarget,
          preimage: observeRegularFile(observedTarget),
        }];
      }),
    ),
    actions: actions.map(({ id, preimage }) => ({ id, preimage })),
    cleanInstall: model.clean,
    priorReceiptPlanDigest: model.currentReceipt?.planDigest ?? null,
  };
}

function blockingIds(preflight: readonly PlanPreflight[]): string[] {
  return preflight
    .filter(({ required, status }) => required && status !== "ready")
    .map(({ id }) => id);
}

function optionalGapIds(preflight: readonly PlanPreflight[]): string[] {
  return preflight
    .filter(({ required, status }) => !required && status !== "ready")
    .map(({ id }) => id);
}

function previewCommand(model: EnvironmentModel): string {
  return `omh setup --profile ${model.profile.id} --agents ${
    selectedAgentsArgument(model.selectedAgents)
  } --root ${JSON.stringify(model.stateRoot)}`;
}

function selectedAgentsArgument(selectedAgents: readonly AgentId[]): string {
  return selectedAgents.join(",") || "none";
}

function normalizedOptions(
  options: EnvironmentOrchestratorOptions,
): Required<
  Pick<EnvironmentOrchestratorOptions, "env" | "repositoryRoot" | "cwd" | "os" | "arch">
> & Pick<
  EnvironmentOrchestratorOptions,
  "now" | "runCommand" | "inspectPackageVersion"
> {
  return {
    arch: options.arch ?? process.arch,
    cwd: resolve(options.cwd ?? process.cwd()),
    env: options.env ?? process.env,
    os: options.os ?? process.platform,
    repositoryRoot: resolve(options.repositoryRoot),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.inspectPackageVersion === undefined
      ? {}
      : { inspectPackageVersion: options.inspectPackageVersion }),
    ...(options.runCommand === undefined ? {} : { runCommand: options.runCommand }),
  };
}

export function previewEnvironment(
  selection: EnvironmentSelection,
  options: EnvironmentOrchestratorOptions,
): EnvironmentPreview {
  const normalized = normalizedOptions(options);
  return buildEnvironmentPreview(selection, normalized).preview;
}

function buildEnvironmentPreview(
  selection: EnvironmentSelection,
  normalized: ReturnType<typeof normalizedOptions>,
): {
  readonly model: EnvironmentModel;
  readonly preview: EnvironmentPreview;
} {
  const model = buildModel(selection, normalized);
  const checks = preflights(model, normalized);
  const blockers = blockingIds(checks);
  const nativeRegistrationBlockers = blockers.filter((id) =>
    id.startsWith("native-registration:")
  );
  const actions = blockers.length === 0 ? planActions(model, normalized) : [];
  const plan = blockers.length === 0
    ? createApplyPlan({
        actions,
        catalogRevision: model.catalog.revision,
        desiredState: {
          profileId: model.profile.id,
          runtimeAddons: model.runtimeAddons.map(runtimeAddonPin),
          selectedAgents: model.selectedAgents,
          ...(model.desired.instance === undefined
            ? {}
            : {
                capabilitySet: model.desired.capabilitySet,
                instance: model.desired.instance,
                selectedCapabilities: model.desired.selectedCapabilities,
                selectedPackages: model.desired.selectedPackages,
                toolRoutes: model.desired.toolRoutes,
              }),
        },
        observedState: observedState(model, actions, normalized.env),
        platform: {
          arch: normalized.arch,
          os: normalized.os,
        },
        preflights: checks,
      })
    : null;
  return {
    model,
    preview: {
      addons: model.runtimeAddons.map(({ status }) => status),
      agents: model.agents,
      blockers,
      capabilities: model.capabilities,
      catalogRevision: model.catalog.revision,
      digest: plan?.digest ?? null,
      kind: "environment-preview",
      optionalGaps: optionalGapIds(checks),
      packages: model.packages,
      plan,
      preflights: checks,
      profileId: model.profile.id,
      readiness: plan === null ? "blocked" : "preview",
      receiptPath: model.receiptPath,
      remediation: plan === null
        ? nativeRegistrationBlockers.length === 0
          ? `${previewCommand(model)} after resolving required blockers`
          : `inspect ${nativeRegistrationBlockers.join(", ")} and resolve only the reported collision manually while preserving unrelated user-owned configuration, then rerun ${previewCommand(model)}`
        : `${previewCommand(model)} --apply --digest ${plan.digest}`,
      schemaVersion: "2.0.0",
      selectedAgents: model.selectedAgents,
      stateRoot: model.stateRoot,
      instanceId: model.desired.instance?.id ?? null,
    },
  };
}

function payloadString(action: PlanAction, key: string): string {
  const value = action.payload?.[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${action.id} is missing payload.${key}`);
  }
  return value;
}

function runCommand(
  command: string,
  args: readonly string[],
  options: ReturnType<typeof normalizedOptions>,
): string {
  if (options.runCommand) {
    return options.runCommand(command, args, {
      cwd: options.cwd,
      env: options.env,
    });
  }
  return execFileSync(command, [...args], {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env,
    maxBuffer: MAX_NATIVE_OUTPUT_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
    windowsHide: true,
  });
}

function packageInstaller(
  catalog: CatalogBundle,
  id: PackageId,
  os: OperatingSystem,
): PackageInstaller {
  const entry = catalog.packages.packages.find((candidate) => candidate.id === id);
  const installer = entry?.installers.find((candidate) => candidate.os === os);
  if (!entry || !installer) throw new Error(`missing package installer: ${id}/${os}`);
  return installer;
}

function installPackage(
  action: PlanAction,
  model: EnvironmentModel,
  options: ReturnType<typeof normalizedOptions>,
): void {
  const rawId = payloadString(action, "packageId");
  if (!isPackageId(rawId)) throw new Error(`unsupported package action: ${rawId}`);
  const entry = model.catalog.packages.packages.find(({ id }) => id === rawId);
  if (!entry) throw new Error(`unknown package action: ${rawId}`);
  const installer = packageInstaller(model.catalog, rawId, model.os);
  if (installer.kind === "managed-artifact") {
    throw new Error(`${rawId} managed artifact passed an unsupported preflight`);
  }
  if (!installer.command) throw new Error(`${rawId} installer command is missing`);
  const manager = resolveTrustedInvocation([installer.command], {
    env: options.env,
    platform: model.os,
    workspace: options.cwd,
  });
  if (!manager) throw new Error(`${rawId} package manager is no longer available`);
  runCommand(
    manager.command,
    [...manager.argsPrefix, ...installer.args],
    options,
  );
  const invocation = entry.executables
    .map((command) => resolveTrustedInvocation([command], {
      env: options.env,
      platform: model.os,
      workspace: options.cwd,
    }))
    .find((candidate): candidate is TrustedInvocation =>
      candidate !== undefined);
  if (!invocation) {
    throw new Error(`${rawId} installer completed without a trusted executable`);
  }
  if (entry.version !== undefined) {
    const observed =
      options.inspectPackageVersion?.(invocation.executablePath, rawId)
      ?? inspectInvocationVersion(invocation, options.env, options.cwd);
    if (observed !== entry.version) {
      throw new Error(
        `${rawId} installer produced ${
          observed ?? "an unverifiable version"
        }; expected ${entry.version}`,
      );
    }
  }
  atomicWriteFile(action.target, payloadString(action, "content"));
}

function runtimeExecutable(
  runtimeId: AgentId,
  model: EnvironmentModel,
  options: ReturnType<typeof normalizedOptions>,
): string {
  if (model.profile.compositionOnly === true) {
    const agent = model.agents.find(({ id }) => id === runtimeId);
    if (
      agent?.state !== "ready"
      || agent.ownership !== "external"
      || agent.executablePath === null
    ) {
      throw new Error(`${runtimeId} caller-provided executable is unavailable`);
    }
    return agent.executablePath;
  }
  const adapter = model.adapters.find(({ id }) => id === runtimeId);
  if (!adapter) throw new Error(`missing selected runtime adapter: ${runtimeId}`);
  const managed = managedRuntimePath(model.stateRoot, adapter, model.platformId);
  if (existsSync(managed)) return managed;
  const external = findTrustedExecutable(adapter.command, {
    cwd: options.cwd,
    env: options.env,
  });
  if (!external) throw new Error(`${runtimeId} executable is unavailable`);
  return external;
}

async function acquireAgent(
  action: PlanAction,
  model: EnvironmentModel,
  options: ReturnType<typeof normalizedOptions>,
): Promise<void> {
  const rawId = payloadString(action, "agentId");
  if (!isAgentId(rawId)) throw new Error(`unsupported agent action: ${rawId}`);
  const adapter = model.adapters.find(({ id }) => id === rawId);
  if (!adapter) throw new Error(`missing runtime adapter action: ${rawId}`);
  mkdirSync(model.stateRoot, { recursive: true, mode: 0o700 });
  const result = await installSelectedAgents(
    {
      adapters: [adapter],
      platformId: model.platformId,
      selectedAgentIds: [rawId],
    },
    createNodeAgentAcquisitionOperations({
      cwd: options.cwd,
      env: options.env,
      stateRoot: model.stateRoot,
    }),
  );
  const installed = result.results[0];
  if (installed?.state !== "ready") {
    throw new Error(`${rawId} runtime acquisition did not become ready`);
  }
  if (installed.executablePath !== action.target) {
    throw new Error(`${rawId} runtime published at an unexpected target`);
  }
}

function assertManagedPayloadExact(payload: ManagedRuntimePayload): void {
  for (const path of [payload.storeRoot, payload.activeRoot]) {
    if (!existsSync(path) || hashManagedDirectory(path) !== payload.digest) {
      throw new Error(`managed runtime payload drifted after preview: ${path}`);
    }
  }
}

async function executeAction(
  action: PlanAction,
  model: EnvironmentModel,
  options: ReturnType<typeof normalizedOptions>,
): Promise<{ readonly verified: boolean; readonly detail?: string }> {
  const operation = payloadString(action, "operation");
  if (operation === "verify-file") {
    const target = action.id === "omh-node" ? process.execPath : action.target;
    return {
      verified: sha256File(target) === payloadString(action, "contentDigest"),
    };
  }
  if (operation === "materialize-runtime-package") {
    materializeManagedRuntimePayload(model.managedPayload);
    return {
      verified:
        hashManagedDirectory(action.target)
        === payloadString(action, "contentDigest"),
    };
  }
  if (operation === "acquire-opencode-addon-snapshot") {
    const addon = model.runtimeAddons.find(
      (candidate): candidate is OpenCodeRuntimeAddonModel =>
        candidate.kind === "opencode-package",
    );
    if (
      addon === undefined
      || addon.fingerprint !== payloadString(action, "fingerprint")
      || action.target !== addon.snapshot.root
      || addon.snapshot.digest !== payloadString(action, "contentDigest")
      || addon.addon.registration.packageName
        !== payloadString(action, "packageName")
      || addon.addon.version !== payloadString(action, "version")
      || addon.addon.registration.snapshotArchivePath
        !== payloadString(action, "snapshotArchivePath")
      || addon.addon.registration.snapshotArchiveSha256
        !== payloadString(action, "snapshotArchiveSha256")
    ) {
      throw new Error("OpenCode OMO snapshot identity changed after preview");
    }
    if (!inspectOpenCodeAddonSnapshot(addon.addon, model.stateRoot)) {
      if (
        addon.sourceArchivePath === null
        || !inspectRuntimeAddonArchive(
          addon.sourceArchivePath,
          addon.addon.registration.snapshotArchiveSha256,
        )
      ) {
        throw new Error("OpenCode OMO source changed after preview");
      }
      await materializeOpenCodeAddonSnapshotFromArchive(
        addon.sourceArchivePath,
        addon.addon,
        model.stateRoot,
        join(
          options.repositoryRoot,
          "node_modules",
          addon.addon.registration.snapshotDependencyPackage ?? "",
        ),
      );
    }
    return {
      verified: inspectOpenCodeAddonSnapshot(addon.addon, model.stateRoot),
    };
  }
  if (operation === "acquire-codex-addon-snapshot") {
    const addon = model.runtimeAddons.find(
      (candidate): candidate is CodexRuntimeAddonModel =>
        candidate.kind === "codex-marketplace",
    );
    if (
      addon === undefined
      || addon.fingerprint !== payloadString(action, "fingerprint")
      || action.target !== addon.snapshot.root
      || addon.snapshot.digest !== payloadString(action, "contentDigest")
    ) {
      throw new Error("Codex OMO snapshot identity changed after preview");
    }
    if (!inspectCodexAddonSnapshot(addon.addon, model.stateRoot)) {
      if (
        addon.sourceArchivePath === null
        || addon.addon.registration.snapshotArchivePath
          !== payloadString(action, "snapshotArchivePath")
        || addon.addon.registration.snapshotArchiveSha256
          !== payloadString(action, "snapshotArchiveSha256")
      ) {
        throw new Error("Codex OMO source changed after preview");
      }
      await materializeCodexAddonSnapshotFromArchive(
        addon.sourceArchivePath,
        addon.addon,
        model.stateRoot,
      );
    }
    return {
      verified:
        inspectCodexAddonSnapshot(addon.addon, model.stateRoot)
        && hashManagedDirectory(action.target)
          === payloadString(action, "contentDigest"),
    };
  }
  if (operation === "acquire-claude-official-marketplace") {
    const snapshot = model.officialMarketplaceSnapshot;
    if (snapshot === null || action.target !== snapshot.root) {
      throw new Error(`${action.id}: Claude marketplace snapshot changed`);
    }
    const existing = inspectOfficialMarketplaceSnapshot(
      model.officialMarketplaceLock,
      model.stateRoot,
    );
    if (existing.state !== "ready") {
      const externalSource = action.payload?.externalSource;
      if (typeof externalSource === "string") {
        if (
          model.officialMarketplaceExternalSource === null
          || resolve(externalSource)
            !== resolve(model.officialMarketplaceExternalSource)
        ) {
          throw new Error(
            "external Claude marketplace source changed after preview",
          );
        }
        materializeOfficialMarketplaceSnapshotFromDirectory(
          snapshot,
          model.officialMarketplaceLock,
          externalSource,
        );
      } else {
        const plannedGit = payloadString(action, "gitPath");
        const currentGit = findTrustedExecutable("git", {
          cwd: options.cwd,
          env: options.env,
          platform: options.os,
        });
        if (
          currentGit === null
          || resolve(currentGit) !== resolve(plannedGit)
        ) {
          throw new Error("trusted Git changed after Claude marketplace preview");
        }
        materializeOfficialMarketplaceSnapshot(
          snapshot,
          model.officialMarketplaceLock,
          createOfficialMarketplaceGitOperations(
            currentGit,
            (command, args, env) =>
              runCommand(command, args, { ...options, env }),
            options.env,
          ),
        );
      }
    }
    return {
      verified:
        inspectOfficialMarketplaceSnapshot(
          model.officialMarketplaceLock,
          model.stateRoot,
        ).state === "ready",
    };
  }
  if (operation === "materialize-claude-official-adapter") {
    const snapshot = model.officialMarketplaceSnapshot;
    const adapter = model.officialMarketplaceAdapter;
    if (
      snapshot === null
      || adapter === null
      || action.target !== adapter.root
    ) {
      throw new Error(`${action.id}: Claude marketplace adapter changed`);
    }
    materializeOfficialMarketplaceRuntimeAdapter(
      adapter,
      snapshot,
      model.officialMarketplaceLock,
    );
    return {
      verified:
        inspectOfficialMarketplaceRuntimeAdapter(
          model.officialMarketplaceLock,
          model.stateRoot,
        ).state === "ready",
    };
  }
  if (operation === "acquire-agent") {
    await acquireAgent(action, model, options);
    return {
      verified: sha256File(action.target) === payloadString(action, "sourceDigest"),
    };
  }
  if (operation === "verify-agent") {
    const agentId = payloadString(action, "agentId");
    if (!isAgentId(agentId)) {
      throw new Error(`${action.id}: unknown caller-owned agent`);
    }
    const executable = runtimeExecutable(agentId, model, options);
    return {
      verified:
        sha256File(executable) === payloadString(action, "sourceDigest"),
    };
  }
  if (operation === "install-package") {
    installPackage(action, model, options);
    return {
      verified: sha256File(action.target) === payloadString(action, "contentDigest"),
    };
  }
  if (operation === "remove-owned") {
    if (!isPathStrictlyWithin(model.stateRoot, action.target)) {
      throw new Error(`${action.id}: clean target escapes the selected instance root`);
    }
    if (existsSync(action.target)) {
      const kind = payloadString(action, "ownershipKind");
      const exact = kind === "directory"
        ? hashManagedDirectory(action.target)
          === payloadString(action, "contentDigest")
        : sha256File(action.target) === payloadString(action, "contentDigest");
      if (!exact) throw new Error(`${action.id}: managed clean target drifted`);
      rmSync(action.target, {
        force: false,
        recursive: kind === "directory",
      });
    }
    return { verified: !existsSync(action.target) };
  }
  if (operation === "register-claude-official-marketplace") {
    const inspection = inspectOfficialMarketplaceRuntimeAdapter(
      model.officialMarketplaceLock,
      model.stateRoot,
    );
    const adapter = model.officialMarketplaceAdapter;
    if (
      inspection.state !== "ready"
      || adapter === null
      || adapter.name !== payloadString(action, "marketplaceName")
      || adapter.root !== payloadString(action, "marketplaceRoot")
    ) {
      throw new Error("verified Claude runtime marketplace became unavailable");
    }
    registerClaudeOfficialMarketplace(
      runtimeExecutable("claude-code", model, options),
      { name: adapter.name, root: adapter.root },
      (command, args) => runCommand(command, args, options),
    );
    atomicWriteFile(action.target, payloadString(action, "content"));
    return {
      verified: sha256File(action.target) === payloadString(action, "contentDigest"),
    };
  }
  if (operation === "register-claude-official") {
    const currentMarketplace = inspectOfficialMarketplaceRuntimeAdapter(
      model.officialMarketplaceLock,
      model.stateRoot,
    );
    if (currentMarketplace.state !== "ready") {
      throw new Error("verified Claude official marketplace became unavailable");
    }
    const plugin = currentMarketplace.plugins.find(
      ({ capabilityId, pathTree, selector }) =>
        capabilityId === payloadString(action, "capabilityId")
        && pathTree === payloadString(action, "pathTree")
        && selector === payloadString(action, "selector"),
    );
    if (plugin === undefined) {
      throw new Error(`${action.id}: official plugin identity changed after preview`);
    }
    registerClaudeOfficialPlugin(
      runtimeExecutable("claude-code", model, options),
      plugin,
      (command, args) => runCommand(command, args, options),
    );
    atomicWriteFile(action.target, payloadString(action, "content"));
    return {
      verified: sha256File(action.target) === payloadString(action, "contentDigest"),
    };
  }
  if (operation === "register-opencode-skill") {
    const capabilityId = payloadString(action, "capabilityId");
    const [registration] = planOpenCodeSkillRegistrations(
      model.managedPayload.activeRoot,
      [capabilityId],
      options.env,
      options.os,
    );
    if (
      registration === undefined
      || registration.target !== payloadString(action, "observedTarget")
      || registration.digest !== payloadString(action, "skillDigest")
    ) {
      throw new Error(`${action.id}: OpenCode skill identity changed after preview`);
    }
    registerOpenCodeSkills([registration]);
    atomicWriteFile(action.target, payloadString(action, "content"));
    return {
      verified:
        openCodeSkillsReady([registration])
        && sha256File(action.target) === payloadString(action, "contentDigest"),
    };
  }
  if (operation === "register-opencode-addon") {
    const addon = model.runtimeAddons.find(
      (candidate): candidate is OpenCodeRuntimeAddonModel =>
        candidate.kind === "opencode-package",
    );
    if (
      addon === undefined
      || addon.fingerprint !== payloadString(action, "fingerprint")
      || addon.addon.registration.packageName
        !== payloadString(action, "packageName")
      || addon.addon.registration.spec
        !== payloadString(action, "previousSpec")
      || addon.snapshot.spec !== payloadString(action, "spec")
      || !inspectOpenCodeAddonSnapshot(addon.addon, model.stateRoot)
    ) {
      throw new Error("OpenCode OMO registration changed after preview");
    }
    const registration = {
      packageName: addon.addon.registration.packageName,
      previousSpec: addon.addon.registration.spec,
      spec: addon.snapshot.spec,
    };
    registerOpenCodePackageAddon(
      registration,
      options.env,
      options.os,
    );
    if (
      !openCodePackageAddonResolved(
        runtimeExecutable("opencode", model, options),
        registration,
        options.env,
        options.os,
        (command, args) => runCommand(command, args, options),
      )
    ) {
      throw new Error("OpenCode did not resolve the exact OMO package");
    }
    atomicWriteFile(action.target, payloadString(action, "content"));
    return {
      verified:
        sha256File(action.target) === payloadString(action, "contentDigest"),
    };
  }
  if (operation === "register-codex-addon") {
    const addon = model.runtimeAddons.find(
      (candidate): candidate is CodexRuntimeAddonModel =>
        candidate.kind === "codex-marketplace",
    );
    if (
      addon === undefined
      || addon.fingerprint !== payloadString(action, "fingerprint")
      || addon.snapshot.root !== payloadString(action, "marketplaceRoot")
      || addon.addon.registration.selector !== payloadString(action, "selector")
      || !inspectCodexAddonSnapshot(addon.addon, model.stateRoot)
    ) {
      throw new Error("Codex OMO registration changed after preview");
    }
    const currentGit = findTrustedExecutable("git", {
      cwd: options.cwd,
      env: options.env,
      platform: options.os,
    });
    const gitOperations = currentGit === null
      ? null
      : createRuntimeAddonGitOperations(
          currentGit,
          (command, args, environment) =>
            runCommand(command, args, { ...options, env: environment }),
          options.env,
        );
    const executable = runtimeExecutable("codex", model, options);
    registerCodexMarketplaceAddon(
      executable,
      codexAddonNativeRegistration(addon),
      (root) =>
        gitOperations !== null
        && verifyCodexAddonGitMarketplace(
          root,
          addon.addon,
          gitOperations,
        ),
      (command, args) => runCommand(command, args, options),
    );
    atomicWriteFile(action.target, payloadString(action, "content"));
    return {
      verified:
        sha256File(action.target) === payloadString(action, "contentDigest"),
    };
  }
  if (operation === "register-runtime") {
    const rawId = payloadString(action, "runtimeId");
    if (!isAgentId(rawId)) throw new Error(`unsupported runtime action: ${rawId}`);
    const executable = runtimeExecutable(rawId, model, options);
    const registration = {
      activeRoot: model.managedPayload.activeRoot,
      ...(action.payload?.previousActiveRoot === undefined
        ? {}
        : {
            previousActiveRoot: payloadString(action, "previousActiveRoot"),
          }),
      receiptPath: model.receiptPath,
    };
    const previousPayloadDigest = action.payload?.previousPayloadDigest === undefined
      ? undefined
      : payloadString(action, "previousPayloadDigest");
    const nativeRun = (command: string, args: readonly string[]) =>
      runCommand(command, args, options);
    assertManagedPayloadExact(model.managedPayload);
    const expectedPrevious = previousManagedPayloadIdentity(model, rawId);
    if (
      (registration.previousActiveRoot === undefined)
        !== (previousPayloadDigest === undefined)
      || (registration.previousActiveRoot === undefined)
        !== (expectedPrevious === null)
      || (
        registration.previousActiveRoot !== undefined
        && previousPayloadDigest !== undefined
        && expectedPrevious !== null
        && (
          resolve(registration.previousActiveRoot)
              !== resolve(expectedPrevious.root)
          || previousPayloadDigest !== expectedPrevious.digest
        )
      )
    ) {
      throw new Error(`${rawId} prior managed payload identity changed`);
    }
    if (rawId === "claude-code") {
      registerClaudeRuntime(
        executable,
        claudeNativeRegistration(
          model.managedPayload.activeRoot,
          model.receiptPath,
          HARNESS_VERSION,
          registration.previousActiveRoot,
        ),
        nativeRun,
      );
    }
    else if (rawId === "codex") {
      registerCodexRuntime(executable, registration, nativeRun);
    } else {
      registerOpenCodeRuntime(registration, options.env, options.os);
    }
    assertManagedPayloadExact(model.managedPayload);
    atomicWriteFile(action.target, payloadString(action, "content"));
    return {
      verified: sha256File(action.target) === payloadString(action, "contentDigest"),
    };
  }
  throw new Error(`unsupported environment action: ${operation}`);
}

type EnvironmentRollbackSnapshot =
  | {
      readonly existed: false;
      readonly expectedKind: "directory" | "file";
      readonly target: string;
    }
  | {
      readonly backup: string;
      readonly digest: string;
      readonly existed: true;
      readonly kind: "directory" | "file";
      readonly target: string;
    };

type EnvironmentNativeRecovery =
  | {
      readonly executablePath: string;
      readonly kind: "claude-marketplace-absent";
      readonly marketplaceName: string;
      readonly marketplaceRoot: string;
    }
  | {
      readonly activeRoot: string;
      readonly executablePath: string;
      readonly kind: "claude-runtime-absent";
      readonly receiptPath: string;
    }
  | {
      readonly activeRoot: string;
      readonly executablePath: string;
      readonly kind: "claude-runtime-previous";
      readonly previousActiveRoot: string;
      readonly previousPayloadDigest: string;
      readonly receiptPath: string;
    }
  | {
      readonly capabilityId: string;
      readonly executablePath: string;
      readonly kind: "claude-plugin-absent";
      readonly selector: string;
    }
  | {
      readonly activeRoot: string;
      readonly executablePath: string;
      readonly kind: "codex-runtime-absent";
      readonly receiptPath: string;
    }
  | {
      readonly activeRoot: string;
      readonly executablePath: string;
      readonly kind: "codex-runtime-previous";
      readonly previousActiveRoot: string;
      readonly previousPayloadDigest: string;
      readonly receiptPath: string;
    }
  | {
      readonly activeRoot: string;
      readonly kind: "opencode-runtime-previous";
      readonly previousActiveRoot: string;
      readonly previousPayloadDigest: string;
      readonly receiptPath: string;
    }
  | {
      readonly executablePath: string;
      readonly kind: "codex-addon-both-absent";
      readonly marketplaceName: string;
      readonly selector: string;
    }
  | {
      readonly executablePath: string;
      readonly kind: "codex-addon-plugin-absent";
      readonly marketplaceName: string;
      readonly selector: string;
    };

interface EnvironmentRecoveryPayload {
  readonly backupRoot: string;
  readonly native: EnvironmentNativeRecovery | null;
  readonly operation: string;
  readonly schemaVersion: "2.0.0";
  readonly selection?: EnvironmentSelection;
  readonly snapshots: readonly EnvironmentRollbackSnapshot[];
}

function recoveryKeysMatch(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function recoverySelection(model: EnvironmentModel): EnvironmentSelection {
  const instance = model.desired.instance;
  return {
    ...(model.desired.capabilitySet === undefined
      ? {}
      : { capabilitySet: model.desired.capabilitySet }),
    clean: model.clean,
    profileId: model.profile.id,
    ...(model.desired.selectedCapabilities === undefined
      ? {}
      : { selectedCapabilities: model.desired.selectedCapabilities }),
    selectedAgents: model.selectedAgents,
    ...(model.desired.selectedPackages === undefined
      ? {}
      : { selectedPackages: model.desired.selectedPackages }),
    stateRoot: model.stateRoot,
    ...(instance === undefined ? {} : { target: instance.id }),
    ...(instance?.id === "wsl-ubuntu"
      ? { distribution: instance.distribution }
      : {}),
    ...(model.desired.toolRoutes === undefined
      ? {}
      : { toolRoutes: model.desired.toolRoutes }),
  };
}

function validatedRecoverySelection(
  value: unknown,
  actionId: string,
): EnvironmentSelection {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`invalid recovery selection: ${actionId}`);
  }
  const selection = value as Record<string, unknown>;
  const allowed = new Set([
    "capabilitySet",
    "clean",
    "distribution",
    "profileId",
    "selectedAgents",
    "selectedCapabilities",
    "selectedPackages",
    "stateRoot",
    "target",
    "toolRoutes",
  ]);
  if (
    Object.keys(selection).some((key) => !allowed.has(key))
    || typeof selection.profileId !== "string"
    || typeof selection.stateRoot !== "string"
    || !isAbsolute(selection.stateRoot)
    || typeof selection.clean !== "boolean"
    || !Array.isArray(selection.selectedAgents)
    || selection.selectedAgents.some((id) => typeof id !== "string")
    || (
      selection.selectedCapabilities !== undefined
      && (
        !Array.isArray(selection.selectedCapabilities)
        || selection.selectedCapabilities.some((id) => typeof id !== "string")
      )
    )
    || (
      selection.selectedPackages !== undefined
      && (
        !Array.isArray(selection.selectedPackages)
        || selection.selectedPackages.some((id) => typeof id !== "string")
      )
    )
    || (
      selection.capabilitySet !== undefined
      && (
        typeof selection.capabilitySet !== "string"
        || !isCapabilitySet(selection.capabilitySet)
      )
    )
    || (
      selection.target !== undefined
      && (
        typeof selection.target !== "string"
        || !isEnvironmentInstanceId(selection.target)
      )
    )
    || (
      selection.distribution !== undefined
      && selection.distribution !== "Ubuntu"
    )
    || (
      selection.toolRoutes !== undefined
      && !Array.isArray(selection.toolRoutes)
    )
  ) {
    throw new Error(`invalid recovery selection: ${actionId}`);
  }
  return structuredClone(value) as EnvironmentSelection;
}

function validatedNativeRecovery(
  value: unknown,
  actionId: string,
): EnvironmentNativeRecovery | null {
  if (value === null) return null;
  if (
    typeof value !== "object"
    || Array.isArray(value)
    || value === null
    || typeof (value as Record<string, unknown>).kind !== "string"
  ) {
    throw new Error(`invalid native recovery record: ${actionId}`);
  }
  const native = value as Record<string, unknown>;
  const kind = native.kind;
  const keySets: Readonly<Record<string, readonly string[]>> = {
    "claude-marketplace-absent": [
      "executablePath",
      "kind",
      "marketplaceName",
      "marketplaceRoot",
    ],
    "claude-plugin-absent": [
      "capabilityId",
      "executablePath",
      "kind",
      "selector",
    ],
    "claude-runtime-absent": [
      "activeRoot",
      "executablePath",
      "kind",
      "receiptPath",
    ],
    "claude-runtime-previous": [
      "activeRoot",
      "executablePath",
      "kind",
      "previousActiveRoot",
      "previousPayloadDigest",
      "receiptPath",
    ],
    "codex-runtime-absent": [
      "activeRoot",
      "executablePath",
      "kind",
      "receiptPath",
    ],
    "codex-runtime-previous": [
      "activeRoot",
      "executablePath",
      "kind",
      "previousActiveRoot",
      "previousPayloadDigest",
      "receiptPath",
    ],
    "opencode-runtime-previous": [
      "activeRoot",
      "kind",
      "previousActiveRoot",
      "previousPayloadDigest",
      "receiptPath",
    ],
    "codex-addon-both-absent": [
      "executablePath",
      "kind",
      "marketplaceName",
      "selector",
    ],
    "codex-addon-plugin-absent": [
      "executablePath",
      "kind",
      "marketplaceName",
      "selector",
    ],
  };
  const expectedKeys = keySets[String(kind)];
  if (
    expectedKeys === undefined
    || !recoveryKeysMatch(native, expectedKeys)
    || expectedKeys.some(
      (key) =>
        key !== "kind"
        && (
          typeof native[key] !== "string"
          || String(native[key]).length === 0
        ),
    )
    || expectedKeys.some(
      (key) =>
        [
          "activeRoot",
          "executablePath",
          "marketplaceRoot",
          "previousActiveRoot",
          "receiptPath",
        ].includes(key)
        && !isAbsolute(String(native[key])),
    )
    || (
      native.previousPayloadDigest !== undefined
      && !/^[0-9a-f]{64}$/u.test(String(native.previousPayloadDigest))
    )
  ) {
    throw new Error(`invalid native recovery record: ${actionId}`);
  }
  return native as unknown as EnvironmentNativeRecovery;
}

function snapshotDigest(
  target: string,
  kind: "directory" | "file",
): string {
  return kind === "directory"
    ? hashManagedDirectory(target)
    : sha256File(target);
}

function recoveryPayload(
  recovery: ApplyRecoveryRecord,
): EnvironmentRecoveryPayload {
  const value = recovery.payload;
  if (
    recovery.kind !== "environment-action-v1"
    || !(
      recoveryKeysMatch(
        value as Record<string, unknown>,
        ["backupRoot", "native", "operation", "schemaVersion", "snapshots"],
      )
      || recoveryKeysMatch(
        value as Record<string, unknown>,
        [
          "backupRoot",
          "native",
          "operation",
          "schemaVersion",
          "selection",
          "snapshots",
        ],
      )
    )
    || value.schemaVersion !== "2.0.0"
    || typeof value.backupRoot !== "string"
    || !isAbsolute(value.backupRoot)
    || typeof value.operation !== "string"
    || ![
      "acquire-agent",
      "acquire-codex-addon-snapshot",
      "acquire-claude-official-marketplace",
      "install-package",
      "materialize-claude-official-adapter",
      "materialize-runtime-package",
      "register-claude-official",
      "register-claude-official-marketplace",
      "register-codex-addon",
      "register-opencode-addon",
      "register-opencode-skill",
      "register-runtime",
      "remove-owned",
      "verify-opencode-addon-source",
      "acquire-opencode-addon-snapshot",
    ].includes(value.operation)
    || !Array.isArray(value.snapshots)
    || value.snapshots.length < 1
    || value.snapshots.length > 2
  ) {
    throw new Error(`invalid environment recovery record: ${recovery.actionId}`);
  }
  const native = validatedNativeRecovery(value.native, recovery.actionId);
  const selection = value.selection === undefined
    ? undefined
    : validatedRecoverySelection(value.selection, recovery.actionId);
  if (native !== null) {
    const expectedOperation =
      native.kind === "claude-marketplace-absent"
        ? "register-claude-official-marketplace"
        : native.kind === "claude-plugin-absent"
          ? "register-claude-official"
          : native.kind === "codex-addon-both-absent"
              || native.kind === "codex-addon-plugin-absent"
            ? "register-codex-addon"
            : "register-runtime";
    if (value.operation !== expectedOperation) {
      throw new Error(`native recovery operation changed: ${recovery.actionId}`);
    }
  }
  const snapshots = value.snapshots as readonly unknown[];
  for (const value of snapshots) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`invalid recovery snapshot: ${recovery.actionId}`);
    }
    const snapshot = value as Record<string, unknown>;
    if (
      !recoveryKeysMatch(
        snapshot,
        snapshot.existed === true
          ? ["backup", "digest", "existed", "kind", "target"]
          : ["existed", "expectedKind", "target"],
      )
      || typeof snapshot.target !== "string"
      || !isAbsolute(snapshot.target)
      || typeof snapshot.existed !== "boolean"
      || (
        snapshot.existed
        && (
          typeof snapshot.backup !== "string"
          || !isAbsolute(snapshot.backup)
          || typeof snapshot.digest !== "string"
          || !/^[0-9a-f]{64}$/u.test(snapshot.digest)
          || !["directory", "file"].includes(String(snapshot.kind))
        )
      )
      || (
        !snapshot.existed
        && !["directory", "file"].includes(String(snapshot.expectedKind))
      )
    ) {
      throw new Error(`invalid recovery snapshot: ${recovery.actionId}`);
    }
  }
  if (
    new Set(
      snapshots.map((snapshot) =>
        resolve(String((snapshot as Record<string, unknown>).target))
      ),
    ).size !== snapshots.length
  ) {
    throw new Error(`duplicate recovery snapshot: ${recovery.actionId}`);
  }
  return {
    backupRoot: value.backupRoot,
    native,
    operation: value.operation,
    schemaVersion: "2.0.0",
    ...(selection === undefined ? {} : { selection }),
    snapshots: snapshots as readonly EnvironmentRollbackSnapshot[],
  };
}

function recoveryTargetAllowed(
  target: string,
  model: EnvironmentModel,
  options: ReturnType<typeof normalizedOptions>,
): boolean {
  const resolvedTarget = resolve(target);
  if (
    resolvedTarget === resolve(model.stateRoot)
    || isPathStrictlyWithin(model.stateRoot, resolvedTarget)
  ) {
    return true;
  }
  const allowed = new Set(
    model.openCodeSkills.map(({ target: path }) => resolve(path)),
  );
  allowed.add(resolve(openCodeConfigPath(options.env, options.os)));
  for (const ownership of model.currentReceipt?.ownership ?? []) {
    if (ownership.scope === "managed") {
      allowed.add(resolve(ownership.target));
    }
  }
  return allowed.has(resolvedTarget);
}

function validateRecoverySnapshots(
  payload: EnvironmentRecoveryPayload,
  model: EnvironmentModel,
  options: ReturnType<typeof normalizedOptions>,
): { readonly backupRoot: string; readonly backupsExist: boolean } {
  const rollbackRoot = join(model.stateRoot, "journal", "rollback");
  const backupRoot = assertSafeManagedRootPath(
    payload.backupRoot,
    "rollback backup root",
  );
  if (!isPathStrictlyWithin(rollbackRoot, backupRoot)) {
    throw new Error("rollback backup root escapes managed state");
  }
  for (const snapshot of payload.snapshots) {
    if (!recoveryTargetAllowed(snapshot.target, model, options)) {
      throw new Error(`rollback target is outside the allowed roots: ${snapshot.target}`);
    }
  }
  if (!existsSync(backupRoot)) {
    return { backupRoot, backupsExist: false };
  }
  const rootStat = lstatSync(backupRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("rollback backup root is not a real directory");
  }
  for (const snapshot of payload.snapshots) {
    if (!snapshot.existed) continue;
    if (!isPathStrictlyWithin(backupRoot, snapshot.backup)) {
      throw new Error(`rollback backup escapes its action root: ${snapshot.backup}`);
    }
    const stat = lstatSync(snapshot.backup);
    if (
      stat.isSymbolicLink()
      || (snapshot.kind === "directory") !== stat.isDirectory()
      || snapshotDigest(snapshot.backup, snapshot.kind) !== snapshot.digest
    ) {
      throw new Error(`rollback backup identity changed: ${snapshot.backup}`);
    }
  }
  return { backupRoot, backupsExist: true };
}

function assertRecoveryAlreadyRestored(
  payload: EnvironmentRecoveryPayload,
): void {
  for (const snapshot of payload.snapshots) {
    if (!snapshot.existed) {
      if (existsSync(snapshot.target)) {
        throw new Error(
          `rollback backup is missing before target removal: ${snapshot.target}`,
        );
      }
      continue;
    }
    if (!existsSync(snapshot.target)) {
      throw new Error(
        `rollback backup and original target are both missing: ${snapshot.target}`,
      );
    }
    const stat = lstatSync(snapshot.target);
    if (
      stat.isSymbolicLink()
      || (snapshot.kind === "directory") !== stat.isDirectory()
      || snapshotDigest(snapshot.target, snapshot.kind) !== snapshot.digest
    ) {
      throw new Error(
        `rollback backup is missing and target is not restored: ${snapshot.target}`,
      );
    }
  }
}

function rollbackNativeRegistration(
  native: EnvironmentNativeRecovery | null,
  model: EnvironmentModel,
  options: ReturnType<typeof normalizedOptions>,
): void {
  if (native === null) return;
  if (native.kind === "opencode-runtime-previous") {
    if (
      resolve(native.activeRoot) !== resolve(model.managedPayload.activeRoot)
      || resolve(native.receiptPath) !== resolve(model.receiptPath)
    ) {
      throw new Error("OpenCode runtime recovery identity changed");
    }
    const expectedPrevious = previousManagedPayloadIdentity(model, "opencode");
    if (
      expectedPrevious === null
      || resolve(expectedPrevious.root) !== resolve(native.previousActiveRoot)
    ) {
      throw new Error("OpenCode prior runtime recovery identity changed");
    }
    if (native.previousPayloadDigest !== expectedPrevious.digest) {
      throw new Error("OpenCode prior runtime recovery digest changed");
    }
    return;
  }
  if (
    native.kind === "codex-addon-both-absent"
    || native.kind === "codex-addon-plugin-absent"
  ) {
    const addon = model.runtimeAddons.find(
      (candidate): candidate is CodexRuntimeAddonModel =>
        candidate.kind === "codex-marketplace",
    );
    if (
      addon === undefined
      || native.marketplaceName !== addon.addon.registration.marketplaceName
      || native.selector !== addon.addon.registration.selector
    ) {
      throw new Error("Codex OMO recovery identity changed");
    }
    const executable = runtimeExecutable("codex", model, options);
    if (resolve(executable) !== resolve(native.executablePath)) {
      throw new Error("Codex OMO recovery executable changed");
    }
    const gitPath = findTrustedExecutable("git", {
      cwd: options.cwd,
      env: options.env,
      platform: options.os,
    });
    const gitOperations = gitPath === null
      ? null
      : createRuntimeAddonGitOperations(
          gitPath,
          (command, args, environment) =>
            runCommand(command, args, { ...options, env: environment }),
          options.env,
        );
    const nativeRun = (command: string, args: readonly string[]) =>
      runCommand(command, args, options);
    const state = inspectCodexMarketplaceAddon(
      executable,
      codexAddonNativeRegistration(addon),
      (root) =>
        gitOperations !== null
        && verifyCodexAddonGitMarketplace(
          root,
          addon.addon,
          gitOperations,
        ),
      nativeRun,
    );
    if (state.marketplace === "collision" || state.plugin === "collision") {
      throw new Error("Codex OMO recovery encountered a collision");
    }
    if (state.plugin === "ready") {
      nativeRun(executable, [
        "plugin",
        "remove",
        native.selector,
        "--json",
      ]);
    }
    if (
      native.kind === "codex-addon-both-absent"
      && state.marketplace === "ready"
    ) {
      nativeRun(executable, [
        "plugin",
        "marketplace",
        "remove",
        native.marketplaceName,
        "--json",
      ]);
    }
    return;
  }
  if (
    native.kind === "codex-runtime-absent"
    || native.kind === "codex-runtime-previous"
  ) {
    const executable = runtimeExecutable("codex", model, options);
    if (resolve(executable) !== resolve(native.executablePath)) {
      throw new Error("Codex recovery executable changed");
    }
    const nativeRun = (command: string, args: readonly string[]) =>
      runCommand(command, args, options);
    if (
      resolve(native.activeRoot) !== resolve(model.managedPayload.activeRoot)
      || resolve(native.receiptPath) !== resolve(model.receiptPath)
    ) {
      throw new Error("Codex runtime recovery identity changed");
    }
    if (native.kind === "codex-runtime-previous") {
      const expectedPrevious = previousManagedPayloadIdentity(model, "codex");
      if (
        expectedPrevious === null
        || resolve(expectedPrevious.root) !== resolve(native.previousActiveRoot)
      ) {
        throw new Error("Codex prior runtime recovery identity changed");
      }
      if (native.previousPayloadDigest !== expectedPrevious.digest) {
        throw new Error("Codex prior runtime recovery digest changed");
      }
      registerCodexRuntime(
        executable,
        {
          activeRoot: native.previousActiveRoot,
          previousActiveRoot: native.activeRoot,
          receiptPath: native.receiptPath,
        },
        nativeRun,
      );
      return;
    }
    const state = inspectCodexManagedRuntimeRegistration(
      executable,
      {
        activeRoot: native.activeRoot,
        receiptPath: native.receiptPath,
      },
      nativeRun,
    );
    if (state.marketplace === "collision" || state.plugin === "collision") {
      throw new Error("Codex runtime recovery encountered a collision");
    }
    if (state.plugin === "ready") {
      nativeRun(executable, [
        "plugin",
        "remove",
        "oh-my-harness@oh-my-harness",
        "--json",
      ]);
    }
    if (state.marketplace === "ready") {
      nativeRun(executable, [
        "plugin",
        "marketplace",
        "remove",
        "oh-my-harness",
        "--json",
      ]);
    }
    return;
  }
  const executable = runtimeExecutable("claude-code", model, options);
  if (resolve(executable) !== resolve(native.executablePath)) {
    throw new Error("Claude recovery executable changed");
  }
  const nativeRun = (command: string, args: readonly string[]) =>
    runCommand(command, args, options);
  if (native.kind === "claude-marketplace-absent") {
    const adapter = model.officialMarketplaceAdapter;
    if (
      adapter === null
      || adapter.name !== native.marketplaceName
      || resolve(adapter.root) !== resolve(native.marketplaceRoot)
    ) {
      throw new Error("Claude marketplace recovery identity changed");
    }
    const state = inspectClaudeOfficialMarketplaceRegistration(
      executable,
      { name: native.marketplaceName, root: native.marketplaceRoot },
      nativeRun,
    );
    if (state === "collision") {
      throw new Error("Claude marketplace recovery encountered a collision");
    }
    if (state === "ready") {
      nativeRun(executable, [
        "plugin",
        "marketplace",
        "remove",
        native.marketplaceName,
      ]);
    }
    return;
  }
  if (native.kind === "claude-plugin-absent") {
    const plugin = model.officialMarketplace.state === "ready"
      ? model.officialMarketplace.plugins.find(
          ({ capabilityId, selector }) =>
            capabilityId === native.capabilityId
            && selector === native.selector,
        )
      : undefined;
    if (plugin === undefined) {
      throw new Error("Claude plugin recovery identity changed");
    }
    const state = inspectClaudeOfficialPluginRegistration(
      executable,
      plugin,
      nativeRun,
    );
    if (state === "collision") {
      throw new Error("Claude plugin recovery encountered a collision");
    }
    if (state === "ready") {
      nativeRun(executable, [
        "plugin",
        "uninstall",
        native.selector,
        "--scope",
        "user",
      ]);
    }
    return;
  }
  if (
    resolve(native.activeRoot) !== resolve(model.managedPayload.activeRoot)
    || resolve(native.receiptPath) !== resolve(model.receiptPath)
  ) {
    throw new Error("Claude runtime recovery identity changed");
  }
  if (native.kind === "claude-runtime-previous") {
    const expectedPrevious = previousManagedPayloadIdentity(
      model,
      "claude-code",
    );
    if (
      expectedPrevious === null
      || resolve(expectedPrevious.root) !== resolve(native.previousActiveRoot)
    ) {
      throw new Error("Claude prior runtime recovery identity changed");
    }
    if (native.previousPayloadDigest !== expectedPrevious.digest) {
      throw new Error("Claude prior runtime recovery digest changed");
    }
    if (
      claudeRegistrationReady(
        executable,
        claudeNativeRegistration(
          native.previousActiveRoot,
          native.receiptPath,
          claudeManagedPluginVersion(native.previousActiveRoot),
        ),
        [],
        nativeRun,
      )
    ) {
      return;
    }
    registerClaudeRuntime(
      executable,
      {
        ...claudeNativeRegistration(
          native.previousActiveRoot,
          native.receiptPath,
          claudeManagedPluginVersion(native.previousActiveRoot),
          native.activeRoot,
        ),
      },
      nativeRun,
    );
    return;
  }
  const state = inspectClaudeManagedRuntimeRegistration(
    executable,
    claudeNativeRegistration(
      native.activeRoot,
      native.receiptPath,
      HARNESS_VERSION,
    ),
    nativeRun,
  );
  if (state.plugin === "collision" || state.marketplace === "collision") {
    throw new Error("Claude runtime recovery encountered a collision");
  }
  if (state.plugin === "ready") {
    nativeRun(executable, [
      "plugin",
      "uninstall",
      "oh-my-harness@oh-my-harness",
      "--scope",
      "user",
    ]);
  }
  if (state.marketplace === "ready") {
    nativeRun(executable, [
      "plugin",
      "marketplace",
      "remove",
      "oh-my-harness",
    ]);
  }
}

function recoverEnvironmentAction(
  recovery: ApplyRecoveryRecord,
  model: EnvironmentModel,
  options: ReturnType<typeof normalizedOptions>,
): void {
  const payload = recoveryPayload(recovery);
  const validation = validateRecoverySnapshots(payload, model, options);
  if (!validation.backupsExist) {
    assertRecoveryAlreadyRestored(payload);
    return;
  }
  if (payload.native?.kind === "opencode-runtime-previous") {
    rollbackNativeRegistration(payload.native, model, options);
  }
  const failures: unknown[] = [];
  try {
    if (payload.native?.kind !== "opencode-runtime-previous") {
      rollbackNativeRegistration(payload.native, model, options);
    }
  } catch (error) {
    failures.push(error);
  }
  try {
    for (const snapshot of [...payload.snapshots].reverse()) {
      if (existsSync(snapshot.target)) {
        const current = lstatSync(snapshot.target);
        const expectedDirectory = snapshot.existed
          ? snapshot.kind === "directory"
          : snapshot.expectedKind === "directory";
        if (
          current.isSymbolicLink()
          || current.isDirectory() !== expectedDirectory
        ) {
          throw new Error(`rollback target type changed: ${snapshot.target}`);
        }
        rmSync(snapshot.target, {
          force: true,
          recursive: current.isDirectory(),
        });
      }
      if (snapshot.existed) {
        cpSync(snapshot.backup, snapshot.target, {
          errorOnExist: true,
          force: false,
          preserveTimestamps: true,
          recursive: snapshot.kind === "directory",
        });
      }
    }
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0) {
    throw new Error(
      failures.map((error) =>
        error instanceof Error ? error.message : String(error)
      ).join("; "),
    );
  }
  rmSync(validation.backupRoot, { force: true, recursive: true });
}

function commitEnvironmentRecovery(
  recovery: ApplyRecoveryRecord,
  model: EnvironmentModel,
  options: ReturnType<typeof normalizedOptions>,
): void {
  const payload = recoveryPayload(recovery);
  const validation = validateRecoverySnapshots(payload, model, options);
  if (!validation.backupsExist) return;
  rmSync(validation.backupRoot, { force: true, recursive: true });
}

function prepareActionRollback(
  action: PlanAction,
  model: EnvironmentModel,
  options: ReturnType<typeof normalizedOptions>,
): {
  readonly commit: () => Promise<void>;
  readonly recovery: ApplyRecoveryRecord;
  readonly rollback: () => Promise<void>;
} | undefined {
  const operation = payloadString(action, "operation");
  if (["verify-file", "verify-agent"].includes(operation)) return undefined;
  let native: EnvironmentNativeRecovery | null = null;
  if (operation === "register-codex-addon") {
    const addon = model.runtimeAddons.find(
      (candidate): candidate is CodexRuntimeAddonModel =>
        candidate.kind === "codex-marketplace",
    );
    if (addon === undefined) {
      throw new Error("Codex OMO recovery model is unavailable");
    }
    const executable = runtimeExecutable("codex", model, options);
    const gitPath = findTrustedExecutable("git", {
      cwd: options.cwd,
      env: options.env,
      platform: options.os,
    });
    const gitOperations = gitPath === null
      ? null
      : createRuntimeAddonGitOperations(
          gitPath,
          (command, args, environment) =>
            runCommand(command, args, { ...options, env: environment }),
          options.env,
        );
    const state = inspectCodexMarketplaceAddon(
      executable,
      codexAddonNativeRegistration(addon),
      (root) =>
        gitOperations !== null
        && verifyCodexAddonGitMarketplace(
          root,
          addon.addon,
          gitOperations,
        ),
      (command, args) => runCommand(command, args, options),
    );
    if (state.marketplace === "collision" || state.plugin === "collision") {
      throw new Error(
        `${addon.addon.registration.selector} collides with an existing Codex registration`,
      );
    }
    if (state.marketplace === "missing" && state.plugin === "ready") {
      throw new Error(
        `${addon.addon.registration.selector} exists without its exact marketplace`,
      );
    }
    if (state.marketplace === "missing") {
      native = {
        executablePath: executable,
        kind: "codex-addon-both-absent",
        marketplaceName: addon.addon.registration.marketplaceName,
        selector: addon.addon.registration.selector,
      };
    } else if (state.plugin === "missing") {
      native = {
        executablePath: executable,
        kind: "codex-addon-plugin-absent",
        marketplaceName: addon.addon.registration.marketplaceName,
        selector: addon.addon.registration.selector,
      };
    }
  } else if (operation === "register-claude-official-marketplace") {
    const adapter = model.officialMarketplaceAdapter;
    if (adapter === null) {
      throw new Error("Claude official marketplace adapter is unavailable");
    }
    const executable = runtimeExecutable("claude-code", model, options);
    const nativeRun = (command: string, args: readonly string[]) =>
      runCommand(command, args, options);
    const state = inspectClaudeOfficialMarketplaceRegistration(
      executable,
      { name: adapter.name, root: adapter.root },
      nativeRun,
    );
    if (state === "collision") {
      throw new Error(
        `Claude marketplace ${adapter.name} points to another source`,
      );
    }
    if (state === "missing") {
      native = {
        executablePath: executable,
        kind: "claude-marketplace-absent",
        marketplaceName: adapter.name,
        marketplaceRoot: adapter.root,
      };
    }
  } else if (
    operation === "register-runtime"
    && action.payload?.runtimeId === "claude-code"
  ) {
    const executable = runtimeExecutable("claude-code", model, options);
    const previousActiveRoot = typeof action.payload.previousActiveRoot === "string"
      ? payloadString(action, "previousActiveRoot")
      : null;
    if (previousActiveRoot !== null) {
      const previousPayloadDigest = payloadString(
        action,
        "previousPayloadDigest",
      );
      const nativeRun = (command: string, args: readonly string[]) =>
        runCommand(command, args, options);
      const state = inspectClaudeManagedRuntimeRegistration(
        executable,
        claudeNativeRegistration(
          previousActiveRoot,
          model.receiptPath,
          claudeManagedPluginVersion(previousActiveRoot),
        ),
        nativeRun,
      );
      if (
        managedRuntimeRegistrationDisposition(state) !== "ready"
      ) {
        throw new Error(
          "Claude managed registration no longer matches the prior receipt",
        );
      }
      native = {
        activeRoot: model.managedPayload.activeRoot,
        executablePath: executable,
        kind: "claude-runtime-previous",
        previousActiveRoot,
        previousPayloadDigest,
        receiptPath: model.receiptPath,
      };
    } else {
      const nativeRun = (command: string, args: readonly string[]) =>
        runCommand(command, args, options);
      const state = inspectClaudeManagedRuntimeRegistration(
        executable,
        claudeNativeRegistration(
          model.managedPayload.activeRoot,
          model.receiptPath,
          HARNESS_VERSION,
        ),
        nativeRun,
      );
      const disposition = managedRuntimeRegistrationDisposition(state);
      if (state.marketplace === "collision") {
        throw new Error(
          "Claude marketplace oh-my-harness points to another source",
        );
      }
      if (state.plugin === "collision") {
        throw new Error(
          "oh-my-harness@oh-my-harness collides with an existing user-owned Claude plugin",
        );
      }
      if (disposition === "collision") {
        throw new Error(
          "Claude managed runtime registration is partial and cannot be adopted",
        );
      }
      if (disposition === "missing") {
        native = {
          activeRoot: model.managedPayload.activeRoot,
          executablePath: executable,
          kind: "claude-runtime-absent",
          receiptPath: model.receiptPath,
        };
      }
    }
  } else if (
    operation === "register-runtime"
    && action.payload?.runtimeId === "codex"
  ) {
    const executable = runtimeExecutable("codex", model, options);
    const nativeRun = (command: string, args: readonly string[]) =>
      runCommand(command, args, options);
    const previousActiveRoot = typeof action.payload.previousActiveRoot === "string"
      ? payloadString(action, "previousActiveRoot")
      : null;
    if (previousActiveRoot !== null) {
      const previousPayloadDigest = payloadString(
        action,
        "previousPayloadDigest",
      );
      const state = inspectCodexManagedRuntimeRegistration(
        executable,
        {
          activeRoot: previousActiveRoot,
          receiptPath: model.receiptPath,
        },
        nativeRun,
      );
      if (managedRuntimeRegistrationDisposition(state) !== "ready") {
        throw new Error(
          "Codex managed registration no longer matches the prior receipt",
        );
      }
      native = {
        activeRoot: model.managedPayload.activeRoot,
        executablePath: executable,
        kind: "codex-runtime-previous",
        previousActiveRoot,
        previousPayloadDigest,
        receiptPath: model.receiptPath,
      };
    } else {
      const state = inspectCodexManagedRuntimeRegistration(
        executable,
        {
          activeRoot: model.managedPayload.activeRoot,
          receiptPath: model.receiptPath,
        },
        nativeRun,
      );
      const disposition = managedRuntimeRegistrationDisposition(state);
      if (state.marketplace === "collision") {
        throw new Error(
          "Codex marketplace oh-my-harness points to another root",
        );
      }
      if (state.plugin === "collision") {
        throw new Error(
          "oh-my-harness@oh-my-harness collides with an existing Codex plugin registration",
        );
      }
      if (disposition === "collision") {
        throw new Error(
          "Codex managed runtime registration is partial and cannot be adopted",
        );
      }
      if (disposition === "missing") {
        native = {
          activeRoot: model.managedPayload.activeRoot,
          executablePath: executable,
          kind: "codex-runtime-absent",
          receiptPath: model.receiptPath,
        };
      }
    }
  } else if (
    operation === "register-runtime"
    && action.payload?.runtimeId === "opencode"
  ) {
    const previousActiveRoot = typeof action.payload.previousActiveRoot === "string"
      ? payloadString(action, "previousActiveRoot")
      : null;
    if (previousActiveRoot !== null) {
      const previousPayloadDigest = payloadString(
        action,
        "previousPayloadDigest",
      );
      const state = inspectOpenCodeManagedRuntimeRegistration(
        {
          activeRoot: model.managedPayload.activeRoot,
          previousActiveRoot,
        },
        options.env,
        options.os,
      );
      if (state !== "previous") {
        throw new Error(
          "OpenCode managed registration no longer matches the prior receipt",
        );
      }
      native = {
        activeRoot: model.managedPayload.activeRoot,
        kind: "opencode-runtime-previous",
        previousActiveRoot,
        previousPayloadDigest,
        receiptPath: model.receiptPath,
      };
    }
  } else if (operation === "register-claude-official") {
    const plugin = model.officialMarketplace.state === "ready"
      ? model.officialMarketplace.plugins.find(
          ({ capabilityId, selector }) =>
            capabilityId === payloadString(action, "capabilityId")
            && selector === payloadString(action, "selector"),
        )
      : undefined;
    if (plugin === undefined) {
      throw new Error(`${action.id}: official plugin identity is unavailable`);
    }
    const executable = runtimeExecutable("claude-code", model, options);
    const nativeRun = (command: string, args: readonly string[]) =>
      runCommand(command, args, options);
    const state = inspectClaudeOfficialPluginRegistration(
      executable,
      plugin,
      nativeRun,
    );
    if (state === "collision") {
      throw new Error(
        `${plugin.selector} collides with an existing user-owned Claude plugin`,
      );
    }
    if (state === "missing") {
      native = {
        capabilityId: plugin.capabilityId,
        executablePath: executable,
        kind: "claude-plugin-absent",
        selector: plugin.selector,
      };
    }
  }
  const targets = [action.target];
  const observedTarget = action.payload?.observedTarget;
  if (
    typeof observedTarget === "string"
    && !targets.some((target) => resolve(target) === resolve(observedTarget))
  ) {
    targets.push(observedTarget);
  }
  const backupRoot = assertSafeManagedRootPath(
    join(
      model.stateRoot,
      "journal",
      "rollback",
      `${action.id.replaceAll(":", "-")}-${randomBytes(8).toString("hex")}`,
    ),
    "rollback backup root",
  );
  mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
  let snapshots: EnvironmentRollbackSnapshot[];
  try {
    snapshots = targets.map((target, index) => {
      if (!existsSync(target)) {
        const isObservedTarget =
          typeof observedTarget === "string"
          && resolve(target) === resolve(observedTarget);
        return {
          existed: false as const,
          expectedKind:
              (
                isObservedTarget
                && action.payload?.observedTargetKind === "directory"
              )
              || action.payload?.ownershipKind === "directory"
            ? "directory" as const
            : "file" as const,
          target,
        };
      }
      const stat = lstatSync(target);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
        throw new Error(`rollback target is not a regular file or directory: ${target}`);
      }
      const kind = stat.isDirectory() ? "directory" as const : "file" as const;
      const backup = join(backupRoot, String(index));
      cpSync(target, backup, {
        errorOnExist: true,
        force: false,
        preserveTimestamps: true,
        recursive: stat.isDirectory(),
      });
      return {
        backup,
        digest: snapshotDigest(backup, kind),
        existed: true as const,
        kind,
        target,
      };
    });
  } catch (error) {
    rmSync(backupRoot, { force: true, recursive: true });
    throw error;
  }
  const recovery: ApplyRecoveryRecord = {
    actionId: action.id,
    kind: "environment-action-v1",
    payload: {
      backupRoot,
      native,
      operation,
      schemaVersion: "2.0.0",
      selection: recoverySelection(model),
      snapshots,
    },
  };
  return {
    commit: async () => {
      commitEnvironmentRecovery(recovery, model, options);
    },
    recovery,
    rollback: async () => {
      recoverEnvironmentAction(recovery, model, options);
    },
  };
}

function completedActionReady(action: PlanAction): boolean {
  if (action.payload?.operation === "remove-owned") {
    return !existsSync(action.target);
  }
  if (
    action.payload?.operation === "register-runtime"
    || action.payload?.operation === "register-claude-official-marketplace"
    || action.payload?.operation === "register-claude-official"
    || action.payload?.operation === "register-opencode-skill"
    || action.payload?.operation === "register-opencode-addon"
    || action.payload?.operation === "register-codex-addon"
  ) {
    return false;
  }
  const expected = action.payload?.contentDigest ?? action.payload?.sourceDigest;
  if (typeof expected !== "string" || !existsSync(action.target)) return false;
  return action.payload?.ownershipKind === "directory"
    ? hashManagedDirectory(action.target) === expected
    : sha256File(action.target) === expected;
}

function environmentApplyDependencies(
  model: EnvironmentModel,
  normalized: ReturnType<typeof normalizedOptions>,
  state: FileStateStore,
): ApplyDependencies {
  return {
    state,
    commitRecovery: async (recovery) =>
      commitEnvironmentRecovery(recovery, model, normalized),
    observe: async (action) =>
      action.id === "omh-node"
        ? observeRegularFile(process.execPath)
        : actionPreimage(action),
    prepare: async (action) => prepareActionRollback(
      action,
      model,
      normalized,
    ),
    recover: async (recovery) =>
      recoverEnvironmentAction(recovery, model, normalized),
    receiptTarget(action) {
      if (action.id === "omh-node") return process.execPath;
      if (
        model.profile.compositionOnly === true
        && action.id.startsWith("agent:")
        && action.payload?.ownershipScope === "external"
      ) {
        const agentId = action.payload.agentId;
        if (typeof agentId !== "string") return undefined;
        return model.agents.find(({ id }) => id === agentId)?.executablePath
          ?? undefined;
      }
      return undefined;
    },
    execute: async (action) => executeAction(action, model, normalized),
    verifyCompleted: async (action) => completedActionReady(action),
    ...(normalized.now === undefined ? {} : { now: normalized.now }),
  };
}

export async function applyEnvironment(
  selection: EnvironmentSelection,
  expectedDigest: string,
  options: EnvironmentOrchestratorOptions,
): Promise<{
  readonly preview: EnvironmentPreview;
  readonly result: ApplyResult;
}> {
  const normalized = normalizedOptions(options);
  let current = buildEnvironmentPreview(selection, normalized);
  let state: FileStateStore | null = null;
  const journalPath = join(current.model.stateRoot, "journal", "apply.json");
  if (existsSync(journalPath)) {
    state = new FileStateStore(current.model.stateRoot, {
      validateReceipt(value) {
        validateContractDocument(
          "managed-state-receipt",
          value,
          normalized.repositoryRoot,
        );
        return value as ManagedStateReceipt;
      },
    });
    const journal = await state.readJournal();
    const recoverySelections = (journal?.pendingRecoveries ?? []).map(
      (recovery) => recoveryPayload(recovery).selection,
    );
    if (
      recoverySelections.some(
        (candidate) =>
          stableJson(candidate ?? null)
          !== stableJson(recoverySelections[0] ?? null),
      )
    ) {
      throw new Error("environment recovery selections do not match");
    }
    const recoverySelectionValue = recoverySelections[0];
    if (
      recoverySelectionValue !== undefined
      && resolve(recoverySelectionValue.stateRoot ?? "")
        !== resolve(current.model.stateRoot)
    ) {
      throw new Error("environment recovery selection changed its state root");
    }
    const recoveryModel = recoverySelectionValue === undefined
      ? current.model
      : buildEnvironmentPreview(recoverySelectionValue, normalized).model;
    const recovery = await recoverPendingApply(
      environmentApplyDependencies(recoveryModel, normalized, state),
    );
    if (recovery.failure !== undefined) {
      throw new Error(
        `environment interrupted apply recovery failed: ${recovery.failure}`,
      );
    }
    if (recovery.recovered) {
      current = buildEnvironmentPreview(selection, normalized);
    }
  }
  const { model, preview } = current;
  if (preview.plan === null || preview.digest === null) {
    throw new Error(`environment preview is blocked: ${preview.blockers.join(", ")}`);
  }
  if (preview.digest !== expectedDigest) {
    throw new StalePreviewError("environment preview digest is stale");
  }
  state ??= new FileStateStore(model.stateRoot, {
    validateReceipt(value) {
      validateContractDocument(
        "managed-state-receipt",
        value,
        normalized.repositoryRoot,
      );
      return value as ManagedStateReceipt;
    },
  });
  const result = await applyExactPlan(
    preview.plan,
    expectedDigest,
    environmentApplyDependencies(model, normalized, state),
  );
  return { preview, result };
}

function readReceipt(
  path: string,
  repositoryRoot: string,
): ManagedStateReceipt | null {
  if (!existsSync(path)) return null;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 1024 * 1024) {
    throw new Error("managed receipt must be a bounded regular file");
  }
  const value = JSON.parse(
    readBoundedRegularFile(path, 1024 * 1024).toString("utf8"),
  ) as unknown;
  validateContractDocument("managed-state-receipt", value, repositoryRoot);
  return value as ManagedStateReceipt;
}

function selectionFromReceipt(
  receipt: ManagedStateReceipt,
  stateRoot: string,
): EnvironmentSelection {
  return {
    ...(receipt.desiredState.capabilitySet === undefined
      ? {}
      : { capabilitySet: receipt.desiredState.capabilitySet }),
    profileId: receipt.desiredState.profileId,
    ...(receipt.desiredState.selectedCapabilities === undefined
      ? {}
      : { selectedCapabilities: receipt.desiredState.selectedCapabilities }),
    selectedAgents: receipt.desiredState.selectedAgents,
    ...(receipt.desiredState.selectedPackages === undefined
      ? {}
      : { selectedPackages: receipt.desiredState.selectedPackages }),
    stateRoot,
    ...(receipt.desiredState.instance === undefined
      ? {}
      : { target: receipt.desiredState.instance.id }),
    ...(receipt.desiredState.toolRoutes === undefined
      ? {}
      : { toolRoutes: receipt.desiredState.toolRoutes }),
  };
}

export function inspectEnvironment(
  selection: Pick<EnvironmentSelection, "stateRoot" | "target">,
  options: EnvironmentOrchestratorOptions,
): EnvironmentStatus {
  const normalized = normalizedOptions(options);
  const stateRoot = resolveStateRoot(
    selection.stateRoot,
    normalized.env,
    selection.target,
  );
  const receiptPath = join(stateRoot, "receipts", "environment.json");
  const catalog = loadCatalogBundle(normalized.repositoryRoot);
  let receipt: ManagedStateReceipt | null = null;
  let receiptFailure: string | null = null;
  try {
    receipt = readReceipt(receiptPath, normalized.repositoryRoot);
  } catch (error) {
    receiptFailure = error instanceof Error ? error.message : String(error);
  }
  if (
    receipt !== null
    && selection.target !== undefined
    && receipt.desiredState.instance?.id !== selection.target
  ) {
    receiptFailure = "receipt environment instance does not match the selected target";
    receipt = null;
  }
  if (receipt === null) {
    return {
      addons: [],
      agents: [],
      blockers: [receiptFailure ?? "environment:unconfigured"],
      capabilities: [],
      catalogRevision: null,
      claudeMilestoneReady: false,
      currentCatalogRevision: catalog.revision,
      kind: "environment-status",
      optionalGaps: [],
      packages: [],
      profileId: null,
      readiness: receiptFailure === null ? "unconfigured" : "unverifiable",
      receiptPath,
      remediation: [
        `omh setup${
          selection.target === undefined ? "" : ` --target ${selection.target}`
        } --profile personal --agents claude-code`,
      ],
      schemaVersion: "2.0.0",
      selectedAgents: [],
      stateRoot,
      v2ParityReady: false,
      instanceId: selection.target ?? null,
      planDigest: null,
      receiptFingerprint: null,
    };
  }
  const receiptSelection = selectionFromReceipt(receipt, stateRoot);
  const { model, preview } = buildEnvironmentPreview(
    receiptSelection,
    normalized,
  );
  const runtimeReady = new Map(
    receipt.runtimeReadiness.map(({ agentId, state }) => [agentId, state]),
  );
  const nativeReadyById = new Map(preview.selectedAgents.map((id) => {
    const target = runtimeMarkerPath(stateRoot, id);
    const expected = markerFor(
      `runtime:${id}:native`,
      catalog.revision,
      target,
    );
    const ownership = receipt.ownership.filter(
      (entry) =>
        entry.id === `runtime:${id}:native`
        && entry.kind === "registration",
    );
    return [id, (
      ownership.length === 1
      && ownership[0]?.target === target
      && ownership[0]?.digest === sha256Bytes(expected)
      && existsSync(target)
      && sha256File(target) === sha256Bytes(expected)
    )] as const;
  }));
  const nativeReady = [...nativeReadyById.values()].every(Boolean);
  const payloadOwnership = receipt.ownership.filter(
    ({ id, kind }) => id === "plugin:runtime-package" && kind === "directory",
  );
  let payloadReady =
    model.profile.compositionOnly === true
    && model.selectedAgents.length === 0;
  if (
    payloadOwnership.length === 1
    && payloadOwnership[0]?.target === model.managedPayload.activeRoot
    && payloadOwnership[0]?.repairSource === model.managedPayload.storeRoot
    && payloadOwnership[0]?.digest === model.managedPayload.digest
  ) {
    try {
      payloadReady =
        hashManagedDirectory(model.managedPayload.activeRoot)
        === model.managedPayload.digest;
    } catch {
      payloadReady = false;
    }
  }
  const runtimeAddonPinsReady =
    stableJson(receipt.desiredState.runtimeAddons ?? [])
      === stableJson(model.desired.runtimeAddons ?? []);
  const addons = model.runtimeAddons.map((addon): RuntimeAddonEnvironmentStatus => {
    const actionId = `addon:${addon.agentId}:omo`;
    const target = runtimeAddonMarkerPath(
      stateRoot,
      addon.agentId,
      "omo",
    );
    const content = markerFor(
      actionId,
      catalog.revision,
      target,
      addon.fingerprint,
    );
    const markerReady =
      receiptOwnershipMatches(
        receipt,
        actionId,
        "registration",
        target,
        sha256Bytes(content),
      )
      && existsSync(target)
      && sha256File(target) === sha256Bytes(content);
    let sourceReady = false;
    let nativeReady = false;
    try {
      if (addon.kind === "opencode-package") {
        sourceReady =
          receiptOwnershipMatches(
            receipt,
            "addon:opencode:omo:source",
            "directory",
            addon.snapshot.root,
            addon.snapshot.digest,
          )
          && inspectOpenCodeAddonSnapshot(addon.addon, stateRoot);
        nativeReady = openCodePackageAddonResolved(
          runtimeExecutable("opencode", model, normalized),
          {
            packageName: addon.addon.registration.packageName,
            spec: addon.snapshot.spec,
          },
          normalized.env,
          normalized.os,
          (command, args) => runCommand(command, args, normalized),
        );
      } else {
        sourceReady =
          receiptOwnershipMatches(
            receipt,
            "addon:codex:omo:source",
            "directory",
            addon.snapshot.root,
            addon.snapshot.digest,
          )
          && inspectCodexAddonSnapshot(addon.addon, stateRoot);
        nativeReady = addon.status.state === "ready";
      }
    } catch {
      sourceReady = false;
      nativeReady = false;
    }
    const ready =
      runtimeAddonPinsReady && sourceReady && markerReady && nativeReady;
    return ready
      ? addon.status
      : {
          ...addon.status,
          detail:
            "receipt-backed exact runtime add-on registration is missing or drifted",
          state: "unverifiable",
        };
  });
  const runtimeAddonGaps = addons
    .filter(({ state }) => state !== "ready")
    .map(({ agentId, id }) => `addon:${agentId}:${id}`);
  const officialByCapability = model.officialMarketplace.state === "ready"
    ? new Map(
        model.officialMarketplace.plugins.map((entry) => [
          entry.capabilityId,
          entry,
        ]),
      )
    : new Map<string, VerifiedOfficialPlugin>();
  let officialMarketplaceRegistrationReady =
    !model.selectedAgents.includes("claude-code");
  if (model.officialMarketplaceAdapter !== null) {
    const actionId = "runtime:claude-code:official-marketplace";
    const target = capabilityMarkerPath(
      stateRoot,
      "claude-code",
      "official-marketplace",
    );
    const content = markerFor(
      actionId,
      catalog.revision,
      target,
      model.officialMarketplaceAdapter.digest,
    );
    const ownership = receipt.ownership.filter(
      ({ id, kind }) => id === actionId && kind === "registration",
    );
    officialMarketplaceRegistrationReady =
      ownership.length === 1
      && ownership[0]?.target === target
      && ownership[0]?.digest === sha256Bytes(content)
      && existsSync(target)
      && sha256File(target) === sha256Bytes(content);
  }
  const capabilities = preview.capabilities.map((entry) => {
    if (entry.state !== "ready") return entry;
    let registered =
      payloadReady
      && nativeReadyById.get(entry.runtimeId) === true
      && (
        entry.runtimeId !== "claude-code"
        || officialMarketplaceRegistrationReady
      );
    const openCodeSkill = entry.runtimeId === "opencode"
      ? model.openCodeSkills.find(({ id }) => id === entry.id)
      : undefined;
    if (openCodeSkill !== undefined) {
      const actionId = `capability:opencode:${entry.id}`;
      const target = capabilityMarkerPath(stateRoot, "opencode", entry.id);
      const content = markerFor(
        actionId,
        catalog.revision,
        target,
        openCodeSkill.digest,
      );
      const ownership = receipt.ownership.filter(
        ({ id, kind }) => id === actionId && kind === "registration",
      );
      registered = registered
        && ownership.length === 1
        && ownership[0]?.target === target
        && ownership[0]?.digest === sha256Bytes(content)
        && existsSync(target)
        && sha256File(target) === sha256Bytes(content)
        && openCodeSkillsReady([openCodeSkill]);
    }
    const official = entry.runtimeId === "claude-code"
      ? officialByCapability.get(entry.id)
      : undefined;
    if (official !== undefined) {
      const actionId = `capability:claude-code:${entry.id}`;
      const target = capabilityMarkerPath(stateRoot, "claude-code", entry.id);
      const content = markerFor(
        actionId,
        catalog.revision,
        target,
        official.pathTree,
      );
      const ownership = receipt.ownership.filter(
        ({ id, kind }) => id === actionId && kind === "registration",
      );
      registered = registered
        && ownership.length === 1
        && ownership[0]?.target === target
        && ownership[0]?.digest === sha256Bytes(content)
        && existsSync(target)
        && sha256File(target) === sha256Bytes(content);
    }
    return registered
      ? entry
      : {
          ...entry,
          detail: "receipt-backed native capability registration is missing or drifted",
          state: "pending" as const,
        };
  });
  const capabilityRegistrationGaps = capabilities
    .filter(({ state }) => state !== "ready")
    .map(({ id, runtimeId }) => `capability:${runtimeId}:${id}`);
  const selectedReady = preview.selectedAgents.every((id) =>
    runtimeReady.get(id) === "ready"
    && preview.agents.find((entry) => entry.id === id)?.state === "ready");
  const requiredPackageGaps = preview.packages
    .filter(
      ({ required, status }) =>
        required && status !== "installed-unconfigured",
    )
    .map(({ id }) => `package:${id}`);
  const optionalPackageGaps = preview.packages
    .filter(
      ({ required, status }) =>
        !required && status !== "installed-unconfigured",
    )
    .map(({ id }) => `package:${id}`);
  const revisionReady = receipt.catalogRevision === catalog.revision;
  const blockers = [
    ...new Set([
      ...preview.blockers,
      ...(selectedReady ? [] : ["runtime-readiness"]),
      ...(nativeReady ? [] : ["native-registration"]),
      ...(payloadReady ? [] : ["plugin:runtime-package"]),
      ...runtimeAddonGaps,
      ...(revisionReady ? [] : ["catalog-revision"]),
      ...requiredPackageGaps,
      ...capabilityRegistrationGaps,
    ]),
  ];
  const optionalGaps = [
    ...new Set([...preview.optionalGaps, ...optionalPackageGaps]),
  ];
  const readiness: EnvironmentReadiness = blockers.length > 0
    ? "unverifiable"
    : optionalGaps.length > 0
      ? "ready-with-optional-gaps"
      : "ready";
  return {
    addons,
    agents: preview.agents,
    blockers,
    capabilities,
    catalogRevision: receipt.catalogRevision,
    claudeMilestoneReady:
      runtimeReady.get("claude-code") === "ready"
      && preview.selectedAgents.includes("claude-code")
      && nativeReadyById.get("claude-code") === true
      && payloadReady
      && capabilities
        .filter(({ runtimeId }) => runtimeId === "claude-code")
        .every(({ state }) => state === "ready"),
    currentCatalogRevision: catalog.revision,
    kind: "environment-status",
    optionalGaps,
    packages: preview.packages,
    profileId: receipt.desiredState.profileId,
    readiness,
    receiptPath,
    remediation: blockers.length === 0
      ? []
      : [
          `omh setup --profile ${receipt.desiredState.profileId} --agents ${
            selectedAgentsArgument(receipt.desiredState.selectedAgents)
          } --root ${JSON.stringify(stateRoot)}`,
        ],
    schemaVersion: "2.0.0",
    selectedAgents: receipt.desiredState.selectedAgents,
    stateRoot,
    v2ParityReady: (["claude-code", "opencode", "codex"] as const).every(
      (id) => runtimeReady.get(id) === "ready",
    )
      && nativeReady
      && payloadReady
      && addons.every(({ state }) => state === "ready")
      && capabilities.every(({ state }) => state === "ready"),
    instanceId: receipt.desiredState.instance?.id ?? null,
    planDigest: receipt.planDigest,
    receiptFingerprint: sha256Bytes(stableJson(receipt)),
  };
}

function nativeDoctorIssues(
  model: EnvironmentModel,
  options: ReturnType<typeof normalizedOptions>,
): string[] {
  const issues: string[] = [];
  for (const runtimeId of model.selectedAgents) {
    try {
      if (runtimeId === "opencode") {
        const addon = model.runtimeAddons.find(
          (candidate): candidate is OpenCodeRuntimeAddonModel =>
            candidate.kind === "opencode-package",
        );
        if (
          !openCodeRegistrationReady(
            model.managedPayload.activeRoot,
            options.env,
            options.os,
          )
          || !openCodeSkillsReady(model.openCodeSkills)
          || addon === undefined
          || !openCodePackageAddonResolved(
            runtimeExecutable("opencode", model, options),
            {
              packageName: addon.addon.registration.packageName,
              spec: addon.snapshot.spec,
            },
            options.env,
            options.os,
            (command, args) => runCommand(command, args, options),
          )
        ) {
          issues.push("native:opencode:registration-drift");
        }
        continue;
      }
      const executable = runtimeExecutable(runtimeId, model, options);
      const nativeRun = (command: string, args: readonly string[]) =>
        runCommand(command, args, options);
      if (runtimeId === "claude-code") {
        const registration = claudeNativeRegistration(
          model.managedPayload.activeRoot,
          model.receiptPath,
          HARNESS_VERSION,
        );
        const expectedOfficialPlugins =
          model.officialMarketplace.state === "ready"
            ? model.officialMarketplace.plugins.filter(({ capabilityId }) =>
                model.desired.selectedCapabilities?.some(
                  (id) => id === capabilityId,
                ) ?? model.profile.capabilities.some(
                  (id) => id === capabilityId,
                )
              )
            : [];
        const officialMarketplace = model.officialMarketplaceAdapter === null
          ? undefined
          : {
              name: model.officialMarketplaceAdapter.name,
              root: model.officialMarketplaceAdapter.root,
            };
        if (
          model.officialMarketplace.state !== "ready"
          || officialMarketplace === undefined
          || !claudeOfficialMarketplaceReady(
            executable,
            officialMarketplace,
            nativeRun,
          )
          || !claudeRegistrationReady(
            executable,
            registration,
            expectedOfficialPlugins,
            nativeRun,
            officialMarketplace,
          )
        ) {
          issues.push("native:claude-code:registration-drift");
        }
        continue;
      }
      const registration = {
        activeRoot: model.managedPayload.activeRoot,
        receiptPath: model.receiptPath,
      };
      if (!codexRegistrationReady(executable, registration, nativeRun)) {
        issues.push("native:codex:registration-drift");
      }
      const addon = model.runtimeAddons.find(
        (candidate): candidate is CodexRuntimeAddonModel =>
          candidate.kind === "codex-marketplace",
      );
      if (
        addon === undefined
        || !codexMarketplaceAddonReady(
          executable,
          codexAddonNativeRegistration(addon),
          (root) =>
            addon.gitOperations !== null
            && verifyCodexAddonGitMarketplace(
              root,
              addon.addon,
              addon.gitOperations,
            ),
          nativeRun,
        )
      ) {
        issues.push("native:codex:addon-drift");
      }
    } catch {
      issues.push(`native:${runtimeId}:unverifiable`);
    }
  }
  return issues;
}

export function diagnoseEnvironment(
  selection: Pick<EnvironmentSelection, "stateRoot" | "target">,
  options: EnvironmentOrchestratorOptions,
): EnvironmentStatus {
  const status = inspectEnvironment(selection, options);
  if (
    status.profileId === null
    || status.selectedAgents.length === 0
  ) {
    return status;
  }
  const normalized = normalizedOptions(options);
  const receipt = readReceipt(status.receiptPath, normalized.repositoryRoot);
  if (receipt === null) return status;
  const model = buildModel(
    selectionFromReceipt(receipt, status.stateRoot),
    normalized,
  );
  const issues = nativeDoctorIssues(model, normalized);
  if (issues.length === 0) return status;
  const blockers = [...new Set([...status.blockers, ...issues])];
  return {
    ...status,
    blockers,
    claudeMilestoneReady:
      status.claudeMilestoneReady
      && !issues.some((id) => id.startsWith("native:claude-code:")),
    readiness: "unverifiable",
    remediation: [
      `omh setup --profile ${status.profileId} --agents ${
        selectedAgentsArgument(status.selectedAgents)
      } --root ${JSON.stringify(status.stateRoot)}`,
    ],
    v2ParityReady: status.v2ParityReady && issues.length === 0,
  };
}
