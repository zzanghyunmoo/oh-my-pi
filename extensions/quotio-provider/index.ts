import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REQUIRED_ENV_VARS = ["QUOTIO_BASE_URL", "QUOTIO_API_KEY"] as const;

function loadEnvFile(): void {
  // Look for .env in the package root (two levels up from extensions/quotio-provider/)
  const envPath = resolve(__dirname, "../../.env");
  try {
    const content = readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIndex = trimmed.indexOf("=");
      if (eqIndex === -1) continue;
      const key = trimmed.slice(0, eqIndex).trim();
      const value = trimmed.slice(eqIndex + 1).trim();
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

export default function (pi: ExtensionAPI) {
  // --- Session Start: Validate env vars and register provider ---
  pi.on("session_start", async (_event, ctx) => {
    const missing = getMissingEnvVars();

    if (missing.length > 0) {
      ctx.ui.notify(
        `Quotio provider disabled — missing environment variables: ${missing.join(", ")}. Set them and reload.`,
        "error",
      );
      return;
    }

    pi.registerProvider("quotio", {
      name: "Quotio (Anthropic)",
      baseUrl: "$QUOTIO_BASE_URL",
      apiKey: "$QUOTIO_API_KEY",
      api: "anthropic-messages",
      models: [
        {
          id: "claude-sonnet-4-20250514",
          name: "Claude Sonnet 4 (Quotio)",
          reasoning: true,
          input: ["text", "image"],
          cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
          contextWindow: 200000,
          maxTokens: 8192,
        },
        {
          id: "claude-opus-4-20250514",
          name: "Claude Opus 4 (Quotio)",
          reasoning: true,
          input: ["text", "image"],
          cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
          contextWindow: 200000,
          maxTokens: 32000,
        },
      ],
    });

    ctx.ui.notify(
      "Quotio provider loaded. Models available via quotio proxy.",
      "info",
    );
  });

  // --- /quotio-status: Health check command ---
  pi.registerCommand("quotio-status", {
    description: "Check quotio proxy connectivity and authentication status",
    handler: async (_args, ctx) => {
      const missing = getMissingEnvVars();
      if (missing.length > 0) {
        ctx.ui.notify(
          `Cannot check status — missing environment variables: ${missing.join(", ")}`,
          "error",
        );
        return;
      }

      const baseUrl = process.env.QUOTIO_BASE_URL!.trim();
      const apiKey = process.env.QUOTIO_API_KEY!.trim();

      const startTime = Date.now();

      const probeUrl = baseUrl.replace(/\/+$/, "") + "/models";

      try {
        const response = await fetch(probeUrl, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          signal: AbortSignal.timeout(10000),
        });

        const elapsed = Date.now() - startTime;

        if (response.status === 401 || response.status === 403) {
          ctx.ui.notify(
            `Quotio: Authentication failed (HTTP ${response.status}). Check QUOTIO_API_KEY.`,
            "error",
          );
        } else if (response.ok) {
          ctx.ui.notify(
            `Quotio: Connected successfully (HTTP ${response.status}, ${elapsed}ms)`,
            "info",
          );
        } else {
          ctx.ui.notify(
            `Quotio: Server responded with HTTP ${response.status} (${elapsed}ms). Proxy may be misconfigured.`,
            "error",
          );
        }
      } catch (error: any) {
        const elapsed = Date.now() - startTime;

        if (error?.name === "TimeoutError" || error?.name === "AbortError") {
          ctx.ui.notify(
            `Quotio: Connection timed out after ${elapsed}ms. Check QUOTIO_BASE_URL and network.`,
            "error",
          );
        } else {
          ctx.ui.notify(
            `Quotio: Connection failed — ${error?.message ?? String(error)}. Check QUOTIO_BASE_URL.`,
            "error",
          );
        }
      }
    },
  });
}
