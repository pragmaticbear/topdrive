# Topdrive: Limit-Aware Multi-Model Orchestration for OpenRig

Topdrive adds subscription-only, limit-aware, multi-model routing to OpenRig across **Anthropic (Claude Code)**, **OpenAI (Codex)**, and **Google (Antigravity / `agy`)**.

**Architecture:** topdrive is a separate program (this repo, command `topdrive`) that runs beside the user's existing OpenRig and works only through OpenRig's standard HTTP API. The two changes that must live inside OpenRig (the Antigravity runtime and the launch-time API-key scrub) are kept in `openrig-patches/` until they're merged upstream. See `../README.md`.

This document serves as the handover reference for cloud agents picking up the project.

---

## 1. What Has Been Implemented and Merged

PRs #1-#3 built routing *inside* the OpenRig daemon. The add-on refactor then moved it out into topdrive, and this repo was trimmed to topdrive only. The table below is history: the rows' routing pieces (`topdrive/*.ts`, migration `093`, `rig provider quota`, `rig route explain`, the TUI Providers panel, the frontier-repoint hook) no longer exist in the daemon. Their logic and tests now live in the add-on.

All foundational implementation PRs were squash-merged into `main` on `pragmaticbear/topdrive` while it was still a fork of `mvschwarz/openrig`:

| PR | Title | Key Additions |
|---|---|---|
| **PR #1** | Limit-aware multi-model orchestration | `adapters/antigravity-runtime-adapter.ts`, `topdrive/provider-health.ts`, `topdrive/eligibility.ts`, `topdrive/quota-service.ts`, `topdrive/failover-reactor.ts`, `topdrive/auto-handoff.ts`, SQLite migration `093_topdrive.ts`, CLI commands (`rig provider quota`, `rig route explain`, `topdrive doctor`). |
| **PR #2** | Atomic frontier repoint & agy resume | Transactional frontier repoint inside queue handoff (`QueueHandoffInput.withinTransaction`); exact live `agy` conversation ID capture via process `lsof` + `AntigravityResumeAdapter`; OpenRig event bus events (`provider.health_changed`, `topdrive.routing_decision`); TUI Providers panel (`:providers` / `:quota`). |
| **PR #3** | Hardening & billing scrub | Fail-closed shell-aware billing scrub for bash, zsh, sh, dash, ksh, fish, nu; `useG1Credits` guard parsed from `agy -p "/config"` (read-only JSON). |

### Test Status
* **topdrive**: 10 files, 104 tests (`npm test`). They cover eligibility, health, config, limit detection, quota readers, failover, restart/sleep recovery (§80/§81), doctor, and the OpenRig client. A fake OpenRig in `test/fake-openrig.ts` mirrors the stock API's behavior.
* **OpenRig patch** (Antigravity runtime + key scrub): `openrig-patches/README.md` has the apply-and-test steps. It was verified on upstream `main` @ `2b63d69`.
* **Verified live against unmodified upstream OpenRig** (`mvschwarz/openrig` main): a Claude limit banner on a seat put Anthropic in cooldown, and the review moved to Codex through `POST /api/workflow/:id/route`. When Codex then hit its limit too, the review was HELD (`provider-capacity:reviewer`) rather than given to the Gemini implementer.

---

## 2. In-the-Wild Reactive Limit Proof (Verified Live)

During a live 5-step workflow on rig `tdreal`:
1. `dev-pln@tdreal` (Antigravity with Gemini 3.8 Flash) claimed the task, wrote the plan, and completed step `plan` via `rig workflow project`.
2. Step `verify` was assigned to `dev-ver@tdreal` (Claude Code).
3. Claude Code hit Anthropic's session limit:
   ```text
   ⚠ Usage limit reached · limit resets 6pm (America/New_York)
   ```
4. **Topdrive's screen scanner caught the banner live**, parsed `resets 6pm` (`resetAt: 2026-10-02T22:00:00.000Z`), and transitioned Anthropic to `cooldown`.
5. **Review Independence Enforced**:
   - Because Google (Antigravity) performed `planner`, Google seats were disqualified from `verifier` (`performed_role:planner`).
   - Anthropic was in `cooldown`.
   - Topdrive refused to compromise the separation rule and marked the queue item as **`blocked` (`HELD`)** with blocker `provider-capacity:verifier`.

