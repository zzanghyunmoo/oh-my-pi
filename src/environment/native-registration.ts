import { randomBytes } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  dirname,
  isAbsolute,
  join,
  resolve,
} from "node:path";
import { pathToFileURL } from "node:url";

import {
  applyEdits,
  getNodeValue,
  modify,
  parseTree,
  type ParseError,
} from "jsonc-parser";

import type {
  VerifiedOfficialPlugin,
} from "../install/official-marketplace.js";
import { hashManagedDirectory } from "../install/managed-payload.js";
import {
  loadOpenCodeCapabilityDefinitions,
} from "../runtime/opencode.js";
import {
  assertSafeManagedRootPath,
  atomicWriteFile,
  readBoundedRegularFile,
  sha256File,
} from "./filesystem.js";

export type NativeCommandRunner = (
  command: string,
  args: readonly string[],
) => string;

export interface ManagedNativeRegistration {
  readonly activeRoot: string;
  readonly previousActiveRoot?: string;
  readonly receiptPath: string;
}

interface ClaudeManagedNativeRegistrationBase {
  readonly activeRoot: string;
  readonly expectedVersion: string;
  readonly receiptPath: string;
}

export type ClaudeManagedNativeRegistration =
  & ClaudeManagedNativeRegistrationBase
  & (
    | {
        readonly previousActiveRoot?: never;
        readonly previousExpectedVersion?: never;
      }
    | {
        readonly previousActiveRoot: string;
        readonly previousExpectedVersion: string;
      }
  );

export interface ClaudeOfficialMarketplaceRegistration {
  readonly name: string;
  readonly root: string;
}

export interface OpenCodeSkillRegistration {
  readonly digest: string;
  readonly id: string;
  readonly source: string;
  readonly target: string;
}

export type OpenCodeSkillRegistrationState =
  | "missing"
  | "ready"
  | "collision";

export type ClaudeRegistrationState =
  | "missing"
  | "ready"
  | "collision";

export interface ClaudeManagedRuntimeRegistrationState {
  readonly marketplace: ClaudeRegistrationState;
  readonly plugin: ClaudeRegistrationState;
}

export type ManagedRuntimeRegistrationDisposition =
  | "missing"
  | "ready"
  | "collision";

const MAX_CLAUDE_PLUGIN_MANIFEST_BYTES = 64 * 1024;

export function claudeManagedPluginVersion(root: string): string {
  const manifestPath = join(
    root,
    "plugins",
    "oh-my-harness",
    ".claude-plugin",
    "plugin.json",
  );
  let value: unknown;
  try {
    value = JSON.parse(
      readBoundedRegularFile(
        manifestPath,
        MAX_CLAUDE_PLUGIN_MANIFEST_BYTES,
      ).toString("utf8"),
    ) as unknown;
  } catch {
    throw new Error(
      `Claude managed plugin manifest is invalid: ${manifestPath}`,
    );
  }
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || (value as Record<string, unknown>).name !== "oh-my-harness"
    || typeof (value as Record<string, unknown>).version !== "string"
    || !/^[0-9]+\.[0-9]+\.[0-9]+$/u.test(
      String((value as Record<string, unknown>).version),
    )
  ) {
    throw new Error(
      `Claude managed plugin manifest has no exact version: ${manifestPath}`,
    );
  }
  return String((value as Record<string, unknown>).version);
}

function assertClaudeManagedRegistrationVersions(
  registration: ClaudeManagedNativeRegistration,
): void {
  if (
    claudeManagedPluginVersion(registration.activeRoot)
      !== registration.expectedVersion
  ) {
    throw new Error("Claude managed plugin active version changed");
  }
  if (
    (registration.previousActiveRoot === undefined)
      !== (registration.previousExpectedVersion === undefined)
  ) {
    throw new Error("Claude managed plugin predecessor identity is incomplete");
  }
  if (
    registration.previousActiveRoot !== undefined
    && claudeManagedPluginVersion(registration.previousActiveRoot)
      !== registration.previousExpectedVersion
  ) {
    throw new Error("Claude managed plugin predecessor version changed");
  }
}

export function managedRuntimeRegistrationDisposition(
  state: ClaudeManagedRuntimeRegistrationState,
): ManagedRuntimeRegistrationDisposition {
  if (state.marketplace === "ready" && state.plugin === "ready") {
    return "ready";
  }
  if (state.marketplace === "missing" && state.plugin === "missing") {
    return "missing";
  }
  return "collision";
}

export interface OpenCodePackageAddonRegistration {
  readonly packageName: "oh-my-openagent";
  readonly previousSpec?: string;
  readonly spec: string;
}

export type OpenCodeManagedRuntimeRegistrationState =
  | "missing"
  | "ready"
  | "previous"
  | "collision";

export type OpenCodeManagedRuntimeRegistration = Pick<
  ManagedNativeRegistration,
  "activeRoot" | "previousActiveRoot"
>;

export interface CodexMarketplaceAddonRegistration {
  readonly manifestPath: ".agents/plugins/marketplace.json";
  readonly manifestSha256: string;
  readonly marketplaceName: "sisyphuslabs";
  readonly marketplaceRoot: string;
  readonly pluginContentSha256: string;
  readonly pluginPath: "plugins/omo";
  readonly repository: string;
  readonly selector: "omo@sisyphuslabs";
  readonly version: string;
}

export type RuntimeAddonRegistrationState =
  | "missing"
  | "ready"
  | "collision";

export type OpenCodePackageAddonRegistrationState =
  | RuntimeAddonRegistrationState
  | "previous";

export interface CodexMarketplaceAddonState {
  readonly marketplace: RuntimeAddonRegistrationState;
  readonly plugin: RuntimeAddonRegistrationState;
}

export type CodexMarketplaceTrustVerifier = (
  root: string,
  repository: string,
) => boolean;

const MAX_OPEN_CODE_CONFIG_BYTES = 1024 * 1024;

