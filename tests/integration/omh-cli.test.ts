import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { formatOmhResult, runOmh } from "../../dist/cli/main.js";
import {
  applyEnvironment,
  previewEnvironment,
} from "../../dist/environment/orchestrator.js";
import { inspectCodexManagedRuntimeRegistration } from "../../dist/environment/native-registration.js";
import {
  hashManagedDirectory,
  inspectManagedRuntimePayload,
  materializeManagedRuntimePayload,
} from "../../dist/install/managed-payload.js";
import { gitTreeSha1 } from "../../dist/install/official-marketplace.js";
import { StalePreviewError } from "../../dist/planning/apply.js";

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function assertCliNativeRegistrationBlocked(
  result: Awaited<ReturnType<typeof runOmh>>,
  agentId: "claude-code" | "opencode" | "codex",
): void {
  assert.equal(result.state, "blocked");
  assert.equal(result.preview?.plan, null);
  assert.equal(result.preview?.digest, null);
  assert.equal(
    result.preview?.blockers.includes(`native-registration:${agentId}`),
    true,
  );
  assert.match(
    result.preview?.remediation ?? "",
    new RegExp(`inspect native-registration:${agentId}`, "u"),
  );
  assert.match(
    result.preview?.remediation ?? "",
    /resolve only the reported collision manually while preserving unrelated user-owned configuration/u,
  );
  const rendered = formatOmhResult(result);
  assert.match(
    rendered,
    new RegExp(`blocking: native-registration:${agentId}`, "u"),
  );
  assert.match(rendered, /next: inspect native-registration:/u);
}

function createExecutable(directory: string, command: string): string {
  const extension = process.platform === "win32" ? ".exe" : "";
  const path = join(directory, `${command}${extension}`);
  if (process.platform === "win32") {
    copyFileSync(process.execPath, path);
  } else {
    writeFileSync(path, "#!/bin/sh\nexit 0\n", "utf8");
    chmodSync(path, 0o755);
  }
  return path;
}

function createOfficialMarketplaceFixture(
  repositoryRoot: string,
  claudeConfigRoot: string,
): Map<string, string> {
  const lockPath = join(
    repositoryRoot,
    "harness",
    "catalog",
    "upstreams",
    "anthropic-official-capabilities.json",
  );
  const lock = JSON.parse(readFileSync(lockPath, "utf8")) as {
    repository: {
      commit: string;
      contentSha256: string;
      marketplace: { path: string; sha256: string };
      runtimeMarketplace: {
        name: string;
        manifestSha256: string;
        contentSha256: string;
      };
    };
    candidates: Array<{
      capabilityId: string;
      disposition: string;
      path: string;
      pathTree: string;
      pluginName: string;
      runtimeContentSha256: string;
    }>;
  };
  const marketplaceRoot = join(
    claudeConfigRoot,
    "plugins",
    "marketplaces",
    "claude-plugins-official",
  );
  const installPaths = new Map<string, string>();
  const plugins: Array<{
    name: string;
    source: string;
    version: string;
  }> = [];
  mkdirSync(marketplaceRoot, { recursive: true });
  writeFileSync(join(marketplaceRoot, ".gcs-sha"), `${lock.repository.commit}\n`);
  for (const candidate of lock.candidates.filter(
    ({ disposition }) => disposition === "accepted",
  )) {
    const pluginRoot = join(marketplaceRoot, candidate.path);
    mkdirSync(pluginRoot, { recursive: true });
    writeFileSync(
      join(pluginRoot, "fixture.txt"),
      `${candidate.capabilityId}\n`,
    );
    candidate.pathTree = gitTreeSha1(pluginRoot);
    candidate.runtimeContentSha256 = hashManagedDirectory(pluginRoot);
    installPaths.set(
      `${candidate.pluginName}@${lock.repository.runtimeMarketplace.name}`,
      pluginRoot,
    );
    plugins.push({
      name: candidate.pluginName,
      source: `./${candidate.path}`,
      version: "1.0.0",
    });
  }
  const manifestPath = join(
    marketplaceRoot,
    lock.repository.marketplace.path,
  );
  mkdirSync(join(manifestPath, ".."), { recursive: true });
  writeFileSync(manifestPath, `${JSON.stringify({ plugins }, null, 2)}\n`);
  lock.repository.marketplace.sha256 = sha256(manifestPath);
  lock.repository.contentSha256 = hashManagedDirectory(marketplaceRoot, {
    ignoreTopLevel: [".gcs-sha"],
  });
  const adapterFixture = join(repositoryRoot, ".official-adapter-fixture");
  cpSync(marketplaceRoot, adapterFixture, { recursive: true });
  rmSync(join(adapterFixture, ".gcs-sha"));
  const adapterManifestPath = join(
    adapterFixture,
    lock.repository.marketplace.path,
  );
  const adapterManifest = JSON.parse(
    readFileSync(adapterManifestPath, "utf8"),
  ) as Record<string, unknown>;
  adapterManifest.name = lock.repository.runtimeMarketplace.name;
  writeFileSync(
    adapterManifestPath,
    `${JSON.stringify(adapterManifest, null, 2)}\n`,
  );
  lock.repository.runtimeMarketplace.manifestSha256 =
    sha256(adapterManifestPath);
  lock.repository.runtimeMarketplace.contentSha256 =
    hashManagedDirectory(adapterFixture);
  rmSync(adapterFixture, { recursive: true });
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  return installPaths;
}

function writePreviousManagedReceipt(
  stateRoot: string,
  payloadRoot: string,
  agentId: "claude-code" | "codex" | "opencode",
  catalogRevision: string,
): string {
  const receiptPath = join(stateRoot, "receipts", "environment.json");
  mkdirSync(join(receiptPath, ".."), { recursive: true });
  writeFileSync(
    receiptPath,
    `${JSON.stringify({
      $schema: "../contracts/managed-state-receipt.schema.json",
      appliedAt: "2026-08-04T00:00:00.000Z",
      catalogRevision,
      completedActionIds: [],
      desiredState: {
        profileId: "mds-host",
        selectedAgents: [agentId],
      },
      kind: "managed-state-receipt",
      ownership: [
        {
          digest: hashManagedDirectory(payloadRoot),
          id: "plugin:runtime-package",
          kind: "directory",
          scope: "managed",
          target: payloadRoot,
        },
        {
          digest: "b".repeat(64),
          id: `runtime:${agentId}:native`,
          kind: "registration",
          scope: "managed",
          target: join(
            stateRoot,
            "markers",
            "runtimes",
            `${agentId}.json`,
          ),
        },
      ],
      planDigest: "c".repeat(64),
      runtimeReadiness: [{ agentId, state: "ready" }],
      schemaVersion: "2.0.0",
      startupConsent: {
        addReviewedContent: true,
        artifactClasses: ["managed-skill"],
        channelId: "stable",
        permissionScopes: ["workspace:read"],
        profileId: "mds-host",
        repairPinned: true,
      },
    }, null, 2)}\n`,
  );
  return receiptPath;
}

