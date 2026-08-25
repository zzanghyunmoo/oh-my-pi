#!/usr/bin/env node
import {
  assertCliToolAllowed,
  assertCurrentToolPolicy,
  cliToolDefinitionsForPolicy,
  cliToolServiceIdsForPolicy,
  executeCliTool,
  formatCliToolResult,
  listCliToolStatusForPolicy,
  loadToolPolicySnapshot,
  redactCliOutput,
  staleSessionToolPolicy,
  toolPolicyStatus,
} from "./cli-tools-core.mjs";

const RUNTIME_ID = process.env.OH_MY_HARNESS_RUNTIME ?? "";
const SESSION_POLICY = loadToolPolicySnapshot({ runtimeId: RUNTIME_ID });
const TOOL_DEFINITIONS = cliToolDefinitionsForPolicy(SESSION_POLICY);
const TOOL_NAMES = new Set(TOOL_DEFINITIONS.map(({ name }) => name));
const SERVER_INFO = Object.freeze({
  name: "oh-my-harness-cli-tools",
  version: "0.3.2",
});
const MAX_LINE_BYTES = 64 * 1024;
const JSON_RPC_ERRORS = Object.freeze({
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
});

function readCurrentPolicy() {
  return loadToolPolicySnapshot({ runtimeId: RUNTIME_ID });
}

function activeSessionPolicy() {
  if (SESSION_POLICY.mode !== "ready") return SESSION_POLICY;
  try {
    assertCurrentToolPolicy(SESSION_POLICY, readCurrentPolicy());
    return SESSION_POLICY;
  } catch {
    return staleSessionToolPolicy(SESSION_POLICY);
  }
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, value) {
  send({ jsonrpc: "2.0", id, result: value });
}

function error(id, code, message) {
  send({
    jsonrpc: "2.0",
    id,
    error: { code, message: redactCliOutput(message) },
  });
}

function toolSchema(definition) {
  return {
    name: definition.name,
    title: definition.label,
    description:
      `${definition.description} The executable must already be installed and authenticated. Arguments run without a shell. confirmedWrite is a defense-in-depth signal for an exact user-requested state change; it is not proof of human authorization.`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["args", "cwd"],
      properties: {
        args: {
          type: "array",
          minItems: definition.service === "coderabbit" ? 0 : 1,
          maxItems: 64,
          items: { type: "string", minLength: 1, maxLength: 4096 },
          description:
            `Arguments passed directly without a shell. Examples: ${
              definition.examples.map((args) => JSON.stringify(args)).join(" or ")
            }.`,
        },
        cwd: {
          type: "string",
          minLength: 1,
          description:
            "Absolute coding-workspace directory in which to run the CLI.",
        },
        confirmedWrite: {
          type: "boolean",
          default: false,
          description:
            "Defense-in-depth signal. Set true only after explicit user intent for this exact state change.",
        },
      },
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  };
}

const STATUS_TOOL = Object.freeze({
  name: "workspace_cli_status",
  title: "Workspace CLI status",
  description:
    "Show the receipt-derived tool policy and local trusted-PATH installation state. Authentication is not probed.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["cwd"],
    properties: {
      cwd: {
        type: "string",
        minLength: 1,
        description:
          "Absolute coding-workspace directory used to reject workspace-local shims.",
      },
    },
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
});

const SETUP_TOOL = Object.freeze({
  name: "workspace_cli_setup",
  title: "Workspace CLI setup guidance",
  description:
    "Show the exact preview-first setup command for the current receipt state. This tool never applies changes.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {},
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
});