export function openCodeConfigPath(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string {
  const explicitConfigRoot = env.OPENCODE_CONFIG_DIR;
  if (explicitConfigRoot !== undefined) {
    if (!isAbsolute(explicitConfigRoot)) {
      throw new Error("OpenCode explicit config directory must be absolute");
    }
    return join(explicitConfigRoot, "opencode.json");
  }
  const userHome = env.HOME
    ?? (platform === "win32" ? env.USERPROFILE : undefined)
    ?? homedir();
  const configRoot = env.XDG_CONFIG_HOME
    ?? join(userHome, ".config");
  if (!configRoot || !isAbsolute(configRoot)) {
    throw new Error("OpenCode user configuration root must be absolute");
  }
  return join(configRoot, "opencode", "opencode.json");
}

function openCodeSkillsRoot(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string {
  return join(dirname(openCodeConfigPath(env, platform)), "skills");
}

export function planOpenCodeSkillRegistrations(
  runtimePackageRoot: string,
  selectedCapabilityIds: readonly string[],
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): readonly OpenCodeSkillRegistration[] {
  if (new Set(selectedCapabilityIds).size !== selectedCapabilityIds.length) {
    throw new Error("OpenCode skill selection contains duplicates");
  }
  const definitions = loadOpenCodeCapabilityDefinitions(runtimePackageRoot);
  const byId = new Map<string, (typeof definitions)[number]>(
    definitions.map((entry) => [entry.id, entry]),
  );
  const root = assertSafeManagedRootPath(
    openCodeSkillsRoot(env, platform),
    "OpenCode skills root",
  );
  return selectedCapabilityIds.map((id) => {
    const definition = byId.get(id);
    if (definition === undefined) {
      throw new Error(`unsupported OpenCode workflow skill: ${id}`);
    }
    const source = dirname(definition.sourcePath);
    return {
      digest: hashManagedDirectory(source),
      id,
      source,
      target: join(root, id),
    };
  });
}

export function openCodeSkillsReady(
  registrations: readonly OpenCodeSkillRegistration[],
): boolean {
  try {
    return registrations.every(({ digest, target }) => {
      if (!existsSync(target)) return false;
      const stat = lstatSync(target);
      return !stat.isSymbolicLink()
        && stat.isDirectory()
        && hashManagedDirectory(target) === digest;
    });
  } catch {
    return false;
  }
}

export function inspectOpenCodeSkillRegistration(
  registration: OpenCodeSkillRegistration,
): OpenCodeSkillRegistrationState {
  if (!existsSync(registration.target)) return "missing";
  try {
    const stat = lstatSync(registration.target);
    return !stat.isSymbolicLink()
        && stat.isDirectory()
        && hashManagedDirectory(registration.target) === registration.digest
      ? "ready"
      : "collision";
  } catch {
    return "collision";
  }
}

export function registerOpenCodeSkills(
  registrations: readonly OpenCodeSkillRegistration[],
): void {
  for (const registration of registrations) {
    const state = inspectOpenCodeSkillRegistration(registration);
    if (state === "ready") continue;
    if (state === "collision") {
        throw new Error(
          `OpenCode skill ${registration.id} has a collision with existing user content`,
        );
    }
    const parent = assertSafeManagedRootPath(
      dirname(registration.target),
      "OpenCode skills root",
    );
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const staging = join(
      parent,
      `.${registration.id}.${process.pid}.${
        randomBytes(8).toString("hex")
      }.tmp`,
    );
    try {
      cpSync(registration.source, staging, {
        errorOnExist: true,
        force: false,
        recursive: true,
        verbatimSymlinks: true,
      });
      if (hashManagedDirectory(staging) !== registration.digest) {
        throw new Error(
          `OpenCode skill ${registration.id} changed after preview`,
        );
      }
      renameSync(staging, registration.target);
    } finally {
      rmSync(staging, { force: true, recursive: true });
    }
  }
  if (!openCodeSkillsReady(registrations)) {
    throw new Error("OpenCode native skill registration did not converge");
  }
}

function parseJsonArray(
  output: string,
  label: string,
): readonly Record<string, unknown>[] {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    throw new Error(`${label} did not return JSON`);
  }
  if (
    !Array.isArray(value)
    || value.some(
      (entry) =>
        typeof entry !== "object"
        || entry === null
        || Array.isArray(entry),
    )
  ) {
    throw new Error(`${label} did not return an object array`);
  }
  return value as readonly Record<string, unknown>[];
}

function claudeMarketplacePath(
  entry: Readonly<Record<string, unknown>>,
): string | null {
  for (const key of ["path", "sourcePath", "directory", "localPath"]) {
    const value = entry[key];
    if (typeof value === "string" && isAbsolute(value)) return value;
  }
  const source = entry.source;
  if (
    typeof source === "object"
    && source !== null
    && !Array.isArray(source)
  ) {
    for (const key of ["path", "directory"]) {
      const value = (source as Record<string, unknown>)[key];
      if (typeof value === "string" && isAbsolute(value)) return value;
    }
  }
  return null;
}

function exactClaudeOfficialPlugin(
  entry: Readonly<Record<string, unknown>> | undefined,
  plugin: VerifiedOfficialPlugin,
): boolean {
  if (
    entry?.id !== plugin.selector
    || entry.scope !== "user"
    || entry.enabled !== true
    || typeof entry.installPath !== "string"
    || !isAbsolute(entry.installPath)
  ) {
    return false;
  }
  try {
    return hashManagedDirectory(entry.installPath, {
      ignoreTopLevel: [".in_use"],
    }) === plugin.runtimeContentSha256;
  } catch {
    return false;
  }
}

export function claudeOfficialMarketplaceReady(
  executable: string,
  registration: ClaudeOfficialMarketplaceRegistration,
  run: NativeCommandRunner,
): boolean {
  try {
    const matches = parseJsonArray(
      run(executable, ["plugin", "marketplace", "list", "--json"]),
      "Claude marketplace list",
    ).filter((entry) => entry.name === registration.name);
    if (matches.length !== 1) return false;
    const source = claudeMarketplacePath(matches[0]!);
    return source !== null && resolve(source) === resolve(registration.root);
  } catch {
    return false;
  }
}

export function inspectClaudeOfficialMarketplaceRegistration(
  executable: string,
  registration: ClaudeOfficialMarketplaceRegistration,
  run: NativeCommandRunner,
): ClaudeRegistrationState {
  try {
    const matches = parseJsonArray(
      run(executable, ["plugin", "marketplace", "list", "--json"]),
      "Claude marketplace list",
    ).filter((entry) => entry.name === registration.name);
    if (matches.length === 0) return "missing";
    if (matches.length > 1) return "collision";
    const source = claudeMarketplacePath(matches[0]!);
    return source !== null && resolve(source) === resolve(registration.root)
      ? "ready"
      : "collision";
  } catch {
    return "collision";
  }
}

export function registerClaudeOfficialMarketplace(
  executable: string,
  registration: ClaudeOfficialMarketplaceRegistration,
  run: NativeCommandRunner,
): void {
  const matches = parseJsonArray(
    run(executable, ["plugin", "marketplace", "list", "--json"]),
    "Claude marketplace list",
  ).filter((entry) => entry.name === registration.name);
  if (matches.length > 1) {
    throw new Error(
      `Claude marketplace ${registration.name} is registered more than once`,
    );
  }
  const current = matches[0];
  if (current !== undefined) {
    const source = claudeMarketplacePath(current);
    if (source === null || resolve(source) !== resolve(registration.root)) {
      throw new Error(
        `Claude marketplace ${registration.name} points to another source`,
      );
    }
  } else {
    run(executable, [
      "plugin",
      "marketplace",
      "add",
      registration.root,
    ]);
  }
  if (!claudeOfficialMarketplaceReady(executable, registration, run)) {
    throw new Error(
      `Claude marketplace ${registration.name} registration did not converge`,
    );
  }
}

export function inspectClaudeOfficialPluginRegistration(
  executable: string,
  plugin: VerifiedOfficialPlugin,
  run: NativeCommandRunner,
): ClaudeRegistrationState {
  try {
    const matches = parseJsonArray(
      run(executable, ["plugin", "list", "--json"]),
      "Claude plugin list",
    ).filter(({ id }) => id === plugin.selector);
    if (matches.length === 0) return "missing";
    if (
      matches.length > 1
      || matches.some(({ scope }) => scope !== "user")
    ) {
      return "collision";
    }
    return exactClaudeOfficialPlugin(matches[0], plugin)
      ? "ready"
      : "collision";
  } catch {
    return "collision";
  }
}

export function registerClaudeOfficialPlugin(
  executable: string,
  plugin: VerifiedOfficialPlugin,
  run: NativeCommandRunner,
): void {
  const matches = parseJsonArray(
    run(executable, ["plugin", "list", "--json"]),
    "Claude plugin list",
  ).filter(({ id }) => id === plugin.selector);
  if (matches.length > 1) {
    throw new Error(`${plugin.selector} has duplicate Claude plugin registrations`);
  }
  if (matches.some(({ scope }) => scope !== "user")) {
    throw new Error(
      `${plugin.selector} collides with a non-user Claude plugin registration`,
    );
  }
  const current = matches.find(({ scope }) => scope === "user");
  if (current !== undefined && !exactClaudeOfficialPlugin(current, plugin)) {
    throw new Error(
      `${plugin.selector} collides with an existing user-owned Claude plugin`,
    );
  }
  if (current === undefined) {
    run(executable, [
      "plugin",
      "install",
      plugin.selector,
      "--scope",
      "user",
    ]);
  }
  const verifiedMatches = parseJsonArray(
    run(executable, ["plugin", "list", "--json"]),
    "Claude plugin list",
  ).filter(
    ({ id, scope }) => id === plugin.selector && scope === "user",
  );
  if (
    verifiedMatches.length !== 1
    || !exactClaudeOfficialPlugin(verifiedMatches[0], plugin)
  ) {
    throw new Error(`${plugin.selector} installation did not match its reviewed tree`);
  }
}

export function registerClaudeRuntime(
  executable: string,
  registration: ClaudeManagedNativeRegistration,
  run: NativeCommandRunner,
): void {
  assertClaudeManagedRegistrationVersions(registration);
  const selector = "oh-my-harness@oh-my-harness";
  const marketplaceMatches = parseJsonArray(
    run(executable, ["plugin", "marketplace", "list", "--json"]),
    "Claude marketplace list",
  ).filter((entry) => entry.name === "oh-my-harness");
  if (marketplaceMatches.length > 1) {
    throw new Error("Claude marketplace oh-my-harness is registered more than once");
  }
  const marketplace = marketplaceMatches[0];
  const marketplaceSource = marketplace === undefined
    ? null
    : claudeMarketplacePath(marketplace);
  const selectorMatches = parseJsonArray(
    run(executable, ["plugin", "list", "--json"]),
    "Claude plugin list",
  ).filter((entry) => entry.id === selector);
  if (selectorMatches.length > 1) {
    throw new Error(`${selector} has duplicate Claude plugin registrations`);
  }
  if (selectorMatches.some((entry) => entry.scope !== "user")) {
    throw new Error(`${selector} collides with a non-user Claude plugin registration`);
  }
  const plugin = selectorMatches.find((entry) => entry.scope === "user");

  const pluginMatchesRoot = (
    root: string,
    expectedVersion: string,
  ): boolean => {
    if (
      plugin === undefined
      || plugin.version !== expectedVersion
      || plugin.enabled !== true
      || typeof plugin.installPath !== "string"
      || !isAbsolute(plugin.installPath)
    ) {
      return false;
    }
    try {
      return hashManagedDirectory(plugin.installPath, {
        ignoreTopLevel: [".in_use"],
      }) === hashManagedDirectory(join(root, "plugins", "oh-my-harness"));
    } catch {
      return false;
    }
  };

  const previousRoot = registration.previousActiveRoot;
  if (
    marketplaceSource !== null
    && resolve(marketplaceSource) !== resolve(registration.activeRoot)
  ) {
    if (
      previousRoot === undefined
      || registration.previousExpectedVersion === undefined
      || resolve(marketplaceSource) !== resolve(previousRoot)
      || (
        plugin !== undefined
        && !pluginMatchesRoot(
          previousRoot,
          registration.previousExpectedVersion,
        )
      )
    ) {
      throw new Error("Claude marketplace oh-my-harness points to another source");
    }
    if (plugin !== undefined) {
      run(executable, [
        "plugin",
        "uninstall",
        selector,
        "--scope",
        "user",
      ]);
    }
    run(executable, [
      "plugin",
      "marketplace",
      "remove",
      "oh-my-harness",
    ]);
  } else if (marketplaceSource === null && plugin !== undefined) {
    throw new Error(`${selector} exists without its managed marketplace`);
  } else if (
    marketplaceSource !== null
    && plugin !== undefined
    && !pluginMatchesRoot(
      registration.activeRoot,
      registration.expectedVersion,
    )
  ) {
    throw new Error(`${selector} collides with an existing user-owned Claude plugin`);
  }

  const refreshedMarketplace = parseJsonArray(
    run(executable, ["plugin", "marketplace", "list", "--json"]),
    "Claude marketplace list",
  ).filter((entry) => entry.name === "oh-my-harness");
  if (refreshedMarketplace.length > 1) {
    throw new Error("Claude marketplace oh-my-harness is registered more than once");
  }
  const refreshedSource = refreshedMarketplace[0] === undefined
    ? null
    : claudeMarketplacePath(refreshedMarketplace[0]!);
  if (marketplace !== undefined) {
    if (
      refreshedSource !== null
      && resolve(refreshedSource) !== resolve(registration.activeRoot)
    ) {
      throw new Error("Claude marketplace oh-my-harness points to another source");
    }
  }
  if (refreshedSource === null) {
    run(executable, [
      "plugin",
      "marketplace",
      "add",
      registration.activeRoot,
    ]);
  }

  const currentSelectorMatches = parseJsonArray(
    run(executable, ["plugin", "list", "--json"]),
    "Claude plugin list",
  ).filter((entry) => entry.id === selector);
  if (currentSelectorMatches.length > 1) {
    throw new Error(`${selector} has duplicate Claude plugin registrations`);
  }
  if (currentSelectorMatches.some((entry) => entry.scope !== "user")) {
    throw new Error(`${selector} collides with a non-user Claude plugin registration`);
  }
  const currentPlugin = currentSelectorMatches.find(
    (entry) => entry.scope === "user",
  );
  const sourcePluginDigest = hashManagedDirectory(
    join(registration.activeRoot, "plugins", "oh-my-harness"),
  );
  let installedPluginExact = false;
  if (
    typeof currentPlugin?.installPath === "string"
    && isAbsolute(currentPlugin.installPath)
  ) {
    try {
      installedPluginExact = hashManagedDirectory(currentPlugin.installPath, {
        ignoreTopLevel: [".in_use"],
      }) === sourcePluginDigest;
    } catch {
      installedPluginExact = false;
    }
  }
  const pluginCurrent =
    currentPlugin?.version === registration.expectedVersion
    && currentPlugin.enabled === true
    && installedPluginExact;
  if (currentPlugin !== undefined && !pluginCurrent) {
    throw new Error(`${selector} collides with an existing user-owned Claude plugin`);
  }
  if (currentPlugin === undefined) {
    run(executable, [
      "plugin",
      "install",
      selector,
      "--scope",
      "user",
      "--config",
      `node_path=${process.execPath}`,
      "--config",
      `receipt_path=${registration.receiptPath}`,
    ]);
  }

  if (!claudeRegistrationReady(executable, registration, [], run)) {
    throw new Error("Claude native registration could not be verified");
  }
}

export function inspectClaudeManagedRuntimeRegistration(
  executable: string,
  registration: ClaudeManagedNativeRegistration,
  run: NativeCommandRunner,
): ClaudeManagedRuntimeRegistrationState {
  try {
    const marketplaceMatches = parseJsonArray(
      run(executable, ["plugin", "marketplace", "list", "--json"]),
      "Claude marketplace list",
    ).filter((entry) => entry.name === "oh-my-harness");
    const marketplace = marketplaceMatches.length === 0
      ? "missing"
      : marketplaceMatches.length === 1
          && claudeMarketplacePath(marketplaceMatches[0]!) !== null
          && resolve(claudeMarketplacePath(marketplaceMatches[0]!)!)
            === resolve(registration.activeRoot)
        ? "ready"
        : "collision";
    const pluginMatches = parseJsonArray(
      run(executable, ["plugin", "list", "--json"]),
      "Claude plugin list",
    ).filter((entry) => entry.id === "oh-my-harness@oh-my-harness");
    if (marketplaceMatches.length === 0 && pluginMatches.length === 0) {
      return { marketplace: "missing", plugin: "missing" };
    }
    if (pluginMatches.length > 0) {
      assertClaudeManagedRegistrationVersions(registration);
    }
    let plugin: ClaudeRegistrationState;
    if (pluginMatches.length === 0) {
      plugin = "missing";
    } else if (
      pluginMatches.length !== 1
      || pluginMatches[0]?.scope !== "user"
      || pluginMatches[0]?.version !== registration.expectedVersion
      || pluginMatches[0]?.enabled !== true
      || typeof pluginMatches[0]?.installPath !== "string"
      || !isAbsolute(pluginMatches[0].installPath)
    ) {
      plugin = "collision";
    } else {
      try {
        plugin = hashManagedDirectory(pluginMatches[0].installPath, {
          ignoreTopLevel: [".in_use"],
        }) === hashManagedDirectory(
          join(registration.activeRoot, "plugins", "oh-my-harness"),
        )
          ? "ready"
          : "collision";
      } catch {
        plugin = "collision";
      }
    }
    return { marketplace, plugin };
  } catch {
    return { marketplace: "collision", plugin: "collision" };
  }
}

function parseCodexMarketplaces(output: string): ReadonlyMap<string, string> {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    throw new Error("Codex marketplace list did not return JSON");
  }
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || !Array.isArray((value as Record<string, unknown>).marketplaces)
  ) {
    throw new Error("Codex marketplace list does not match the native contract");
  }
  const entries = new Map<string, string>();
  for (const item of (value as { marketplaces: unknown[] }).marketplaces) {
    if (
      typeof item !== "object"
      || item === null
      || Array.isArray(item)
      || typeof (item as Record<string, unknown>).name !== "string"
      || typeof (item as Record<string, unknown>).root !== "string"
      || !isAbsolute(String((item as Record<string, unknown>).root))
    ) {
      throw new Error("Codex marketplace entry does not match the native contract");
    }
    const { name, root } = item as { name: string; root: string };
    if (entries.has(name)) {
      throw new Error(`duplicate Codex marketplace registration: ${name}`);
    }
    entries.set(name, root);
  }
  return entries;
}

