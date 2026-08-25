#!/usr/bin/env node

import readline from "node:readline";

import { invokeReceiptReconciler } from "../scripts/startup-sync.mjs";

const RUNTIME_IDS = new Set(["claude-code", "opencode", "codex"]);
const MAX_LINE_BYTES = 64 * 1024;
const runtimeId = process.env.OH_MY_HARNESS_RUNTIME ?? "";
const receiptPath = process.env.OH_MY_HARNESS_RECEIPT_PATH ?? "";
const serverInfo = Object.freeze({
  name: "oh-my-harness-environment-status",
  version: "0.3.2",
});
const tool = Object.freeze({
  annotations: {
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
    readOnlyHint: true,
  },
  description:
    "Read the approved receipt and return the current profile, Catalog Revision, selected agents, packages, capabilities, gaps, and preview-first remediation.",
  inputSchema: {
    additionalProperties: false,
    properties: {},
    type: "object",
  },
  name: "environment_status",
  title: "Oh My Harness environment status",
});

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function result(id, value) {
  send({ id, jsonrpc: "2.0", result: value });
}

function error(id, code, message) {
  send({
    error: {
      code,
      message: String(message).replace(/\s+/g, " ").slice(0, 1_024),
    },
    id,
    jsonrpc: "2.0",
  });
}

function startupEnvelope() {
  if (!RUNTIME_IDS.has(runtimeId)) {
    throw new Error("OH_MY_HARNESS_RUNTIME is invalid");
  }
  return invokeReceiptReconciler({
    environment: process.env,
    mode: "native-post-discovery",
    receiptPath,
    runtimeId,
  });
}

function handle(message) {
  if (
    !message
    || typeof message !== "object"
    || Array.isArray(message)
    || message.jsonrpc !== "2.0"
    || typeof message.method !== "string"
    || message.id === undefined
  ) {
    return;
  }
  if (message.method === "initialize") {
    result(message.id, {
      capabilities: { tools: { listChanged: false } },
      instructions:
        "Read-only receipt-derived Oh My Harness startup status. Mutations remain preview-first.",
      protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
      serverInfo,
    });
    return;
  }
  if (message.method === "ping") {
    result(message.id, {});
    return;
  }
  if (message.method === "tools/list") {
    result(message.id, { tools: [tool] });
    return;
  }
  if (
    message.method === "tools/call"
    && message.params?.name === tool.name
  ) {
    try {
      const envelope = startupEnvelope();
      result(message.id, {
        content: [{ text: envelope.renderedContext, type: "text" }],
        structuredContent: envelope,
      });
    } catch (caught) {
      result(message.id, {
        content: [{
          text:
            `Environment status is unverifiable: ${
              caught instanceof Error ? caught.message : String(caught)
            }. Run omh setup and review a new exact preview.`,
          type: "text",
        }],
        isError: true,
      });
    }
    return;
  }
  error(message.id, -32601, `method not found: ${message.method}`);
}

const lines = readline.createInterface({
  crlfDelay: Infinity,
  input: process.stdin,
});
lines.on("line", (line) => {
  if (!line.trim()) return;
  if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
    error(null, -32600, "request exceeded the bounded protocol limit");
    return;
  }
  try {
    handle(JSON.parse(line));
  } catch {
    error(null, -32700, "invalid JSON");
  }
});
