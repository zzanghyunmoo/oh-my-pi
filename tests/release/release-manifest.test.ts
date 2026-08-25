import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import tar from "tar-stream";

import {
  buildReleaseManifest,
  inspectReleaseArchive,
  loadReleaseSidecar,
  materializeReleaseSource,
  resolveReleaseSourceIdentity,
  verifyReleaseArtifact,
} from "../../dist/catalog/release.js";
import {
  runReleaseCommand,
  type ReleaseCommandOperations,
} from "../../dist/catalog/release-command.js";
import { validateContractDocument } from "../../dist/catalog/load.js";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));

function git(repositoryRoot: string, args: readonly string[]): string {
  const result = spawnSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test("U15 release manifest binds catalog, managed skills, plugin bytes, and CLI compatibility", () => {
  const packageManifest = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { version: string };
  const expected = buildReleaseManifest(
    REPOSITORY_ROOT,
    packageManifest.version,
  );
  const released = JSON.parse(
    readFileSync(
      new URL("../../harness/catalog/release.json", import.meta.url),
      "utf8",
    ),
  ) as unknown;

  validateContractDocument("release-catalog", released, REPOSITORY_ROOT);
  assert.deepEqual(released, expected);
  assert.equal(expected.catalogRevision, expected.artifacts[0]?.digest);
  assert.equal(
    expected.artifacts.every(({ digest }) => /^[0-9a-f]{64}$/u.test(digest)),
    true,
  );
  assert.deepEqual(expected.distribution, {
    archiveFilename: "oh-my-harness-v0.3.2.tgz",
    packageName: "oh-my-harness",
    sidecarFilename: "oh-my-harness-v0.3.2.release.json",
    tag: "v0.3.2",
    version: "0.3.2",
  });
});

async function writeArchive(
  path: string,
  entries: readonly { readonly name: string; readonly value: string }[],
): Promise<void> {
  const pack = tar.pack();
  const chunks: Buffer[] = [];
  pack.on("data", (chunk: Buffer) => chunks.push(chunk));
  for (const entry of entries) pack.entry({ name: entry.name }, entry.value);
  pack.finalize();
  await once(pack, "end");
  writeFileSync(path, gzipSync(Buffer.concat(chunks)));
}

test("release archive inspection rejects unsafe and duplicate members", async () => {
  const root = mkdtempSync(join(tmpdir(), "omh-release-invalid-"));
  try {
    const unsafe = join(root, "unsafe.tgz");
    await writeArchive(unsafe, [{ name: "package/../escape", value: "x" }]);
    await assert.rejects(inspectReleaseArchive(unsafe), /unsafe release archive member/i);

    const duplicate = join(root, "duplicate.tgz");
    await writeArchive(duplicate, [
      { name: "package/file", value: "one" },
      { name: "package/file", value: "two" },
    ]);
    await assert.rejects(inspectReleaseArchive(duplicate), /duplicate release archive member/i);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("release source identity requires the exact local tag commit", () => {
  const root = mkdtempSync(join(tmpdir(), "omh-release-identity-"));
  try {
    git(root, ["init"]);
    git(root, ["config", "user.name", "Oh My Harness Test"]);
    git(root, ["config", "user.email", "test@oh-my-harness.invalid"]);
    writeFileSync(join(root, "source.txt"), "first\n");
    git(root, ["add", "source.txt"]);
    git(root, ["commit", "-m", "first"]);
    git(root, ["tag", "v0.3.0"]);
    const matching = resolveReleaseSourceIdentity(root, "v0.3.0");
    assert.equal(matching.commit, git(root, ["rev-parse", "HEAD^{commit}"]));
    assert.equal(matching.tree, git(root, ["rev-parse", "HEAD^{tree}"]));

    writeFileSync(join(root, "source.txt"), "second\n");
    git(root, ["add", "source.txt"]);
    git(root, ["commit", "-m", "second"]);
    assert.throws(
      () => resolveReleaseSourceIdentity(root, "v0.3.0"),
      /does not point to source commit/i,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("release source materialization uses only committed blobs", async () => {
  const root = mkdtempSync(join(tmpdir(), "omh-release-materialize-"));
  const materialized = join(root, "materialized");
  try {
    git(root, ["init"]);
    git(root, ["config", "user.name", "Oh My Harness Test"]);
    git(root, ["config", "user.email", "test@oh-my-harness.invalid"]);
    writeFileSync(join(root, ".gitignore"), "dist/\n");
    writeFileSync(join(root, "source.txt"), "committed\n");
    git(root, ["add", ".gitignore", "source.txt"]);
    git(root, ["commit", "-m", "source"]);
    git(root, ["tag", "v0.3.0"]);
    const identity = resolveReleaseSourceIdentity(root, "v0.3.0");

    writeFileSync(
      join(root, ".git", "info", "attributes"),
      "source.txt export-ignore\n",
    );
    const externalAttributes = join(root, "external-attributes");
    writeFileSync(externalAttributes, ".gitignore export-ignore\n");
    git(root, ["config", "core.attributesFile", externalAttributes]);

    writeFileSync(join(root, "source.txt"), "dirty\n");
    writeFileSync(join(root, "untracked.txt"), "untracked\n");
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "dist", "provenance-backdoor.js"), "ignored\n");

    await materializeReleaseSource(root, identity, materialized);
    assert.equal(readFileSync(join(materialized, "source.txt"), "utf8"), "committed\n");
    assert.equal(readFileSync(join(materialized, ".gitignore"), "utf8"), "dist/\n");
    assert.equal(existsSync(join(materialized, "untracked.txt")), false);
    assert.equal(existsSync(join(materialized, "external-attributes")), false);
    assert.equal(existsSync(join(materialized, "dist")), false);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("release sidecar loading is bounded and schema-closed", () => {
  const root = mkdtempSync(join(tmpdir(), "omh-release-sidecar-"));
  try {
    const released = JSON.parse(
      readFileSync(new URL("../../harness/catalog/release.json", import.meta.url), "utf8"),
    );
    const path = join(root, "sidecar.json");
    const sidecar = {
      $schema: "harness/contracts/release-catalog.schema.json#/$defs/releaseSidecar",
      archive: {
        filename: released.distribution.archiveFilename,
        files: [{ mode: 420, path: "package/package.json", sha256: "a".repeat(64), size: 1 }],
        sha256: "b".repeat(64),
        size: 1,
      },
      catalogRevision: released.catalogRevision,
      kind: "release-sidecar",
      package: { name: "oh-my-harness", tag: "v0.3.0", version: "0.3.0" },
      schemaVersion: "2.0.0",
      source: { commit: "c".repeat(40), tree: "d".repeat(40) },
    };
    writeFileSync(path, JSON.stringify(sidecar));
    assert.deepEqual(loadReleaseSidecar(REPOSITORY_ROOT, path), sidecar);

    writeFileSync(path, JSON.stringify({ ...sidecar, unexpected: true }));
    assert.throws(
      () => loadReleaseSidecar(REPOSITORY_ROOT, path),
      /additional field|schema|contract/i,
    );
    writeFileSync(path, "x".repeat(8 * 1024 * 1024 + 1));
    assert.throws(
      () => loadReleaseSidecar(REPOSITORY_ROOT, path),
      /maximum allowed size|too large|exceeds/i,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("release verification fails closed on tag/version before reading an asset", async () => {
  const released = JSON.parse(
    readFileSync(new URL("../../harness/catalog/release.json", import.meta.url), "utf8"),
  );
  await assert.rejects(
    verifyReleaseArtifact(REPOSITORY_ROOT, "missing.tgz", {
      $schema: "harness/contracts/release-catalog.schema.json#/$defs/releaseSidecar",
      archive: {
        filename: "oh-my-harness-v0.3.2.tgz",
        files: [{ mode: 420, path: "package/package.json", sha256: "a".repeat(64), size: 1 }],
        sha256: "b".repeat(64),
        size: 1,
      },
      catalogRevision: released.catalogRevision,
      kind: "release-sidecar",
      package: { name: "oh-my-harness", tag: "v0.3.3", version: "0.3.2" },
      schemaVersion: "2.0.0",
      source: { commit: "c".repeat(40), tree: "d".repeat(40) },
    }),
    /tag\/version identity mismatch/i,
  );
});

function commandSidecar() {
  return {
    $schema: "harness/contracts/release-catalog.schema.json#/$defs/releaseSidecar" as const,
    archive: {
      filename: "oh-my-harness-v0.3.0.tgz",
      files: [],
      sha256: "a".repeat(64),
      size: 1,
    },
    catalogRevision: "b".repeat(64),
    kind: "release-sidecar" as const,
    package: {
      name: "oh-my-harness" as const,
      tag: "v0.3.0",
      version: "0.3.0",
    },
    schemaVersion: "2.0.0" as const,
    source: { commit: "c".repeat(40), tree: "d".repeat(40) },
  };
}

function commandOperations(calls: string[]): ReleaseCommandOperations {
  const sidecar = commandSidecar();
  return {
    async buildArtifact(repositoryRoot, outputDirectory) {
      calls.push(`build:${repositoryRoot}:${outputDirectory}`);
      return {
        archivePath: "/output/archive.tgz",
        sidecar,
        sidecarPath: "/output/release.json",
      };
    },
    loadSidecar(repositoryRoot, sidecarPath) {
      calls.push(`load:${repositoryRoot}:${sidecarPath}`);
      return sidecar;
    },
    async publishArtifact(input) {
      calls.push(
        `publish:${input.repository}:${input.tag}:${input.sourceSha}:${input.archivePath}:${input.sidecarPath}`,
      );
      return {
        archiveAssetId: 101,
        releaseId: 100,
        sidecarAssetId: 102,
      };
    },
    resolvePath(base, path) {
      calls.push(`resolve:${base}:${path}`);
      return `${base}/${path}`;
    },
    resolveSourceIdentity(repositoryRoot, tag) {
      calls.push(`source:${repositoryRoot}:${tag}`);
      return sidecar.source;
    },
    async verifyArtifact(repositoryRoot, archivePath, value, source) {
      calls.push(
        `verify:${repositoryRoot}:${archivePath}:${value.package.tag}:${source.commit}`,
      );
    },
  };
}

test("release command dispatches build and emits immutable artifact identity", async () => {
  const calls: string[] = [];
  const result = await runReleaseCommand(
    "/repo",
    "/cwd",
    ["build", "output"],
    commandOperations(calls),
  );
  assert.deepEqual(result, {
    exitCode: 0,
    stderr: "",
    stdout: `${JSON.stringify({
      archive: "/output/archive.tgz",
      sidecar: "/output/release.json",
      source: commandSidecar().source,
    })}\n`,
  });
  assert.deepEqual(calls, [
    "resolve:/cwd:output",
    "build:/repo:/cwd/output",
  ]);
});

test("release command dispatches verify through sidecar-bound source identity", async () => {
  const calls: string[] = [];
  const result = await runReleaseCommand(
    "/repo",
    "/cwd",
    ["verify", "archive.tgz", "release.json"],
    commandOperations(calls),
  );
  assert.deepEqual(result, {
    exitCode: 0,
    stderr: "",
    stdout: `${JSON.stringify({
      archive: "/cwd/archive.tgz",
      verified: true,
    })}\n`,
  });
  assert.deepEqual(calls, [
    "resolve:/cwd:archive.tgz",
    "resolve:/cwd:release.json",
    "load:/repo:/cwd/release.json",
    "source:/repo:v0.3.0",
    `verify:/repo:/cwd/archive.tgz:v0.3.0:${"c".repeat(40)}`,
  ]);
});

test("release command dispatches publication with explicit immutable identity", async () => {
  const calls: string[] = [];
  const sourceSha = "c".repeat(40);
  const result = await runReleaseCommand(
    "/repo",
    "/cwd",
    [
      "publish",
      "owner/repository",
      "v0.3.0",
      sourceSha,
      "archive.tgz",
      "release.json",
    ],
    commandOperations(calls),
  );
  assert.deepEqual(result, {
    exitCode: 0,
    stderr: "",
    stdout: `${JSON.stringify({
      archiveAssetId: 101,
      releaseId: 100,
      sidecarAssetId: 102,
    })}\n`,
  });
  assert.deepEqual(calls, [
    "resolve:/cwd:archive.tgz",
    "resolve:/cwd:release.json",
    `publish:owner/repository:v0.3.0:${sourceSha}:/cwd/archive.tgz:/cwd/release.json`,
  ]);
});

test("release command rejects unknown commands and wrong arity without operations", async () => {
  for (const argv of [
    [] as const,
    ["build"] as const,
    ["build", "one", "two"] as const,
    ["verify", "archive"] as const,
    ["publish", "owner/repository", "v0.3.0", "c".repeat(40), "archive.tgz"] as const,
    ["unknown"] as const,
  ]) {
    const calls: string[] = [];
    const result = await runReleaseCommand(
      "/repo",
      "/cwd",
      argv,
      commandOperations(calls),
    );
    assert.equal(result.exitCode, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^usage:/u);
    assert.deepEqual(calls, []);
  }
});