function codexPluginState(
  output: string,
  registration: ManagedNativeRegistration,
): ClaudeRegistrationState {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    throw new Error("Codex plugin list did not return JSON");
  }
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || !Array.isArray((value as Record<string, unknown>).installed)
  ) {
    throw new Error("Codex plugin list does not match the native contract");
  }
  const matches = (value as { installed: unknown[] }).installed.filter(
    (item) =>
      typeof item === "object"
      && item !== null
      && !Array.isArray(item)
      && (item as Record<string, unknown>).pluginId
        === "oh-my-harness@oh-my-harness",
  );
  if (matches.length === 0) return "missing";
  if (matches.length !== 1) return "collision";
  const plugin = matches[0] as Record<string, unknown>;
  const source = plugin.source;
  if (
    plugin.installed !== true
    || plugin.enabled !== true
    || plugin.marketplaceName !== "oh-my-harness"
    || typeof source !== "object"
    || source === null
    || Array.isArray(source)
    || (source as Record<string, unknown>).source !== "local"
    || typeof (source as Record<string, unknown>).path !== "string"
    || !isAbsolute(String((source as Record<string, unknown>).path))
  ) {
    return "collision";
  }
  try {
    return hashManagedDirectory(String((source as Record<string, unknown>).path))
        === hashManagedDirectory(
          join(registration.activeRoot, "plugins", "oh-my-harness"),
        )
      ? "ready"
      : "collision";
  } catch {
    return "collision";
  }
}