test("U13 CLI closes preview, exact apply, receipt, status, and startup context end to end", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "omh-v2-cli-"));
  const repositoryRoot = join(root, "repository");
  const workspace = join(root, "workspace");
  const binaryRoot = join(root, "bin");
  const stateRoot = join(root, "state");
  const calls: Array<{ readonly command: string; readonly args: readonly string[] }> = [];
  let pluginInstalled = false;
  let managedPluginVersion = "0.3.2";
  let managedMarketplaceRoot: string | null = null;
  let codexManagedMarketplaceRoot: string | null = null;
  let codexPluginInstalled = false;
  let codexFailureHook: (() => void) | undefined;
  let managedUpgradeInspectionHook: (() => void) | undefined;
  let managedUpgradeDrift: (() => void) | undefined;
  const marketplaces = new Map<string, string>();
  const officialInstalled = new Set<string>();

  try {
    mkdirSync(repositoryRoot);
    mkdirSync(workspace);
    mkdirSync(binaryRoot);
    cpSync("harness", join(repositoryRoot, "harness"), { recursive: true });
    for (const path of [
      ".agents",
      ".claude-plugin",
      "dist",
      "plugins",
    ]) {
      cpSync(path, join(repositoryRoot, path), { recursive: true });
    }
    mkdirSync(join(repositoryRoot, ".opencode"), { recursive: true });
    copyFileSync(
      join(".opencode", "package.json"),
      join(repositoryRoot, ".opencode", "package.json"),
    );
    cpSync(
      join(".opencode", "plugins"),
      join(repositoryRoot, ".opencode", "plugins"),
      { recursive: true },
    );
    mkdirSync(join(repositoryRoot, "scripts", "harness"), {
      recursive: true,
    });
    copyFileSync(
      join("scripts", "harness", "acquisition.mjs"),
      join(repositoryRoot, "scripts", "harness", "acquisition.mjs"),
    );
    copyFileSync("package.json", join(repositoryRoot, "package.json"));
    for (const dependency of [
      "b4a",
      "bare-events",
      "events-universal",
      "fast-fifo",
      "jsonc-parser",
      "pend",
      "streamx",
      "tar-stream",
      "text-decoder",
      "typebox",
      "yauzl",
      "zod",
    ]) {
      cpSync(
        join("node_modules", dependency),
        join(repositoryRoot, "node_modules", dependency),
        { recursive: true },
      );
    }
    const claudeConfigRoot = join(root, "claude");
    const officialInstallPaths = createOfficialMarketplaceFixture(
      repositoryRoot,
      claudeConfigRoot,
    );

    const claudePath = createExecutable(binaryRoot, "claude");
    const openCodePath = createExecutable(binaryRoot, "opencode");
    const codexPath = createExecutable(binaryRoot, "codex");
    const canonicalCodexPath = realpathSync(codexPath);
    for (const command of [
      "linear",
      "ntn",
      "gh",
      "jira",
      "confluence",
      "glab",
      "jdtls",
      "kotlin-lsp",
      "csharp-ls",
      "clangd",
      "gopls",
      "pyright-langserver",
      "typescript-language-server",
    ]) {
      createExecutable(binaryRoot, command);
    }

    for (const [adapterId, executablePath] of [
      ["claude-code", claudePath],
      ["opencode", openCodePath],
      ["codex", codexPath],
    ] as const) {
      const descriptorPath = join(
        repositoryRoot,
        "harness",
        "adapters",
        `${adapterId}.json`,
      );
      const descriptor = JSON.parse(readFileSync(descriptorPath, "utf8")) as {
        platforms: Array<{
          architecture: string;
          os: string;
          executable: { sha256: string };
        }>;
      };
      const platform = descriptor.platforms.find(
        (entry) =>
          entry.os === process.platform && entry.architecture === process.arch,
      );
      assert.ok(platform, `fixture has no ${process.platform}-${process.arch} adapter`);
      platform.executable.sha256 = sha256(executablePath);
      writeFileSync(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`);
    }

    const env = {
      ...process.env,
      PATH: `${binaryRoot}${delimiter}${process.env.PATH ?? ""}`,
      CLAUDE_CONFIG_DIR: claudeConfigRoot,
      XDG_CONFIG_HOME: join(root, "config"),
    };
    const commonOptions = {
      cwd: workspace,
      env,
      repositoryRoot,
      inspectPackageVersion(
        _path: string,
        id: "notion" | "linear" | "jira" | "confluence" | "github" | "gitlab",
      ) {
        return {
          confluence: "2.18.0",
          jira: "1.7.0",
          linear: "2.0.0",
          notion: "0.19.0",
        }[id] ?? null;
      },
      runCommand(command: string, args: readonly string[]) {
        calls.push({ command, args: [...args] });
        const invocation = args.join(" ");
        if (command === canonicalCodexPath) {
          if (invocation === "plugin marketplace list --json") {
            return JSON.stringify({
              marketplaces: codexManagedMarketplaceRoot === null
                ? []
                : [{
                    name: "oh-my-harness",
                    root: codexManagedMarketplaceRoot,
                  }],
            });
          }
          if (invocation === "plugin list --json") {
            return JSON.stringify({
              installed: codexPluginInstalled
                && codexManagedMarketplaceRoot !== null
                ? [{
                    enabled: true,
                    installed: true,
                    marketplaceName: "oh-my-harness",
                    pluginId: "oh-my-harness@oh-my-harness",
                    source: {
                      path: join(
                        codexManagedMarketplaceRoot,
                        "plugins",
                        "oh-my-harness",
                      ),
                      source: "local",
                    },
                  }]
                : [],
            });
          }
          if (invocation.startsWith("plugin marketplace remove ")) {
            codexManagedMarketplaceRoot = null;
            return "{}";
          }
          codexFailureHook?.();
          throw new Error(`unexpected Codex mutation: ${invocation}`);
        }
        if (invocation === "plugin marketplace list --json") {
          return JSON.stringify([...marketplaces].map(([name, path]) => ({
            name,
            path,
          })));
        }
        if (invocation === "plugin list --json") {
          const plugins = [...officialInstalled].map((id) => ({
            enabled: true,
            id,
            installPath: officialInstallPaths.get(id),
            scope: "user",
            version: "1.0.0",
          }));
          if (pluginInstalled && managedMarketplaceRoot !== null) {
            plugins.push({
              enabled: true,
              id: "oh-my-harness@oh-my-harness",
              installPath: join(
                managedMarketplaceRoot,
                "plugins",
                "oh-my-harness",
              ),
              scope: "user",
              version: managedPluginVersion,
            });
          }
          const result = JSON.stringify(plugins);
          managedUpgradeInspectionHook?.();
          return result;
        }
        if (invocation.startsWith("plugin marketplace add ")) {
          const marketplaceRoot = args[3];
          assert.ok(marketplaceRoot);
          const manifest = JSON.parse(
            readFileSync(
              join(marketplaceRoot, ".claude-plugin", "marketplace.json"),
              "utf8",
            ),
          ) as { name: string };
          marketplaces.set(manifest.name, marketplaceRoot);
          if (manifest.name === "oh-my-harness") {
            managedMarketplaceRoot = marketplaceRoot;
          }
        }
        if (invocation.startsWith("plugin marketplace remove ")) {
          const name = args[3];
          if (name !== undefined) marketplaces.delete(name);
          if (name === "oh-my-harness") managedMarketplaceRoot = null;
        }
        if (invocation.startsWith("plugin install ")) {
          const selector = args[2];
          if (selector === "oh-my-harness@oh-my-harness") {
            pluginInstalled = true;
            assert.ok(managedMarketplaceRoot);
            managedPluginVersion = JSON.parse(
              readFileSync(
                join(
                  managedMarketplaceRoot,
                  "plugins",
                  "oh-my-harness",
                  ".claude-plugin",
                  "plugin.json",
                ),
                "utf8",
              ),
            ).version as string;
            managedUpgradeDrift?.();
          } else if (selector !== undefined) {
            officialInstalled.add(selector);
          }
        }
        if (invocation.startsWith("plugin uninstall ")) {
          const selector = args[2];
          if (selector === "oh-my-harness@oh-my-harness") {
            pluginInstalled = false;
          } else if (selector !== undefined) {
            officialInstalled.delete(selector);
          }
        }
        return "";
      },
    };
    const mutationCount = () =>
      calls.filter(({ args }) =>
        /^(?:plugin marketplace (?:add|remove)|plugin (?:add|install|remove|uninstall)) /u.test(
          args.join(" "),
        )
      ).length;
    const hostPreview = await runOmh(
      [
        "setup",
        "--profile",
        "mds-host",
        "--agents",
        "claude-code",
        "--root",
        join(root, "host-state"),
      ],
      commonOptions,
    );
    assert.equal(hostPreview.state, "preview");
    assert.equal(hostPreview.preview?.readiness, "preview");
    assert.deepEqual(hostPreview.preview?.packages, []);
    assert.deepEqual(
      hostPreview.preview?.agents.map(
        ({ id, ownership, state }) => ({ id, ownership, state }),
      ),
      [{ id: "claude-code", ownership: "external", state: "ready" }],
    );
    const hostAgentAction = hostPreview.preview?.plan?.actions.find(
      ({ id }) => id === "agent:claude-code",
    );
    assert.equal(
      hostAgentAction?.target,
      join(
        realpathSync(root),
        "host-state",
        "external",
        "agents",
        "claude-code",
      ),
    );
    assert.equal(hostAgentAction?.payload?.operation, "verify-agent");
    assert.equal(
      hostPreview.preview?.plan?.actions.some(
        ({ payload }) => payload?.operation === "acquire-agent",
      ),
      false,
    );
    assert.equal(existsSync(join(root, "host-state")), false);
    const hostCatalogRevision = hostPreview.preview?.catalogRevision;
    assert.ok(hostCatalogRevision);

    await t.test(
      "mds-host selected caller-owned runtimes share verify-agent planning",
      async () => {
        for (const agentId of ["claude-code", "opencode", "codex"] as const) {
          const selected = await runOmh(
            [
              "setup",
              "--profile",
              "mds-host",
              "--agents",
              agentId,
              "--root",
              join(root, `host-${agentId}-preview-state`),
            ],
            commonOptions,
          );
          assert.equal(
            selected.state,
            "preview",
            JSON.stringify(selected.preview, null, 2),
          );
          const verifyAgent = selected.preview?.plan?.actions.find(
            ({ id }) => id === `agent:${agentId}`,
          );
          assert.equal(verifyAgent?.payload?.operation, "verify-agent");
          assert.equal(verifyAgent?.payload?.ownershipScope, "external");
          assert.equal(
            selected.preview?.plan?.actions.some(
              ({ payload }) => payload?.operation === "acquire-agent",
            ),
            false,
          );
        }
      },
    );

    await t.test(
      "mds-host add-ons stay previewable without ambient package managers and bind agent bytes rather than paths",
      async () => {
        const isolatedEnvironment = {
          ...env,
          PATH: binaryRoot,
        };
        for (const agentId of ["opencode", "codex"] as const) {
          const preview = previewEnvironment(
            {
              profileId: "mds-host",
              selectedAgents: [agentId],
              selectedPackages: [],
              stateRoot: join(root, `isolated-${agentId}-state`),
            },
            { ...commonOptions, env: isolatedEnvironment },
          );
          assert.equal(
            preview.readiness,
            "preview",
            JSON.stringify(preview, null, 2),
          );
          assert.equal(preview.addons[0]?.state, "installable");
        }

        const alternateBinaryRoot = join(root, "alternate-bin");
        mkdirSync(alternateBinaryRoot);
        const alternateCodexPath = join(alternateBinaryRoot, "codex");
        copyFileSync(canonicalCodexPath, alternateCodexPath);
        chmodSync(alternateCodexPath, 0o755);
        const stateRoot = join(root, "path-independent-codex-state");
        const selection = {
          profileId: "mds-host",
          selectedAgents: ["codex"],
          selectedPackages: [],
          stateRoot,
        } as const;
        const first = previewEnvironment(selection, {
          ...commonOptions,
          env: { ...isolatedEnvironment, PATH: binaryRoot },
        });
        const second = previewEnvironment(selection, {
          ...commonOptions,
          env: { ...isolatedEnvironment, PATH: alternateBinaryRoot },
          runCommand(command, args) {
            return commonOptions.runCommand(
              command === realpathSync(alternateCodexPath)
                ? canonicalCodexPath
                : command,
              args,
            );
          },
        });
        assert.equal(first.readiness, "preview");
        assert.equal(second.readiness, "preview");
        assert.equal(first.digest, second.digest);
      },
    );

    await t.test(
      "mds-host selected Claude apply reaches native registration and converges idempotently",
      async () => {
        const selectedCallsStart = calls.length;
        const selectedStateRoot = join(root, "host-claude-apply-state");
        const selectedArgs = [
          "setup",
          "--profile",
          "mds-host",
          "--agents",
          "claude-code",
          "--root",
          selectedStateRoot,
        ] as const;
        const selectedPreview = await runOmh(selectedArgs, commonOptions);
        assert.ok(selectedPreview.preview?.digest);
        const mutationsBefore = mutationCount();
        const selectedApplied = await runOmh(
          [
            ...selectedArgs,
            "--apply",
            "--digest",
            selectedPreview.preview.digest,
          ],
          commonOptions,
        );
        assert.equal(
          selectedApplied.state,
          "ready",
          JSON.stringify(selectedApplied.apply, null, 2),
        );
        assert.equal(mutationCount() > mutationsBefore, true);
        const selectedReceipt = JSON.parse(readFileSync(
          join(selectedStateRoot, "receipts", "environment.json"),
          "utf8",
        )) as { ownership: Array<{ id: string; scope: string }> };
        assert.equal(selectedReceipt.ownership.find(
          ({ id }) => id === "agent:claude-code",
        )?.scope, "external");
        const selectedStatus = await runOmh(
          ["status", "--root", selectedStateRoot],
          commonOptions,
        );
        assert.equal(selectedStatus.state, "ready");

        const repeatedPreview = await runOmh(selectedArgs, commonOptions);
        assert.ok(repeatedPreview.preview?.digest);
        const mutationsAfterApply = mutationCount();
        const repeatedApply = await runOmh(
          [
            ...selectedArgs,
            "--apply",
            "--digest",
            repeatedPreview.preview.digest,
          ],
          commonOptions,
        );
        assert.equal(repeatedApply.state, "ready");
        assert.equal(mutationCount(), mutationsAfterApply);

        pluginInstalled = false;
        managedMarketplaceRoot = null;
        marketplaces.clear();
        officialInstalled.clear();
        calls.splice(selectedCallsStart);
      },
    );

    await t.test(
      "mds-host apply rejects caller-owned executable drift before mutation",
      async () => {
        const driftArgs = [
          "setup",
          "--profile",
          "mds-host",
          "--agents",
          "opencode",
          "--root",
          join(root, "host-opencode-drift-state"),
        ] as const;
        const driftPreview = await runOmh(driftArgs, commonOptions);
        assert.ok(driftPreview.preview?.digest);
        const executableBytes = readFileSync(openCodePath);
        const mutationsBefore = mutationCount();
        try {
          writeFileSync(openCodePath, Buffer.concat([
            executableBytes,
            Buffer.from("\n# drift\n"),
          ]));
          chmodSync(openCodePath, 0o755);
          await assert.rejects(
            runOmh(
              [
                ...driftArgs,
                "--apply",
                "--digest",
                driftPreview.preview.digest,
              ],
              commonOptions,
            ),
            /environment preview is blocked: agent:opencode/u,
          );
          assert.equal(mutationCount(), mutationsBefore);
        } finally {
          writeFileSync(openCodePath, executableBytes);
          chmodSync(openCodePath, 0o755);
        }
      },
    );

    await t.test(
      "interrupted native registrations recover from journal selection before a new selection",
      async () => {
        const recoveryCallsStart = calls.length;
        for (const agentId of ["claude-code", "codex"] as const) {
          const recoveryStateRoot = join(root, `host-${agentId}-recovery-state`);
          const selection = {
            profileId: "mds-host",
            selectedAgents: [agentId],
            selectedPackages: [],
            stateRoot: recoveryStateRoot,
          };
          const preview = previewEnvironment(selection, commonOptions);
          assert.ok(preview.plan);
          assert.ok(preview.digest);
          const runtimeAction = preview.plan.actions.find(
            ({ id }) => id === `runtime:${agentId}:native`,
          );
          assert.ok(runtimeAction);
          const activeRoot = inspectManagedRuntimePayload(
            repositoryRoot,
            recoveryStateRoot,
          ).activeRoot;
          const backupRoot = join(
            recoveryStateRoot,
            "journal",
            "rollback",
            `${agentId}-interrupted`,
          );
          mkdirSync(backupRoot, { recursive: true });
          writeFileSync(
            join(recoveryStateRoot, "journal", "apply.json"),
            `${JSON.stringify({
              catalogRevision: preview.catalogRevision,
              completedActionIds: [],
              kind: "apply-journal",
              pendingRecoveries: [{
                actionId: runtimeAction.id,
                kind: "environment-action-v1",
                payload: {
                  backupRoot,
                  native: {
                    activeRoot,
                    executablePath: agentId === "claude-code"
                      ? realpathSync(claudePath)
                      : canonicalCodexPath,
                    kind: agentId === "claude-code"
                      ? "claude-runtime-absent"
                      : "codex-runtime-absent",
                    receiptPath: preview.receiptPath,
                  },
                  operation: "register-runtime",
                  schemaVersion: "2.0.0",
                  selection: {
                    clean: false,
                    profileId: "mds-host",
                    selectedAgents: [agentId],
                    stateRoot: dirname(dirname(preview.receiptPath)),
                  },
                  snapshots: [{
                    existed: false,
                    expectedKind: "file",
                    target: runtimeAction.target,
                  }],
                },
              }],
              planDigest: preview.digest,
              schemaVersion: "2.0.0",
              status: "partial-unready",
            }, null, 2)}\n`,
          );
          if (agentId === "claude-code") {
            marketplaces.set("oh-my-harness", activeRoot);
            managedMarketplaceRoot = activeRoot;
            pluginInstalled = false;
          } else {
            codexManagedMarketplaceRoot = activeRoot;
            codexPluginInstalled = false;
          }

          await assert.rejects(
            applyEnvironment(
              {
                ...selection,
                selectedAgents: [
                  agentId === "claude-code" ? "opencode" : "claude-code",
                ],
              },
              "0".repeat(64),
              commonOptions,
            ),
            StalePreviewError,
          );

          const recoveredJournal = JSON.parse(readFileSync(
            join(recoveryStateRoot, "journal", "apply.json"),
            "utf8",
          )) as { pendingRecoveries: unknown[] };
          assert.deepEqual(recoveredJournal.pendingRecoveries, []);
          assert.equal(existsSync(backupRoot), false);
          assert.equal(
            agentId === "claude-code"
              ? marketplaces.has("oh-my-harness")
              : codexManagedMarketplaceRoot !== null,
            false,
          );
          const recoveredPreview = previewEnvironment(selection, commonOptions);
          assert.equal(
            recoveredPreview.readiness,
            "preview",
            JSON.stringify(recoveredPreview, null, 2),
          );
          assert.equal(recoveredPreview.digest, preview.digest);
          rmSync(recoveryStateRoot, { force: true, recursive: true });
        }
        calls.splice(recoveryCallsStart);
      },
    );
    await t.test(
      "selection-less legacy OpenCode recovery records remain readable",
      async () => {
        const stateRoot = join(root, "legacy-opencode-recovery-state");
        const selection = {
          profileId: "mds-host",
          selectedAgents: [],
          selectedPackages: [],
          stateRoot,
        };
        const preview = previewEnvironment(selection, commonOptions);
        assert.ok(preview.plan);
        assert.ok(preview.digest);
        const journalRoot = join(preview.stateRoot, "journal");
        const backupRoot = join(journalRoot, "rollback", "legacy-opencode");
        const legacyTarget = join(
          preview.stateRoot,
          "markers",
          "legacy-opencode-source",
        );
        mkdirSync(journalRoot, { recursive: true });
        writeFileSync(
          join(journalRoot, "apply.json"),
          `${JSON.stringify({
            catalogRevision: preview.catalogRevision,
            completedActionIds: [],
            kind: "apply-journal",
            pendingRecoveries: [{
              actionId: "addon:opencode:omo:source",
              kind: "environment-action-v1",
              payload: {
                backupRoot,
                native: null,
                operation: "verify-opencode-addon-source",
                schemaVersion: "2.0.0",
                snapshots: [{
                  existed: false,
                  expectedKind: "file",
                  target: legacyTarget,
                }],
              },
            }],
            planDigest: preview.digest,
            schemaVersion: "2.0.0",
            status: "partial-unready",
          }, null, 2)}\n`,
        );

        await applyEnvironment(selection, preview.digest, commonOptions);
        const recovered = JSON.parse(readFileSync(
          join(journalRoot, "apply.json"),
          "utf8",
        )) as { pendingRecoveries: unknown[] };
        assert.deepEqual(recovered.pendingRecoveries, []);
        assert.equal(existsSync(legacyTarget), false);
      },
    );
    const verifyPreviousNativePreview = (
      agentId: "claude-code" | "codex",
      activate: (payloadRoot: string, receiptPath: string) => void,
      deactivate: () => void,
      verifyNative?: (payloadRoot: string, receiptPath: string) => void,
    ): void => {
      const stateRoot = join(root, `previous-${agentId}-clean-state`);
      const payloadRoot = join(
        stateRoot,
        "payloads",
        "generations",
        "previous",
      );
      mkdirSync(join(payloadRoot, "plugins"), { recursive: true });
      cpSync(
        join(repositoryRoot, "plugins", "oh-my-harness"),
        join(payloadRoot, "plugins", "oh-my-harness"),
        { recursive: true },
      );
      if (agentId === "claude-code") {
        const manifestPath = join(
          payloadRoot,
          "plugins",
          "oh-my-harness",
          ".claude-plugin",
          "plugin.json",
        );
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        manifest.version = "0.3.1";
        writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      }
      const receiptPath = writePreviousManagedReceipt(
        stateRoot,
        payloadRoot,
        agentId,
        hostCatalogRevision,
      );
      const receiptBytes = readFileSync(receiptPath, "utf8");
      const input = {
        clean: true,
        profileId: "mds-host" as const,
        selectedAgents: [agentId],
        selectedPackages: [],
        stateRoot,
      };

      activate(payloadRoot, receiptPath);
      try {
        verifyNative?.(payloadRoot, receiptPath);
        const preview = previewEnvironment(input, commonOptions);
        const repeated = previewEnvironment(input, commonOptions);
        assert.equal(
          preview.readiness,
          "preview",
          JSON.stringify(preview, null, 2),
        );
        assert.ok(preview.plan);
        assert.equal(preview.digest, repeated.digest);
        assert.equal(
          preview.plan.actions.find(
            ({ id }) => id === `runtime:${agentId}:native`,
          )?.payload?.previousActiveRoot,
          payloadRoot,
        );
        assert.equal(mutationCount(), 0);
        assert.equal(readFileSync(receiptPath, "utf8"), receiptBytes);

        rmSync(join(payloadRoot, "plugins", "oh-my-harness"), {
          recursive: true,
        });
        const partial = previewEnvironment(input, commonOptions);
        assert.equal(partial.readiness, "blocked");
        assert.equal(partial.plan, null);
        assert.equal(
          partial.blockers.includes(`native-registration:${agentId}`),
          true,
        );
        assert.equal(mutationCount(), 0);
        assert.equal(readFileSync(receiptPath, "utf8"), receiptBytes);
      } finally {
        deactivate();
      }
    };

    const currentOnlyStateRoot = join(root, "current-only-clean-state");
    const previousPayloadRoot = join(
      currentOnlyStateRoot,
      "payloads",
      "generations",
      "previous",
    );
    const currentPayload = inspectManagedRuntimePayload(
      repositoryRoot,
      currentOnlyStateRoot,
    );
    mkdirSync(join(currentPayload.activeRoot, "plugins"), { recursive: true });
    cpSync(
      join(repositoryRoot, "plugins", "oh-my-harness"),
      join(currentPayload.activeRoot, "plugins", "oh-my-harness"),
      { recursive: true },
    );
    const currentOnlyReceiptRoot = join(currentOnlyStateRoot, "receipts");
    mkdirSync(currentOnlyReceiptRoot, { recursive: true });
    writeFileSync(
      join(currentOnlyReceiptRoot, "environment.json"),
      `${JSON.stringify({
        $schema: "../contracts/managed-state-receipt.schema.json",
        appliedAt: "2026-08-04T00:00:00.000Z",
        catalogRevision: hostPreview.preview?.catalogRevision,
        completedActionIds: [],
        desiredState: {
          profileId: "mds-host",
          selectedAgents: ["claude-code"],
        },
        kind: "managed-state-receipt",
        ownership: [
          {
            digest: "a".repeat(64),
            id: "plugin:runtime-package",
            kind: "directory",
            scope: "managed",
            target: previousPayloadRoot,
          },
          {
            digest: "b".repeat(64),
            id: "runtime:claude-code:native",
            kind: "registration",
            scope: "managed",
            target: join(
              currentOnlyStateRoot,
              "markers",
              "runtimes",
              "claude-code.json",
            ),
          },
        ],
        planDigest: "c".repeat(64),
        runtimeReadiness: [{ agentId: "claude-code", state: "ready" }],
        schemaVersion: "2.0.0",
        startupConsent: {
          addReviewedContent: true,
          artifactClasses: ["managed-skill"],
          channelId: "stable",
          permissionScopes: ["workspace:read"],
          profileId: "mds-host",
          repairPinned: true,
        },
      }, null, 2)}\n`,
    );
    managedMarketplaceRoot = currentPayload.activeRoot;
    marketplaces.set("oh-my-harness", currentPayload.activeRoot);
    pluginInstalled = true;
    const currentOnlyPreview = previewEnvironment(
      {
        clean: true,
        profileId: "mds-host",
        selectedAgents: ["claude-code"],
        selectedPackages: [],
        stateRoot: currentOnlyStateRoot,
      },
      commonOptions,
    );
    assert.equal(currentOnlyPreview.readiness, "blocked");
    assert.equal(currentOnlyPreview.plan, null);
    assert.equal(
      currentOnlyPreview.blockers.includes(
        "native-registration:claude-code",
      ),
      true,
    );
    assert.equal(mutationCount(), 0);
    pluginInstalled = false;
    managedMarketplaceRoot = null;
    marketplaces.delete("oh-my-harness");

    await t.test(
      "clean Claude preview rejects an exact receipt payload outside its state root without mutation",
      () => {
        const stateRoot = join(realpathSync(root), "outside-predecessor-state");
        const outsideRoot = join(realpathSync(root), "outside-predecessor-payload");
        const currentPayload = inspectManagedRuntimePayload(
          repositoryRoot,
          stateRoot,
        );
        materializeManagedRuntimePayload(currentPayload);
        cpSync(currentPayload.activeRoot, outsideRoot, { recursive: true });
        const manifestPath = join(
          outsideRoot,
          "plugins",
          "oh-my-harness",
          ".claude-plugin",
          "plugin.json",
        );
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        manifest.version = "0.3.1";
        writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
        writePreviousManagedReceipt(
          stateRoot,
          outsideRoot,
          "claude-code",
          hostCatalogRevision,
        );
        managedMarketplaceRoot = outsideRoot;
        marketplaces.set("oh-my-harness", outsideRoot);
        pluginInstalled = true;
        managedPluginVersion = "0.3.1";
        const mutationsBefore = mutationCount();
        try {
          const preview = previewEnvironment(
            {
              clean: true,
              profileId: "mds-host",
              selectedAgents: ["claude-code"],
              selectedPackages: [],
              stateRoot,
            },
            commonOptions,
          );
          assert.equal(preview.readiness, "blocked");
          assert.equal(preview.plan, null);
          assert.equal(
            preview.blockers.includes("native-registration:claude-code"),
            true,
          );
          assert.equal(mutationCount(), mutationsBefore);
        } finally {
          pluginInstalled = false;
          managedMarketplaceRoot = null;
          managedPluginVersion = "0.3.2";
          marketplaces.delete("oh-my-harness");
        }
      },
    );

    verifyPreviousNativePreview(
      "claude-code",
      (payloadRoot) => {
        managedMarketplaceRoot = payloadRoot;
        marketplaces.set("oh-my-harness", payloadRoot);
        pluginInstalled = true;
        managedPluginVersion = "0.3.1";
      },
      () => {
        pluginInstalled = false;
        managedMarketplaceRoot = null;
        managedPluginVersion = "0.3.2";
        marketplaces.delete("oh-my-harness");
      },
    );

    await t.test(
      "clean Claude upgrade rolls back to v0.3.1 on a later failure and then converges to v0.3.2",
      async () => {
        const stateRoot = join(
          realpathSync(root),
          "claude-v0.3.1-upgrade-state",
        );
        const currentPayload = inspectManagedRuntimePayload(
          repositoryRoot,
          stateRoot,
        );
        materializeManagedRuntimePayload(currentPayload);
        const previousRoot = join(
          stateRoot,
          "payloads",
          "generations",
          "previous",
        );
        cpSync(
          currentPayload.activeRoot,
          previousRoot,
          { recursive: true },
        );
        const previousManifestPath = join(
          previousRoot,
          "plugins",
          "oh-my-harness",
          ".claude-plugin",
          "plugin.json",
        );
        const previousManifest = JSON.parse(
          readFileSync(previousManifestPath, "utf8"),
        );
        previousManifest.version = "0.3.1";
        writeFileSync(
          previousManifestPath,
          `${JSON.stringify(previousManifest, null, 2)}\n`,
        );
        const previousReceiptPath = writePreviousManagedReceipt(
          stateRoot,
          previousRoot,
          "claude-code",
          hostCatalogRevision,
        );
        const previousPayloadDigest = hashManagedDirectory(previousRoot);
        const previousReceiptBytes = readFileSync(previousReceiptPath, "utf8");
        managedMarketplaceRoot = previousRoot;
        marketplaces.set("oh-my-harness", previousRoot);
        pluginInstalled = true;
        managedPluginVersion = "0.3.1";

        const selection = {
          clean: true,
          profileId: "mds-host",
          selectedAgents: ["claude-code"],
          selectedPackages: [],
          stateRoot,
        } as const;
        try {
          const failureSelection = {
            ...selection,
            selectedAgents: ["claude-code", "codex"],
          } as const;
          const failurePreview = previewEnvironment(
            failureSelection,
            commonOptions,
          );
          assert.equal(
            failurePreview.readiness,
            "preview",
            JSON.stringify(failurePreview, null, 2),
          );
          assert.ok(failurePreview.plan);
          assert.ok(failurePreview.digest);
          const claudeActionIndex = failurePreview.plan.actions.findIndex(
            ({ id }) => id === "runtime:claude-code:native",
          );
          const codexActionIndex = failurePreview.plan.actions.findIndex(
            ({ id }) => id === "runtime:codex:native",
          );
          assert.equal(claudeActionIndex >= 0, true);
          assert.equal(codexActionIndex > claudeActionIndex, true);

          const failed = await applyEnvironment(
            failureSelection,
            failurePreview.digest,
            commonOptions,
          );
          assert.equal(failed.result.status, "partial-unready");
          assert.match(
            failed.result.failure ?? "",
            /unexpected Codex mutation/u,
          );
          assert.equal(managedMarketplaceRoot, previousRoot);
          assert.equal(managedPluginVersion, "0.3.1");
          assert.equal(pluginInstalled, true);
          assert.equal(
            readFileSync(previousReceiptPath, "utf8"),
            previousReceiptBytes,
          );
          const failedJournal = JSON.parse(readFileSync(
            join(stateRoot, "journal", "apply.json"),
            "utf8",
          )) as { pendingRecoveries: unknown[] };
          assert.deepEqual(failedJournal.pendingRecoveries, []);

          const executeGuardPreview = previewEnvironment(
            failureSelection,
            commonOptions,
          );
          assert.ok(executeGuardPreview.digest);
          let inspectionCount = 0;
          const executeDriftPath = join(
            previousRoot,
            "pre-execute-drift.txt",
          );
          managedUpgradeInspectionHook = () => {
            inspectionCount += 1;
            if (inspectionCount === 2) {
              queueMicrotask(() => {
                writeFileSync(executeDriftPath, "drift\n");
              });
            }
          };
          const executeDrifted = await applyEnvironment(
            failureSelection,
            executeGuardPreview.digest,
            commonOptions,
          );
          assert.equal(executeDrifted.result.status, "partial-unready");
          assert.match(
            executeDrifted.result.failure ?? "",
            /claude-code prior managed payload identity changed/u,
          );
          assert.equal(managedMarketplaceRoot, previousRoot);
          assert.equal(pluginInstalled, true);
          assert.equal(managedPluginVersion, "0.3.1");
          managedUpgradeInspectionHook = undefined;
          rmSync(executeDriftPath);
          await assert.rejects(
            applyEnvironment(
              selection,
              "0".repeat(64),
              commonOptions,
            ),
            StalePreviewError,
          );

          managedUpgradeDrift = () => {
            writeFileSync(
              join(previousRoot, "post-capture-drift.txt"),
              "drift\n",
            );
          };
          const driftPreview = previewEnvironment(
            failureSelection,
            commonOptions,
          );
          assert.ok(driftPreview.digest);
          const drifted = await applyEnvironment(
            failureSelection,
            driftPreview.digest,
            commonOptions,
          );
          assert.equal(drifted.result.status, "partial-unready");
          assert.match(
            drifted.result.failure ?? "",
            /rollback failed: runtime:claude-code:native: Claude prior runtime recovery identity changed/u,
          );
          assert.equal(managedPluginVersion, "0.3.2");
          const driftedJournalPath = join(stateRoot, "journal", "apply.json");
          const driftedJournalBytes = readFileSync(driftedJournalPath, "utf8");
          const driftedJournal = JSON.parse(driftedJournalBytes) as {
            pendingRecoveries: Array<{
              payload: {
                native: { previousPayloadDigest?: string };
              };
            }>;
          };
          assert.equal(driftedJournal.pendingRecoveries.length > 0, true);
          assert.equal(
            driftedJournal.pendingRecoveries[0]?.payload.native
              .previousPayloadDigest,
            previousPayloadDigest,
          );

          managedUpgradeDrift = undefined;
          delete driftedJournal.pendingRecoveries[0]?.payload.native
            .previousPayloadDigest;
          writeFileSync(
            driftedJournalPath,
            `${JSON.stringify(driftedJournal, null, 2)}\n`,
          );
          await assert.rejects(
            applyEnvironment(
              selection,
              "0".repeat(64),
              commonOptions,
            ),
            /invalid native recovery record: runtime:claude-code:native/u,
          );
          assert.equal(managedPluginVersion, "0.3.2");
          writeFileSync(driftedJournalPath, driftedJournalBytes);

          const driftedReceipt = JSON.parse(
            readFileSync(previousReceiptPath, "utf8"),
          ) as {
            ownership: Array<{ digest: string; id: string }>;
          };
          const driftedPayloadOwnership = driftedReceipt.ownership.find(
            ({ id }) => id === "plugin:runtime-package",
          );
          assert.ok(driftedPayloadOwnership);
          driftedPayloadOwnership.digest = hashManagedDirectory(previousRoot);
          writeFileSync(
            previousReceiptPath,
            `${JSON.stringify(driftedReceipt, null, 2)}\n`,
          );
          await assert.rejects(
            applyEnvironment(
              selection,
              "0".repeat(64),
              commonOptions,
            ),
            /interrupted apply recovery failed for runtime:claude-code:native: Claude prior runtime recovery digest changed/u,
          );
          assert.equal(managedPluginVersion, "0.3.2");

          rmSync(join(previousRoot, "post-capture-drift.txt"));
          writeFileSync(previousReceiptPath, previousReceiptBytes);
          await assert.rejects(
            applyEnvironment(
              selection,
              "0".repeat(64),
              commonOptions,
            ),
            StalePreviewError,
          );
          assert.equal(managedMarketplaceRoot, previousRoot);
          assert.equal(managedPluginVersion, "0.3.1");
          const recoveredJournal = JSON.parse(readFileSync(
            join(stateRoot, "journal", "apply.json"),
            "utf8",
          )) as { pendingRecoveries: unknown[] };
          assert.deepEqual(recoveredJournal.pendingRecoveries, []);

          const preview = previewEnvironment(selection, commonOptions);
          assert.equal(
            preview.readiness,
            "preview",
            JSON.stringify(preview, null, 2),
          );
          assert.ok(preview.digest);
          const applied = await applyEnvironment(
            selection,
            preview.digest,
            commonOptions,
          );
          assert.equal(
            applied.result.status,
            "ready",
            applied.result.failure,
          );
          assert.equal(managedPluginVersion, "0.3.2");
          assert.equal(
            managedMarketplaceRoot,
            inspectManagedRuntimePayload(repositoryRoot, stateRoot).activeRoot,
          );
        } finally {
          pluginInstalled = false;
          managedMarketplaceRoot = null;
          managedPluginVersion = "0.3.2";
          managedUpgradeInspectionHook = undefined;
          managedUpgradeDrift = undefined;
          marketplaces.clear();
          officialInstalled.clear();
          calls.splice(0);
        }
      },
    );

    await t.test(
      "clean OpenCode rollback rejects a drifted receipt-owned predecessor",
      async () => {
        const stateRoot = join(
          realpathSync(root),
          "opencode-predecessor-rollback-state",
        );
        const currentPayload = inspectManagedRuntimePayload(
          repositoryRoot,
          stateRoot,
        );
        materializeManagedRuntimePayload(currentPayload);
        const previousRoot = join(
          stateRoot,
          "payloads",
          "generations",
          "previous",
        );
        cpSync(currentPayload.activeRoot, previousRoot, { recursive: true });
        writePreviousManagedReceipt(
          stateRoot,
          previousRoot,
          "opencode",
          hostCatalogRevision,
        );
        const upgradeOpenCodeConfigPath = join(
          env.XDG_CONFIG_HOME,
          "opencode",
          "opencode.json",
        );
        const previousPluginUrl = pathToFileURL(join(
          previousRoot,
          ".opencode",
          "plugins",
          "oh-my-harness.js",
        )).href;
        const currentPluginUrl = pathToFileURL(join(
          currentPayload.activeRoot,
          ".opencode",
          "plugins",
          "oh-my-harness.js",
        )).href;
        mkdirSync(dirname(upgradeOpenCodeConfigPath), { recursive: true });
        writeFileSync(
          upgradeOpenCodeConfigPath,
          `${JSON.stringify({ plugin: [previousPluginUrl] }, null, 2)}\n`,
        );
        const selection = {
          clean: true,
          profileId: "mds-host",
          selectedAgents: ["opencode"],
          selectedPackages: [],
          stateRoot,
        } as const;
        const failureSelection = {
          ...selection,
          selectedAgents: ["opencode", "codex"],
        } as const;
        const preview = previewEnvironment(failureSelection, commonOptions);
        assert.ok(preview.plan, preview.blockers.join(", "));
        assert.ok(preview.digest);
        const openCodeActionIndex = preview.plan.actions.findIndex(
          ({ id }) => id === "runtime:opencode:native",
        );
        const codexActionIndex = preview.plan.actions.findIndex(
          ({ id }) => id === "runtime:codex:native",
        );
        assert.equal(openCodeActionIndex >= 0, true);
        assert.equal(codexActionIndex > openCodeActionIndex, true);
        const driftPath = join(previousRoot, "post-capture-drift.txt");
        codexFailureHook = () => writeFileSync(driftPath, "drift\n");
        try {
          const failed = await applyEnvironment(
            failureSelection,
            preview.digest,
            commonOptions,
          );
          assert.equal(failed.result.status, "partial-unready");
          assert.match(
            failed.result.failure ?? "",
            /rollback failed: runtime:opencode:native: OpenCode prior runtime recovery identity changed/u,
          );
          const failedConfig = JSON.parse(
            readFileSync(upgradeOpenCodeConfigPath, "utf8"),
          ) as { plugin: string[] };
          assert.deepEqual(failedConfig.plugin, [currentPluginUrl]);

          codexFailureHook = undefined;
          rmSync(driftPath);
          await assert.rejects(
            applyEnvironment(
              selection,
              "0".repeat(64),
              commonOptions,
            ),
            StalePreviewError,
          );
          const recoveredConfig = JSON.parse(
            readFileSync(upgradeOpenCodeConfigPath, "utf8"),
          ) as { plugin: string[] };
          assert.deepEqual(recoveredConfig.plugin, [previousPluginUrl]);
        } finally {
          codexFailureHook = undefined;
          codexManagedMarketplaceRoot = null;
          codexPluginInstalled = false;
          calls.splice(0);
          rmSync(upgradeOpenCodeConfigPath, { force: true });
        }
      },
    );

    verifyPreviousNativePreview(
      "codex",
      (payloadRoot) => {
        codexManagedMarketplaceRoot = payloadRoot;
        codexPluginInstalled = true;
      },
      () => {
        codexPluginInstalled = false;
        codexManagedMarketplaceRoot = null;
      },
      (payloadRoot, receiptPath) => {
        assert.deepEqual(
          inspectCodexManagedRuntimeRegistration(
            canonicalCodexPath,
            { activeRoot: payloadRoot, receiptPath },
            commonOptions.runCommand,
          ),
          { marketplace: "ready", plugin: "ready" },
        );
      },
    );

    const openCodeConfigPath = join(
      env.XDG_CONFIG_HOME,
      "opencode",
      "opencode.json",
    );
    const foreignOpenCodePlugin = `file://${join(
      root,
      "foreign",
      ".opencode",
      "plugins",
      "oh-my-harness.js",
    )}`;
    mkdirSync(join(openCodeConfigPath, ".."), { recursive: true });
    const foreignOpenCodeConfig = `${JSON.stringify({
      plugin: [foreignOpenCodePlugin],
    }, null, 2)}\n`;
    writeFileSync(openCodeConfigPath, foreignOpenCodeConfig);
    const openCodeStateRoot = join(root, "host-opencode-state");
    const openCodeCollision = await runOmh(
      [
        "setup",
        "--profile",
        "mds-host",
        "--agents",
        "opencode",
        "--root",
        openCodeStateRoot,
      ],
      commonOptions,
    );
    assertCliNativeRegistrationBlocked(openCodeCollision, "opencode");
    assert.equal(readFileSync(openCodeConfigPath, "utf8"), foreignOpenCodeConfig);
    assert.equal(existsSync(openCodeStateRoot), false);
    rmSync(openCodeConfigPath);

    codexManagedMarketplaceRoot = join(root, "foreign-codex-marketplace");
    const codexStateRoot = join(root, "host-codex-state");
    const codexCollision = await runOmh(
      [
        "setup",
        "--profile",
        "mds-host",
        "--agents",
        "codex",
        "--root",
        codexStateRoot,
      ],
      commonOptions,
    );
    assertCliNativeRegistrationBlocked(codexCollision, "codex");
    assert.equal(existsSync(codexStateRoot), false);
    assert.equal(mutationCount(), 0);
    codexManagedMarketplaceRoot = null;

    const previewArgs = [
      "setup",
      "--profile",
      "personal",
      "--agents",
      "claude-code",
      "--root",
      stateRoot,
    ] as const;

    const first = await runOmh(previewArgs, commonOptions);
    const second = await runOmh(previewArgs, commonOptions);
    assert.equal(first.state, "preview");
    assert.equal(first.exitCode, 2);
    assert.equal(first.preview?.digest, second.preview?.digest);
    assert.equal(existsSync(stateRoot), false);
    assert.equal(mutationCount(), 0);
    assert.ok(first.preview?.digest);
    const payloadAction = first.preview.plan?.actions.find(
      ({ id }) => id === "plugin:runtime-package",
    );
    const reconcilerIdentity = payloadAction?.payload?.receiptIdentity as
      | { readonly target?: unknown }
      | undefined;
    assert.equal(
      reconcilerIdentity?.target,
      join(payloadAction?.target ?? "", "dist", "cli", "main.js"),
      "preview must bind reconciliation to the stable managed generation",
    );

    const userOwnedMarketplace = join(root, "user-owned-marketplace");
    mkdirSync(userOwnedMarketplace);
    marketplaces.set("oh-my-harness", userOwnedMarketplace);
    const blockedByUserMarketplace = await runOmh(previewArgs, commonOptions);
    assertCliNativeRegistrationBlocked(
      blockedByUserMarketplace,
      "claude-code",
    );
    assert.equal(mutationCount(), 0);
    assert.equal(existsSync(stateRoot), false);
    assert.equal(marketplaces.get("oh-my-harness"), userOwnedMarketplace);
    assert.equal(pluginInstalled, false);
    marketplaces.delete("oh-my-harness");

    const applied = await runOmh(
      [...previewArgs, "--apply", "--digest", first.preview.digest],
      commonOptions,
    );
    assert.equal(applied.state, "ready");
    assert.equal(applied.exitCode, 0);
    assert.equal(
      calls.some(({ args }) => args.join(" ").startsWith("plugin marketplace add ")),
      true,
    );
    assert.equal(
      calls.some(({ args }) => args.join(" ").startsWith("plugin install ")),
      true,
    );
    const callsAfterApply = calls.length;
    const mutationsAfterApply = mutationCount();

    const idempotentPreview = await runOmh(previewArgs, commonOptions);
    assert.ok(idempotentPreview.preview?.digest);
    const reapplied = await runOmh(
      [
        ...previewArgs,
        "--apply",
        "--digest",
        idempotentPreview.preview.digest,
      ],
      commonOptions,
    );
    assert.equal(reapplied.state, "ready");
    assert.equal(mutationCount(), mutationsAfterApply);

    const officialSelector = [...officialInstalled][0];
    assert.ok(officialSelector);
    const reviewedOfficialPath = officialInstallPaths.get(officialSelector);
    assert.ok(reviewedOfficialPath);
    const conflictingOfficialPath = join(root, "user-owned-official-plugin");
    mkdirSync(conflictingOfficialPath);
    writeFileSync(join(conflictingOfficialPath, "user.txt"), "keep me\n");
    officialInstallPaths.set(officialSelector, conflictingOfficialPath);
    const officialCollisionPreview = await runOmh(previewArgs, commonOptions);
    assert.ok(officialCollisionPreview.preview?.digest);
    const callsBeforeOfficialCollision = calls.length;
    const officialCollision = await runOmh(
      [
        ...previewArgs,
        "--apply",
        "--digest",
        officialCollisionPreview.preview.digest,
      ],
      commonOptions,
    );
    assert.equal(officialCollision.state, "partial-unready");
    assert.match(officialCollision.apply?.failure ?? "", /user-owned Claude plugin/u);
    assert.equal(mutationCount(), mutationsAfterApply);
    assert.equal(
      calls.slice(callsBeforeOfficialCollision).some(
        ({ args }) => args.join(" ").startsWith("plugin uninstall "),
      ),
      false,
    );
    officialInstallPaths.set(officialSelector, reviewedOfficialPath);

    managedPluginVersion = "9.9.9";
    const collisionPreview = await runOmh(previewArgs, commonOptions);
    assertCliNativeRegistrationBlocked(collisionPreview, "claude-code");
    assert.equal(mutationCount(), mutationsAfterApply);
    managedPluginVersion = "0.3.2";

    const receiptPath = join(stateRoot, "receipts", "environment.json");
    assert.equal(existsSync(receiptPath), true);
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as {
      desiredState: { profileId: string; selectedAgents: string[] };
      ownership: Array<{
        id: string;
        kind: string;
        repairSource?: string;
        scope: string;
        target: string;
      }>;
    };
    assert.equal(receipt.desiredState.profileId, "personal");
    assert.deepEqual(receipt.desiredState.selectedAgents, ["claude-code"]);
    assert.deepEqual(
      receipt.ownership
        .filter(({ id }) => ["omh-node", "omh-reconciler", "agent:claude-code"].includes(id))
        .map(({ id, kind, scope }) => [id, kind, scope]),
      [
        ["omh-node", "file", "external"],
        ["omh-reconciler", "file", "external"],
        ["agent:claude-code", "executable", "external"],
      ],
    );
    assert.equal(
      receipt.ownership.find(({ id }) => id === "plugin:runtime-package")?.scope,
      "managed",
    );

    const status = await runOmh(
      ["status", "--root", stateRoot],
      commonOptions,
    );
    assert.equal(status.state, "ready");
    assert.equal(status.status?.profileId, "personal");
    assert.equal(status.status?.catalogRevision, status.status?.currentCatalogRevision);
    assert.equal(status.status?.capabilities.every(({ state }) => state === "ready"), true);

    const doctor = await runOmh(
      ["doctor", "--root", stateRoot],
      commonOptions,
    );
    assert.equal(doctor.state, "ready");
    assert.equal(doctor.status?.blockers.length, 0);

    const startup = await runOmh(
      [
        "startup",
        "--runtime",
        "claude-code",
        "--mode",
        "native-post-discovery",
        "--receipt",
        receiptPath,
        "--format",
        "json",
      ],
      commonOptions,
    );
    assert.equal(startup.envelope?.context.profileId, "personal");
    const expectedStartupMode = process.platform === "win32"
      ? "degraded"
      : "ready";
    assert.equal(
      startup.envelope?.context.mode,
      expectedStartupMode,
      JSON.stringify(startup.envelope, null, 2),
    );
    assert.match(startup.envelope?.renderedContext ?? "", /profile: personal/);
    assert.match(startup.envelope?.renderedContext ?? "", /capabilities:/);
    assert.match(startup.envelope?.renderedContext ?? "", /packages:/);

    const payload = receipt.ownership.find(
      ({ id }) => id === "plugin:runtime-package",
    );
    assert.ok(payload?.repairSource);
    const reconciler = receipt.ownership.find(
      ({ id }) => id === "omh-reconciler",
    );
    assert.equal(
      reconciler?.target,
      join(payload.target, "dist", "cli", "main.js"),
      "startup reconciliation must use the target-owned managed generation",
    );
    rmSync(payload.target, { recursive: true, force: true });
    const drifted = await runOmh(
      ["status", "--root", stateRoot],
      commonOptions,
    );
    assert.equal(drifted.state, "unverifiable");
    assert.ok(drifted.status?.blockers.includes("plugin:runtime-package"));
    const repaired = await runOmh(
      [
        "startup",
        "--runtime",
        "claude-code",
        "--mode",
        "managed-prelaunch",
        "--receipt",
        receiptPath,
        "--format",
        "json",
      ],
      commonOptions,
    );
    assert.equal(repaired.envelope?.context.mode, expectedStartupMode);
    assert.equal(existsSync(payload.target), true);

    const stale = await runOmh(
      [...previewArgs, "--apply", "--digest", first.preview.digest],
      commonOptions,
    );
    assert.equal(stale.state, "stale-preview");
    assert.equal(stale.exitCode, 4);
    assert.ok(calls.length > callsAfterApply);
    assert.equal(mutationCount(), mutationsAfterApply);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
