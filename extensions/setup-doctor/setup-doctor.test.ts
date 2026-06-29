import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import setupDoctorExtension from "./index.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type RegisteredCommand = { handler: (args: string, ctx: unknown) => Promise<void> | void };

function registerExtension() {
  const commands = new Map<string, RegisteredCommand>();
  const pi = {
    registerCommand: (name: string, options: unknown) => {
      commands.set(name, options as RegisteredCommand);
    },
    on: () => undefined,
  } as unknown as ExtensionAPI;
  setupDoctorExtension(pi);
  return { commands };
}

async function withTempSetupPath<T>(fn: () => Promise<T> | T): Promise<T> {
  const previous = process.env.OH_MY_PI_CONNECTOR_SETUP_PATH;
  const dir = await mkdtemp(join(tmpdir(), "oh-my-pi-setup-doctor-"));
  process.env.OH_MY_PI_CONNECTOR_SETUP_PATH = join(dir, "setup.json");
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.OH_MY_PI_CONNECTOR_SETUP_PATH;
    else process.env.OH_MY_PI_CONNECTOR_SETUP_PATH = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

test("setup doctor registers connector-setup bootstrap command", () => {
  const { commands } = registerExtension();
  assert.ok(commands.has("connector-setup"));
  assert.ok(commands.has("oh-my-pi"));
  assert.ok(commands.has("oh-my-pi-doctor"));
});

test("connector-setup minimal records intent and reports hidden-by-mode", async () => {
  await withTempSetupPath(async () => {
    const { commands } = registerExtension();
    const command = commands.get("connector-setup");
    assert.ok(command);
    const notifications: Array<{ message: string; level: string | undefined }> = [];

    await command.handler("minimal", {
      ui: {
        notify: (message: string, level?: string) => notifications.push({ message, level }),
      },
    });

    assert.equal(notifications.length, 1);
    assert.equal(notifications[0]?.level, "info");
    assert.match(notifications[0]?.message ?? "", /Minimal connector setup selected/);
    assert.match(notifications[0]?.message ?? "", /hidden-by-mode/);
    assert.match(notifications[0]?.message ?? "", /Workspace connector extension/);
  });
});

test("oh-my-pi palette points to connector setup modes", async () => {
  const { commands } = registerExtension();
  const command = commands.get("oh-my-pi");
  assert.ok(command);
  const notifications: Array<{ message: string; level: string | undefined }> = [];

  await command.handler("", {
    ui: {
      notify: (message: string, level?: string) => notifications.push({ message, level }),
    },
  });

  assert.equal(notifications[0]?.level, "info");
  assert.match(notifications[0]?.message ?? "", /\/connector-setup full/);
  assert.match(notifications[0]?.message ?? "", /\/connector-setup minimal/);
  assert.match(notifications[0]?.message ?? "", /gitlab_glab_cli/);
});
