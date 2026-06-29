import { statSync } from "node:fs";
import { delimiter, isAbsolute, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { routeCliConnector, type CliConnectorBackendRoute } from "../connector-backend-catalog.js";

export type CliConnectorId = CliConnectorBackendRoute["id"];

export interface CliAuthStatus {
  readonly service: CliConnectorId;
  readonly command: "gh" | "glab";
  readonly available: boolean;
  readonly ready: boolean;
  readonly code: number | null;
  readonly summary: string;
  readonly executablePath?: string;
  readonly timedOut: boolean;
  readonly error?: string;
}

export interface CliExecutionResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly executablePath: string;
}

interface CommandResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

const COMMAND_TIMEOUT_MS = 3000;
const MAX_OUTPUT_CHARS = 20_000;
const TOKEN_PATTERNS = [
  /github_pat_[A-Za-z0-9_]+/g,
  /gh[pousr]_[A-Za-z0-9_]+/g,
  /glpat-[A-Za-z0-9_\-]+/g,
  /glrt-[A-Za-z0-9_\-]+/g,
  /\bBearer\s+[A-Za-z0-9._\-]+/gi,
  /Authorization:\s*[^\n\r]+/gi,
];

const COMMON_DENIED_ARGS = new Set([
  "--show-token",
  "--with-token",
  "--method",
  "-X",
  "--field",
  "-F",
  "--raw-field",
  "-f",
  "--input",
  "--paginate-all",
  "--web",
  "--browser",
]);

const COMMON_DENIED_ARG_PREFIXES = [
  "--show-token=",
  "--with-token=",
  "--method=",
  "-X=",
  "--field=",
  "-F=",
  "--raw-field=",
  "-f=",
  "--input=",
  "--paginate-all=",
  "--web=",
  "--browser=",
] as const;

const GITHUB_ALLOWED: Readonly<Record<string, readonly string[]>> = {
  auth: ["status"],
  repo: ["list", "view"],
  issue: ["list", "view"],
  pr: ["list", "view"],
  api: ["*"],
};

const GITLAB_ALLOWED: Readonly<Record<string, readonly string[]>> = {
  auth: ["status"],
  repo: ["list", "view", "search"],
  issue: ["list", "view"],
  mr: ["list", "view"],
  api: ["*"],
  search: ["*"],
};

const EXTRA_DENIED_TOP_LEVEL = new Set([
  "alias",
  "extension",
  "config",
  "secret",
  "variable",
  "token",
  "runner",
  "ci",
  "job",
  "workflow",
  "release",
  "label",
  "milestone",
  "schedule",
  "deploy-key",
  "ssh-key",
  "gpg-key",
  "mcp",
]);

const MUTATING_WORDS = new Set([
  "create",
  "edit",
  "update",
  "delete",
  "close",
  "reopen",
  "merge",
  "ready",
  "lock",
  "unlock",
  "approve",
  "unapprove",
  "assign",
  "move",
  "comment",
  "note",
  "subscribe",
  "unsubscribe",
  "fork",
  "clone",
  "transfer",
  "publish",
  "prune",
  "run",
  "retry",
  "cancel",
  "play",
  "trigger",
  "set",
]);

function truncate(value: string): string {
  if (value.length <= MAX_OUTPUT_CHARS) return value;
  return `${value.slice(0, MAX_OUTPUT_CHARS)}\n…[truncated ${value.length - MAX_OUTPUT_CHARS} chars]`;
}

function appendBounded(current: string, chunk: string): string {
  if (current.length >= MAX_OUTPUT_CHARS) return current;
  return truncate(current + chunk);
}

export function redactConnectorOutput(output: string): string {
  let redacted = output;
  for (const pattern of TOKEN_PATTERNS) {
    redacted = redacted.replace(pattern, (match) => {
      if (/^Authorization:/i.test(match)) return "Authorization: …";
      if (/^Bearer/i.test(match)) return "Bearer …";
      if (match.startsWith("github_pat_")) return "github_pat_…";
      if (match.startsWith("glpat-")) return "glpat-…";
      if (match.startsWith("glrt-")) return "glrt-…";
      return `${match.slice(0, 2)}*_…`;
    });
  }
  return truncate(redacted);
}

export function summarizeConnectorOutput(output: string): string {
  return redactConnectorOutput(output)
    .split("\n")
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join("; ");
}

