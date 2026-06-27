export type RuntimeSafetyClass =
  | "local-configuration"
  | "external-provider"
  | "external-workspace";

export type RuntimePolicyTargetKind = "connector" | "provider" | "tool" | "command";
export type RuntimeAccessMode = "read-only" | "confirm-write" | "blocked" | "mixed";
export type RuntimeApprovalExpectation =
  | "no-confirmation-for-safe-reads"
  | "confirm-before-write"
  | "blocked-in-tool";

export type RuntimePolicyHintKind =
  | "tool-name-pattern"
  | "gh-subcommand"
  | "operation-intent"
  | "secret-field";

export interface RuntimePolicyHint {
  readonly kind: RuntimePolicyHintKind;
  readonly values: readonly string[];
  readonly guidance: string;
}

export interface RuntimeApprovalPolicy {
  readonly expectation: RuntimeApprovalExpectation;
  readonly guidance: string;
}

export interface RuntimeSafetyPolicy {
  readonly id: string;
  readonly targetKind: RuntimePolicyTargetKind;
  readonly targetName: string;
  readonly safetyClass: RuntimeSafetyClass;
  readonly accessMode: RuntimeAccessMode;
  readonly allowlistHints: readonly RuntimePolicyHint[];
  readonly blocklistHints: readonly RuntimePolicyHint[];
  readonly redactionGuidance: readonly string[];
  readonly auditGuidance: readonly string[];
  readonly approval: RuntimeApprovalPolicy;
  readonly promptGuidelines: readonly string[];
}

export interface RuntimeSafetyPolicySummary {
  readonly id: string;
  readonly targetKind: RuntimePolicyTargetKind;
  readonly targetName: string;
  readonly safetyClass: RuntimeSafetyClass;
  readonly accessMode: RuntimeAccessMode;
  readonly approvalExpectation: RuntimeApprovalExpectation;
  readonly allowlist: readonly string[];
  readonly blocklist: readonly string[];
  readonly redactionGuidance: readonly string[];
  readonly auditGuidance: readonly string[];
}

const GITHUB_GH_MUTATING_SUBCOMMANDS = [
  "create",
  "edit",
  "delete",
  "close",
  "reopen",
  "merge",
  "ready",
  "lock",
  "unlock",
] as const;

