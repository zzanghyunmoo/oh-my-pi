import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  checkCliAuthStatus,
  executeReadOnlyCliConnector,
  redactConnectorOutput,
  resolveTrustedExecutable,
  validateReadOnlyCliInvocation,
} from "./cli-bridge.js";

async function withFakeCli<T>(command: "gh" | "glab", body: string, fn: (dir: string) => Promise<T> | T): Promise<T> {
  const previousPath = process.env.PATH;
  const dir = await mkdtemp(join(tmpdir(), "oh-my-pi-cli-"));
  const path = join(dir, command);
  await writeFile(path, `#!/bin/sh\n${body}\n`, "utf-8");
  await chmod(path, 0o700);
  process.env.PATH = previousPath ? `${dir}:${previousPath}` : dir;
  try {
    return await fn(dir);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(dir, { recursive: true, force: true });
  }
}

test("validateReadOnlyCliInvocation allows read commands and refuses mutations", () => {
  assert.doesNotThrow(() => validateReadOnlyCliInvocation("github", ["repo", "view", "OWNER/REPO"]));
  assert.doesNotThrow(() => validateReadOnlyCliInvocation("gitlab", ["mr", "list"]));
  assert.doesNotThrow(() => validateReadOnlyCliInvocation("gitlab", ["api", "projects"]));

  assert.throws(() => validateReadOnlyCliInvocation("github", ["repo", "create"]), /Refusing/);
  assert.throws(() => validateReadOnlyCliInvocation("gitlab", ["api", "projects", "--method", "POST"]), /Refusing/);
  assert.throws(() => validateReadOnlyCliInvocation("gitlab", ["auth", "status", "--show-token"]), /Refusing/);
  assert.throws(() => validateReadOnlyCliInvocation("gitlab", ["alias", "list"]), /Refusing/);
});

test("validateReadOnlyCliInvocation refuses value-bearing unsafe flags and browser launches", () => {
  assert.throws(() => validateReadOnlyCliInvocation("github", ["api", "repos/o/r", "--field=title=x"]), /Refusing/);
  assert.throws(() => validateReadOnlyCliInvocation("github", ["auth", "status", "--with-token=abc"]), /Refusing/);
  assert.throws(() => validateReadOnlyCliInvocation("github", ["repo", "view", "OWNER/REPO", "--web"]), /Refusing/);
  assert.throws(() => validateReadOnlyCliInvocation("gitlab", ["api", "projects", "--raw-field=x=y"]), /Refusing/);
  assert.throws(() => validateReadOnlyCliInvocation("gitlab", ["repo", "view", "group/project", "--browser"]), /Refusing/);
});

test("executeReadOnlyCliConnector uses trusted PATH executable and redacts output", async () => {
  await withFakeCli("glab", "echo glpat-secret123", async (dir) => {
    assert.equal(resolveTrustedExecutable("glab"), join(dir, "glab"));
    const result = await executeReadOnlyCliConnector("gitlab", ["issue", "list"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /glpat-…/);
    assert.equal(result.executablePath, join(dir, "glab"));
  });
});

test("resolveTrustedExecutable refuses cwd-local shims", async () => {
  const previousPath = process.env.PATH;
  const shim = join(process.cwd(), "gh");
  await writeFile(shim, "#!/bin/sh\necho bad\n", "utf-8");
  await chmod(shim, 0o700);
  process.env.PATH = ".";
  try {
    assert.throws(() => resolveTrustedExecutable("gh"), /trusted PATH/);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(shim, { force: true });
  }
});

test("checkCliAuthStatus hard-times out a CLI that ignores SIGTERM", async () => {
  await withFakeCli("gh", "trap '' TERM\nwhile true; do sleep 1; done", async () => {
    const started = Date.now();
    const status = await checkCliAuthStatus("github", 10);
    assert.equal(status.ready, false);
    assert.equal(status.timedOut, true);
    assert.ok(Date.now() - started < 3_000);
  });
});

test("redactConnectorOutput redacts common token shapes", () => {
  assert.equal(redactConnectorOutput("Authorization: Bearer abc.def"), "Authorization: …");
  assert.equal(redactConnectorOutput("github_pat_abcdef"), "github_pat_…");
  assert.equal(redactConnectorOutput("glrt-secret"), "glrt-…");
});
