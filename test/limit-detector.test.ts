import { describe, expect, it } from "vitest";
import { detectLimitMessage } from "../src/core/limit-detector.js";

const NOW = new Date("2026-10-02T10:00:00-04:00");

describe("detectLimitMessage", () => {
  it("Claude Code limit banners", () => {
    expect(detectLimitMessage("anthropic", "some output\n5-hour limit reached ∙ resets 3pm", NOW)).toMatchObject({ hit: true });
    expect(detectLimitMessage("anthropic", "Claude usage limit reached. Your limit will reset at 3pm.", NOW)).toMatchObject({ hit: true });
  });
  it("Codex limit banner with an absolute retry time", () => {
    const r = detectLimitMessage("openai", "■ You've hit your usage limit. Try again at Oct 6th, 2026 7:30 PM.", NOW);
    expect(r).toMatchObject({ hit: true });
  });
  it("relative reset: 'try again in 2 hours 5 minutes' => resetAt now+2h05m", () => {
    const r = detectLimitMessage("openai", "You've hit your usage limit. Try again in 2 hours 5 minutes.", NOW);
    expect(r?.resetAt).toBe(new Date(NOW.getTime() + (2 * 60 + 5) * 60_000).toISOString());
  });
  it("'resets 3pm' => next 3pm local after now; unparseable reset => hit with no resetAt (never invented)", () => {
    const r = detectLimitMessage("anthropic", "limit reached ∙ resets 3pm", NOW);
    expect(r?.hit).toBe(true);
    expect(Date.parse(r!.resetAt!)).toBeGreaterThan(NOW.getTime());
    expect(Date.parse(r!.resetAt!) - NOW.getTime()).toBeLessThanOrEqual(24 * 3600_000);
    expect(detectLimitMessage("anthropic", "usage limit reached, resets whenever", NOW)).toEqual({ hit: true });
  });
  it("only the last lines of the screen count (quoted text far above is ignored)", () => {
    const screen = ["5-hour limit reached ∙ resets 3pm", ...Array(30).fill("normal output")].join("\n");
    expect(detectLimitMessage("anthropic", screen, NOW)).toBeNull();
  });
  it("ordinary text mentioning limits does not match", () => {
    expect(detectLimitMessage("anthropic", "I will add a rate limiter to the API", NOW)).toBeNull();
    expect(detectLimitMessage("openai", "the limit of the function as x approaches 0", NOW)).toBeNull();
    expect(detectLimitMessage("google", "all good", NOW)).toBeNull();
  });
  it("Antigravity: quota-exhausted wording", () => {
    expect(detectLimitMessage("google", "You have exhausted your quota for Gemini models", NOW)).toMatchObject({ hit: true });
  });
});
