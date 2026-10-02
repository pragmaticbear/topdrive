// topdrive §17: Antigravity quota adapter. Parses `agy -p "/usage" --output-format json`
// (structured; no TUI scraping) into a HealthSignal. Parser failure => "none" (UNKNOWN), never a made-up number.

import type { HealthSignal } from "./provider-health.js";

interface Bucket { id?: string; window?: string; remaining_fraction?: number; reset_time?: string }
interface Group { name?: string; buckets?: Bucket[] }

export const AGY_USAGE_ARGS = ["-p", "/usage", "--output-format", "json"] as const;
/** Family groups agy reports; Gemini models are the "google" provider quota. */
export type AgyQuotaFamily = "gemini" | "third_party";
const FAMILY_MATCH: Record<AgyQuotaFamily, (g: Group) => boolean> = {
  gemini: (g) => /gemini/i.test(g.name ?? ""),
  third_party: (g) => /claude|gpt/i.test(g.name ?? ""),
};

export function parseAgyUsage(raw: string, family: AgyQuotaFamily = "gemini"): HealthSignal {
  let groups: Group[];
  try {
    const parsed = JSON.parse(raw);
    groups = parsed?.command?.data?.groups;
    if (!Array.isArray(groups)) return { kind: "none", reason: "agy /usage: no groups in response" };
  } catch {
    return { kind: "none", reason: "agy /usage: unparseable response" };
  }
  const buckets = groups.filter(FAMILY_MATCH[family]).flatMap((g) => g.buckets ?? [])
    .filter((b): b is Bucket & { remaining_fraction: number } => typeof b.remaining_fraction === "number");
  if (buckets.length === 0) return { kind: "none", reason: `agy /usage: no ${family} buckets` };
  // The tightest window governs (a drained 5h window blocks work even if the weekly one is full).
  const tight = buckets.reduce((a, b) => (b.remaining_fraction < a.remaining_fraction ? b : a));
  return {
    kind: "quota", source: "provider_exact", unit: tight.window,
    remainingPercent: Math.round(tight.remaining_fraction * 1000) / 10,
    ...(tight.reset_time ? { resetAt: tight.reset_time } : {}),
  };
}

/** `agy /credits` => paid credit balance, or null if unreadable. */
export function parseAgyCredits(raw: string): number | null {
  try {
    const n = JSON.parse(raw)?.command?.data?.remaining_credits;
    return typeof n === "number" ? n : null;
  } catch { return null; }
}
