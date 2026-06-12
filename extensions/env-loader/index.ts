import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const KNOWN_TOGGLES: Record<string, string> = {
  ENABLE_QUOTIO: "quotio-provider",
  ENABLE_WORKSPACE_CONNECTORS: "workspace-connectors",
};

function loadCwdEnv(): string | null {
  const envPath = resolve(process.cwd(), ".env");
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
      // Override existing process.env values
      process.env[key] = value;
    }
    return envPath;
  } catch {
    // .env file not found — rely on existing environment variables
    return null;
  }
}

export default function (pi: ExtensionAPI) {
  const loadedPath = loadCwdEnv();

  pi.on("session_start", async (_event, ctx) => {
    if (loadedPath) {
      ctx.ui.notify(`oh-my-pi: .env 로드됨 — ${loadedPath}`, "info");
    }

    const disabled: string[] = [];
    for (const [envVar, extName] of Object.entries(KNOWN_TOGGLES)) {
      if (process.env[envVar] !== "true") {
        disabled.push(extName);
      }
    }

    if (disabled.length > 0) {
      ctx.ui.notify(
        `oh-my-pi: 비활성화된 익스텐션: ${disabled.join(", ")}. .env에 ENABLE_*=true를 추가하세요.`,
        "info",
      );
    }
  });
}
