import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REQUIRED_ENV_VARS = ["QUOTIO_BASE_URL", "QUOTIO_API_KEY"] as const;

function loadEnvFile(): void {
  const envPath = resolve(__dirname, "../../.env");
  try {
    const content = readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIndex = trimmed.indexOf("=");
      if (eqIndex === -1) continue;
      const key = trimmed.slice(0, eqIndex).trim();
      let value = trimmed.slice(eqIndex + 1).trim();
      // Strip surrounding quotes (single or double)
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch {
    // .env file not found — rely on existing environment variables
  }
}

loadEnvFile();

function getMissingEnvVars(): string[] {
  return REQUIRED_ENV_VARS.filter(
    (key) => !process.env[key] || process.env[key]!.trim() === "",
  );
}

interface QuotioModel {
  id: string;
  object: string;
  created: number;
  owned_by: string;
}

async function fetchModels(baseUrl: string, apiKey: string): Promise<QuotioModel[]> {
  const url = baseUrl.replace(/\/+$/, "") + "/models";
  const response = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const data = await response.json() as { data: QuotioModel[] };
  return data.data ?? [];
}

function toProviderModels(models: QuotioModel[]) {
  return models.map((m) => {
    const isVisionCapable = m.id.includes("claude") || m.id.includes("gpt-4o");
    const isLargeContext = m.id.includes("claude");
    return {
      id: m.id,
      name: m.id.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" "),
      reasoning: m.id.includes("agentic") || m.id.includes("opus"),
      input: isVisionCapable ? ["text", "image"] : ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: isLargeContext ? 200000 : 128000,
      maxTokens: isLargeContext ? 64000 : 16384,
    };
  });
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const missing = getMissingEnvVars();

    if (missing.length > 0) {
      ctx.ui.notify(
        `Quotio provider disabled — missing: ${missing.join(", ")}. Set them in .env and reload.`,
        "error",
      );
      return;
    }

    const baseUrl = process.env.QUOTIO_BASE_URL!.trim();
    const apiKey = process.env.QUOTIO_API_KEY!.trim();

    try {
      const models = await fetchModels(baseUrl, apiKey);
      const providerModels = toProviderModels(models);

      pi.registerProvider("quotio", {
        name: "Quotio",
        baseUrl: baseUrl,
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
    handler: async (_args, ctx) => {
      const missing = getMissingEnvVars();
      if (missing.length > 0) {
        ctx.ui.notify(
          `Cannot check status — missing: ${missing.join(", ")}`,
          "error",
        );
        return;
      }

      const baseUrl = process.env.QUOTIO_BASE_URL!.trim();
      const apiKey = process.env.QUOTIO_API_KEY!.trim();
      const startTime = Date.now();

      try {
        const models = await fetchModels(baseUrl, apiKey);
        const elapsed = Date.now() - startTime;

        const modelList = models.map((m) => `  - ${m.id}`).join("\n");
        ctx.ui.notify(
          `Quotio: Connected (${elapsed}ms), ${models.length} models:\n${modelList}`,
          "info",
        );
      } catch (error: any) {
        const elapsed = Date.now() - startTime;

        if (error?.name === "TimeoutError" || error?.name === "AbortError") {
          ctx.ui.notify(
            `Quotio: Timed out after ${elapsed}ms. Check QUOTIO_BASE_URL.`,
            "error",
          );
        } else if (error?.message?.includes("401") || error?.message?.includes("403")) {
          ctx.ui.notify(
            `Quotio: Auth failed. Check QUOTIO_API_KEY.`,
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
