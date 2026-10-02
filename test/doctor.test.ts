import { describe, expect, it } from "vitest";
import { topdriveDoctorChecks } from "../src/doctor.js";

const USAGE = JSON.stringify({ command: { data: { groups: [{ name: "Gemini Models", buckets: [{ window: "5h", remaining_fraction: 0.8 }] }] } } });
const CONFIG = (g1: unknown) => JSON.stringify({ command: { data: { config: { useG1Credits: g1 } } } });
const CREDITS = (n: number) => JSON.stringify({ command: { data: { remaining_credits: n } } });
const names = (c: Array<{ name: string }>) => c.map((x) => x.name);

describe("topdriveDoctorChecks", () => {
  it("all good: agy installed, quota readable, no credits, no API keys", () => {
    const exec = (cmd: string) => (cmd.startsWith("tmux") ? "HOME=/h\nPATH=/bin\n" : cmd.includes("--version") ? "1.2.14" : cmd.includes("/usage") ? USAGE : cmd.includes("/config") ? CONFIG(false) : CREDITS(0));
    const checks = topdriveDoctorChecks({ exec, env: {} });
    expect(checks.every((c) => c.status === "pass")).toBe(true);
    expect(names(checks)).toEqual(["subscription_only_env", "seat_env_api_credentials", "agy_installed", "agy_quota_readable", "agy_paid_credits", "agy_use_g1_credits"]);
  });
  it("an API key in tmux's global env FAILS (every new seat would inherit it) with an unset fix; no tmux server => no check", () => {
    const leaky = topdriveDoctorChecks({ exec: (cmd) => { if (cmd.startsWith("tmux")) return "ANTHROPIC_API_KEY=sk-secret\nPATH=/bin\n"; throw new Error("x"); }, env: {} });
    const c = leaky.find((x) => x.name === "seat_env_api_credentials")!;
    expect(c.status).toBe("fail");
    expect(c.message).toContain("ANTHROPIC_API_KEY");
    expect(c.message).not.toContain("sk-secret");
    expect(c.fix).toContain("tmux set-environment -gu ANTHROPIC_API_KEY");
    const noServer = topdriveDoctorChecks({ exec: () => { throw new Error("no server running"); }, env: {} });
    expect(names(noServer)).not.toContain("seat_env_api_credentials");
  });
  it("API credentials in this shell warn and are named without values", () => {
    const c = topdriveDoctorChecks({ exec: () => { throw new Error("x"); }, env: { GEMINI_API_KEY: "secret-value", PATH: "/bin" } }).find((x) => x.name === "subscription_only_env")!;
    expect(c.status).toBe("warn");
    expect(c.message).toContain("GEMINI_API_KEY");
    expect(c.message).not.toContain("secret-value");
  });
  it("agy missing: skipped, not failed (Antigravity is optional until configured)", () => {
    const checks = topdriveDoctorChecks({ exec: () => { throw new Error("not found"); }, env: {} });
    expect(checks.find((c) => c.name === "agy_installed")!.status).toBe("skipped");
    expect(names(checks)).not.toContain("agy_quota_readable");
  });
  it("unreadable quota is a warn (routing treats the provider as UNKNOWN), not a pass", () => {
    const exec = (cmd: string) => { if (cmd.includes("--version")) return "1.2.14"; throw new Error("auth"); };
    expect(topdriveDoctorChecks({ exec, env: {} }).find((c) => c.name === "agy_quota_readable")!.status).toBe("warn");
  });
  it("paid credits present while overage is disallowed warns with a fix", () => {
    const exec = (cmd: string) => (cmd.includes("--version") ? "1.2.14" : cmd.includes("/usage") ? USAGE : CREDITS(50));
    const c = topdriveDoctorChecks({ exec, env: {} }).find((x) => x.name === "agy_paid_credits")!;
    expect(c.status).toBe("warn");
    expect(c.fix).toBeTruthy();
  });
  it("useG1Credits=true is a FAIL while paid overage is disallowed (spec §9, §79); false passes; unreadable warns", () => {
    const run = (cfg: string | Error) => topdriveDoctorChecks({ env: {}, exec: (cmd) => {
      if (cmd.includes("--version")) return "1.2.14";
      if (cmd.includes("/usage")) return USAGE;
      if (cmd.includes("/credits")) return CREDITS(0);
      if (cfg instanceof Error) throw cfg;
      return cfg;
    } }).find((c) => c.name === "agy_use_g1_credits")!;
    const on = run(CONFIG(true));
    expect(on.status).toBe("fail");
    expect(on.fix).toContain("useG1Credits");
    expect(run(CONFIG(false)).status).toBe("pass");
    expect(run(new Error("x")).status).toBe("warn");
    expect(run(JSON.stringify({ command: { data: { config: {} } } })).status).toBe("warn");
  });
});
