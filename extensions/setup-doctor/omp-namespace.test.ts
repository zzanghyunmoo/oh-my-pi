import assert from "node:assert/strict";
import test from "node:test";
import {
  buildOmpNamespaceReport,
  parseOmpInvocation,
  resolveOmpRoute,
} from "./index.js";

test("parseOmpInvocation accepts omp and oh-my-pi prefixes", () => {
  assert.deepEqual(parseOmpInvocation("omp: ce-plan docs/foo.md"), {
    target: "ce-plan",
    args: "docs/foo.md",
  });
  assert.deepEqual(parseOmpInvocation("oh-my-pi: doctor"), {
    target: "doctor",
    args: "",
  });
  assert.equal(parseOmpInvocation("ce-plan docs/foo.md"), null);
});

test("resolveOmpRoute maps convenience aliases to installed skill names", () => {
  assert.deepEqual(resolveOmpRoute({ target: "plan", args: "" }), {
    kind: "skill",
    skillName: "ce-plan",
  });
  assert.deepEqual(resolveOmpRoute({ target: "lsp", args: "" }), {
    kind: "skill",
    skillName: "lsp-navigation",
  });
  assert.deepEqual(resolveOmpRoute({ target: "ce-worktree", args: "" }), {
    kind: "skill",
    skillName: "ce-worktree",
  });
});

test("resolveOmpRoute maps command aliases to OMP command handlers", () => {
  assert.deepEqual(resolveOmpRoute({ target: "doctor", args: "" }), {
    kind: "command",
    target: "doctor",
  });
  assert.deepEqual(resolveOmpRoute({ target: "setup", args: "full" }), {
    kind: "command",
    target: "connector-setup",
  });
  assert.deepEqual(resolveOmpRoute({ target: "connector-login", args: "linear" }), {
    kind: "command",
    target: "connector-login",
  });
  assert.deepEqual(resolveOmpRoute({ target: "quotio-status", args: "" }), {
    kind: "command",
    target: "quotio-status",
  });
});

test("resolveOmpRoute rejects invalid skill target syntax", () => {
  assert.deepEqual(resolveOmpRoute({ target: "bad/target", args: "" }), {
    kind: "error",
    message: "Unknown OMP target: bad/target",
  });
});

test("buildOmpNamespaceReport documents the user-facing namespace", () => {
  const report = buildOmpNamespaceReport();
  assert.match(report, /omp: <skill-or-command>/);
  assert.match(report, /plan→ce-plan/);
  assert.match(report, /connector-login linear\|notion/);
});
