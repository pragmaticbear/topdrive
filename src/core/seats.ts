// Seat -> subscription provider and role-preference tokens.
import type { ProviderFamily } from "./provider-health.js";

const RUNTIME_PROVIDER: Record<string, ProviderFamily> = { "claude-code": "anthropic", codex: "openai", antigravity: "google" };
export const runtimeProvider = (runtime: string | null | undefined): ProviderFamily | null => (runtime && RUNTIME_PROVIDER[runtime]) || null;

const ALIAS: Record<string, string> = { "claude-code": "claude", codex: "codex", antigravity: "antigravity" };
/** Preference tokens a seat satisfies: its runtime alias, `alias:<model word>` per word of its model, or `alias:*` when the model is unknown. */
export function seatPrefKeys(runtime: string, model: string | null | undefined): string[] {
  const alias = ALIAS[runtime] ?? runtime;
  const words = (model ?? "").toLowerCase().split(/[^a-z0-9.]+/).filter(Boolean);
  return [alias, ...(words.length ? words.map((w) => `${alias}:${w}`) : [`${alias}:*`])];
}
