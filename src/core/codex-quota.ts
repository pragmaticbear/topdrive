// topdrive §19: Codex quota reader. Codex records provider-reported rate limits in its session logs
// (token_count events: primary = 5h, secondary = weekly; used_percent + resets_at epoch seconds).
// That is structured provider state, but only as fresh as the last turn: a window whose reset time has
// passed has refreshed since, so it is ignored; if nothing is left the answer is UNKNOWN, never 100%.

import type { HealthSignal } from "./provider-health.js";

interface Window { used_percent?: number; window_minutes?: number; resets_at?: number }

const unitOf = (mins: number | undefined): string =>
  mins === 300 ? "5h" : mins === 10080 ? "weekly" : mins ? `${mins}m` : "window";

export function parseCodexRateLimits(text: string, nowMs: number): HealthSignal {
  let last: { primary?: Window; secondary?: Window } | null = null;
  for (const raw of text.split("\n")) {
    if (!raw.includes("rate_limits")) continue;
    try {
      const rl = JSON.parse(raw)?.payload?.rate_limits;
      if (rl && (rl.primary || rl.secondary)) last = rl;
    } catch { /* partial line at the tail boundary */ }
  }
  if (!last) return { kind: "none", reason: "codex: no rate_limits in session log" };
  const live = [last.primary, last.secondary].filter((w): w is Window =>
    !!w && typeof w.used_percent === "number" && (w.resets_at === undefined || w.resets_at * 1000 > nowMs));
  if (live.length === 0) return { kind: "none", reason: "codex: last observed windows have since reset; awaiting a fresh turn" };
  const tight = live.reduce((a, b) => (b.used_percent! > a.used_percent! ? b : a));
  return {
    kind: "quota", source: "provider_exact", unit: unitOf(tight.window_minutes),
    remainingPercent: Math.max(0, Math.min(100, Math.round((100 - tight.used_percent!) * 10) / 10)),
    ...(tight.resets_at ? { resetAt: new Date(tight.resets_at * 1000).toISOString() } : {}),
  };
}

export interface CodexLogFs {
  listRollouts: () => string[];
  mtimeMs: (path: string) => number;
  /** Last chunk of the file (bounded read; rollouts can be large). */
  readTail: (path: string) => string;
  now: () => number;
}

const MAX_FILES = 5;

export async function readLatestCodexRateLimits(fsx: CodexLogFs): Promise<HealthSignal> {
  const newest = fsx.listRollouts().map((p) => ({ p, m: fsx.mtimeMs(p) })).sort((a, b) => b.m - a.m).slice(0, MAX_FILES);
  if (newest.length === 0) return { kind: "none", reason: "codex: no session logs found" };
  let reason = "codex: no rate_limits in recent session logs";
  for (const { p } of newest) {
    const s = parseCodexRateLimits(fsx.readTail(p), fsx.now());
    if (s.kind === "quota") return s;
    if (s.kind === "none" && s.reason && !s.reason.includes("no rate_limits")) reason = s.reason;
  }
  return { kind: "none", reason };
}