async function callTool(id, params) {
  const name = params?.name;
  const args = params?.arguments;
  if (
    typeof name !== "string"
    || !args
    || typeof args !== "object"
    || Array.isArray(args)
  ) {
    error(
      id,
      JSON_RPC_ERRORS.INVALID_PARAMS,
      "tools/call requires a tool name and object arguments",
    );
    return;
  }
  try {
    const activePolicy = activeSessionPolicy();
    if (name === STATUS_TOOL.name) {
      const serviceIds = cliToolServiceIdsForPolicy(activePolicy);
      const services = activePolicy.mode === "ready"
        ? await listCliToolStatusForPolicy(activePolicy, {
            serviceIds,
            workspace: args.cwd,
          })
        : [];
      result(id, {
        content: [{
          type: "text",
          text: JSON.stringify(
            { policy: toolPolicyStatus(activePolicy), services },
            null,
            2,
          ),
        }],
        structuredContent: {
          policy: toolPolicyStatus(activePolicy),
          services,
        },
      });
      return;
    }
    if (name === SETUP_TOOL.name) {
      result(id, {
        content: [{
          type: "text",
          text:
            `${activePolicy.remediation}\nPreview only. Review the plan before any separate --apply action.`,
        }],
        structuredContent: {
          mode: activePolicy.mode,
          remediation: activePolicy.remediation,
        },
      });
      return;
    }
    if (!TOOL_NAMES.has(name)) {
      assertCliToolAllowed(activePolicy, name);
      throw new Error(`${name} is not exposed by the active tool session`);
    }
    assertCurrentToolPolicy(SESSION_POLICY, readCurrentPolicy());
    const execution = await executeCliTool(name, args, {
      policy: SESSION_POLICY,
      revalidatePolicy: readCurrentPolicy,
    });
    result(id, {
      isError: execution.code !== 0 || execution.timedOut,
      content: [{ type: "text", text: formatCliToolResult(execution) }],
      structuredContent: {
        toolName: execution.toolName,
        service: execution.service,
        capability: execution.capability,
        access: execution.access,
        code: execution.code,
        timedOut: execution.timedOut,
      },
    });
  } catch (caught) {
    result(id, {
      isError: true,
      content: [{
        type: "text",
        text: redactCliOutput(
          caught instanceof Error ? caught.message : String(caught),
        ),
      }],
    });
  }
}

async function handle(message) {
  if (
    !message
    || message.jsonrpc !== "2.0"
    || typeof message.method !== "string"
  ) {
    return;
  }
  if (message.id === undefined) return;
  if (message.method === "initialize") {
    const policy = activeSessionPolicy();
    const description = policy.mode !== "ready"
      ? `status-only (${policy.reason})`
      : policy.bindings === null
        ? `profile ${policy.profileId}: no workspace CLI backends (composition-only)`
        : `profile ${policy.profileId}: issue-tracker=${policy.bindings["issue-tracker"]}, wiki=${policy.bindings.wiki}, git=${policy.bindings.git}`;
    result(message.id, {
      protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions:
        `Runtime ${RUNTIME_ID} uses approved receipt-derived ${description}. Use role-specific CLI tools only from an absolute coding workspace. Credentials stay with each external CLI. Reads are allowlisted. confirmedWrite is defense in depth and does not prove human authorization. If the receipt changes, start a new runtime/tool session.`,
    });
    return;
  }
  if (message.method === "ping") {
    result(message.id, {});
    return;
  }
  if (message.method === "tools/list") {
    const policy = activeSessionPolicy();
    const definitions = policy.mode === "ready" ? TOOL_DEFINITIONS : [];
    result(message.id, {
      tools: [
        STATUS_TOOL,
        SETUP_TOOL,
        ...definitions.map(toolSchema),
      ],
    });
    return;
  }
  if (message.method === "tools/call") {
    await callTool(message.id, message.params);
    return;
  }
  error(
    message.id,
    JSON_RPC_ERRORS.METHOD_NOT_FOUND,
    `method not found: ${message.method}`,
  );
}

function handleLine(line) {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    error(null, JSON_RPC_ERRORS.INVALID_REQUEST, "invalid JSON-RPC request");
    return;
  }
  handle(message).catch((caught) => {
    if (message?.id !== undefined) {
      error(
        message.id,
        JSON_RPC_ERRORS.INTERNAL_ERROR,
        caught instanceof Error ? caught.message : String(caught),
      );
    }
  });
}

let lineChunks = [];
let lineBytes = 0;
let discardingOversizedLine = false;

process.stdin.on("data", (rawChunk) => {
  const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
  let offset = 0;
  while (offset < chunk.length) {
    const newline = chunk.indexOf(0x0a, offset);
    const end = newline === -1 ? chunk.length : newline;
    const slice = chunk.subarray(offset, end);
    if (!discardingOversizedLine) {
      lineBytes += slice.length;
      if (lineBytes > MAX_LINE_BYTES) {
        discardingOversizedLine = true;
        lineChunks = [];
        error(
          null,
          JSON_RPC_ERRORS.INVALID_REQUEST,
          "JSON-RPC request exceeds the bounded line limit",
        );
      } else if (slice.length > 0) {
        lineChunks.push(slice);
      }
    }
    if (newline === -1) break;
    if (!discardingOversizedLine) {
      const line = Buffer.concat(lineChunks, lineBytes)
        .toString("utf8")
        .replace(/\r$/u, "");
      handleLine(line);
    }
    lineChunks = [];
    lineBytes = 0;
    discardingOversizedLine = false;
    offset = newline + 1;
  }
});

process.stdin.on("end", () => {
  if (!discardingOversizedLine && lineBytes > 0) {
    handleLine(Buffer.concat(lineChunks, lineBytes).toString("utf8"));
  }
});