export function inspectCodexManagedRuntimeRegistration(
  executable: string,
  registration: ManagedNativeRegistration,
  run: NativeCommandRunner,
): ClaudeManagedRuntimeRegistrationState {
  try {
    const marketplaces = parseCodexMarketplaces(
      run(executable, ["plugin", "marketplace", "list", "--json"]),
    );
    const marketplaceRoot = marketplaces.get("oh-my-harness");
    const marketplace = marketplaceRoot === undefined
      ? "missing"
      : resolve(marketplaceRoot) === resolve(registration.activeRoot)
        ? "ready"
        : "collision";
    const plugin = codexPluginState(
      run(executable, ["plugin", "list", "--json"]),
      registration,
    );
    return { marketplace, plugin };
  } catch {
    return { marketplace: "collision", plugin: "collision" };
  }
}

export function registerCodexRuntime(
  executable: string,
  registration: ManagedNativeRegistration,
  run: NativeCommandRunner,
): void {
  let state = inspectCodexManagedRuntimeRegistration(
    executable,
    registration,
    run,
  );
  if (state.marketplace === "collision") {
    const previous = registration.previousActiveRoot;
    const previousState = previous === undefined
      ? null
      : inspectCodexManagedRuntimeRegistration(
          executable,
          {
            activeRoot: previous,
            receiptPath: registration.receiptPath,
          },
          run,
        );
    if (
      previousState?.marketplace !== "ready"
      || previousState.plugin !== "ready"
    ) {
      throw new Error("Codex marketplace oh-my-harness points to another root");
    }
    run(executable, [
      "plugin",
      "remove",
      "oh-my-harness@oh-my-harness",
      "--json",
    ]);
    run(executable, [
      "plugin",
      "marketplace",
      "remove",
      "oh-my-harness",
      "--json",
    ]);
    state = { marketplace: "missing", plugin: "missing" };
  }
  if (state.plugin === "collision") {
    throw new Error(
      "oh-my-harness@oh-my-harness collides with an existing Codex plugin registration",
    );
  }
  if (state.marketplace === "missing" && state.plugin === "ready") {
    throw new Error(
      "oh-my-harness@oh-my-harness exists without its managed Codex marketplace",
    );
  }
  if (state.marketplace === "missing") {
    run(executable, [
      "plugin",
      "marketplace",
      "add",
      registration.activeRoot,
      "--json",
    ]);
  }
  if (state.plugin === "missing") {
    run(executable, [
      "plugin",
      "add",
      "oh-my-harness@oh-my-harness",
      "--json",
    ]);
  }
  const verified = inspectCodexManagedRuntimeRegistration(
    executable,
    registration,
    run,
  );
  if (
    verified.marketplace !== "ready"
    || verified.plugin !== "ready"
  ) {
    throw new Error("Codex native registration could not be verified");
  }
}

