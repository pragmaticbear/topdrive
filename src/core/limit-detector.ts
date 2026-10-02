// topdrive §35: reactive hard-limit detection from a seat's visible screen. Provider-specific patterns, last
// lines only (quoted text in scrollback must not trigger a failover). Reset times are parsed best-effort and
// are NEVER invented: an unparseable reset leaves resetAt undefined (provider becomes `exhausted`, recovered by polling).
// Wording is the providers' current banners and may drift; polling remains the backstop.

import type { ProviderFamily } from "./provider-health.js";

export interface LimitHit { hit: true; resetAt?: string }

const TAIL_LINES = 12;
const PATTERNS: Record<ProviderFamily, RegExp[]> = {
  anthropic: [/\b(?:5-hour|weekly|usage|session)\s+limit\s+(?:reached|hit|exceeded)/i, /usage limit reached/i, /\blimit reached\b.*\bresets?\b/i],
  openai: [/you['’]ve hit your (?:usage )?limit/i, /usage limit/i],
  google: [/exhausted your quota/i, /quota (?:exceeded|exhausted)/i],
};
// openai's broad "usage limit" must co-occur with an action phrase to count
const OPENAI_CONFIRM = /(hit|reached|exceeded|try again)/i;

function parseReset(line: string, now: Date): string | undefined {
  const rel = /(?:try again )?in\s+(?:(\d+)\s*days?)?\s*(?:(\d+)\s*hours?)?\s*(?:(\d+)\s*minutes?)?/i.exec(line);
  if (rel && (rel[1] || rel[2] || rel[3])) {
    const ms = ((Number(rel[1] ?? 0) * 24 + Number(rel[2] ?? 0)) * 60 + Number(rel[3] ?? 0)) * 60_000;
    return new Date(now.getTime() + ms).toISOString();
  }
  const abs = /try again at\s+([A-Za-z]{3,9} \d{1,2}(?:st|nd|rd|th)?,? \d{4} \d{1,2}:\d{2} ?[AP]M)/i.exec(line);
  if (abs) {
    const t = Date.parse(abs[1]!.replace(/(\d)(st|nd|rd|th)/, "$1"));
    if (!Number.isNaN(t) && t > now.getTime()) return new Date(t).toISOString();
  }
  const clock = /resets?(?: at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(line);
  if (clock) {
    let h = Number(clock[1]) % 12;
    if (clock[3]!.toLowerCase() === "pm") h += 12;
    const d = new Date(now);
    d.setHours(h, Number(clock[2] ?? 0), 0, 0);
    if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
    return d.toISOString();
  }
  return undefined;
}

export function detectLimitMessage(provider: ProviderFamily, screen: string, now: Date): LimitHit | null {
  const lines = screen.split("\n").map((l) => l.trim()).filter(Boolean).slice(-TAIL_LINES);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!PATTERNS[provider].some((re) => re.test(line))) continue;
    if (provider === "openai" && !OPENAI_CONFIRM.test(line)) continue;
    const resetAt = parseReset(line, now);
    return resetAt ? { hit: true, resetAt } : { hit: true };
  }
  return null;
}
