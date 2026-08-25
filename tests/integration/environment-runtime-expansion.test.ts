import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadCatalogBundle } from "../../dist/catalog/load.js";
import { previewEnvironment } from "../../dist/environment/orchestrator.js";
import {
  hashManagedDirectory,
  inspectManagedRuntimePayload,
  materializeManagedRuntimePayload,
} from "../../dist/install/managed-payload.js";
import { createTrustedWindowsToolPath } from "../support/trusted-windows-tools.js";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));

test("clean preview carries the prior payload root only for previously managed runtimes", () => {
  const root = mkdtempSync(join(tmpdir(), "omh-runtime-expansion-"));
  const stateRoot = join(root, "instances", "windows-native");
  const receiptRoot = join(stateRoot, "receipts");
  const previousActiveRoot = join(stateRoot, "payloads", "generations", "previous");
  const previousOpenCodeMarker = join(
    stateRoot,
    "markers",
    "runtimes",
    "opencode.json",
  );
  const configRoot = join(root, "config");

  try {
    const trustedTools = createTrustedWindowsToolPath(root);
    mkdirSync(receiptRoot, { recursive: true });
    mkdirSync(previousActiveRoot, { recursive: true });
    const catalog = loadCatalogBundle(REPOSITORY_ROOT);
    writeFileSync(
      join(receiptRoot, "environment.json"),
      JSON.stringify({
        $schema: "../contracts/managed-state-receipt.schema.json",
        schemaVersion: "2.0.0",
        kind: "managed-state-receipt",
        appliedAt: "2026-07-27T00:00:00.000Z",
        catalogRevision: catalog.revision,
        completedActionIds: [],
        desiredState: {
          capabilitySet: "workflow-only",
          instance: {
            id: "windows-native",
            platform: { arch: "x64", os: "win32" },
            stateRoot,
            transport: "local",
          },
          profileId: "personal",
          selectedAgents: ["opencode"],
          selectedCapabilities: ["goal"],
          selectedPackages: [],
          toolRoutes: [],
        },
        ownership: [
          {
            digest: hashManagedDirectory(previousActiveRoot),
            id: "plugin:runtime-package",
            kind: "directory",
            scope: "managed",
            target: previousActiveRoot,
          },
          {
            digest: "b".repeat(64),
            id: "runtime:opencode:native",
            kind: "registration",
            scope: "managed",
            target: previousOpenCodeMarker,
          },
        ],
        planDigest: "c".repeat(64),
        runtimeReadiness: [{ agentId: "opencode", state: "ready" }],
        startupConsent: {
          addReviewedContent: true,
          artifactClasses: ["managed-skill"],
          channelId: "stable",
          permissionScopes: ["workspace:read"],
          profileId: "personal",
          repairPinned: true,
        },
      }),
    );
    const openCodeConfig = join(configRoot, "opencode", "opencode.json");
    mkdirSync(join(configRoot, "opencode"), { recursive: true });
    writeFileSync(
      openCodeConfig,
      `${JSON.stringify({
        plugin: [pathToFileURL(join(
          previousActiveRoot,
          ".opencode",
          "plugins",
          "oh-my-harness.js",
        )).href],
      }, null, 2)}\n`,
    );

    const preview = previewEnvironment(
      {
        capabilitySet: "workflow-only",
        clean: true,
        profileId: "personal",
        selectedAgents: ["opencode", "codex"],
        selectedPackages: [],
        stateRoot,
        target: "windows-native",
      },
      {
        arch: "x64",
        env: {
          APPDATA: root,
          PATH: trustedTools,
          XDG_CONFIG_HOME: configRoot,
        },
        os: "win32",
        repositoryRoot: REPOSITORY_ROOT,
      },
    );

    assert.ok(preview.plan, preview.blockers.join(", "));
    const openCodeAction = preview.plan.actions.find(
      ({ id }) => id === "runtime:opencode:native",
    );
    const codexAction = preview.plan.actions.find(
      ({ id }) => id === "runtime:codex:native",
    );

    assert.equal(openCodeAction?.payload?.previousActiveRoot, previousActiveRoot);
    assert.equal(
      openCodeAction?.payload?.previousPayloadDigest,
      hashManagedDirectory(previousActiveRoot),
    );
    assert.equal(codexAction?.payload?.previousActiveRoot, undefined);
    assert.equal(codexAction?.payload?.previousPayloadDigest, undefined);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("clean preview accepts an exact receipt-owned current payload", () => {
  const root = mkdtempSync(join(tmpdir(), "omh-runtime-current-"));
  const stateRoot = join(root, "instances", "windows-native");
  const receiptRoot = join(stateRoot, "receipts");
  const currentOpenCodeMarker = join(
    stateRoot,
    "markers",
    "runtimes",
    "opencode.json",
  );
  const configRoot = join(root, "config");

  try {
    const trustedTools = createTrustedWindowsToolPath(root);
    const catalog = loadCatalogBundle(REPOSITORY_ROOT);
    const currentPayload = inspectManagedRuntimePayload(
      REPOSITORY_ROOT,
      stateRoot,
    );
    materializeManagedRuntimePayload(currentPayload);
    mkdirSync(receiptRoot, { recursive: true });
    writeFileSync(
      join(receiptRoot, "environment.json"),
      JSON.stringify({
        $schema: "../contracts/managed-state-receipt.schema.json",
        schemaVersion: "2.0.0",
        kind: "managed-state-receipt",
        appliedAt: "2026-08-07T00:00:00.000Z",
        catalogRevision: catalog.revision,
        completedActionIds: [],
        desiredState: {
          capabilitySet: "workflow-only",
          instance: {
            id: "windows-native",
            platform: { arch: "x64", os: "win32" },
            stateRoot,
            transport: "local",
          },
          profileId: "personal",
          selectedAgents: ["opencode"],
          selectedCapabilities: ["goal"],
          selectedPackages: [],
          toolRoutes: [],
        },
        ownership: [
          {
            digest: currentPayload.digest,
            id: "plugin:runtime-package",
            kind: "directory",
            scope: "managed",
            target: currentPayload.activeRoot,
          },
          {
            digest: "b".repeat(64),
            id: "runtime:opencode:native",
            kind: "registration",
            scope: "managed",
            target: currentOpenCodeMarker,
          },
        ],
        planDigest: "c".repeat(64),
        runtimeReadiness: [{ agentId: "opencode", state: "ready" }],
        startupConsent: {
          addReviewedContent: true,
          artifactClasses: ["managed-skill"],
          channelId: "stable",
          permissionScopes: ["workspace:read"],
          profileId: "personal",
          repairPinned: true,
        },
      }),
    );
    const openCodeConfig = join(configRoot, "opencode", "opencode.json");
    mkdirSync(join(configRoot, "opencode"), { recursive: true });
    writeFileSync(
      openCodeConfig,
      `${JSON.stringify({
        plugin: [pathToFileURL(join(
          currentPayload.activeRoot,
          ".opencode",
          "plugins",
          "oh-my-harness.js",
        )).href],
      }, null, 2)}\n`,
    );

    const preview = previewEnvironment(
      {
        capabilitySet: "workflow-only",
        clean: true,
        profileId: "personal",
        selectedAgents: ["opencode"],
        selectedPackages: [],
        stateRoot,
        target: "windows-native",
      },
      {
        arch: "x64",
        env: {
          APPDATA: root,
          PATH: trustedTools,
          XDG_CONFIG_HOME: configRoot,
        },
        os: "win32",
        repositoryRoot: REPOSITORY_ROOT,
      },
    );

    assert.ok(preview.plan, preview.blockers.join(", "));
    const openCodeAction = preview.plan.actions.find(
      ({ id }) => id === "runtime:opencode:native",
    );
    assert.equal(openCodeAction?.payload?.previousActiveRoot, undefined);
    assert.equal(openCodeAction?.payload?.previousPayloadDigest, undefined);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
