import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  discoverOpenAICompatibleModels,
  ProviderAdapterError,
  toProviderModels,
  type ProviderCapabilityContract,
} from "../provider-adapter-kit/openai-compatible.js";

const REQUIRED_ENV_VARS = ["QUOTIO_BASE_URL", "QUOTIO_API_KEY"] as const;
const QUOTIO_TIMEOUT_MS = 10000;
const QUOTIO_CAPABILITY_CONTRACT: ProviderCapabilityContract = {
  rules: [
    {
      test: /claude|gpt-4o/,
      capabilities: { input: ["text", "image"] },
    },
    {
      test: /claude/,
      capabilities: { contextWindow: 200000, maxTokens: 64000 },
    },
    {
      test: /agentic|opus/,
      capabilities: { reasoning: true },
    },
  ],
};

type NotifyLevel = "info" | "error";

interface NotificationContext {
  readonly ui: {
    notify(message: string, level: NotifyLevel): void | Promise<void>;
  };
}

function getMissingEnvVars(): string[] {
  return REQUIRED_ENV_VARS.filter(
    (key) => !process.env[key] || process.env[key]!.trim() === "",
  );
}

function getQuotioConfig(): { readonly baseUrl: string; readonly apiKey: string } {
  return {
    baseUrl: process.env.QUOTIO_BASE_URL!.trim(),
    apiKey: process.env.QUOTIO_API_KEY!.trim(),
  };
}

async function discoverQuotioModels(baseUrl: string, apiKey: string) {
  return discoverOpenAICompatibleModels({
    baseUrl,
    apiKey,
    timeoutMs: QUOTIO_TIMEOUT_MS,
  });
}

export default function (pi: ExtensionAPI) {
  if (process.env.ENABLE_QUOTIO !== "true") return;
  pi.on("session_start", async (_event: unknown, ctx: NotificationContext) => {
    const missing = getMissingEnvVars();

    if (missing.length > 0) {
      ctx.ui.notify(
        `Quotio provider disabled — missing: ${missing.join(", ")}. Set them in .env and reload.`,
        "error",
      );
      return;
    }

    const { baseUrl, apiKey } = getQuotioConfig();

    try {
      const discovery = await discoverQuotioModels(baseUrl, apiKey);
      const providerModels = toProviderModels(
        discovery.models,
        QUOTIO_CAPABILITY_CONTRACT,
      );

      pi.registerProvider("quotio", {
        name: "Quotio",
        baseUrl: discovery.baseUrl,
        apiKey: apiKey,
        api: "openai-completions",
        models: providerModels,
      });

      ctx.ui.notify(
        `Quotio provider loaded — ${providerModels.length} models available.`,
        "info",
      );
    } catch (error: any) {
      ctx.ui.notify(
        `Quotio provider failed to load: ${error?.message ?? String(error)}`,
        "error",
      );
    }
  });

  pi.registerCommand("quotio-status", {
    description: "Check quotio proxy connectivity and list available models",
    handler: async (_args: string, ctx: NotificationContext) => {
      const missing = getMissingEnvVars();
      if (missing.length > 0) {
        ctx.ui.notify(
          `Cannot check status — missing: ${missing.join(", ")}`,
          "error",
        );
        return;
      }

      const { baseUrl, apiKey } = getQuotioConfig();

      try {
        const discovery = await discoverQuotioModels(baseUrl, apiKey);

        const modelList = discovery.models.map((m) => `  - ${m.id}`).join("\n");
        ctx.ui.notify(
          `Quotio: Connected (${discovery.elapsedMs}ms), ${discovery.models.length} models:\n${modelList}`,
          "info",
        );
      } catch (error: any) {
        if (error instanceof ProviderAdapterError && error.kind === "timeout") {
          ctx.ui.notify(
            `Quotio: Timed out after ${error.elapsedMs}ms. Check QUOTIO_BASE_URL.`,
            "error",
          );
        } else if (error instanceof ProviderAdapterError && error.kind === "auth") {
          ctx.ui.notify(
            "Quotio: Auth failed. Check QUOTIO_API_KEY.",
            "error",
          );
        } else {
          ctx.ui.notify(
            `Quotio: Connection failed — ${error?.message ?? String(error)}`,
            "error",
          );
        }
      }
    },
  });
}