export function claudeRegistrationReady(
  executable: string,
  registration: ClaudeManagedNativeRegistration,
  officialPlugins: readonly VerifiedOfficialPlugin[],
  run: NativeCommandRunner,
  officialMarketplace?: ClaudeOfficialMarketplaceRegistration,
): boolean {
  try {
    assertClaudeManagedRegistrationVersions(registration);
    const marketplaceMatches = parseJsonArray(
      run(executable, ["plugin", "marketplace", "list", "--json"]),
      "Claude marketplace list",
    ).filter((entry) => entry.name === "oh-my-harness");
    const marketplace = marketplaceMatches[0];
    const marketplacePath = marketplace === undefined
      ? null
      : claudeMarketplacePath(marketplace);
    const plugins = parseJsonArray(
      run(executable, ["plugin", "list", "--json"]),
      "Claude plugin list",
    );
    const managedMatches = plugins.filter(
      (entry) => entry.id === "oh-my-harness@oh-my-harness",
    );
    const sourcePluginDigest = hashManagedDirectory(
      join(registration.activeRoot, "plugins", "oh-my-harness"),
    );
    const managedPlugin = managedMatches[0];
    const managedPluginReady =
      managedMatches.length === 1
      && managedPlugin?.scope === "user"
      && managedPlugin.version === registration.expectedVersion
      && managedPlugin.enabled === true
      && typeof managedPlugin.installPath === "string"
      && isAbsolute(managedPlugin.installPath)
      && hashManagedDirectory(managedPlugin.installPath, {
          ignoreTopLevel: [".in_use"],
        }) === sourcePluginDigest;
    const officialPluginsReady = officialPlugins.every((expected) => {
      const matches = plugins.filter(({ id }) => id === expected.selector);
      return matches.length === 1
        && exactClaudeOfficialPlugin(matches[0], expected);
    });
    return marketplaceMatches.length === 1
      && marketplacePath !== null
      && resolve(marketplacePath) === resolve(registration.activeRoot)
      && managedPluginReady
      && officialPluginsReady
      && (
        officialMarketplace === undefined
        || claudeOfficialMarketplaceReady(
          executable,
          officialMarketplace,
          run,
        )
      );
  } catch {
    return false;
  }
}

