/// <reference lib="es2015.promise" />

export type ProviderInputModality = "text" | "image";

export interface OpenAICompatibleModel {
  readonly id: string;
  readonly object?: string;
  readonly created?: number;
  readonly owned_by?: string;
}

export interface ProviderModelCost {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

export interface ProviderModelCapabilities {
  readonly reasoning: boolean;
  readonly input: ProviderInputModality[];
  readonly cost: ProviderModelCost;
  readonly contextWindow: number;
  readonly maxTokens: number;
}

export interface ProviderModelDefinition extends ProviderModelCapabilities {
  readonly id: string;
  readonly name: string;
}

export type ProviderModelCapabilityOverride = Partial<ProviderModelCapabilities> & {
  readonly name?: string;
};

export interface ProviderModelCapabilityRule {
  readonly test: RegExp | ((model: OpenAICompatibleModel) => boolean);
  readonly capabilities: ProviderModelCapabilityOverride;
}

export interface ProviderCapabilityContract {
  readonly defaults?: Partial<ProviderModelCapabilities>;
  readonly rules?: readonly ProviderModelCapabilityRule[];
  readonly modelOverrides?: Readonly<Record<string, ProviderModelCapabilityOverride>>;
}

export interface DiscoverModelsOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly timeoutMs?: number;
  readonly modelsPath?: string;
  readonly fetchImpl?: typeof fetch;
}

export interface ModelDiscoveryResult {
  readonly baseUrl: string;
  readonly models: readonly OpenAICompatibleModel[];
  readonly elapsedMs: number;
}

export type ProviderAdapterErrorKind =
  | "timeout"
  | "auth"
  | "http"
  | "network"
  | "invalid-response";

export class ProviderAdapterError extends Error {
  readonly kind: ProviderAdapterErrorKind;
  readonly status?: number;
  readonly elapsedMs: number;
  readonly cause?: unknown;

  constructor(
    kind: ProviderAdapterErrorKind,
    message: string,
    elapsedMs: number,
    options: { readonly status?: number; readonly cause?: unknown } = {},
  ) {
    super(message);
    this.name = "ProviderAdapterError";
    this.kind = kind;
    this.status = options.status;
    this.elapsedMs = elapsedMs;
    this.cause = options.cause;
  }
}

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_MODELS_PATH = "/models";
const DEFAULT_COST: ProviderModelCost = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};
const DEFAULT_CAPABILITIES: ProviderModelCapabilities = {
  reasoning: false,
  input: ["text"],
  cost: DEFAULT_COST,
  contextWindow: 128000,
  maxTokens: 16384,
};

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

export function formatProviderModelName(modelId: string): string {
  return modelId
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function normalizePath(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

export async function discoverOpenAICompatibleModels(
  options: DiscoverModelsOptions,
): Promise<ModelDiscoveryResult> {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const modelsPath = normalizePath(options.modelsPath ?? DEFAULT_MODELS_PATH);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startTime = Date.now();

  try {
    const response = await (options.fetchImpl ?? fetch)(`${baseUrl}${modelsPath}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${options.apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const elapsedMs = Date.now() - startTime;

    if (!response.ok) {
      const kind = response.status === 401 || response.status === 403 ? "auth" : "http";
      throw new ProviderAdapterError(kind, `HTTP ${response.status}`, elapsedMs, {
        status: response.status,
      });
    }

    const data = (await response.json()) as { readonly data?: unknown };
    if (!Array.isArray(data.data)) {
      throw new ProviderAdapterError(
        "invalid-response",
        "models response did not include a data array",
        elapsedMs,
      );
    }

    return {
      baseUrl,
      models: data.data.filter(isOpenAICompatibleModel),
      elapsedMs,
    };
  } catch (error) {
    if (error instanceof ProviderAdapterError) throw error;

    const elapsedMs = Date.now() - startTime;
    if (isTimeoutError(error)) {
      throw new ProviderAdapterError(
        "timeout",
        `timed out after ${elapsedMs}ms`,
        elapsedMs,
        { cause: error },
      );
    }

    throw new ProviderAdapterError(
      "network",
      error instanceof Error ? error.message : String(error),
      elapsedMs,
      { cause: error },
    );
  }
}

export function toProviderModels(
  models: readonly OpenAICompatibleModel[],
  contract: ProviderCapabilityContract = {},
): ProviderModelDefinition[] {
  return models.map((model) => toProviderModel(model, contract));
}

export function toProviderModel(
  model: OpenAICompatibleModel,
  contract: ProviderCapabilityContract = {},
): ProviderModelDefinition {
  const matchingRuleOverrides = (contract.rules ?? [])
    .filter((rule) => matchesRule(rule, model))
    .map((rule) => rule.capabilities);
  const exactOverride = contract.modelOverrides?.[model.id] ?? {};
  const merged = mergeCapabilities(
    DEFAULT_CAPABILITIES,
    contract.defaults ?? {},
    ...matchingRuleOverrides,
    exactOverride,
  );

  return {
    id: model.id,
    name: resolveModelName(model.id, ...matchingRuleOverrides, exactOverride),
    reasoning: merged.reasoning,
    input: [...merged.input],
    cost: merged.cost,
    contextWindow: merged.contextWindow,
    maxTokens: merged.maxTokens,
  };
}

function resolveModelName(
  modelId: string,
  ...overrides: readonly ProviderModelCapabilityOverride[]
): string {
  for (let index = overrides.length - 1; index >= 0; index -= 1) {
    const name = overrides[index]?.name;
    if (name !== undefined) return name;
  }
  return formatProviderModelName(modelId);
}

function mergeCapabilities(
  defaults: ProviderModelCapabilities,
  ...overrides: readonly ProviderModelCapabilityOverride[]
): ProviderModelCapabilities {
  return overrides.reduce<ProviderModelCapabilities>(
    (current, override) => ({
      reasoning: override.reasoning ?? current.reasoning,
      input: override.input ?? current.input,
      cost: override.cost ?? current.cost,
      contextWindow: override.contextWindow ?? current.contextWindow,
      maxTokens: override.maxTokens ?? current.maxTokens,
    }),
    defaults,
  );
}

function matchesRule(rule: ProviderModelCapabilityRule, model: OpenAICompatibleModel): boolean {
  if (rule.test instanceof RegExp) {
    rule.test.lastIndex = 0;
    return rule.test.test(model.id);
  }
  return rule.test(model);
}

function isOpenAICompatibleModel(value: unknown): value is OpenAICompatibleModel {
  return typeof value === "object"
    && value !== null
    && "id" in value
    && typeof value.id === "string";
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error
    && (error.name === "TimeoutError" || error.name === "AbortError");
}
