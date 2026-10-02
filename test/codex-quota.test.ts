import { describe, expect, it } from "vitest";
import { parseCodexRateLimits, readLatestCodexRateLimits } from "../src/core/codex-quota.js";

// Shape captured from a real ~/.codex rollout token_count event.
const line = (primary: number, secondary: number, pReset = 1790959966, sReset = 1791315002) => JSON.stringify({
  type: "event_msg", payload: { type: "token_count", rate_limits: { limit_id: "codex", primary: { used_percent: primary, window_minutes: 300, resets_at: pReset }, secondary: { used_percent: secondary, window_minutes: 10080, resets_at: sReset } } },
});
const NOW = 1790950000_000; // before both resets

describe("parseCodexRateLimits", () => {
  it("uses the tightest window (weekly 98% used => 2% remaining), exact source, ISO reset", () => {
    const s = parseCodexRateLimits(["noise", line(81, 98)].join("\n"), NOW);
    expect(s).toEqual({ kind: "quota", source: "provider_exact", remainingPercent: 2, unit: "weekly", resetAt: new Date(1791315002_000).toISOString() });
  });
  it("takes the LAST rate_limits event in the log", () => {
    const s = parseCodexRateLimits([line(10, 10), line(40, 20)].join("\n"), NOW);
    expect(s).toMatchObject({ remainingPercent: 60, unit: "5h" });
  });
  it("a window whose reset time has passed is stale and ignored (it has refreshed since the last turn)", () => {
    const s = parseCodexRateLimits(line(99, 30), 1790960000_000); // after primary reset, before weekly
    expect(s).toMatchObject({ remainingPercent: 70, unit: "weekly" });
  });
  it("all windows reset since the last observation => UNKNOWN, not 100%", () => {
    expect(parseCodexRateLimits(line(99, 99), 1800000000_000).kind).toBe("none");
  });
  it("no rate_limits / garbage => UNKNOWN", () => {
    expect(parseCodexRateLimits("", NOW).kind).toBe("none");
    expect(parseCodexRateLimits("{not json\n{\"a\":1}", NOW).kind).toBe("none");
  });
  it("100% used => zero remaining (maps to cooldown via deriveHealth)", () => {
    expect(parseCodexRateLimits(line(100, 5), NOW)).toMatchObject({ remainingPercent: 0, unit: "5h" });
  });
});

describe("readLatestCodexRateLimits", () => {
  it("reads the tail of the newest rollout file; no sessions dir => UNKNOWN", async () => {
    const files: Record<string, { mtime: number; text: string }> = {
      "/s/2026/10/01/rollout-a.jsonl": { mtime: 1, text: line(1, 1) },
      "/s/2026/10/02/rollout-b.jsonl": { mtime: 2, text: line(50, 10) },
    };
    const fsx = { listRollouts: () => Object.keys(files), mtimeMs: (p: string) => files[p]!.mtime, readTail: (p: string) => files[p]!.text };
    expect(await readLatestCodexRateLimits({ ...fsx, now: () => NOW })).toMatchObject({ remainingPercent: 50, unit: "5h" });
    expect((await readLatestCodexRateLimits({ listRollouts: () => [], mtimeMs: () => 0, readTail: () => "", now: () => NOW })).kind).toBe("none");
  });
  it("falls back to older rollouts when the newest has no rate_limits yet", async () => {
    const files: Record<string, { mtime: number; text: string }> = { "/n": { mtime: 9, text: '{"type":"session_meta"}' }, "/o": { mtime: 5, text: line(30, 30) } };
    const r = await readLatestCodexRateLimits({ listRollouts: () => Object.keys(files), mtimeMs: (p) => files[p]!.mtime, readTail: (p) => files[p]!.text, now: () => NOW });
    expect(r).toMatchObject({ kind: "quota", remainingPercent: 70 });
  });
});