export const runtimeSafetyPolicyLedger = [
  {
    id: "connector.linear",
    targetKind: "connector",
    targetName: "linear",
    safetyClass: "external-workspace",
    accessMode: "mixed",
    allowlistHints: [
      {
        kind: "operation-intent",
        values: ["list", "get", "search", "read"],
        guidance: "Safe Linear reads may proceed when explicitly requested by the user.",
      },
    ],
    blocklistHints: [
      {
        kind: "operation-intent",
        values: ["create", "update", "delete", "archive", "comment", "assign", "move"],
        guidance: "Linear workspace mutations require explicit user intent or confirmation before use.",
      },
    ],
    redactionGuidance: [
      "Do not log OAuth tokens, session cookies, or raw MCP auth headers.",
      "Avoid echoing private issue content unless it is needed to answer the user's request.",
    ],
    auditGuidance: [
      "Record service, MCP tool name, and user-visible intent for write-like Linear calls.",
    ],
    approval: {
      expectation: "confirm-before-write",
      guidance: "Ask for confirmation before Linear writes unless the user explicitly requested that exact change.",
    },
    promptGuidelines: [
      "Classify unfamiliar Linear MCP tools by name/description before calling them.",
      "Prefer list/get/search Linear tools for discovery and safe read workflows.",
    ],
  },
  {
    id: "connector.notion",
    targetKind: "connector",
    targetName: "notion",
    safetyClass: "external-workspace",
    accessMode: "mixed",
    allowlistHints: [
      {
        kind: "operation-intent",
        values: ["list", "get", "search", "read"],
        guidance: "Safe Notion reads may proceed when explicitly requested by the user.",
      },
    ],
    blocklistHints: [
      {
        kind: "operation-intent",
        values: ["create", "update", "delete", "archive", "comment", "move"],
        guidance: "Notion page/database mutations require explicit user intent or confirmation before use.",
      },
    ],
    redactionGuidance: [
      "Do not log OAuth tokens, session cookies, or raw MCP auth headers.",
      "Avoid echoing private page/database content unless it is needed to answer the user's request.",
    ],
    auditGuidance: [
      "Record service, MCP tool name, and user-visible intent for write-like Notion calls.",
    ],
    approval: {
      expectation: "confirm-before-write",
      guidance: "Ask for confirmation before Notion writes unless the user explicitly requested that exact change.",
    },
    promptGuidelines: [
      "Classify unfamiliar Notion MCP tools by name/description before calling them.",
      "Prefer list/get/search Notion tools for discovery and safe read workflows.",
    ],
  },
  {
    id: "connector.github-gh-cli",
    targetKind: "connector",
    targetName: "github",
    safetyClass: "external-workspace",
    accessMode: "read-only",
    allowlistHints: [
      {
        kind: "operation-intent",
        values: ["auth status", "repo view", "repo list", "issue list", "issue view", "pr list", "pr view", "api GET"],
        guidance: "Use github_gh_cli for authenticated GitHub reads that do not mutate remote state.",
      },
    ],
    blocklistHints: [
      {
        kind: "gh-subcommand",
        values: GITHUB_GH_MUTATING_SUBCOMMANDS,
        guidance: "These gh subcommands are refused inside the Pi tool boundary.",
      },
    ],
    redactionGuidance: [
      "Do not log gh auth tokens, GitHub PATs, or authorization headers.",
      "Summarize private repository output when full raw output is not required.",
    ],
    auditGuidance: [
      "Record gh arguments and repository scope for troubleshooting, with credentials redacted.",
    ],
    approval: {
      expectation: "blocked-in-tool",
      guidance: "Known mutating gh subcommands are blocked in-tool; after explicit confirmation, run them manually outside this tool if needed.",
    },
    promptGuidelines: [
      "Treat github_gh_cli as a read-only bridge over the user's authenticated gh session.",
      "Do not use github_gh_cli for repository, issue, PR, release, or workflow mutations.",
    ],
  },
  {
    id: "provider.quotio",
    targetKind: "provider",
    targetName: "quotio",
    safetyClass: "external-provider",
    accessMode: "mixed",
    allowlistHints: [
      {
        kind: "operation-intent",
        values: ["model discovery", "status check", "user-requested inference"],
        guidance: "Provider discovery/status checks are safe when secrets are redacted.",
      },
    ],
    blocklistHints: [
      {
        kind: "secret-field",
        values: ["QUOTIO_API_KEY", "Authorization", "api_key"],
        guidance: "Provider credentials must never be included in user-visible output or diagnostics.",
      },
    ],
    redactionGuidance: [
      "Redact QUOTIO_API_KEY and Authorization headers from errors, logs, and status output.",
      "Treat prompts and model responses as potentially sensitive external-provider traffic.",
    ],
    auditGuidance: [
      "Record provider name, model id, status/discovery outcome, and error class without credentials.",
    ],
    approval: {
      expectation: "no-confirmation-for-safe-reads",
      guidance: "No extra confirmation is required for status/model discovery or user-requested model calls.",
    },
    promptGuidelines: [
      "Never expose Quotio credentials in prompts, tool details, or notifications.",
    ],
  },
  {
    id: "tool.workspace_mcp_list_tools",
    targetKind: "tool",
    targetName: "workspace_mcp_list_tools",
    safetyClass: "external-workspace",
    accessMode: "read-only",
    allowlistHints: [
      {
        kind: "operation-intent",
        values: ["list tools", "inspect schema", "discover connector capabilities"],
        guidance: "Tool listing is the preferred safe discovery path before calling MCP tools.",
      },
    ],
    blocklistHints: [],
    redactionGuidance: [
      "Do not include OAuth tokens or transport credentials in tool-listing output.",
    ],
    auditGuidance: [
      "Record the selected workspace service when diagnosing connector availability.",
    ],
    approval: {
      expectation: "no-confirmation-for-safe-reads",
      guidance: "No extra confirmation is required for listing available MCP tools.",
    },
    promptGuidelines: [
      "Use this read-only tool before calling unfamiliar Linear or Notion MCP tools.",
    ],
  },
  {
    id: "tool.workspace_mcp_call_tool",
    targetKind: "tool",
    targetName: "workspace_mcp_call_tool",
    safetyClass: "external-workspace",
    accessMode: "confirm-write",
    allowlistHints: [
      {
        kind: "tool-name-pattern",
        values: ["list*", "get*", "search*", "read*"],
        guidance: "Read-like MCP tool names are usually safe when aligned with the user's request.",
      },
    ],
    blocklistHints: [
      {
        kind: "tool-name-pattern",
        values: ["create*", "update*", "delete*", "archive*", "comment*", "move*"],
        guidance: "Write-like MCP tool names require explicit user intent or confirmation before use.",
      },
    ],
    redactionGuidance: [
      "Do not log OAuth tokens, raw transport credentials, or unrelated private workspace content.",
    ],
    auditGuidance: [
      "Record service, tool name, and high-level intent for write-like MCP calls.",
    ],
    approval: {
      expectation: "confirm-before-write",
      guidance: "Ask for confirmation before destructive or write-like MCP calls unless the user explicitly requested the exact change.",
    },
    promptGuidelines: [
      "Use workspace_mcp_list_tools or user-provided schema context before calling a specific MCP tool.",
      "When the MCP tool appears read-like, do not add confirmation friction for explicitly requested safe reads.",
    ],
  },
  {
    id: "tool.github_gh_cli",
    targetKind: "tool",
    targetName: "github_gh_cli",
    safetyClass: "external-workspace",
    accessMode: "read-only",
    allowlistHints: [
      {
        kind: "operation-intent",
        values: ["repo list", "repo view", "issue list", "issue view", "pr list", "pr view", "auth status", "api GET"],
        guidance: "Read-only gh commands may proceed when requested by the user.",
      },
    ],
    blocklistHints: [
      {
        kind: "gh-subcommand",
        values: GITHUB_GH_MUTATING_SUBCOMMANDS,
        guidance: "The runtime guard refuses args containing any of these known mutating gh subcommands.",
      },
    ],
    redactionGuidance: [
      "Do not print gh auth tokens, PATs, or Authorization headers.",
    ],
    auditGuidance: [
      "Keep gh args, exit code, stdout, and stderr in tool details only after normal credential redaction expectations.",
    ],
    approval: {
      expectation: "blocked-in-tool",
      guidance: "Known mutating gh subcommands are refused by this tool even if confirmation is desired.",
    },
    promptGuidelines: [
      "Use github_gh_cli only for GitHub read commands backed by the user's local gh authentication.",
      "Ask for confirmation before proposing any GitHub mutation, then use a manual path rather than this tool.",
    ],
  },
] as const satisfies readonly RuntimeSafetyPolicy[];

