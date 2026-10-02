# topdrive

Limit-aware multi-model routing for the OpenRig you already run.

OpenRig runs agent seats (Claude Code, Codex, Antigravity) and moves workflow packets between them. topdrive watches
those seats' subscription limits. When a provider runs low or hits its limit, topdrive moves the work to another seat.
It never lets a provider review or approve its own work: if no independent seat is left, the packet is **held** until
one comes back.

topdrive is a separate program. It talks to OpenRig over OpenRig's local HTTP API (the same API the `rig` CLI uses)
and keeps its own state in `~/.topdrive`. It never edits OpenRig's files or database, and you can stop it at any time.

## Install

```bash
# in this repository
npm ci && npm run build
scripts/install-topdrive.sh          # links ~/.local/bin/topdrive (pass another dir if you like)
```

## Use

```bash
rig daemon start                     # your OpenRig, as usual
topdrive doctor                      # OpenRig reachable? config valid? API keys anywhere seats could inherit them?
topdrive start                       # supervisor in the background (log: ~/.topdrive/topdrive.log)
topdrive quota                       # provider health: AVAILABLE / DEGRADED / DRAINING / COOLDOWN / UNKNOWN ...
topdrive explain --role reviewer --workflow <instance-id>   # which seat would review now, and why the others can't
topdrive roles <instance-id>         # who did which role, and every routing decision topdrive made
topdrive stop
```

`topdrive run` runs the supervisor in the foreground, and `topdrive tick` runs one pass and exits.

## What it does each pass (default every 60s)

1. **Reads limits.** Antigravity from `agy /usage` (exact), Codex from its session logs (exact), Claude from OpenRig's
   provider signals. It also looks for limit banners on each agent seat's screen. A reading it can't get is
   `UNKNOWN`; topdrive never makes up a percentage.
2. **Moves work off a provider that can't take it.** A hard limit moves pending work right away. A soft limit
   (draining) waits until the seat finishes its current turn. Moves use OpenRig's `workflow route`, which re-homes
   the packet atomically.
3. **Keeps roles independent.** By default the verifier differs from the planner's provider, and the reviewer and
   approver differ from the implementer's provider. Role history comes from OpenRig's workflow trail. If no eligible
   seat exists, the packet is set to `blocked` with `provider-capacity:<role>`, which OpenRig shows as waiting.
4. **Resumes held work** when a provider comes back. A provider in cooldown counts as back only after a successful
   probe past its reset time. Topdrive also retries held work once on startup, so a restart or a laptop sleep
   never strands it.
5. **Checks normal assignments too.** A pending packet sitting with an ineligible seat (for example, the verify step
   given to the planner's provider) is re-routed or held.

## Configuration: `~/.topdrive/topdrive.yaml`

```yaml
quota_routing:
  polling: { interval_seconds: 60 }
  health: { degraded_threshold_percent: 25, draining_threshold_percent: 10 }
  unknown_provider_policy: allow          # or deny: never route to a provider whose quota is unknown
  constraints:
    verifier_must_differ_from_planner: true      # the only one that can be turned off
    reviewer_must_differ_from_implementer: true
    approver_must_differ_from_implementer: true
  roles:
    reviewer: { prefer: [claude, "codex:sol", antigravity] }
  seat_runtimes:                          # seats whose OpenRig runtime doesn't say which subscription they use
    ops-wrapper@myrig: claude-code
```

Unknown keys are errors. The billing guard can only be tightened, never loosened. Override the location with
`TOPDRIVE_HOME`, and the OpenRig address with `--openrig-url` or `OPENRIG_URL`. By default topdrive reads
`~/.openrig/daemon.json`.

## On stock OpenRig vs OpenRig with the topdrive patch

| | stock OpenRig | OpenRig + `openrig-patches/` |
|---|---|---|
| Claude Code + Codex routing, holds, independence | yes | yes |
| Antigravity (`agy`) seats | no: stock OpenRig can't launch them yet | yes |
| API keys stripped from every seat shell at launch | no: `topdrive doctor` FAILS if tmux's global env holds one | yes |

`openrig-patches/` carries only those two things, and both are meant to go upstream to OpenRig. Don't run the topdrive
supervisor against an old build of the topdrive fork that had routing built into the daemon. `topdrive run` refuses
to: two supervisors would route every packet twice.

## Repository

- `src/`, `test/`: topdrive. Run `npm test` (it builds first) and `npm run lint`.
- `demo/`: live end-to-end run with real `agy`/`codex` seats (`demo/README.md`).
- `openrig-patches/`: the OpenRig changes waiting to be upstreamed.
- `docs/`: status (`docs/status.md`), the design spec (`docs/spec.md`), the original OpenRig extension map.

Licensed under Apache-2.0 (see `LICENSE` and `NOTICE`). topdrive started inside a fork of
[OpenRig](https://github.com/mvschwarz/openrig).
