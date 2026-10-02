# topdrive status

Repo `pragmaticbear/topdrive`: topdrive only. It began as a fork of `mvschwarz/openrig`; the OpenRig code was removed once topdrive became an add-on. Two parts:

- **topdrive** (repo root, command `topdrive`): every piece of limit-aware routing. It runs beside the user's existing OpenRig and talks to it only through OpenRig's standard HTTP API. Its state (provider health, role executions, routing decisions) is kept in `~/.topdrive/topdrive.sqlite`. See `README.md`.
- **`openrig-patches/`**: the only changes that must live inside OpenRig, both upstream candidates. They are the Antigravity (`agy`) runtime adapter (with resume, conversation capture and the `useG1Credits` launch guard) and the launch-time API-key scrub for seat shells. Verified against upstream `main` @ `2b63d69`.

History: PRs #1-#4 built routing inside a fork of the OpenRig daemon. The add-on refactor moved it out into topdrive, and the repo was then trimmed to topdrive only (git history keeps the fork). Removed along the way: the in-daemon service, `/api/topdrive/*`, migration `093`, `rig provider quota|billing-check`, `rig route explain`, `rig workflow roles`, the TUI Providers panel and the queue `withinTransaction` hook. Stock OpenRig's atomic `POST /api/workflow/:id/route` replaces the hook.

## Spec §87 MVP checklist

| MVP item | Status | Where |
| --- | --- | --- |
| Antigravity runtime | Done, verified live (`rig up` launched an `agy` seat, ready) | `openrig-patches/` (`adapters/antigravity-runtime-adapter.ts`) |
| Subscription-only guard | Done. OpenRig patch: seat shells strip API keys at launch (verified live). topdrive: `topdrive doctor` FAILS when tmux's global env holds an API key | `openrig-patches/` (`adapters/tmux.ts`); `src/doctor.ts` |
| Normalized provider health | Done. agy exact (`/usage` JSON); Codex from its session-log `rate_limits`; Claude from OpenRig's `/api/provider/signals`; limit banners on seat screens | `src/core/provider-health.ts`, `agy-quota.ts`, `codex-quota.ts`, `quota-service.ts`, `limit-detector.ts` |
| Role history | Done, from OpenRig's workflow trail (`/api/workflow/:id/trace`) plus topdrive's own handoff rows | `src/supervisor.ts` |
| Eligibility engine | Done, incl. self-review, held, unknown provenance | `src/core/eligibility.ts` |
| Hard-limit failover | Done; moves use OpenRig's atomic workflow route. Verified live against unmodified upstream OpenRig | `src/supervisor.ts`, `src/core/failover-reactor.ts` |
| Soft draining | Done: waits for the seat's in-progress turn, then moves | `src/core/failover-reactor.ts` |
| Review independence | Done: HELD (`blocked`, `provider-capacity:<role>`) rather than weaken. Verified live on upstream OpenRig | `src/supervisor.ts` |
| Automatic cooldown wake | Done via the supervisory tick (probe, then retry held work; held work is also retried once on startup, §80) | `src/supervisor.ts` `tick()` |

Commands: `topdrive doctor | start | stop | status | run | tick | quota | explain | roles | billing-check`.

## Tests

`npm test`: 104 tests, including a fake OpenRig in `test/fake-openrig.ts` that mirrors the stock API's behavior. `npm run lint` typechecks. CI runs both on Node 22 and 24. The OpenRig patch's own tests run inside an OpenRig checkout (see `openrig-patches/README.md`).

## Live end-to-end (real Codex + Claude Code + agy seats, isolated daemon; in-daemon era)

A 5-step workflow (plan, verify, implement, review, approve) ran to `completed`. Steps were closed by a script acting as each seat (no LLM did the work; real seats were launched and idle), so this proves routing, not agent quality. Observed with real provider health (Codex weekly 2% => draining):

- planner packet owned by Sol was moved to an eligible seat within one tick (failover).
- verify was assigned to the seat of the provider that planned; the assignment guard re-routed it to agy (independence enforced on normal assignment).
- review went to Claude (not agy, who implemented); approve went to Claude because Sol was draining.
- Bugs found only by the live run and fixed: workflow frontier kept pointing at the handed-off packet; failover read role history from topdrive rows only, not workflow trails.

## Follow-up work (PR #2; routing parts since moved to the add-on)