export type RuntimeSafetyPolicyId = (typeof runtimeSafetyPolicyLedger)[number]["id"];

export function getRuntimeSafetyPolicy(id: RuntimeSafetyPolicyId): RuntimeSafetyPolicy {
  for (const policy of runtimeSafetyPolicyLedger) {
    if (policy.id === id) {
      return policy;
    }
  }
  throw new Error(`Unknown runtime safety policy: ${id}`);
}

export function getToolRuntimeSafetyPolicy(toolName: string): RuntimeSafetyPolicy {
  for (const policy of runtimeSafetyPolicyLedger) {
    if (policy.targetKind === "tool" && policy.targetName === toolName) {
      return policy;
    }
  }
  throw new Error(`Unknown runtime safety tool policy: ${toolName}`);
}

export function getConnectorRuntimeSafetyPolicy(connectorName: string): RuntimeSafetyPolicy {
  for (const policy of runtimeSafetyPolicyLedger) {
    if (policy.targetKind === "connector" && policy.targetName === connectorName) {
      return policy;
    }
  }
  throw new Error(`Unknown runtime safety connector policy: ${connectorName}`);
}

export function summarizeRuntimeSafetyPolicy(policy: RuntimeSafetyPolicy): RuntimeSafetyPolicySummary {
  return {
    id: policy.id,
    targetKind: policy.targetKind,
    targetName: policy.targetName,
    safetyClass: policy.safetyClass,
    accessMode: policy.accessMode,
    approvalExpectation: policy.approval.expectation,
    allowlist: flattenHintValues(policy.allowlistHints),
    blocklist: flattenHintValues(policy.blocklistHints),
    redactionGuidance: policy.redactionGuidance,
    auditGuidance: policy.auditGuidance,
  };
}

export function formatRuntimeSafetyPolicyGuidelines(policy: RuntimeSafetyPolicy): string[] {
  return [
    `Runtime safety policy ${policy.id}: ${policy.safetyClass}/${policy.accessMode}. ${policy.approval.guidance}`,
    ...policy.promptGuidelines,
    ...policy.allowlistHints.map((hint) => `Allowlist hint (${hint.kind}): ${hint.values.join(", ")}. ${hint.guidance}`),
    ...policy.blocklistHints.map((hint) => `Blocklist hint (${hint.kind}): ${hint.values.join(", ")}. ${hint.guidance}`),
  ];
}

export function getGithubGhCliBlockedSubcommands(): readonly string[] {
  return getHintValuesByKind(getToolRuntimeSafetyPolicy("github_gh_cli"), "gh-subcommand");
}

export function isBlockedGithubGhCliInvocation(args: readonly string[]): boolean {
  const blockedSubcommands = getGithubGhCliBlockedSubcommands();
  for (const arg of args) {
    for (const blockedSubcommand of blockedSubcommands) {
      if (arg === blockedSubcommand) {
        return true;
      }
    }
  }
  return false;
}

export function getGithubGhCliMutationGuardMessage(): string {
  return "Refusing potentially mutating gh command from tool. Ask the user for explicit confirmation and run manually if needed.";
}

function flattenHintValues(hints: readonly RuntimePolicyHint[]): string[] {
  const values: string[] = [];
  for (const hint of hints) {
    for (const value of hint.values) {
      values.push(value);
    }
  }
  return values;
}

function getHintValuesByKind(policy: RuntimeSafetyPolicy, kind: RuntimePolicyHintKind): readonly string[] {
  const values: string[] = [];
  for (const hint of policy.blocklistHints) {
    if (hint.kind !== kind) continue;
    for (const value of hint.values) {
      values.push(value);
    }
  }
  return values;
}