`rig route explain --role verifier --workflow <id>` (now `topdrive explain`) confirmed:
```text
ROLE: verifier  (workflow 01M3Z0TFNFJ7KBBMBFW6KH60PR)

dev-bld@tdreal
  ✗ performed_role:planner
dev-pln@tdreal
  ✗ performed_role:planner
dev-ver@tdreal
  ✗ provider_cooldown

HELD: no eligible seat (constraints are never weakened to keep moving)
```

---

## 3. How to Run / Continue the Real-Agent Workflow

This directory (`demo/`) contains the complete assets to run a live multi-agent workflow:
- `rig.yaml`: rig `tdrun` with Antigravity seats `pln`, `bld` and a Codex seat `sol` (all `cwd: /tmp`).
- `flow.yaml`: 5-step workflow (plan → verify → implement → review → approve) writing `/tmp/hello.txt`.
- `topdrive.yaml`: topdrive's config for the run. It sets `draining_threshold_percent: 1`, so a nearly-spent Codex weekly window (~2% left) can still take the light verify/review steps.
- `drive.py`: answers trust/update/permission prompts in the seats' panes. It approves only single commands from its `SAFE` list (no `;`, `&&`, `||`, `$(...)`, or redirects other than to `/tmp/hello.txt`) and denies everything else.
- `run-e2e.sh`: starts an isolated daemon of your installed OpenRig (`rig` on PATH, or `RIG=/path/to/rig`; home `/tmp/topdrive-e2e-run/openrig`, port 7445, no kernel rig), brings the rig up, starts the topdrive supervisor (home `/tmp/topdrive-e2e-run/topdrive`), instantiates the workflow, runs `drive.py`, and prints status and topdrive's log.

### Prerequisites
- This repo built: `npm ci && npm run build`.
- OpenRig installed, with `openrig-patches/` applied so it can launch `agy` seats.
- `tmux`, `python3`, Node 22 or 24.
- `agy` and `codex` on `PATH` and **logged in with subscriptions**. No API keys: seat shells strip them, and `topdrive doctor` fails on `useG1Credits: true`.
- `/tmp` trusted in agy (`~/.gemini/antigravity-cli/settings.json` `trustedWorkspaces`), or let `drive.py` answer the trust prompt.

### Quick Start
```bash
bash demo/run-e2e.sh
```

The script needs an OpenRig with the patch because stock OpenRig can't launch `agy` seats yet. topdrive itself only uses OpenRig's standard API. Both homes are throwaway, so your `~/.openrig` and `~/.topdrive` are untouched.

Knobs (environment variables): `DRIVE_SECONDS` (default 180), `TOPDRIVE_E2E_PORT` (default 7445), `TOPDRIVE_E2E_DIR` (default `/tmp/topdrive-e2e-run`), `TMUX_SOCKET` (only to force a specific tmux socket for `drive.py`).

To try topdrive on your everyday OpenRig instead (Claude Code + Codex seats), run `scripts/install-topdrive.sh`, then `topdrive doctor` and `topdrive start`.

To include Claude Code, change one seat's `runtime` in `rig.yaml` to `claude-code` once the Anthropic quota has reset, and add `"Do you want to proceed?"`-style prompts you see to `drive.py` if they differ.

### What a cloud container can and cannot do
A cloud session can build, run every unit/integration test, and start the daemon. It cannot finish the live run: that needs interactive subscription logins for `agy`, `codex` and `claude`, which are not available there. The live proof must be run on an operator machine.

---

## 4. Key Commands
```bash
topdrive doctor                       # OpenRig reachable, config, API keys seats could inherit, agy readiness
topdrive start | stop | status        # background supervisor (log: ~/.topdrive/topdrive.log)
topdrive quota [--json] [--refresh]   # normalized provider health; unknown stays unknown
topdrive explain --role verifier --workflow <instance-id>
topdrive roles <instance-id>          # role history + every routing decision
topdrive billing-check
```
