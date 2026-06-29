import { auth, type OAuthClientProvider, type OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { normalizeHeaders, type FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { request as httpRequest, type Server } from "node:http";
import { request as httpsRequest } from "node:https";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { spawn } from "node:child_process";
import { rootCertificates, getCACertificates } from "node:tls";
import {
  routeWorkspaceMcpConnector,
  type WorkspaceMcpServiceName,
} from "../connector-backend-catalog.js";

export type ConnectorAuthMode = "oauth" | "access-key";

type NotifyLevel = "info" | "error";

interface NotificationContext {
  readonly ui: {
    notify(message: string, level: NotifyLevel): void | Promise<void>;
  };
}

interface StoredOAuthState {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  state?: string;
  discoveryState?: OAuthDiscoveryState;
  updatedAt?: string;
}

interface ServiceAuthState {
  oauth?: StoredOAuthState;
}

interface ConnectorAuthFile {
  version: 1;
  services: Partial<Record<WorkspaceMcpServiceName, ServiceAuthState>>;
}

export interface ConnectorAuthStatus {
  readonly service: WorkspaceMcpServiceName;
  readonly authPath: string;
  readonly oauthConfigured: boolean;
  readonly oauthTokenPresent: boolean;
  readonly oauthRefreshTokenPresent: boolean;
  readonly accessKeyConfigured: boolean;
  readonly accessKeyEnvVar?: string;
  readonly preferredMode?: ConnectorAuthMode;
}

export class ConnectorAuthRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectorAuthRequiredError";
  }
}

export class ConnectorAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectorAuthError";
  }
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const AUTH_FILE_VERSION = 1;
const DEFAULT_AUTH_PATH = join(homedir(), ".pi", "agent", "workspace-connectors-auth.json");
const DEFAULT_BROWSER_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_CONNECTOR_HTTP_TIMEOUT_MS = 30_000;
const SYSTEM_CA_CERTIFICATES = Array.from(new Set([...rootCertificates, ...safeGetSystemCertificates()]));
let authFileQueue: Promise<void> = Promise.resolve();

function safeGetSystemCertificates(): string[] {
  try {
    return getCACertificates("system");
  } catch {
    return [];
  }
}

export function getConnectorAuthPath(): string {
  return process.env.OH_MY_PI_CONNECTOR_AUTH_PATH?.trim() || DEFAULT_AUTH_PATH;
}

function emptyAuthFile(): ConnectorAuthFile {
  return { version: AUTH_FILE_VERSION, services: {} };
}

async function readAuthFile(path = getConnectorAuthPath()): Promise<ConnectorAuthFile> {
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as ConnectorAuthFile;
    if (parsed.version !== AUTH_FILE_VERSION || typeof parsed.services !== "object" || parsed.services === null) {
      throw new ConnectorAuthError(`Invalid connector auth file schema at ${path}.`);
    }
    return parsed;
  } catch (error: unknown) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code === "ENOENT") return emptyAuthFile();
    if (error instanceof ConnectorAuthError) throw error;
    throw new ConnectorAuthError(`Failed to read connector auth file at ${path}: ${formatUnknownError(error)}`);
  }
}

