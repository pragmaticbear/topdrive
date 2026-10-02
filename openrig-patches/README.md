# OpenRig patches

topdrive itself needs nothing from OpenRig beyond its standard HTTP API. Two things can only live *inside* OpenRig,
though, and they're kept here as a patch until they're merged upstream into
[mvschwarz/openrig](https://github.com/mvschwarz/openrig).

`0001-antigravity-runtime-and-api-key-scrub.patch` (26 files, OpenRig `packages/daemon` only):

- **Antigravity runtime.** `runtime: antigravity` seats run `agy` in tmux. The patch also adds:
  - ready/trust-gate detection;
  - exact conversation-id capture from the live `agy` process, so `rig restore` resumes with `agy --conversation <id>`;
  - a launch and restore guard that refuses to start while `useG1Credits=true`, because paid credits would be spent.
- **API-key scrub.** Every managed seat shell unsets `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY`,
  `CODEX_API_KEY`, `GEMINI_API_KEY` and `GOOGLE_API_KEY` before the agent starts, so seats bill subscriptions and never
  API keys. It is shell-aware (bash/zsh/sh/dash/ksh, fish, nu) and fails closed on anything else. Opt out with
  `TOPDRIVE_BILLING_MODE=unrestricted`.

Without the patch, topdrive still works on stock OpenRig for Claude Code and Codex seats. `topdrive doctor` then
checks for API keys in tmux's global environment instead.

## Apply

The patch was checked against upstream `main` @ `2b63d69` (2026-10-02). There it applies cleanly, builds, and its 149
related tests pass.

```bash
git clone https://github.com/mvschwarz/openrig.git && cd openrig     # or your fork of it
git apply --3way /path/to/topdrive/openrig-patches/0001-antigravity-runtime-and-api-key-scrub.patch
npm ci && npm run build
cd packages/daemon && npx vitest run test/antigravity-*.test.ts test/topdrive-tmux-scrub.test.ts
```

## Upstreaming

The plan is to fork `mvschwarz/openrig` (as `pragmaticbear/openrig`), commit this patch on a branch there, and open
upstream PRs, one for the Antigravity runtime and one for the key scrub. Once they're merged, this folder can be deleted.
