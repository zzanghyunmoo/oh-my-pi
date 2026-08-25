import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { HARNESS_VERSION } from "../../dist/package-version.js";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(REPOSITORY_ROOT, path), "utf8")) as Record<string, unknown>;
}

test("0.3.2 package identity is coherent across distributed surfaces", () => {
  const packageManifest = readJson("package.json");
  const shrinkwrap = readJson("npm-shrinkwrap.json");
  const marketplace = readJson(".claude-plugin/marketplace.json");
  const claudePlugin = readJson("plugins/oh-my-harness/.claude-plugin/plugin.json");
  const codexPlugin = readJson("plugins/oh-my-harness/.codex-plugin/plugin.json");
  const release = readJson("harness/catalog/release.json");

  assert.equal(HARNESS_VERSION, "0.3.2");
  assert.equal(packageManifest.version, HARNESS_VERSION);
  assert.equal(shrinkwrap.version, HARNESS_VERSION);
  assert.equal((shrinkwrap.packages as Record<string, { version: string }>)[""]?.version, HARNESS_VERSION);
  assert.equal(marketplace.version, HARNESS_VERSION);
  assert.equal((marketplace.plugins as Array<{ version: string }>)[0]?.version, HARNESS_VERSION);
  assert.equal(claudePlugin.version, HARNESS_VERSION);
  assert.equal(codexPlugin.version, HARNESS_VERSION);
  assert.deepEqual(release.compatibility, {
    maximumCliVersion: HARNESS_VERSION,
    minimumCliVersion: HARNESS_VERSION,
  });
  for (const path of [
    "plugins/oh-my-harness/mcp/status-server.mjs",
    "plugins/oh-my-harness/mcp/cli-tools-server.mjs",
  ]) {
    assert.match(
      readFileSync(join(REPOSITORY_ROOT, path), "utf8"),
      new RegExp(`version: ["']${HARNESS_VERSION.replaceAll(".", "\\.")}["']`),
    );
  }
});
