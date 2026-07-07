import { claudeAdapter } from "./claude.js";
import { codexAdapter } from "./codex.js";
import type { ProviderAdapter, ProviderId } from "../types.js";

export const PROVIDERS: Record<ProviderId, ProviderAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
};

export function parseProviders(value: string | undefined): ProviderId[] {
  if (!value) return ["claude", "codex"];
  const providers = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const invalid = providers.find(
    (provider) => provider !== "claude" && provider !== "codex",
  );
  if (invalid) {
    throw new Error(`unsupported provider: ${invalid}`);
  }
  return providers as ProviderId[];
}