async function writeAuthFile(data: ConnectorAuthFile, path = getConnectorAuthPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tempPath = `${path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  await rename(tempPath, path);
}

async function withAuthFileQueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = authFileQueue.then(fn, fn);
  authFileQueue = run.then(() => undefined, () => undefined);
  return run;
}

async function updateOAuthState(
  service: WorkspaceMcpServiceName,
  updater: (state: StoredOAuthState) => StoredOAuthState | Promise<StoredOAuthState>,
): Promise<StoredOAuthState> {
  return withAuthFileQueue(async () => {
    const data = await readAuthFile();
    const currentService = data.services[service] ?? {};
    const currentOAuth = currentService.oauth ?? {};
    const nextOAuth = await updater({ ...currentOAuth });
    data.services[service] = {
      ...currentService,
      oauth: {
        ...nextOAuth,
        updatedAt: new Date().toISOString(),
      },
    };
    await writeAuthFile(data);
    return data.services[service]?.oauth ?? {};
  });
}

async function getOAuthState(service: WorkspaceMcpServiceName): Promise<StoredOAuthState> {
  const data = await readAuthFile();
  return data.services[service]?.oauth ?? {};
}

function hasToken(state: StoredOAuthState): boolean {
  return typeof state.tokens?.access_token === "string" && state.tokens.access_token.trim() !== "";
}

export async function clearOAuthState(service: WorkspaceMcpServiceName): Promise<void> {
  await withAuthFileQueue(async () => {
    const data = await readAuthFile();
    const current = data.services[service];
    if (!current) return;
    delete current.oauth;
    if (Object.keys(current).length === 0) {
      delete data.services[service];
    } else {
      data.services[service] = current;
    }
    await writeAuthFile(data);
  });
}

export async function getConnectorAuthStatus(service: WorkspaceMcpServiceName): Promise<ConnectorAuthStatus> {
  const state = await getOAuthState(service);
  const accessKey = resolveAccessKey(service);
  const oauthTokenPresent = hasToken(state);
  return {
    service,
    authPath: getConnectorAuthPath(),
    oauthConfigured: existsSync(getConnectorAuthPath()) && (oauthTokenPresent || state.clientInformation !== undefined),
    oauthTokenPresent,
    oauthRefreshTokenPresent: typeof state.tokens?.refresh_token === "string" && state.tokens.refresh_token.trim() !== "",
    accessKeyConfigured: accessKey !== undefined,
    accessKeyEnvVar: accessKey?.envVar,
    preferredMode: oauthTokenPresent ? "oauth" : accessKey ? "access-key" : undefined,
  };
}

export function resolveAccessKey(service: WorkspaceMcpServiceName): { envVar: string; value: string } | undefined {
  const route = routeWorkspaceMcpConnector(service);
  for (const envVar of route.accessKeyEnvVars) {
    const value = process.env[envVar]?.trim();
    if (value) return { envVar, value };
  }
  return undefined;
}

function isClientInfoForRedirect(clientInformation: OAuthClientInformationMixed | undefined, redirectUrl: string): boolean {
  const redirectUris = (clientInformation as { redirect_uris?: string[] } | undefined)?.redirect_uris;
  if (!Array.isArray(redirectUris)) return true;
  return redirectUris.includes(redirectUrl);
}

class StoredOAuthClientProvider implements OAuthClientProvider {
  readonly clientMetadata: OAuthClientMetadata;

  constructor(
    private readonly service: WorkspaceMcpServiceName,
    readonly redirectUrl: string,
    private readonly onAuthorizationUrl: (authorizationUrl: URL) => void | Promise<void>,
  ) {
    const route = routeWorkspaceMcpConnector(service);
    this.clientMetadata = {
      redirect_uris: [redirectUrl],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: `Pi ${route.label} Connector`,
    };
  }

  async state(): Promise<string> {
    const state = randomUUID();
    await updateOAuthState(this.service, (current) => ({ ...current, state }));
    return state;
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const state = await getOAuthState(this.service);
    if (!isClientInfoForRedirect(state.clientInformation, this.redirectUrl)) {
      await updateOAuthState(this.service, (current) => ({ ...current, clientInformation: undefined }));
      return undefined;
    }
    return state.clientInformation;
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    await updateOAuthState(this.service, (current) => ({ ...current, clientInformation }));
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return (await getOAuthState(this.service)).tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await updateOAuthState(this.service, (current) => ({ ...current, tokens }));
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    await this.onAuthorizationUrl(authorizationUrl);
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await updateOAuthState(this.service, (current) => ({ ...current, codeVerifier }));
  }

  async codeVerifier(): Promise<string> {
    const verifier = (await getOAuthState(this.service)).codeVerifier;
    if (!verifier) throw new ConnectorAuthError("Missing OAuth PKCE code verifier; restart /connector-login.");
    return verifier;
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    await updateOAuthState(this.service, (current) => {
      const next = { ...current };
      if (scope === "all" || scope === "client") next.clientInformation = undefined;
      if (scope === "all" || scope === "tokens") next.tokens = undefined;
      if (scope === "all" || scope === "verifier") next.codeVerifier = undefined;
      if (scope === "all" || scope === "discovery") next.discoveryState = undefined;
      return next;
    });
  }

  async saveDiscoveryState(discoveryState: OAuthDiscoveryState): Promise<void> {
    await updateOAuthState(this.service, (current) => ({ ...current, discoveryState }));
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return (await getOAuthState(this.service)).discoveryState;
  }
}

async function listen(server: Server, port: number): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("OAuth callback server did not expose a TCP address."));
        return;
      }
      resolve(address.port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

interface OAuthCallbackResult {
  readonly code?: string;
  readonly state?: string;
  readonly error?: string;
  readonly errorDescription?: string;
}

async function startOAuthCallbackServer(service: WorkspaceMcpServiceName, preferredPort: number, timeoutMs: number): Promise<{
  readonly port: number;
  readonly redirectUrl: string;
  readonly waitForCallback: () => Promise<OAuthCallbackResult>;
  readonly close: () => Promise<void>;
}> {
  const { createServer } = await import("node:http");
  let resolveCallback: (result: OAuthCallbackResult) => void;
  let rejectCallback: (error: Error) => void;
  const callbackPromise = new Promise<OAuthCallbackResult>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });
  let settled = false;
  let timer: NodeJS.Timeout | undefined;

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/oauth/callback") {
        res.statusCode = 404;
        res.end("Not found");
        return;
      }

      const result: OAuthCallbackResult = {
        code: url.searchParams.get("code") ?? undefined,
        state: url.searchParams.get("state") ?? undefined,
        error: url.searchParams.get("error") ?? undefined,
        errorDescription: url.searchParams.get("error_description") ?? undefined,
      };
      const expectedState = (await getOAuthState(service)).state;
      if (expectedState && result.state !== expectedState) {
        res.statusCode = 400;
        res.end("OAuth state mismatch. Return to Pi and retry /connector-login.");
        return;
      }

      settled = true;
      resolveCallback(result);
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(`<!doctype html><meta charset="utf-8"><title>Pi connector authorized</title><body><h1>Authorization received</h1><p>You can close this browser tab and return to Pi.</p><script>window.close();</script></body>`);
    } catch (error: unknown) {
      settled = true;
      rejectCallback(error instanceof Error ? error : new Error(String(error)));
      res.statusCode = 500;
      res.end("Authorization callback failed.");
    }
  });

  let port: number;
  try {
    port = await listen(server, preferredPort);
  } catch (error: unknown) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code === "EADDRINUSE") {
      throw new ConnectorAuthError(`OAuth callback port ${preferredPort} is already in use; close the other process and retry /connector-login ${service}.`);
    }
    throw error;
  }

  return {
    port,
    redirectUrl: `http://127.0.0.1:${port}/oauth/callback`,
    waitForCallback: () => {
      timer ??= setTimeout(() => {
        if (settled) return;
        settled = true;
        rejectCallback(new ConnectorAuthError(`OAuth browser callback timed out after ${Math.round(timeoutMs / 1000)}s.`));
      }, timeoutMs);
      return callbackPromise;
    },
    close: async () => {
      if (timer) clearTimeout(timer);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function openBrowser(authorizationUrl: string): boolean {
  const platform = process.platform;
  const command = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", authorizationUrl] : [authorizationUrl];

  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore", shell: false });
    child.once("error", () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function formatAuthFallback(service: WorkspaceMcpServiceName): string {
  return routeWorkspaceMcpConnector(service).authGuidance;
}

export async function runBrowserOAuthLogin(
  service: WorkspaceMcpServiceName,
  ctx: NotificationContext,
  options: { timeoutMs?: number } = {},
): Promise<void> {
  const route = routeWorkspaceMcpConnector(service);
  const timeoutMs = options.timeoutMs ?? DEFAULT_BROWSER_LOGIN_TIMEOUT_MS;
  const callbackServer = await startOAuthCallbackServer(service, route.oauth.callbackPort, timeoutMs);
  let authorizationUrlText: string | undefined;

  const provider = new StoredOAuthClientProvider(service, callbackServer.redirectUrl, async (authorizationUrl) => {
    authorizationUrlText = authorizationUrl.toString();
    const opened = openBrowser(authorizationUrlText);
    await ctx.ui.notify(
      `${route.label} browser OAuth started${opened ? "" : " (automatic browser open may have failed)"}. If needed, open this URL manually:\n${authorizationUrlText}`,
      "info",
    );
  });

  try {
    const initial = await auth(provider, { serverUrl: route.mcpUrl, fetchFn: fetchWithSystemCa });
    if (initial === "AUTHORIZED") {
      await ctx.ui.notify(`${route.label} OAuth credentials are already valid/refreshed. ${route.statusGuidance}`, "info");
      return;
    }

    const callback = await callbackServer.waitForCallback();
    if (callback.error) {
      throw new ConnectorAuthError(`${route.label} OAuth failed: ${callback.errorDescription ?? callback.error}`);
    }
    if (!callback.code) {
      throw new ConnectorAuthError(`${route.label} OAuth callback did not include an authorization code.`);
    }

    const expectedState = (await getOAuthState(service)).state;
    if (expectedState && callback.state !== expectedState) {
      throw new ConnectorAuthError(`${route.label} OAuth state mismatch; refusing callback.`);
    }

    const final = await auth(provider, {
      serverUrl: route.mcpUrl,
      authorizationCode: callback.code,
      fetchFn: fetchWithSystemCa,
    });
    if (final !== "AUTHORIZED") {
      throw new ConnectorAuthError(`${route.label} OAuth did not complete after callback.`);
    }

    await ctx.ui.notify(`${route.label} OAuth login completed. ${route.statusGuidance}`, "info");
  } catch (error: unknown) {
    const accessKey = resolveAccessKey(service);
    const accessKeyNote = accessKey
      ? ` Access-key fallback is configured via ${accessKey.envVar}; connector tools will try it when OAuth is unavailable.`
      : ` No access key fallback is configured. ${formatAuthFallback(service)}`;
    const urlNote = authorizationUrlText ? ` Last authorization URL: ${authorizationUrlText}` : "";
    const message = error instanceof Error ? error.message : String(error);
    throw new ConnectorAuthError(`${route.label} browser OAuth failed: ${message}.${accessKeyNote}${urlNote}`);
  } finally {
    await callbackServer.close().catch(() => undefined);
  }
}

export async function hasStoredOAuthToken(service: WorkspaceMcpServiceName): Promise<boolean> {
  return hasToken(await getOAuthState(service));
}

export function createOAuthProviderForTransport(service: WorkspaceMcpServiceName): OAuthClientProvider {
  const route = routeWorkspaceMcpConnector(service);
  return new StoredOAuthClientProvider(service, `http://127.0.0.1:${route.oauth.callbackPort}/oauth/callback`, async () => undefined);
}

export function formatAuthRequiredMessage(service: WorkspaceMcpServiceName): string {
  const route = routeWorkspaceMcpConnector(service);
  return `${route.label} connector is not authenticated. ${formatAuthFallback(service)}`;
}

function requestBodyToNodeBody(body: BodyInit | null | undefined): string | Buffer | Uint8Array | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string" || Buffer.isBuffer(body) || body instanceof Uint8Array) return body;
  if (body instanceof URLSearchParams) return body.toString();
  throw new Error(`Unsupported fetch body type for connector HTTP request: ${Object.prototype.toString.call(body)}`);
}

function parseFetchUrl(input: string | URL | Request): URL {
  try {
    return new URL(input instanceof Request ? input.url : input.toString());
  } catch (error: unknown) {
    throw new Error(`Invalid connector HTTP URL: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export const fetchWithSystemCa: FetchLike = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const inputRequest = input instanceof Request ? input : undefined;
  const url = parseFetchUrl(input);
  const headers = {
    ...normalizeHeaders(inputRequest?.headers),
    ...normalizeHeaders(init?.headers),
  };
  const method = init?.method ?? inputRequest?.method ?? "GET";
  const body = requestBodyToNodeBody(init?.body ?? undefined);
  const requester = url.protocol === "http:" ? httpRequest : httpsRequest;

  return new Promise<Response>((resolve, reject) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_CONNECTOR_HTTP_TIMEOUT_MS);
    const externalAbort = () => controller.abort();
    init?.signal?.addEventListener("abort", externalAbort, { once: true });
    if (init?.signal?.aborted) controller.abort();

    const cleanup = () => {
      clearTimeout(timeout);
      init?.signal?.removeEventListener("abort", externalAbort);
    };

    const req = requester(url, {
      method,
      headers,
      ca: url.protocol === "https:" ? SYSTEM_CA_CERTIFICATES : undefined,
    }, (res) => {
      cleanup();
      const responseHeaders = new Headers();
      for (const [key, value] of Object.entries(res.headers)) {
        if (Array.isArray(value)) {
          for (const item of value) responseHeaders.append(key, item);
        } else if (value !== undefined) {
          responseHeaders.set(key, String(value));
        }
      }

      resolve(new Response(Readable.toWeb(res) as ReadableStream, {
        status: res.statusCode ?? 0,
        statusText: res.statusMessage,
        headers: responseHeaders,
      }));
    });

    const abort = () => {
      req.destroy(new Error(`Connector HTTP request timed out or was aborted after ${DEFAULT_CONNECTOR_HTTP_TIMEOUT_MS}ms.`));
    };
    controller.signal.addEventListener("abort", abort, { once: true });
    req.on("error", (error) => {
      cleanup();
      reject(error);
    });
    req.on("close", () => {
      cleanup();
      controller.signal.removeEventListener("abort", abort);
    });

    if (body !== undefined) req.write(body);
    req.end();
  });
};

export async function removeAuthFileIfEmpty(): Promise<void> {
  const path = getConnectorAuthPath();
  const data = await readAuthFile(path);
  if (Object.keys(data.services).length === 0) {
    await rm(path, { force: true });
  }
}