function isInside(parent: string, child: string): boolean {
  const normalizedParent = resolve(parent);
  const normalizedChild = resolve(child);
  return normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}${sep}`);
}

function isExecutable(path: string): boolean {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return false;
    if (process.platform === "win32") return true;
    return (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

export function resolveTrustedExecutable(command: "gh" | "glab", env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  const pathValue = env.PATH ?? "";
  for (const rawEntry of pathValue.split(delimiter)) {
    if (!rawEntry || rawEntry === ".") continue;
    const dir = isAbsolute(rawEntry) ? rawEntry : resolve(cwd, rawEntry);
    if (isInside(cwd, dir)) continue;
    const candidate = resolve(dir, process.platform === "win32" ? `${command}.exe` : command);
    if (isExecutable(candidate)) {
      return candidate;
    }
  }
  throw new Error(`${command} not available on a trusted PATH outside the current repository.`);
}

export function sanitizeCliEnvironment(route: ReturnType<typeof routeCliConnector>): NodeJS.ProcessEnv {
  const allowedKeys = [
    "PATH",
    "HOME",
    "USERPROFILE",
    "XDG_CONFIG_HOME",
    "XDG_STATE_HOME",
    "XDG_DATA_HOME",
    "GH_CONFIG_DIR",
    "GITLAB_CONFIG_DIR",
    "GITLAB_HOST",
    "NO_COLOR",
    "TERM",
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const key of allowedKeys) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  if (route.hostEnvVar && process.env[route.hostEnvVar]) {
    env[route.hostEnvVar] = process.env[route.hostEnvVar];
  }
  return env;
}

function deny(message: string): string {
  return `Refusing potentially mutating or unsafe CLI command: ${message}`;
}

function validateAllowed(service: CliConnectorId, args: readonly string[]): string | null {
  if (args.length === 0) return deny("empty argument list");
  for (const arg of args) {
    if (COMMON_DENIED_ARGS.has(arg) || COMMON_DENIED_ARG_PREFIXES.some((prefix) => arg.startsWith(prefix))) {
      return deny(`${arg} is not allowed`);
    }
  }

  const top = args[0];
  const sub = args[1];
  if (!top) return deny("missing top-level command");
  if (EXTRA_DENIED_TOP_LEVEL.has(top)) return deny(`${top} is not allowed`);
  for (const arg of args) {
    if (MUTATING_WORDS.has(arg)) return deny(`${arg} is not allowed`);
  }

  const allowed = service === "github" ? GITHUB_ALLOWED : GITLAB_ALLOWED;
  const allowedSubcommands = allowed[top];
  if (!allowedSubcommands) return deny(`${top} is not in the read-only allowlist`);
  if (top === "api") {
    if (!sub || sub.startsWith("-")) return deny("api requires a read endpoint argument");
    return null;
  }
  if (allowedSubcommands.includes("*")) return null;
  if (!sub || !allowedSubcommands.includes(sub)) {
    return deny(`${top} ${sub ?? ""}`.trim() + " is not in the read-only allowlist");
  }
  return null;
}

export function validateReadOnlyCliInvocation(service: CliConnectorId, args: readonly string[]): void {
  const message = validateAllowed(service, args);
  if (message) throw new Error(message);
}

function spawnCommand(executablePath: string, args: readonly string[], signal: AbortSignal | undefined, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<CommandResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(executablePath, args, {
      shell: false,
      signal,
      env,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(null);
      }, 1_000);
    }, timeoutMs);

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolveResult({ code, stdout: redactConnectorOutput(stdout), stderr: redactConnectorOutput(stderr), timedOut });
    };

    child.stdout?.on("data", (chunk) => {
      stdout = appendBounded(stdout, chunk.toString());
    });
    child.stderr?.on("data", (chunk) => {
      stderr = appendBounded(stderr, chunk.toString());
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      reject(error);
    });
    child.on("exit", finish);
  });
}

export async function executeReadOnlyCliConnector(service: CliConnectorId, args: readonly string[], signal?: AbortSignal): Promise<CliExecutionResult> {
  validateReadOnlyCliInvocation(service, args);
  const route = routeCliConnector(service);
  const executablePath = resolveTrustedExecutable(route.command);
  const result = await spawnCommand(executablePath, args, signal, sanitizeCliEnvironment(route), 30_000);
  return {
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    executablePath,
  };
}

export async function checkCliAuthStatus(service: CliConnectorId, timeoutMs = COMMAND_TIMEOUT_MS): Promise<CliAuthStatus> {
  const route = routeCliConnector(service);
  let executablePath: string | undefined;
  try {
    executablePath = resolveTrustedExecutable(route.command);
    validateReadOnlyCliInvocation(service, route.authStatusArgs);
    const result = await spawnCommand(executablePath, route.authStatusArgs, undefined, sanitizeCliEnvironment(route), timeoutMs);
    const summary = summarizeConnectorOutput(`${result.stdout}\n${result.stderr}`) || (result.code === 0 ? "authenticated" : `not authenticated or unavailable (exit ${result.code})`);
    return {
      service,
      command: route.command,
      available: true,
      ready: result.code === 0 && !result.timedOut,
      code: result.code,
      summary: result.timedOut ? `timed out after ${timeoutMs}ms` : summary,
      executablePath,
      timedOut: result.timedOut,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      service,
      command: route.command,
      available: executablePath !== undefined,
      ready: false,
      code: null,
      summary: redactConnectorOutput(message),
      executablePath,
      timedOut: false,
      error: redactConnectorOutput(message),
    };
  }
}
