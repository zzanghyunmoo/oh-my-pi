import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { applyEdits as applyJsoncEdits, modify as modifyJsonc, parse as parseJsonc } from "jsonc-parser";

import {
  assertExactRuntimeVersion,
  buildInstallPlan,
  inspectInstallPlan,
  installRuntimeBinary,
  parseInstallArguments,
  registerRuntimePackages,
  resolveInstallRoot,
} from "../../scripts/harness/install.mjs";
import {
  PLUGIN_RUNTIME_PATHS,
  materializePluginRuntime,
} from "../../dist/install/plugin-runtime-files.js";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

function createRuntimeStatusFixture(installRoot, id, version) {
  const executablePath = join(installRoot, "runtimes", id, version, "darwin-arm64-personal", "bin", id);
  const executable = Buffer.from(`${id} fixture\n`);
  mkdirSync(join(executablePath, ".."), { recursive: true });
  mkdirSync(join(installRoot, "receipts"), { recursive: true });
  writeFileSync(executablePath, executable);
  writeFileSync(join(installRoot, "receipts", `${id}.json`), `${JSON.stringify({
    harnessPackageSha256: "a".repeat(64),
    compoundEngineeringCommit: "b".repeat(40),
  })}\n`);
  return {
    id,
    version,
    executable: {
      path: executablePath,
      sha256: createHash("sha256").update(executable).digest("hex"),
    },
    tuple: { os: "darwin" },
  };
}

function expectedRegistrationPaths(installRoot) {
  return {
    harness: join(installRoot, "packages", "oh-my-harness", "0.3.2", "a".repeat(64)),
    compoundEngineering: join(
      installRoot,
      "packages",
      "compound-engineering",
      "3.19.0",
      "b".repeat(40),
      "plugins",
      "compound-engineering",
    ),
  };
}

function materializeExpectedRegistrationPaths(installRoot) {
  const expected = expectedRegistrationPaths(installRoot);
  mkdirSync(expected.harness, { recursive: true });
  mkdirSync(expected.compoundEngineering, { recursive: true });
  return expected;
}

function appendJsoncPlugin(configPath, pluginPath) {
  const source = readFileSync(configPath, "utf8");
  const errors = [];
  const config = parseJsonc(source, errors, { allowTrailingComma: true });
  assert.deepEqual(errors, []);
  const plugins = Array.isArray(config.plugin) ? config.plugin : [];
  if (plugins.includes(pluginPath)) return;
  const updated = applyJsoncEdits(source, modifyJsonc(source, ["plugin", plugins.length], pluginPath, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
  }));
  writeFileSync(configPath, updated);
}

test("installer preview closes macOS arm64 to the three exact runtime versions", async () => {
  const root = join(tmpdir(), "oh-my-harness-preview-root");
  const plan = await buildInstallPlan({ installRoot: root, os: "darwin", architecture: "arm64" });
  assert.deepEqual(plan.runtimes.map(({ id, version }) => [id, version]), [
    ["claude-code", "2.1.210"],
    ["codex", "0.144.4"],
    ["opencode", "1.18.0"],
  ]);
  assert.equal(plan.compoundEngineering.version, "3.19.0");
  assert.equal(plan.compoundEngineering.commit, "1756c0b9f3cf94493f287ea29ae766ad668fb7cf");
  assert.equal(existsSync(root), false);
});