export function codexRegistrationReady(
  executable: string,
  registration: ManagedNativeRegistration,
  run: NativeCommandRunner,
): boolean {
  const state = inspectCodexManagedRuntimeRegistration(
    executable,
    registration,
    run,
  );
  return state.marketplace === "ready" && state.plugin === "ready";
}

export function registerOpenCodeRuntime(
  registration: OpenCodeManagedRuntimeRegistration,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): void {
  const { configPath, current, plugins } = openCodePluginEntries(env, platform);
  const state = classifyOpenCodeManagedRuntimeRegistration(
    plugins,
    registration,
  );
  if (state === "collision") {
    throw new Error(
      "oh-my-harness collides with an existing OpenCode plugin registration",
    );
  }
  if (state === "ready") return;

  const currentSources = openCodeManagedRuntimeSources(registration.activeRoot);
  const previousSources = registration.previousActiveRoot === undefined
    ? null
    : openCodeManagedRuntimeSources(registration.previousActiveRoot);
  const preserved = state === "previous" && previousSources !== null
    ? plugins.filter((entry) => !previousSources.accepted.has(entry))
    : [...plugins];
  const edits = modify(current, ["plugin"], [...preserved, currentSources.url], {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  });
  atomicWriteFile(configPath, `${applyEdits(current, edits).trimEnd()}\n`);
  if (
    inspectOpenCodeManagedRuntimeRegistration(registration, env, platform)
    !== "ready"
  ) {
    throw new Error("OpenCode native registration could not be verified");
  }
}

