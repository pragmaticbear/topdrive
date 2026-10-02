// topdrive §45: `topdrive doctor` checks — subscription-only billing posture + Antigravity readiness.
// Names API-credential env vars that are SET, never their values.

interface Check { name: string; status: "pass" | "warn" | "fail" | "skipped"; message: string; reason?: string; fix?: string }

const API_CREDENTIAL_NAMES = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"];

export function topdriveDoctorChecks(deps: { exec: (cmd: string) => string; env: Record<string, string | undefined> }): Check[] {
  const checks: Check[] = [];

  const present = API_CREDENTIAL_NAMES.filter((n) => deps.env[n]);
  checks.push(present.length === 0
    ? { name: "subscription_only_env", status: "pass", message: "No API credentials in this shell's environment." }
    : {
      name: "subscription_only_env", status: "warn",
      message: `API credentials set in this shell: ${present.join(", ")}. An OpenRig daemon or tmux server started from it can pass them to seats.`,
      reason: "Seats must authenticate with the interactive subscription login, never API billing (subscription_only).",
      fix: `Unset ${present.join(", ")} before starting OpenRig (and its tmux server).`,
    });

  // What seats actually inherit: tmux's global environment. A key there reaches every new seat shell.
  let tmuxEnv: string | null = null;
  try { tmuxEnv = deps.exec("tmux show-environment -g"); } catch { /* no tmux server running: nothing to inherit yet */ }
  if (tmuxEnv !== null) {
    const leaked = API_CREDENTIAL_NAMES.filter((n) => new RegExp(`^${n}=`, "m").test(tmuxEnv!));
    checks.push(leaked.length === 0
      ? { name: "seat_env_api_credentials", status: "pass", message: "tmux global environment has no API credentials (seats inherit none)." }
      : {
        name: "seat_env_api_credentials", status: "fail",
        message: `tmux global environment holds ${leaked.join(", ")}: every new seat inherits it and may bill the API.`,
        reason: "subscription_only: a seat must never fall back to API billing.",
        fix: `Run ${leaked.map((n) => `tmux set-environment -gu ${n}`).join("; ")} (then restart affected seats).`,
      });
  }

  let version: string | null = null;
  try { version = deps.exec("agy --version").trim(); } catch { /* absent */ }
  if (!version) {
    checks.push({ name: "agy_installed", status: "skipped", message: "agy (Antigravity CLI) not found; antigravity seats unavailable." });
    return checks;
  }
  checks.push({ name: "agy_installed", status: "pass", message: `agy ${version}` });

  try {
    const groups = JSON.parse(deps.exec('agy -p "/usage" --output-format json'))?.command?.data?.groups;
    if (!Array.isArray(groups) || groups.length === 0) throw new Error("no groups");
    checks.push({ name: "agy_quota_readable", status: "pass", message: "Antigravity quota readable (structured /usage)." });
  } catch {
    checks.push({
      name: "agy_quota_readable", status: "warn", message: "Antigravity quota could not be read; routing will treat google as UNKNOWN.",
      reason: "`agy -p /usage` failed or returned an unexpected shape (not logged in?).", fix: "Run `agy` once interactively to log in, then re-run `topdrive doctor`.",
    });
  }

  try {
    const credits = JSON.parse(deps.exec('agy -p "/credits" --output-format json'))?.command?.data?.remaining_credits;
    if (typeof credits !== "number") throw new Error("no credits field");
    checks.push(credits === 0
      ? { name: "agy_paid_credits", status: "pass", message: "No purchased Antigravity credits to fall back onto." }
      : {
        name: "agy_paid_credits", status: "warn", message: `${credits} Antigravity credits are available and could be consumed past plan quota.`,
        reason: "allow_paid_overage=false: the workflow must hand off, never spend purchased credits.", fix: "Disable credit usage in `agy` settings (useG1Credits=false).",
      });
  } catch {
    checks.push({ name: "agy_paid_credits", status: "warn", message: "Antigravity credit state could not be verified.", fix: "Check `agy` settings for useG1Credits." });
  }

  // The setting itself (spec §9): `agy -p "/config"` reports it read-only; true means plan-quota exhaustion would spend purchased credits.
  try {
    const g1 = JSON.parse(deps.exec('agy -p "/config" --output-format json'))?.command?.data?.config?.useG1Credits;
    if (typeof g1 !== "boolean") throw new Error("no useG1Credits");
    checks.push(g1
      ? {
        name: "agy_use_g1_credits", status: "fail", message: "useG1Credits=true: Antigravity may spend purchased credits when plan quota runs out.",
        reason: "allow_paid_overage=false: an exhausted plan must hand off, never buy more usage.", fix: "Turn off useG1Credits in agy (`agy`, then /config) before running managed seats.",
      }
      : { name: "agy_use_g1_credits", status: "pass", message: "useG1Credits=false (paid credit fallback disabled)." });
  } catch {
    checks.push({ name: "agy_use_g1_credits", status: "warn", message: "useG1Credits could not be read from `agy /config`.", fix: "Check `agy` /config for useG1Credits=false." });
  }
  return checks;
}
