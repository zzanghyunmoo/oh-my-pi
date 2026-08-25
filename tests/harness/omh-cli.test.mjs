import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseOmhArguments } from "../../dist/cli/main.js";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));

test("legacy omh parser coverage follows the Claude-first v2 selection contract", () => {
  const setup = parseOmhArguments(["setup", "--root", "/tmp/omh-test", "--json"]);
  assert.deepEqual(setup.agents, ["claude-code"]);
  assert.deepEqual(
    setup.tools,
    ["notion", "linear", "jira", "confluence", "github", "gitlab"],
  );
  assert.equal(setup.apply, false);
  assert.equal(setup.digest, undefined);
  assert.equal(setup.profile, "personal");
  assert.equal(setup.json, true);

  const selected = parseOmhArguments([
    "agents",
    "install",
    "--only",
    "claude,codex,opencode",
  ]);
  assert.deepEqual(
    selected.agents,
    ["claude-code", "codex", "opencode"],
  );
  assert.throws(
    () => parseOmhArguments(["setup", "--agents", "unknown-agent"]),
    /must contain ids/,
  );
  assert.deepEqual(
    parseOmhArguments(["setup", "--profile", "mds-host"]).agents,
    [],
  );
});

test("legacy omh parser coverage preserves preview-first digest safety", () => {
  const digest = "a".repeat(64);
  assert.throws(
    () => parseOmhArguments(["setup", "--apply"]),
    /requires the exact --digest/,
  );
  const apply = parseOmhArguments([
    "setup",
    "--agents",
    "claude-code",
    "--apply",
    "--digest",
    digest,
  ]);
  assert.equal(apply.apply, true);
  assert.equal(apply.digest, digest);
  assert.throws(
    () => parseOmhArguments(["status", "--apply"]),
    /--apply is not valid for this command/,
  );
});

test("root launcher and package bin metadata expose omh", () => {
  const launched = process.platform === "win32"
    ? spawnSync(
        process.env.ComSpec ?? "cmd.exe",
        ["/d", "/s", "/c", "omh.cmd --version"],
        { cwd: REPOSITORY_ROOT, encoding: "utf8" },
      )
    : spawnSync(
        join(REPOSITORY_ROOT, "omh"),
        ["--version"],
        { cwd: REPOSITORY_ROOT, encoding: "utf8" },
      );
  assert.equal(launched.status, 0, launched.stderr);
  assert.match(launched.stdout, /^omh 0\.3\.2/m);
  if (process.platform !== "win32") {
    assert.notEqual(statSync(join(REPOSITORY_ROOT, "omh")).mode & 0o111, 0);
  }
  assert.equal(existsSync(join(REPOSITORY_ROOT, "omh.cmd")), true);
  const manifest = JSON.parse(
    readFileSync(join(REPOSITORY_ROOT, "package.json"), "utf8"),
  );
  assert.equal(manifest.bin.omh, "./omh");
  assert.equal(manifest.bin["oh-my-harness"], "./omh");
});