function openCodePluginEntries(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): {
  readonly configPath: string;
  readonly current: string;
  readonly plugins: readonly string[];
} {
  const configPath = openCodeConfigPath(env, platform);
  const current = existsSync(configPath)
    ? readBoundedRegularFile(configPath, MAX_OPEN_CODE_CONFIG_BYTES)
      .toString("utf8")
    : "{}\n";
  const errors: ParseError[] = [];
  const root = parseTree(current, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  const pluginProperties = root?.children?.filter(
    (node) =>
      node.type === "property"
      && node.children?.[0]?.value === "plugin",
  ) ?? [];
  const parsed = root === undefined
    ? undefined
    : getNodeValue(root) as { readonly plugin?: unknown };
  if (
    errors.length > 0
    || root?.type !== "object"
    || pluginProperties.length > 1
    || parsed === undefined
    || (parsed.plugin !== undefined && !Array.isArray(parsed.plugin))
  ) {
    throw new Error("OpenCode plugin configuration is not a string array");
  }
  if (
    Array.isArray(parsed.plugin)
    && parsed.plugin.some((entry) => typeof entry !== "string")
  ) {
    throw new Error("OpenCode plugin configuration contains a non-string entry");
  }
  return {
    configPath,
    current,
    plugins: (parsed.plugin ?? []) as readonly string[],
  };
}

function openCodeManagedRuntimeSources(root: string): {
  readonly accepted: ReadonlySet<string>;
  readonly url: string;
} {
  const path = resolve(
    root,
    ".opencode",
    "plugins",
    "oh-my-harness.js",
  );
  const url = pathToFileURL(path).href;
  return {
    accepted: new Set([path, url]),
    url,
  };
}

function isOpenCodeManagedRuntimeEntry(value: string): boolean {
  const [withoutSuffix = value] = value.split(/[?#]/u, 1);
  const normalized = withoutSuffix.replaceAll("\\", "/");
  return normalized === ".opencode/plugins/oh-my-harness.js"
    || normalized === "./.opencode/plugins/oh-my-harness.js"
    || normalized.endsWith("/.opencode/plugins/oh-my-harness.js");
}

function classifyOpenCodeManagedRuntimeRegistration(
  plugins: readonly string[],
  registration: OpenCodeManagedRuntimeRegistration,
): OpenCodeManagedRuntimeRegistrationState {
  const matches = plugins.filter(isOpenCodeManagedRuntimeEntry);
  if (matches.length === 0) return "missing";
  if (matches.length !== 1) return "collision";

  const [match] = matches;
  if (match === undefined) return "collision";
  if (
    openCodeManagedRuntimeSources(registration.activeRoot).accepted.has(match)
  ) {
    return "ready";
  }
  if (
    registration.previousActiveRoot !== undefined
    && openCodeManagedRuntimeSources(
      registration.previousActiveRoot,
    ).accepted.has(match)
  ) {
    return "previous";
  }
  return "collision";
}

export function inspectOpenCodeManagedRuntimeRegistration(
  registration: OpenCodeManagedRuntimeRegistration,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): OpenCodeManagedRuntimeRegistrationState {
  try {
    const { plugins } = openCodePluginEntries(env, platform);
    return classifyOpenCodeManagedRuntimeRegistration(plugins, registration);
  } catch {
    return "collision";
  }
}

function isOpenCodeOmoSpec(value: string): boolean {
  if (/^(?:oh-my-openagent|oh-my-opencode)(?:@|$)/u.test(value)) return true;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "file:"
      && /\/addons\/opencode\/omo\/[0-9a-f]{64}\/dist\/index\.js$/u.test(
        parsed.pathname,
      );
  } catch {
    return false;
  }
}

export function inspectOpenCodePackageAddon(
  registration: OpenCodePackageAddonRegistration,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): OpenCodePackageAddonRegistrationState {
  try {
    const { plugins } = openCodePluginEntries(env, platform);
    const matches = plugins.filter(isOpenCodeOmoSpec);
    if (matches.length === 0) return "missing";
    if (matches.length !== 1) return "collision";
    if (matches[0] === registration.spec) return "ready";
    return registration.previousSpec !== undefined
        && matches[0] === registration.previousSpec
      ? "previous"
      : "collision";
  } catch {
    return "collision";
  }
}

export function registerOpenCodePackageAddon(
  registration: OpenCodePackageAddonRegistration,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): void {
  const state = inspectOpenCodePackageAddon(registration, env, platform);
  if (state === "ready") return;
  if (state === "collision") {
    throw new Error(
      `${registration.packageName} collides with an existing OpenCode plugin registration`,
    );
  }
  const { configPath, current, plugins } = openCodePluginEntries(env, platform);
  const nextPlugins = state === "previous"
    ? plugins.map((plugin) =>
        plugin === registration.previousSpec ? registration.spec : plugin
      )
    : [...plugins, registration.spec];
  const edits = modify(current, ["plugin"], nextPlugins, {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  });
  atomicWriteFile(configPath, `${applyEdits(current, edits).trimEnd()}\n`);
  if (inspectOpenCodePackageAddon(registration, env, platform) !== "ready") {
    throw new Error("OpenCode OMO registration could not be verified");
  }
}

export function openCodePackageAddonResolved(
  executable: string,
  registration: OpenCodePackageAddonRegistration,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  run: NativeCommandRunner,
): boolean {
  if (inspectOpenCodePackageAddon(registration, env, platform) !== "ready") {
    return false;
  }
  try {
    const output = run(executable, ["debug", "config"]);
    let value: unknown;
    try {
      value = JSON.parse(output);
    } catch {
      const errors: ParseError[] = [];
      const root = parseTree(output, errors, {
        allowTrailingComma: false,
        disallowComments: true,
      });
      const pluginProperties = root?.children?.filter(
        (node) =>
          node.type === "property"
          && node.children?.[0]?.value === "plugin",
      ) ?? [];
      const pluginNode = pluginProperties[0]?.children?.[1];
      const pluginEnd = pluginNode === undefined
        ? 0
        : pluginNode.offset + pluginNode.length;
      if (
        root?.type !== "object"
        || pluginProperties.length !== 1
        || pluginNode?.type !== "array"
        || output[pluginEnd - 1] !== "]"
        || errors.some((error) => error.offset < pluginEnd)
      ) {
        return false;
      }
      value = { plugin: getNodeValue(pluginNode) };
    }
    if (
      typeof value !== "object"
      || value === null
      || Array.isArray(value)
    ) {
      return false;
    }
    const plugins = (value as Record<string, unknown>).plugin;
    return Array.isArray(plugins)
      && plugins.filter((entry) => entry === registration.spec).length === 1;
  } catch {
    return false;
  }
}

export function openCodeRegistrationReady(
  runtimePackageRoot: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): boolean {
  return inspectOpenCodeManagedRuntimeRegistration(
    { activeRoot: runtimePackageRoot },
    env,
    platform,
  ) === "ready";
}

interface CodexMarketplaceObservation {
  readonly name: string;
  readonly root: string;
  readonly source: {
    readonly source: string;
    readonly sourceType: string;
  } | null;
}

function codexMarketplaceObservations(
  output: string,
): readonly CodexMarketplaceObservation[] {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    throw new Error("Codex marketplace list did not return JSON");
  }
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || !Array.isArray((value as Record<string, unknown>).marketplaces)
  ) {
    throw new Error("Codex marketplace list does not match the native contract");
  }
  return (value as { marketplaces: unknown[] }).marketplaces.map((item) => {
    if (
      typeof item !== "object"
      || item === null
      || Array.isArray(item)
    ) {
      throw new Error("Codex marketplace entry does not match the native contract");
    }
    const entry = item as Record<string, unknown>;
    if (
      typeof entry.name !== "string"
      || typeof entry.root !== "string"
      || !isAbsolute(entry.root)
    ) {
      throw new Error("Codex marketplace entry does not match the native contract");
    }
    const marketplaceSource = entry.marketplaceSource;
    if (marketplaceSource === undefined) {
      return { name: entry.name, root: entry.root, source: null };
    }
    if (
      typeof marketplaceSource !== "object"
      || marketplaceSource === null
      || Array.isArray(marketplaceSource)
      || typeof (marketplaceSource as Record<string, unknown>).sourceType
        !== "string"
      || typeof (marketplaceSource as Record<string, unknown>).source
        !== "string"
    ) {
      throw new Error(
        "Codex marketplace source does not match the native contract",
      );
    }
    return {
      name: entry.name,
      root: entry.root,
      source: {
        source: String(
          (marketplaceSource as Record<string, unknown>).source,
        ),
        sourceType: String(
          (marketplaceSource as Record<string, unknown>).sourceType,
        ),
      },
    };
  });
}