test("legacy package payload mirrors the compiled CLI runtime inside the plugin boundary", () => {
  const root = mkdtempSync(join(tmpdir(), "oh-my-harness-plugin-runtime-"));
  try {
    const fixtures = PLUGIN_RUNTIME_PATHS.map((path) => [
      path,
      path.endsWith(".json") ? "{}" : `// ${path}\n`,
    ]);
    for (const [path, content] of fixtures) {
      const target = join(root, path);
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, content);
    }

    materializePluginRuntime(root);
    assert.throws(
      () => materializePluginRuntime(root),
      /plugin runtime payload already exists/,
    );

    for (const [path, content] of fixtures) {
      assert.equal(
        readFileSync(
          join(root, "plugins", "oh-my-harness", "runtime", path),
          "utf8",
        ),
        content,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installer resolves Intel macOS and both Windows architectures to reviewed native archives", async () => {
  const root = join(tmpdir(), "oh-my-harness-cross-platform-root");
  const cases = [
    { os: "darwin", architecture: "x64", platformId: "darwin-x64-release", suffix: "", asset: "claude-darwin-x64.tar.gz" },
    { os: "win32", architecture: "x64", platformId: "win32-x64-release", suffix: ".exe", asset: "claude-win32-x64.zip" },
    { os: "win32", architecture: "arm64", platformId: "win32-arm64-release", suffix: ".exe", asset: "claude-win32-arm64.zip" },
  ];
  for (const expected of cases) {
    const plan = await buildInstallPlan({ installRoot: root, os: expected.os, architecture: expected.architecture });
    assert.equal(plan.runtimes.length, 3);
    assert.equal(plan.runtimes.every(({ platformId }) => platformId === expected.platformId), true);
    assert.equal(plan.runtimes.every(({ executable }) => executable.path.endsWith(".exe")), expected.suffix === ".exe");
    assert.equal(plan.runtimes.find(({ id }) => id === "claude-code").archive.name, expected.asset);
    for (const runtime of plan.runtimes) {
      assert.match(runtime.archive.sha256, /^[0-9a-f]{64}$/);
      assert.match(runtime.executable.sha256, /^[0-9a-f]{64}$/);
      if (expected.suffix) assert.equal(runtime.executable.path.endsWith(`${runtime.id}${expected.suffix}`), true);
    }
  }
});

test("Windows reuses verified runtime payloads through managed hardlinks", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows hardlink fixture");
  const installRoot = mkdtempSync(join(tmpdir(), "oh-my-harness-windows-hardlink-"));
  const executablePath = join(installRoot, "runtimes", "codex", "0.144.4", "win32-x64-release", "bin", "codex.exe");
  try {
    mkdirSync(join(executablePath, ".."), { recursive: true });
    const body = Buffer.from("MZ codex fixture\n");
    writeFileSync(executablePath, body);
    const result = await installRuntimeBinary({
      installRoot,
      runtime: { id: "codex", version: "0.144.4" },
      tuple: {
        os: "win32",
        platformId: "win32-x64-release",
        executable: { sha256: createHash("sha256").update(body).digest("hex") },
      },
      runner: { run: () => "codex-cli 0.144.4\n" },
    });
    const payload = statSync(executablePath);
    const managed = statSync(result.linkPath);
    assert.equal(result.reused, true);
    assert.equal(result.linkPath.endsWith("codex.exe"), true);
    assert.equal(managed.dev, payload.dev);
    assert.equal(managed.ino, payload.ino);
    assert.equal(managed.nlink >= 2, true);
  } finally {
    rmSync(installRoot, { recursive: true, force: true });
  }
});

test("installer refuses to place managed payloads inside the source repository", () => {
  assert.throws(
    () => resolveInstallRoot(join(REPO_ROOT, ".managed-payloads")),
    /outside the source repository/i,
  );
  assert.throws(
    () => resolveInstallRoot(join(REPO_ROOT, "..managed-payloads")),
    /outside the source repository/i,
  );
});

test("Claude registration installs exact local marketplaces and plugins idempotently", () => {
  const harnessRoot = "/managed/packages/oh-my-harness/0.3.0/digest";
  const ceRoot = "/managed/packages/compound-engineering/3.19.0/commit/plugins/compound-engineering";
  const marketplaces = new Map();
  const plugins = new Map();
  const disabledPlugins = new Set();
  const calls = [];
  const runner = {
    run(_binary, args) {
      calls.push(args);
      if (args.join(" ") === "plugin marketplace list --json") {
        return JSON.stringify([...marketplaces].map(([name, path]) => ({ name, source: "directory", path })));
      }
      if (args[0] === "plugin" && args[1] === "marketplace" && args[2] === "add") {
        const path = args[3];
        marketplaces.set(path.includes("compound-engineering") ? "compound-engineering-plugin" : "oh-my-harness", path);
        return "";
      }
      if (args[0] === "plugin" && args[1] === "marketplace" && args[2] === "remove") {
        const name = args[3];
        marketplaces.delete(name);
        for (const selector of [...plugins.keys()]) if (selector.endsWith(`@${name}`)) plugins.delete(selector);
        return "";
      }
      if (args.join(" ") === "plugin list --json") {
        return JSON.stringify([...plugins].map(([id, version]) => ({ id, version, scope: "user", enabled: !disabledPlugins.has(id) })));
      }
      if (args[0] === "plugin" && args[1] === "install") {
        const selector = args[2];
        plugins.set(selector, selector.startsWith("oh-my-harness@") ? "0.3.0" : "3.19.0");
        disabledPlugins.delete(selector);
        return "";
      }
      if (args[0] === "plugin" && args[1] === "uninstall") {
        plugins.delete(args[2]);
        disabledPlugins.delete(args[2]);
        return "";
      }
      throw new Error(`unexpected command: ${args.join(" ")}`);
    },
  };
  const input = {
    runtimeId: "claude-code",
    binaryPath: "/managed/claude-code",
    harnessPayload: { path: harnessRoot, version: "0.3.0" },
    cePayload: { pluginPath: ceRoot, version: "3.19.0" },
    managedRoot: "/managed",
    runner,
  };
  registerRuntimePackages(input);
  const mutations = calls.filter((args) => ["add", "install"].includes(args[2] ?? args[1])).length;
  registerRuntimePackages(input);
  assert.equal(calls.filter((args) => ["add", "install"].includes(args[2] ?? args[1])).length, mutations);
  assert.deepEqual([...plugins], [
    ["oh-my-harness@oh-my-harness", "0.3.0"],
    ["compound-engineering@compound-engineering-plugin", "3.19.0"],
  ]);

  disabledPlugins.add("oh-my-harness@oh-my-harness");
  const repaired = registerRuntimePackages(input);
  assert.equal(repaired.harnessPlugin, "updated");
  assert.equal(disabledPlugins.has("oh-my-harness@oh-my-harness"), false);

  const nextRoot = "/managed/packages/oh-my-harness/0.3.0/next-digest";
  const updated = registerRuntimePackages({ ...input, harnessPayload: { path: nextRoot, version: "0.3.0" } });
  assert.equal(updated.harnessMarketplace, "updated");
  assert.equal(marketplaces.get("oh-my-harness"), nextRoot);
  assert.equal(plugins.get("oh-my-harness@oh-my-harness"), "0.3.0");
});

test("installer arguments are preview-first and reject ambiguous mutations", () => {
  const root = join(tmpdir(), "oh-my-harness-arguments-root");
  const preview = parseInstallArguments(["--root", root, "--runtime", "codex,opencode", "--json"]);
  assert.equal(preview.apply, false);
  assert.deepEqual(preview.runtimeIds, ["codex", "opencode"]);
  assert.equal(preview.register, true);
  assert.equal(parseInstallArguments(["--help"]).help, true);
  const apply = parseInstallArguments(["--root", root, "--runtime", "all", "--apply", "--skip-registration"]);
  assert.equal(apply.apply, true);
  assert.equal(apply.register, false);
  assert.throws(() => parseInstallArguments(["--root", root, "--apply", "--status"]), /mutually exclusive/i);
  assert.throws(() => parseInstallArguments(["--root", root, "--skip-registration"]), /requires --apply/i);
  assert.throws(() => parseInstallArguments(["--root", root, "--status", "--skip-registration"]), /requires --apply/i);
  assert.throws(() => parseInstallArguments(["--root", root, "--wat"]), /unknown/i);
});

test("installer rejects combining all with an explicit runtime", async () => {
  await assert.rejects(
    buildInstallPlan({ installRoot: join(tmpdir(), "oh-my-harness-ambiguous-root"), os: "darwin", architecture: "arm64", runtimeIds: ["all", "codex"] }),
    /cannot be combined/i,
  );
  await assert.rejects(
    buildInstallPlan({ installRoot: join(tmpdir(), "oh-my-harness-unsupported-root"), os: "darwin", architecture: "arm64", runtimeIds: ["unknown-runtime"] }),
    /runtime selection must contain only/i,
  );
});

test("runtime version verification refuses newer and older versions", () => {
  assert.doesNotThrow(() => assertExactRuntimeVersion("codex", "0.144.4", "codex-cli 0.144.4\n"));
  assert.throws(() => assertExactRuntimeVersion("opencode", "1.18.0", "1.18.2\n"), /version mismatch/i);
});

test("Codex registration uses both local fixed marketplaces and is idempotent", () => {
  const harnessRoot = join(tmpdir(), "packages", "oh-my-harness-payload");
  const ceRoot = join(tmpdir(), "packages", "compound-engineering-payload");
  const marketplaces = new Map();
  const plugins = new Set();
  const available = [
    "compound-engineering@compound-engineering-plugin",
    "oh-my-harness@oh-my-harness",
  ];
  const calls = [];
  const runner = {
    run(_binary, args) {
      calls.push(args);
      if (args.join(" ") === "plugin marketplace list") {
        return `MARKETPLACE  ROOT\n${[...marketplaces].map(([name, root]) => `${name}  ${root}`).join("\n")}\n`;
      }
      if (args[0] === "plugin" && args[1] === "marketplace" && args[2] === "add") {
        const root = args[3];
        marketplaces.set(root.includes("oh-my-harness") ? "oh-my-harness" : "compound-engineering-plugin", root);
        return "{}\n";
      }
      if (args[0] === "plugin" && args[1] === "marketplace" && args[2] === "remove") {
        marketplaces.delete(args[3]);
        return "{}\n";
      }
      if (args.join(" ") === "plugin list") {
        return `PLUGIN  STATUS\n${available.map((name) => `${name}  ${plugins.has(name) ? "installed, enabled" : "not installed"}`).join("\n")}\n`;
      }
      if (args[0] === "plugin" && args[1] === "add") {
        plugins.add(args[2]);
        return "{}\n";
      }
      if (args[0] === "plugin" && args[1] === "remove") {
        plugins.delete(args[2]);
        return "{}\n";
      }
      throw new Error(`unexpected command: ${args.join(" ")}`);
    },
  };
  const input = {
    runtimeId: "codex",
    binaryPath: "/managed/codex",
    harnessPayload: { path: harnessRoot },
    cePayload: { path: ceRoot },
    managedRoot: tmpdir(),
    environment: {},
    runner,
  };
  registerRuntimePackages(input);
  const mutations = calls.filter((args) => args.includes("add")).length;
  registerRuntimePackages(input);
  assert.equal(calls.filter((args) => args.includes("add")).length, mutations);
  assert.deepEqual([...plugins].sort(), [
    "compound-engineering@compound-engineering-plugin",
    "oh-my-harness@oh-my-harness",
  ]);

  const nextHarnessRoot = join(tmpdir(), "packages", "oh-my-harness-payload-next");
  const updated = registerRuntimePackages({ ...input, harnessPayload: { path: nextHarnessRoot } });
  assert.equal(updated.harnessMarketplace, "updated");
  assert.equal(marketplaces.get("oh-my-harness"), nextHarnessRoot);
  assert.equal(plugins.has("oh-my-harness@oh-my-harness"), true);
});

test("Codex registration reinstalls plugins that are installed but disabled", () => {
  const harnessRoot = join(tmpdir(), "packages", "oh-my-harness-disabled");
  const ceRoot = join(tmpdir(), "packages", "compound-engineering-disabled");
  const marketplaces = new Map([
    ["oh-my-harness", harnessRoot],
    ["compound-engineering-plugin", ceRoot],
  ]);
  const pluginStates = new Map([
    ["oh-my-harness@oh-my-harness", "installed, disabled"],
    ["compound-engineering@compound-engineering-plugin", "installed, enabled"],
  ]);
  const calls = [];
  const runner = {
    run(_binary, args) {
      calls.push(args);
      if (args.join(" ") === "plugin marketplace list") {
        return `MARKETPLACE  ROOT\n${[...marketplaces].map(([name, root]) => `${name}  ${root}`).join("\n")}\n`;
      }
      if (args.join(" ") === "plugin list") {
        return `PLUGIN  STATUS\n${[...pluginStates].map(([selector, status]) => `${selector}  ${status}`).join("\n")}\n`;
      }
      if (args[0] === "plugin" && args[1] === "remove") {
        pluginStates.set(args[2], "not installed");
        return "{}\n";
      }
      if (args[0] === "plugin" && args[1] === "add") {
        pluginStates.set(args[2], "installed, enabled");
        return "{}\n";
      }
      throw new Error(`unexpected command: ${args.join(" ")}`);
    },
  };

  registerRuntimePackages({
    runtimeId: "codex",
    binaryPath: "/managed/codex",
    harnessPayload: { path: harnessRoot },
    cePayload: { path: ceRoot },
    managedRoot: tmpdir(),
    environment: {},
    runner,
  });

  assert.equal(pluginStates.get("oh-my-harness@oh-my-harness"), "installed, enabled");
  assert.equal(calls.some((args) => args.join(" ") === "plugin remove oh-my-harness@oh-my-harness --json"), true);
  assert.equal(calls.some((args) => args.join(" ") === "plugin add oh-my-harness@oh-my-harness --json"), true);
});

test("Codex status reports missing registration instead of trusting a stale receipt", async () => {
  const installRoot = mkdtempSync(join(tmpdir(), "oh-my-harness-codex-status-"));
  const executablePath = join(installRoot, "runtimes", "codex", "0.144.4", "darwin-arm64-personal", "bin", "codex");
  const executable = Buffer.from("codex fixture\n");
  try {
    mkdirSync(join(executablePath, ".."), { recursive: true });
    mkdirSync(join(installRoot, "receipts"), { recursive: true });
    writeFileSync(executablePath, executable);
    writeFileSync(join(installRoot, "receipts", "codex.json"), `${JSON.stringify({
      harnessPackageSha256: "a".repeat(64),
      compoundEngineeringCommit: "b".repeat(40),
    })}\n`);
    const plan = {
      installRoot,
      runtimes: [{
        id: "codex",
        version: "0.144.4",
        executable: {
          path: executablePath,
          sha256: createHash("sha256").update(executable).digest("hex"),
        },
        tuple: { os: "darwin" },
      }],
    };
    const result = await inspectInstallPlan(plan, {
      environment: {},
      runner: {
        run(_binary, args) {
          if (args.join(" ") === "--version") return "codex-cli 0.144.4\n";
          if (args.join(" ") === "plugin marketplace list") return "MARKETPLACE  ROOT\n";
          if (args.join(" ") === "plugin list") {
            return "PLUGIN  STATUS\noh-my-harness@oh-my-harness-old  installed, enabled\ncompound-engineering@compound-engineering-plugin-old  installed, enabled\n";
          }
          throw new Error(`unexpected command: ${args.join(" ")}`);
        },
      },
    });

    assert.equal(result.runtimes[0].state, "registration-missing");
    assert.equal(result.runtimes[0].registration.marketplaces.every(({ state }) => state === "missing"), true);
    assert.equal(result.runtimes[0].registration.plugins.every(({ installed }) => installed === false), true);
  } finally {
    rmSync(installRoot, { recursive: true, force: true });
  }
});

test("Claude and OpenCode status report missing registration instead of trusting stale receipts", async () => {
  const installRoot = mkdtempSync(join(tmpdir(), "oh-my-harness-runtime-status-missing-"));
  try {
    const runtimes = [
      createRuntimeStatusFixture(installRoot, "claude-code", "2.1.210"),
      createRuntimeStatusFixture(installRoot, "opencode", "1.18.0"),
    ];
    const expected = expectedRegistrationPaths(installRoot);
    mkdirSync(expected.harness, { recursive: true });
    const xdgConfigHome = join(installRoot, "missing-xdg");
    const openCodeConfigPath = join(xdgConfigHome, "opencode", "opencode.json");
    mkdirSync(join(openCodeConfigPath, ".."), { recursive: true });
    writeFileSync(openCodeConfigPath, `${JSON.stringify({ plugin: [expected.harness, expected.compoundEngineering] })}\n`);
    const result = await inspectInstallPlan({ installRoot, runtimes }, {
      environment: {
        TEST_MARKER: "registration-status",
        XDG_CONFIG_HOME: xdgConfigHome,
      },
      runner: {
        run(binary, args, options) {
          assert.equal(options?.env?.TEST_MARKER, "registration-status");
          if (args.join(" ") === "--version") {
            if (binary.endsWith("claude-code")) return "2.1.210 (Claude Code)\n";
            if (binary.endsWith("opencode")) return "1.18.0\n";
          }
          if (binary.endsWith("claude-code") && args.join(" ") === "plugin marketplace list --json") return "[]\n";
          if (binary.endsWith("claude-code") && args.join(" ") === "plugin list --json") return "[]\n";
          throw new Error(`unexpected command: ${binary} ${args.join(" ")}`);
        },
      },
    });

    assert.deepEqual(result.runtimes.map(({ id, state }) => [id, state]), [
      ["claude-code", "registration-missing"],
      ["opencode", "registration-missing"],
    ]);
    assert.equal(result.runtimes[0].registration.marketplaces.every(({ state }) => state === "missing"), true);
    assert.equal(result.runtimes[1].registration.plugins.find(({ id }) => id === "compound-engineering").registered, true);
    assert.equal(result.runtimes[1].registration.plugins.find(({ id }) => id === "compound-engineering").installed, false);
  } finally {
    rmSync(installRoot, { recursive: true, force: true });
  }
});

test("Claude and OpenCode status distinguish registration drift", async () => {
  const installRoot = mkdtempSync(join(tmpdir(), "oh-my-harness-runtime-status-drift-"));
  try {
    const runtimes = [
      createRuntimeStatusFixture(installRoot, "claude-code", "2.1.210"),
      createRuntimeStatusFixture(installRoot, "opencode", "1.18.0"),
    ];
    const expected = materializeExpectedRegistrationPaths(installRoot);
    const staleOpenCode = join(installRoot, "packages", "oh-my-harness", "0.1.0", "old-digest");
    const xdgConfigHome = join(installRoot, "drift-config");
    const openCodeConfigPath = join(xdgConfigHome, "opencode", "opencode.json");
    mkdirSync(join(openCodeConfigPath, ".."), { recursive: true });
    writeFileSync(openCodeConfigPath, `${JSON.stringify({ plugin: [
      expected.harness,
      expected.compoundEngineering,
      staleOpenCode,
    ] })}\n`);
    const result = await inspectInstallPlan({ installRoot, runtimes }, {
      environment: { XDG_CONFIG_HOME: xdgConfigHome },
      runner: {
        run(binary, args) {
          if (args.join(" ") === "--version") {
            if (binary.endsWith("claude-code")) return "2.1.210 (Claude Code)\n";
            if (binary.endsWith("opencode")) return "1.18.0\n";
          }
          if (binary.endsWith("claude-code") && args.join(" ") === "plugin marketplace list --json") {
            return JSON.stringify([
              { name: "oh-my-harness", source: "directory", path: expected.harness },
              { name: "compound-engineering-plugin", source: "directory", path: expected.compoundEngineering },
            ]);
          }
          if (binary.endsWith("claude-code") && args.join(" ") === "plugin list --json") {
            return JSON.stringify([
              { id: "oh-my-harness@oh-my-harness", version: "0.1.0", scope: "user", enabled: true },
              { id: "compound-engineering@compound-engineering-plugin", version: "3.19.0", scope: "user", enabled: false },
            ]);
          }
          throw new Error(`unexpected command: ${binary} ${args.join(" ")}`);
        },
      },
    });

    assert.deepEqual(result.runtimes.map(({ id, state }) => [id, state]), [
      ["claude-code", "registration-drift"],
      ["opencode", "registration-drift"],
    ]);
    assert.deepEqual(result.runtimes[1].registration.stalePlugins, [staleOpenCode]);
  } finally {
    rmSync(installRoot, { recursive: true, force: true });
  }
});

test("Claude status isolates each marketplace and plugin drift cause", async () => {
  const installRoot = mkdtempSync(join(tmpdir(), "oh-my-harness-claude-drift-causes-"));
  try {
    const runtime = createRuntimeStatusFixture(installRoot, "claude-code", "2.1.210");
    const expected = materializeExpectedRegistrationPaths(installRoot);
    const healthyMarketplaces = [
      { name: "oh-my-harness", path: expected.harness },
      { name: "compound-engineering-plugin", path: expected.compoundEngineering },
    ];
    const healthyPlugins = [
      { id: "oh-my-harness@oh-my-harness", version: "0.3.2", scope: "user", enabled: true },
      { id: "compound-engineering@compound-engineering-plugin", version: "3.19.0", scope: "user", enabled: true },
    ];
    const cases = [
      {
        name: "marketplace root",
        marketplaces: [{ ...healthyMarketplaces[0], path: join(installRoot, "wrong-root") }, healthyMarketplaces[1]],
        plugins: healthyPlugins,
        assertDrift(registration) { assert.equal(registration.marketplaces[0].state, "drift"); },
      },
      {
        name: "plugin version",
        marketplaces: healthyMarketplaces,
        plugins: [{ ...healthyPlugins[0], version: "0.1.0" }, healthyPlugins[1]],
        assertDrift(registration) { assert.equal(registration.plugins[0].state, "drift"); },
      },
      {
        name: "disabled plugin",
        marketplaces: healthyMarketplaces,
        plugins: [{ ...healthyPlugins[0], enabled: false }, healthyPlugins[1]],
        assertDrift(registration) { assert.equal(registration.plugins[0].state, "drift"); },
      },
      {
        name: "plugin scope",
        marketplaces: healthyMarketplaces,
        plugins: [{ ...healthyPlugins[0], scope: "project" }, healthyPlugins[1]],
        assertDrift(registration) { assert.equal(registration.plugins[0].state, "drift"); },
      },
    ];

    for (const current of cases) {
      const result = await inspectInstallPlan({ installRoot, runtimes: [runtime] }, {
        runner: {
          run(_binary, args) {
            if (args.join(" ") === "--version") return "2.1.210 (Claude Code)\n";
            if (args.join(" ") === "plugin marketplace list --json") return JSON.stringify(current.marketplaces);
            if (args.join(" ") === "plugin list --json") return JSON.stringify(current.plugins);
            throw new Error(`unexpected command for ${current.name}: ${args.join(" ")}`);
          },
        },
      });
      assert.equal(result.runtimes[0].state, "registration-drift", current.name);
      current.assertDrift(result.runtimes[0].registration);
    }
  } finally {
    rmSync(installRoot, { recursive: true, force: true });
  }
});

test("runtime status fails closed when receipt package identities are incomplete", async () => {
  const installRoot = mkdtempSync(join(tmpdir(), "oh-my-harness-incomplete-receipt-"));
  try {
    const cases = [
      ["claude-code", "2.1.210", "2.1.210 (Claude Code)\n"],
      ["opencode", "1.18.0", "1.18.0\n"],
    ];
    for (const [runtimeId, version, versionOutput] of cases) {
      const runtime = createRuntimeStatusFixture(installRoot, runtimeId, version);
      for (const missingIdentity of ["harnessPackageSha256", "compoundEngineeringCommit"]) {
        const receiptPath = join(installRoot, "receipts", `${runtimeId}.json`);
        const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
        delete receipt[missingIdentity];
        writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`);
        const result = await inspectInstallPlan({ installRoot, runtimes: [runtime] }, {
          runner: {
            run(_binary, args) {
              if (args.join(" ") === "--version") return versionOutput;
              throw new Error("native registration inspection should not run");
            },
          },
        });
        assert.equal(result.runtimes[0].state, "registration-unverifiable", `${runtimeId}:${missingIdentity}`);
        assert.match(result.runtimes[0].registration.error, /missing managed package identities/);
        writeFileSync(receiptPath, `${JSON.stringify({
          harnessPackageSha256: "a".repeat(64),
          compoundEngineeringCommit: "b".repeat(40),
        })}\n`);
      }
    }
  } finally {
    rmSync(installRoot, { recursive: true, force: true });
  }
});

test("Claude and OpenCode status fail closed when registration cannot be inspected", async () => {
  const installRoot = mkdtempSync(join(tmpdir(), "oh-my-harness-runtime-status-unverifiable-"));
  try {
    const runtimes = [
      createRuntimeStatusFixture(installRoot, "claude-code", "2.1.210"),
      createRuntimeStatusFixture(installRoot, "opencode", "1.18.0"),
    ];
    const expected = materializeExpectedRegistrationPaths(installRoot);
    const xdgConfigHome = join(installRoot, "unverifiable-config");
    const openCodeConfigPath = join(xdgConfigHome, "opencode", "opencode.json");
    mkdirSync(join(openCodeConfigPath, ".."), { recursive: true });
    writeFileSync(openCodeConfigPath, `{ "plugin": ["${expected.harness}"`);
    const result = await inspectInstallPlan({ installRoot, runtimes }, {
      environment: { XDG_CONFIG_HOME: xdgConfigHome },
      runner: {
        run(binary, args) {
          if (args.join(" ") === "--version") {
            if (binary.endsWith("claude-code")) return "2.1.210 (Claude Code)\n";
            if (binary.endsWith("opencode")) return "1.18.0\n";
          }
          throw new Error(`registration inspection failed for ${binary}`);
        },
      },
    });

    assert.deepEqual(result.runtimes.map(({ id, state }) => [id, state]), [
      ["claude-code", "registration-unverifiable"],
      ["opencode", "registration-unverifiable"],
    ]);
    assert.match(result.runtimes[0].registration.error, /inspection failed/);
    assert.match(result.runtimes[1].registration.error, /not valid JSON\/JSONC/);
  } finally {
    rmSync(installRoot, { recursive: true, force: true });
  }
});

test("Claude and OpenCode status report healthy native registration details", async () => {
  const installRoot = mkdtempSync(join(tmpdir(), "oh-my-harness-runtime-status-healthy-"));
  try {
    const runtimes = [
      createRuntimeStatusFixture(installRoot, "claude-code", "2.1.210"),
      createRuntimeStatusFixture(installRoot, "opencode", "1.18.0"),
    ];
    const expected = materializeExpectedRegistrationPaths(installRoot);
    const xdgConfigHome = join(installRoot, "healthy-config");
    const configPath = join(xdgConfigHome, "opencode", "opencode.json");
    mkdirSync(join(configPath, ".."), { recursive: true });
    writeFileSync(configPath, `${JSON.stringify({ plugin: [expected.harness, expected.compoundEngineering] })}\n`);
    const result = await inspectInstallPlan({ installRoot, runtimes }, {
      environment: { XDG_CONFIG_HOME: xdgConfigHome },
      runner: {
        run(binary, args) {
          if (args.join(" ") === "--version") {
            if (binary.endsWith("claude-code")) return "2.1.210 (Claude Code)\n";
            if (binary.endsWith("opencode")) return "1.18.0\n";
          }
          if (args.join(" ") === "plugin marketplace list --json") return JSON.stringify([
            { name: "oh-my-harness", path: expected.harness },
            { name: "compound-engineering-plugin", path: expected.compoundEngineering },
          ]);
          if (args.join(" ") === "plugin list --json") return JSON.stringify([
            { id: "oh-my-harness@oh-my-harness", version: "0.3.2", scope: "user", enabled: true },
            { id: "compound-engineering@compound-engineering-plugin", version: "3.19.0", scope: "user", enabled: true },
          ]);
          throw new Error(`unexpected command: ${binary} ${args.join(" ")}`);
        },
      },
    });
    assert.deepEqual(result.runtimes.map(({ id, state }) => [id, state]), [
      ["claude-code", "installed"], ["opencode", "installed"],
    ]);
    assert.equal(result.runtimes[0].registration.plugins.every(({ state }) => state === "installed"), true);
    assert.equal(result.runtimes[1].registration.plugins.every(({ targetSafe }) => targetSafe), true);
  } finally {
    rmSync(installRoot, { recursive: true, force: true });
  }
});

test("Claude status rejects registrations whose payload directories were deleted", async () => {
  const installRoot = mkdtempSync(join(tmpdir(), "oh-my-harness-deleted-registration-targets-"));
  try {
    const runtimes = [
      createRuntimeStatusFixture(installRoot, "claude-code", "2.1.210"),
    ];
    const expected = materializeExpectedRegistrationPaths(installRoot);
    rmSync(expected.harness, { recursive: true });
    rmSync(expected.compoundEngineering, { recursive: true });
    const result = await inspectInstallPlan({ installRoot, runtimes }, {
      runner: {
        run(binary, args) {
          if (args.join(" ") === "--version") return "2.1.210 (Claude Code)\n";
          if (args.join(" ") === "plugin marketplace list --json") return JSON.stringify([
            { name: "oh-my-harness", path: expected.harness },
            { name: "compound-engineering-plugin", path: expected.compoundEngineering },
          ]);
          if (args.join(" ") === "plugin list --json") return JSON.stringify([
            { id: "oh-my-harness@oh-my-harness", version: "0.3.0", scope: "user", enabled: true },
            { id: "compound-engineering@compound-engineering-plugin", version: "3.19.0", scope: "user", enabled: true },
          ]);
          throw new Error(`unexpected command: ${binary} ${args.join(" ")}`);
        },
      },
    });

    assert.deepEqual(result.runtimes.map(({ id, state }) => [id, state]), [
      ["claude-code", "registration-missing"],
    ]);
    assert.equal(result.runtimes[0].registration.marketplaces.every(({ targetSafe }) => !targetSafe), true);
  } finally {
    rmSync(installRoot, { recursive: true, force: true });
  }
});

test("OpenCode migrates JSONC without discarding comments and converges idempotently", async () => {
  const installRoot = mkdtempSync(join(tmpdir(), "oh-my-harness-opencode-jsonc-"));
  try {
    const runtime = createRuntimeStatusFixture(installRoot, "opencode", "1.18.0");
    const expected = materializeExpectedRegistrationPaths(installRoot);
    const xdgConfigHome = join(installRoot, "xdg");
    const configPath = join(xdgConfigHome, "opencode", "opencode.jsonc");
    const stale = join(installRoot, "packages", "oh-my-harness", "0.1.0", "old-digest");
    mkdirSync(join(configPath, ".."), { recursive: true });
    const original = `{\n  // keep this comment\n  "unrelated": true,\n  "plugin": [\n    // keep this plugin comment\n    "keep-me@1.0.0",\n    // remove this stale plugin comment\n    ${JSON.stringify(stale)},\n  ],\n}\n`;
    writeFileSync(configPath, original);
    const environment = { XDG_CONFIG_HOME: xdgConfigHome };
    const status = await inspectInstallPlan({ installRoot, runtimes: [runtime] }, {
      environment,
      runner: { run() { return "1.18.0\n"; } },
    });
    assert.equal(status.runtimes[0].state, "registration-missing");
    assert.deepEqual(status.runtimes[0].registration.stalePlugins, [stale]);
    const calls = [];
    const input = {
      runtimeId: "opencode", binaryPath: "/managed/opencode", managedRoot: installRoot, environment,
      harnessPayload: { path: expected.harness }, cePayload: { pluginPath: expected.compoundEngineering },
      runner: { run(_binary, args) { calls.push(args); appendJsoncPlugin(configPath, args[1]); return ""; } },
    };
    const applied = registerRuntimePackages(input);
    const mutationCount = calls.length;
    const reapplied = registerRuntimePackages(input);
    const migrated = readFileSync(configPath, "utf8");
    const parsed = parseJsonc(migrated, [], { allowTrailingComma: true });
    assert.match(migrated, /keep this comment/);
    assert.match(migrated, /keep this plugin comment/);
    assert.doesNotMatch(migrated, /remove this stale plugin comment/);
    assert.equal(parsed.unrelated, true);
    assert.deepEqual(parsed.plugin, ["keep-me@1.0.0", expected.harness, expected.compoundEngineering]);
    assert.equal(readFileSync(`${configPath}.oh-my-harness.pre-fixed-install`, "utf8"), original);
    assert.deepEqual(applied.removed, [stale]);
    assert.deepEqual(reapplied.removed, []);
    assert.equal(calls.length, mutationCount);
  } finally {
    rmSync(installRoot, { recursive: true, force: true });
  }
});

test("Codex registration under Orca repairs both the canonical and active homes", () => {
  const harnessRoot = join(tmpdir(), "packages", "oh-my-harness-orca");
  const ceRoot = join(tmpdir(), "packages", "compound-engineering-orca");
  const activeHome = join(tmpdir(), "orca", "codex-home");
  const registries = new Map();
  const calls = [];
  const registry = (options) => {
    const home = options?.env?.CODEX_HOME ?? "system-default";
    if (!registries.has(home)) registries.set(home, { marketplaces: new Map(), plugins: new Set() });
    return registries.get(home);
  };
  const runner = {
    run(_binary, args, options) {
      calls.push({ args, home: options?.env?.CODEX_HOME ?? "system-default" });
      const current = registry(options);
      if (args.join(" ") === "plugin marketplace list") {
        return `MARKETPLACE  ROOT\n${[...current.marketplaces].map(([name, root]) => `${name}  ${root}`).join("\n")}\n`;
      }
      if (args[0] === "plugin" && args[1] === "marketplace" && args[2] === "add") {
        const root = args[3];
        current.marketplaces.set(root.includes("oh-my-harness") ? "oh-my-harness" : "compound-engineering-plugin", root);
        return "{}\n";
      }
      if (args.join(" ") === "plugin list") {
        return `PLUGIN  STATUS\noh-my-harness@oh-my-harness  ${current.plugins.has("oh-my-harness@oh-my-harness") ? "installed, enabled" : "not installed"}\ncompound-engineering@compound-engineering-plugin  ${current.plugins.has("compound-engineering@compound-engineering-plugin") ? "installed, enabled" : "not installed"}\n`;
      }
      if (args[0] === "plugin" && args[1] === "add") {
        current.plugins.add(args[2]);
        return "{}\n";
      }
      throw new Error(`unexpected command: ${args.join(" ")}`);
    },
  };

  const result = registerRuntimePackages({
    runtimeId: "codex",
    binaryPath: "/managed/codex",
    harnessPayload: { path: harnessRoot },
    cePayload: { path: ceRoot },
    managedRoot: tmpdir(),
    environment: {
      HOME: homedir(),
      ORCA_CODEX_HOME: activeHome,
    },
    runner,
  });

  assert.deepEqual(result.codexHomes.map(({ scope }) => scope), ["system-default", "active"]);
  assert.deepEqual([...registries.keys()], ["system-default", activeHome]);
  for (const current of registries.values()) {
    assert.deepEqual([...current.marketplaces.keys()].sort(), ["compound-engineering-plugin", "oh-my-harness"]);
    assert.deepEqual([...current.plugins].sort(), [
      "compound-engineering@compound-engineering-plugin",
      "oh-my-harness@oh-my-harness",
    ]);
  }
  assert.equal(calls.findIndex(({ home }) => home === "system-default") < calls.findIndex(({ home }) => home === activeHome), true);
});

test("OpenCode registration uses fixed local payloads idempotently", (t) => {
  const opencodeRoot = mkdtempSync(join(tmpdir(), "oh-my-harness-opencode-registration-"));
  const managedRoot = join(opencodeRoot, "managed");
  const harnessRoot = join(managedRoot, "packages", "oh-my-harness", "0.1.0", "digest");
  const cePluginRoot = join(managedRoot, "packages", "compound-engineering", "3.19.0", "commit", "plugins", "compound-engineering");
  const opencodeConfigPath = join(opencodeRoot, "opencode.json");
  mkdirSync(harnessRoot, { recursive: true });
  mkdirSync(cePluginRoot, { recursive: true });
  writeFileSync(opencodeConfigPath, `${JSON.stringify({ plugin: [] })}\n`);
  t.after(() => rmSync(opencodeRoot, { recursive: true, force: true }));
  const opencodeCalls = [];
  const opencodeInput = {
    runtimeId: "opencode",
    binaryPath: "/managed/opencode",
    harnessPayload: { path: harnessRoot },
    cePayload: { pluginPath: cePluginRoot },
    opencodeConfigPaths: [opencodeConfigPath],
    environment: { TEST_MARKER: "opencode-registration" },
    runner: {
      run(_binary, args, options) {
        assert.equal(options?.env?.TEST_MARKER, "opencode-registration");
        opencodeCalls.push(args);
        if (args[0] === "plugin") {
          const config = JSON.parse(readFileSync(opencodeConfigPath, "utf8"));
          if (!config.plugin.includes(args[1])) config.plugin.push(args[1]);
          writeFileSync(opencodeConfigPath, `${JSON.stringify(config)}\n`);
        }
        return "";
      },
    },
  };
  registerRuntimePackages(opencodeInput);
  const opencodeMutations = opencodeCalls.filter(([command]) => command === "plugin").length;
  registerRuntimePackages(opencodeInput);
  assert.deepEqual(opencodeCalls.filter(([command]) => command === "plugin"), [
    ["plugin", harnessRoot, "--global", "--force"],
    ["plugin", cePluginRoot, "--global", "--force"],
  ]);
  assert.equal(opencodeCalls.filter(([command]) => command === "plugin").length, opencodeMutations);
});

test("OpenCode preserves stale registrations when replacements do not converge", (t) => {
  const root = mkdtempSync(join(tmpdir(), "oh-my-harness-registration-prepare-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const managedRoot = join(root, "managed");
  const harnessRoot = join(managedRoot, "packages", "oh-my-harness", "0.3.0", "new-digest");
  const cePluginRoot = join(managedRoot, "packages", "compound-engineering", "3.19.0", "commit", "plugins", "compound-engineering");
  mkdirSync(harnessRoot, { recursive: true });
  mkdirSync(cePluginRoot, { recursive: true });

  const staleOpenCode = join(managedRoot, "packages", "oh-my-harness", "0.1.0", "old-digest");
  const configPath = join(root, "opencode.json");
  writeFileSync(configPath, `${JSON.stringify({ plugin: [staleOpenCode] })}\n`);
  assert.throws(() => registerRuntimePackages({
    runtimeId: "opencode",
    binaryPath: "/managed/opencode",
    harnessPayload: { path: harnessRoot },
    cePayload: { pluginPath: cePluginRoot },
    managedRoot,
    opencodeConfigPaths: [configPath],
    runner: { run() { return ""; } },
  }), /OpenCode replacement registration did not converge/);
  assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")).plugin, [staleOpenCode]);
  assert.deepEqual(JSON.parse(readFileSync(`${configPath}.oh-my-harness.pre-fixed-install`, "utf8")).plugin, [staleOpenCode]);
});

test("OpenCode migration removes only the known mutable predecessor and keeps a recovery copy", () => {
  const root = mkdtempSync(join(tmpdir(), "oh-my-harness-opencode-config-"));
  try {
    const configPath = join(root, "opencode.json");
    const legacySkill = join(root, "skills", "ce-legacy");
    mkdirSync(legacySkill, { recursive: true });
    writeFileSync(join(legacySkill, "SKILL.md"), "---\nname: ce-legacy\ndescription: predecessor fixture\n---\n");
    writeFileSync(configPath, `${JSON.stringify({ plugin: ["keep-me@1.0.0", "oh-my-openagent@latest", "/managed/packages/oh-my-harness/0.1.0/old-digest"] }, null, 2)}\n`);
    const result = registerRuntimePackages({
      runtimeId: "opencode",
      binaryPath: "/managed/opencode",
      harnessPayload: { path: "/managed/packages/oh-my-harness/0.1.0/new-digest" },
      cePayload: { pluginPath: "/managed/packages/compound-engineering/3.19.0/commit/plugins/compound-engineering" },
      managedRoot: "/managed",
      opencodeConfigPaths: [configPath],
      runner: {
        run(_binary, args) {
          if (args[0] === "plugin") {
            const config = JSON.parse(readFileSync(configPath, "utf8"));
            if (!config.plugin.includes(args[1])) config.plugin.push(args[1]);
            writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
          }
          return "";
        },
      },
    });
    assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")).plugin, [
      "keep-me@1.0.0",
      "/managed/packages/oh-my-harness/0.1.0/new-digest",
      "/managed/packages/compound-engineering/3.19.0/commit/plugins/compound-engineering",
    ]);
    assert.deepEqual(result.removed, ["oh-my-openagent@latest", "/managed/packages/oh-my-harness/0.1.0/old-digest"]);
    assert.deepEqual(result.archivedSkills, ["ce-legacy"]);
    assert.equal(existsSync(join(root, ".oh-my-harness.pre-fixed-skills", "ce-legacy", "SKILL.md")), true);
    assert.equal(existsSync(legacySkill), false);
    assert.equal(result.backups.length, 1);
    assert.deepEqual(JSON.parse(readFileSync(result.backups[0], "utf8")).plugin, ["keep-me@1.0.0", "oh-my-openagent@latest", "/managed/packages/oh-my-harness/0.1.0/old-digest"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("one plugin package shares skills and CLI tools across three maintained runtimes", () => {
  const packageJson = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
  const marketplace = JSON.parse(readFileSync(join(REPO_ROOT, ".agents", "plugins", "marketplace.json"), "utf8"));
  const claudeMarketplace = JSON.parse(readFileSync(join(REPO_ROOT, ".claude-plugin", "marketplace.json"), "utf8"));
  const plugin = JSON.parse(readFileSync(join(REPO_ROOT, "plugins", "oh-my-harness", ".codex-plugin", "plugin.json"), "utf8"));
  const claudePlugin = JSON.parse(readFileSync(join(REPO_ROOT, "plugins", "oh-my-harness", ".claude-plugin", "plugin.json"), "utf8"));
  const codexMcp = JSON.parse(readFileSync(join(REPO_ROOT, "plugins", "oh-my-harness", ".mcp.json"), "utf8"));
  const claudeMcp = JSON.parse(readFileSync(join(REPO_ROOT, "plugins", "oh-my-harness", ".mcp.claude.json"), "utf8"));
  const runtimeToolProfiles = JSON.parse(readFileSync(join(REPO_ROOT, "plugins", "oh-my-harness", "profiles", "runtime-tools.json"), "utf8"));
  const retiredNamespacePath = join(
    REPO_ROOT,
    "plugins",
    "oh-my-harness",
    "skills",
    String.fromCodePoint(111, 109, 112),
  );
  assert.equal(packageJson.main, ".opencode/plugins/oh-my-harness.js");
  assert.deepEqual(Object.keys(packageJson.bin).sort(), ["oh-my-harness", "omh"]);
  assert.equal(packageJson.files.some((path) => path.startsWith("extensions")), false);
  assert.equal(marketplace.name, "oh-my-harness");
  assert.equal(marketplace.plugins[0].source.path, "./plugins/oh-my-harness");
  assert.equal(claudeMarketplace.name, "oh-my-harness");
  assert.equal(claudeMarketplace.plugins[0].source, "./plugins/oh-my-harness");
  assert.equal(plugin.version, packageJson.version);
  assert.equal(claudePlugin.version, packageJson.version);
  assert.deepEqual(plugin.skills, ["./skills/", "./codex/skills/"]);
  assert.equal(plugin.mcpServers, "./.mcp.json");
  assert.equal(claudePlugin.mcpServers, "./.mcp.claude.json");
  assert.deepEqual(
    codexMcp.mcpServers["workspace-cli-tools"],
    {
      command: "node",
      args: ["./mcp/codex-cli-tools-server.mjs"],
      cwd: ".",
    },
  );
  assert.match(claudeMcp.mcpServers["workspace-cli-tools"].args.at(-1), /OH_MY_HARNESS_RUNTIME = 'claude-code'/);
  assert.deepEqual(runtimeToolProfiles.runtimes, [
    { runtimeId: "claude-code", profileId: "company" },
    { runtimeId: "codex", profileId: "personal" },
    { runtimeId: "opencode", profileId: "company" },
  ]);
  assert.equal(existsSync(retiredNamespacePath), false);
});