- **Atomic frontier repoint**: the workflow frontier now moves inside the queue handoff transaction (`QueueHandoffInput.withinTransaction`); a failing repoint rolls the handoff back.
- **agy conversation id**: read exactly from the seat's live `agy` process (`lsof`: it holds its `<uuid>.db` open); filled at snapshot time; restore resumes with `agy --conversation <id>` (new `AntigravityResumeAdapter`). Verified live: snapshot captured the id, `rig down` + `rig restore` relaunched `agy --conversation <same id>`.
- **Events**: `provider.health_changed`, `topdrive.routing_decision`.
- **TUI**: System > Providers (`:providers` / `:quota`), read-only, from `/api/topdrive/quota`; unknown quota shown as `unknown`. Unit-tested; not exercised in a live terminal.

## Hardening (PR #3)

- `useG1Credits` is read from `agy -p "/config"` (structured, read-only). `topdrive doctor` FAILS on `true`; agy launch and restore are refused (attention_required) while it is `true`; an unreadable value warns and does not block.
- Billing scrub is shell-aware (bash/zsh/sh/dash/ksh `unset`, fish `set -e`, nu `hide-env`) and **fails closed** on any other shell or if the scrub can't be delivered (session removed). Tests that mock tmux set `TOPDRIVE_BILLING_MODE=unrestricted`.

## Cloud-agent handover (`feat/cloud-agent-handover`)

- **Add-on refactor**: routing moved out of the daemon into topdrive. It was verified against **unmodified upstream OpenRig** built from `mvschwarz/openrig` main:
  - The seats were three terminal seats, mapped to agy, Claude Code and Codex with `seat_runtimes`.
  - A real Claude limit banner printed on the reviewer's screen put Anthropic in `cooldown` (reset parsed), and the review moved to Codex through `POST /api/workflow/:id/route`.
  - A Codex banner on the new seat then put OpenAI in `cooldown`, and the review was HELD rather than given to the Gemini implementer.
  - `topdrive explain` showed `performed_role:implementer` / `provider_cooldown` / `provider_cooldown`.
- **Stock API quirk handled**: routing a `blocked` packet keeps it blocked on the new seat, so topdrive releases it after the move. Both orders recover on the next pass if topdrive dies in between.
- **§80 restart fix**: a held packet stayed `blocked` forever if its provider was stored `available` just before topdrive stopped, because no further `.available` transition is ever seen. The first tick now retries held work. The test fails without the fix.
- **Demo harness made runnable** (`demo/`):
  - `drive.py`'s regexes had lost their backslashes; that's fixed, and it now refuses chained commands and stray redirects.
  - `run-e2e.sh` now runs an isolated daemon of your installed OpenRig plus the topdrive supervisor.

## Config

`~/.topdrive/topdrive.yaml` (`TOPDRIVE_HOME`) with the spec's `quota_routing:` block: thresholds, polling, role preferences, constraint flags, and `seat_runtimes` for seats whose OpenRig runtime doesn't name their subscription. Parsing is strict: unknown keys are errors, billing can only be tightened, and the implementer!=reviewer/approver separations cannot be disabled. An invalid file stops `topdrive start`/`run` with the error.

## Known gaps & Live Verification Findings

1. **Real agents doing real work**: Partially executed live on rig `tdreal`. Finishing it needs subscription logins for `agy`/`codex`/`claude`, so it must run on an operator machine (`bash demo/run-e2e.sh`), not in a cloud container. `dev-pln@tdreal` (Antigravity) claimed the queue item, wrote the plan, and completed step `plan` via `rig workflow project`. Step `verify` was handed off to `dev-ver@tdreal` (Claude Code).
2. **Reactive hard limit — VERIFIED LIVE**: During the live `tdreal` run, `dev-ver` (Claude Code) hit Anthropic's session limit ("resets 6pm"). Topdrive's screen scanner caught the banner live, parsed `resetAt: 2026-10-02T22:00:00.000Z`, transitioned Anthropic to `cooldown`, and HELD the verification qitem as `blocked` (`provider-capacity:verifier`) rather than violating provider independence (Google planned, so Google could not verify).
3. **No watchdog policies** (`provider-reset` etc.), deliberately: the supervisory tick already does the cooldown re-probe and held-work retry, so policies would duplicate it. Health transitions and routing decisions are written to `~/.topdrive/topdrive.log` and topdrive's database (`topdrive quota --json` events, `topdrive roles`).
4. **agy trust gate**: new folders show a trust prompt; the seat reports `trust_gate` (attention required). Trust lives in `~/.gemini/antigravity-cli/settings.json` `trustedWorkspaces` (exact paths, not recursive).
5. **Not on OpenRig's own surfaces (add-on limits)**: stock OpenRig has no API for an outside program to publish feed events or add a TUI panel. So topdrive's health changes and routing decisions don't appear in `rig` feeds or the OpenRig TUI; use `topdrive quota/roles` and its log. The moves and holds themselves are ordinary OpenRig queue transitions, so they do appear in OpenRig: the `route` reason starts with `topdrive`, and held packets show `provider-capacity:<role>`.
