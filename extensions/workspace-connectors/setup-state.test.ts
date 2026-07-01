import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getConnectorSetupPath,
  parseConnectorSetupCommand,
  readConnectorSetupState,
  resolveConnectorSetupSelection,
  writeConnectorSetupState,
} from "./setup-state.js";

async function withTempSetupPath<T>(fn: (path: string) => Promise<T> | T): Promise<T> {
  const previous = process.env.OH_MY_PI_CONNECTOR_SETUP_PATH;
  const dir = await mkdtemp(join(tmpdir(), "oh-my-pi-setup-state-"));
  const path = join(dir, "setup.json");
  process.env.OH_MY_PI_CONNECTOR_SETUP_PATH = path;
  try {
    return await fn(path);
  } finally {
    if (previous === undefined) delete process.env.OH_MY_PI_CONNECTOR_SETUP_PATH;
    else process.env.OH_MY_PI_CONNECTOR_SETUP_PATH = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

test("parseConnectorSetupCommand supports full and minimal modes", () => {
  const full = parseConnectorSetupCommand("full");
  assert.ok("state" in full);
  assert.equal(full.state.mode, "full");

  const minimal = parseConnectorSetupCommand("minimal");
  assert.ok("state" in minimal);
  assert.equal(minimal.state.mode, "minimal");
  const resolution = resolveConnectorSetupSelection(minimal.state);
  assert.equal(resolution.selectedIds.length, 0);
  assert.ok(resolution.hiddenIds.includes("linear"));
  assert.equal(resolution.reasonById.linear, "hidden-by-mode");
});

test("selective tenant and capability selectors intersect across dimensions", () => {
  const parsed = parseConnectorSetupCommand("selective tenant:company capability:git");
  assert.ok("state" in parsed);
  const resolution = resolveConnectorSetupSelection(parsed.state);
  assert.deepEqual(resolution.selectedIds, ["gitlab"]);
  assert.equal(resolution.reasonById.github, "hidden-by-filter");
});

test("selective service selectors are explicit and cannot mix with filters", () => {
  const parsed = parseConnectorSetupCommand("selective service:linear service:notion");
  assert.ok("state" in parsed);
  assert.deepEqual(resolveConnectorSetupSelection(parsed.state).selectedIds, ["linear", "notion"]);

  const mixed = parseConnectorSetupCommand("selective service:linear tenant:company");
  assert.ok("error" in mixed);
  assert.match(mixed.error, /cannot be mixed/);
});

test("setup state writes secret-free versioned JSON outside the repo", async () => {
  await withTempSetupPath(async (path) => {
    const parsed = parseConnectorSetupCommand("selective service:linear");
    assert.ok("state" in parsed);
    await writeConnectorSetupState(parsed.state);
    assert.equal(getConnectorSetupPath(), path);
    const state = await readConnectorSetupState();
    assert.equal(state?.version, 1);
    assert.equal(state?.mode, "selective");
    assert.deepEqual(state?.services, ["linear"]);
    assert.equal(JSON.stringify(state).includes("token"), false);
  });
});

test("setup state refuses symlinked override paths", async () => {
  const previous = process.env.OH_MY_PI_CONNECTOR_SETUP_PATH;
  const dir = await mkdtemp(join(tmpdir(), "oh-my-pi-setup-state-link-"));
  const target = join(dir, "target.json");
  const link = join(dir, "link.json");
  try {
    await symlink(target, link);
    process.env.OH_MY_PI_CONNECTOR_SETUP_PATH = link;
    assert.throws(() => getConnectorSetupPath(), /symlinked connector setup state path/);
  } finally {
    if (previous === undefined) delete process.env.OH_MY_PI_CONNECTOR_SETUP_PATH;
    else process.env.OH_MY_PI_CONNECTOR_SETUP_PATH = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