function codexAddonMarketplaceContentExact(
  root: string,
  registration: CodexMarketplaceAddonRegistration,
): boolean {
  try {
    return sha256File(join(root, registration.manifestPath))
        === registration.manifestSha256
      && hashManagedDirectory(join(root, registration.pluginPath), {
        ignoreTopLevel: [".in_use"],
      }) === registration.pluginContentSha256;
  } catch {
    return false;
  }
}

function codexAddonPluginState(
  output: string,
  registration: CodexMarketplaceAddonRegistration,
  marketplaceRoot: string | null,
): RuntimeAddonRegistrationState {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    throw new Error("Codex plugin list did not return JSON");
  }
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || !Array.isArray((value as Record<string, unknown>).installed)
  ) {
    throw new Error("Codex plugin list does not match the native contract");
  }
  const matches = (value as { installed: unknown[] }).installed.filter(
    (item) =>
      typeof item === "object"
      && item !== null
      && !Array.isArray(item)
      && (item as Record<string, unknown>).pluginId === registration.selector,
  );
  if (matches.length === 0) return "missing";
  if (matches.length !== 1) return "collision";
  const plugin = matches[0] as Record<string, unknown>;
  const source = plugin.source;
  if (
    plugin.installed !== true
    || plugin.enabled !== true
    || plugin.marketplaceName !== registration.marketplaceName
    || plugin.version !== registration.version
    || typeof source !== "object"
    || source === null
    || Array.isArray(source)
    || (source as Record<string, unknown>).source !== "local"
    || typeof (source as Record<string, unknown>).path !== "string"
    || !isAbsolute(String((source as Record<string, unknown>).path))
    || marketplaceRoot === null
    || resolve(String((source as Record<string, unknown>).path))
      !== resolve(join(marketplaceRoot, registration.pluginPath))
  ) {
    return "collision";
  }
  try {
    return hashManagedDirectory(
        String((source as Record<string, unknown>).path),
        { ignoreTopLevel: [".in_use"] },
      ) === registration.pluginContentSha256
      ? "ready"
      : "collision";
  } catch {
    return "collision";
  }
}

export function inspectCodexMarketplaceAddon(
  executable: string,
  registration: CodexMarketplaceAddonRegistration,
  verifyGitMarketplace: CodexMarketplaceTrustVerifier,
  run: NativeCommandRunner,
): CodexMarketplaceAddonState {
  try {
    const matches = codexMarketplaceObservations(
      run(executable, ["plugin", "marketplace", "list", "--json"]),
    ).filter(({ name }) => name === registration.marketplaceName);
    let marketplace: RuntimeAddonRegistrationState;
    let marketplaceRoot: string | null = null;
    if (matches.length === 0) {
      marketplace = "missing";
    } else if (matches.length !== 1) {
      marketplace = "collision";
    } else {
      const observation = matches[0];
      if (observation === undefined) {
        marketplace = "collision";
      } else {
        const localRootExact =
          resolve(observation.root) === resolve(registration.marketplaceRoot);
        const sourceExact = observation.source === null
          ? localRootExact
          : observation.source.sourceType === "local"
            ? localRootExact
              && isAbsolute(observation.source.source)
              && resolve(observation.source.source)
                === resolve(registration.marketplaceRoot)
            : observation.source.sourceType === "git"
              && observation.source.source === registration.repository
              && verifyGitMarketplace(
                observation.root,
                registration.repository,
              );
        marketplace = sourceExact
            && codexAddonMarketplaceContentExact(
              observation.root,
              registration,
            )
          ? "ready"
          : "collision";
        if (marketplace === "ready") {
          marketplaceRoot = observation.root;
        }
      }
    }
    const plugin = codexAddonPluginState(
      run(executable, ["plugin", "list", "--json"]),
      registration,
      marketplaceRoot,
    );
    return { marketplace, plugin };
  } catch {
    return { marketplace: "collision", plugin: "collision" };
  }
}

export function registerCodexMarketplaceAddon(
  executable: string,
  registration: CodexMarketplaceAddonRegistration,
  verifyGitMarketplace: CodexMarketplaceTrustVerifier,
  run: NativeCommandRunner,
): void {
  const state = inspectCodexMarketplaceAddon(
    executable,
    registration,
    verifyGitMarketplace,
    run,
  );
  if (state.marketplace === "collision" || state.plugin === "collision") {
    throw new Error(
      `${registration.selector} collides with an existing Codex registration`,
    );
  }
  if (state.marketplace === "missing" && state.plugin === "ready") {
    throw new Error(
      `${registration.selector} exists without its exact marketplace`,
    );
  }
  if (state.marketplace === "missing") {
    run(executable, [
      "plugin",
      "marketplace",
      "add",
      registration.marketplaceRoot,
      "--json",
    ]);
  }
  if (state.plugin === "missing") {
    run(executable, ["plugin", "add", registration.selector, "--json"]);
  }
  const verified = inspectCodexMarketplaceAddon(
    executable,
    registration,
    verifyGitMarketplace,
    run,
  );
  if (
    verified.marketplace !== "ready"
    || verified.plugin !== "ready"
  ) {
    throw new Error("Codex OMO registration could not be verified");
  }
}

export function codexMarketplaceAddonReady(
  executable: string,
  registration: CodexMarketplaceAddonRegistration,
  verifyGitMarketplace: CodexMarketplaceTrustVerifier,
  run: NativeCommandRunner,
): boolean {
  const state = inspectCodexMarketplaceAddon(
    executable,
    registration,
    verifyGitMarketplace,
    run,
  );
  return state.marketplace === "ready" && state.plugin === "ready";
}
