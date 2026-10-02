# OpenRig Limit-Aware Multi-Model Orchestration

**Status:** Proposed  
**Version:** 1.0  
**Date:** October 1, 2026  
**Base:** OpenRig 0.5.x  
**Architecture:** Local-first OpenRig extension/fork  
**License:** Preserve OpenRig Apache-2.0 compatibility  
**Primary platforms:** macOS and Linux  
**Primary runtimes:** Codex, Claude Code, Antigravity CLI  
**Billing model:** Existing user subscriptions only

---

## 1. Executive Summary

Extend OpenRig into a **limit-aware, subscription-backed multi-model coding control plane**.

OpenRig remains responsible for:

- agent seats
- tmux session management
- durable workflows
- SQLite persistence
- queue ownership
- transactional handoffs
- restore packets
- provider/account state
- watchdogs
- runtime lifecycle
- topology
- messaging
- recovery

This project adds:

1. **Google Antigravity as a native OpenRig runtime**
2. **normalized provider quota/availability state**
3. **subscription-only enforcement**
4. **quota-aware role routing**
5. **automatic soft and hard limit handoff**
6. **task-history-aware separation of duties**
7. **provider eligibility scoring**
8. **provider cooldown/reset handling**
9. **auditability for every automatic routing decision**

The target experience is:

```text
Sol
PLAN
  ↓
Claude
VERIFY
  ↓
Gemini / Antigravity
IMPLEMENT
  ↓
Claude
REVIEW
  ↓
Sol
APPROVE
```

But those assignments are preferences, not hard dependencies.

If Claude becomes unavailable:

```text
Claude REVIEW
     ↓
approaching limit
     ↓
DRAINING
     ↓
checkpoint
     ↓
eligible reviewer selection
     ↓
Sol REVIEW
```

If no valid replacement exists:

```text
FLOW PAUSED
```

The system must never weaken review independence simply to keep a workflow moving.

---

## 2. Product Principle

The central design principle is:

> **The role and work item survive the model performing them.**

The system does not think in terms of:

```text
Claude must review.
```

It thinks in terms of:

```text
This task requires an independent reviewer.

Preferred provider: Claude.
Current eligible provider: Sol.
```

Provider identity is replaceable.

Workflow responsibility is durable.

---

## 3. Why OpenRig

The project MUST extend OpenRig rather than recreate its existing control-plane functionality.

OpenRig currently provides:

- local daemon
- CLI
- TUI
- MCP interface
- SQLite state
- tmux-backed seats
- Claude Code runtime
- Codex runtime
- Pi runtime
- YAML-defined rigs
- persistent workflow instances
- owned queue items
- transactional handoffs
- fallback routing
- provider status/signals
- named auth profiles
- provider prechecks
- snapshots
- restore packets
- watchdogs
- context-usage monitoring

OpenRig workflows already persist step ownership independently from the agent session and atomically project the next workflow step when a current step closes.

OpenRig also operates the accounts that the native harnesses are already authenticated with rather than centrally storing provider tokens.

Therefore none of these systems should be duplicated.

---

## 4. Non-Goals

This project will NOT:

- create another agent framework
- create another terminal multiplexer
- replace OpenRig workflows
- replace OpenRig queue items
- build another SQLite state store
- create an LLM gateway
- proxy OpenAI, Anthropic, or Google APIs
- require model API keys
- circumvent provider rate limits
- circumvent subscription rules
- auto-purchase additional usage
- merge code automatically by default
- push code automatically by default
- create a new IDE
- become part of BearPaws
- require BearPaws
- depend on one specific model version
- allow an agent to approve its own implementation

---

## 5. Required Providers

Initial release supports three provider families.

### OpenAI

Harness:

```text
Codex CLI
```

Primary preferred model:

```text
GPT-5.6 Sol
```

Primary roles:

```text
planner
reviewer fallback
approver
```

Authentication:

```text
existing Codex / ChatGPT login
```

### Anthropic

Harness:

```text
Claude Code
```

Primary roles:

```text
plan verifier
reviewer
implementer fallback
```

Authentication:

```text
existing Claude subscription login
```

### Google

Harness:

```text
Antigravity CLI
agy
```

Primary roles:

```text
implementer
reviewer fallback
planner fallback
```

Authentication:

```text
existing Google / Antigravity account login
```

Antigravity exposes active model quota through its usage/quota surfaces.

---

## 6. Subscription-Only Invariant

The most important provider invariant is:

```text
NO API FALLBACK
```

A provider is either usable through the authenticated subscription or unavailable.

The workflow must never silently change billing modes.

---

## 7. Billing Guard

Introduce a billing policy:

```yaml
billing:
  mode: subscription_only
  allow_api_fallback: false
  allow_paid_overage: false
```

This MUST be globally enforceable.

It may additionally be overridden only toward stricter behavior.

A seat cannot override it toward API usage.

---

## 8. Environment Sanitization

Before spawning a managed runtime, OpenRig MUST create a sanitized provider environment.

### Claude

Remove or reject:

```text
ANTHROPIC_API_KEY
ANTHROPIC_AUTH_TOKEN
```

and configurable additional Anthropic credential variables.

### Codex

Remove or reject:

```text
OPENAI_API_KEY
CODEX_API_KEY
```

and configurable additional API credential variables.

### Antigravity

Remove or reject API-mode configuration such as:

```text
GEMINI_API_KEY
```

where its presence/configuration would cause the seat to use API billing instead of interactive account authentication.

---

## 9. Antigravity Credit Protection

Antigravity MUST be configured with:

```json
{
  "useG1Credits": false
}
```

when:

```yaml
allow_paid_overage: false
```

The desired behavior is:

```text
plan quota exhausted
       ↓
Antigravity unavailable
       ↓
handoff
```

Never:

```text
plan quota exhausted
       ↓
consume purchased credits
```

---

## 10. New Core Concepts

Five concepts are introduced.

```text
Provider Health
Provider Eligibility
Role History
Drain State
Routing Decision
```

---

## 11. Provider Health

Every provider/runtime pair has a normalized health state.

```typescript
type ProviderHealthState =
  | "available"
  | "degraded"
  | "draining"
  | "exhausted"
  | "cooldown"
  | "auth_required"
  | "disabled"
  | "unknown";
```

---

## 12. State Definitions

### AVAILABLE

Provider is eligible for normal assignment.

`AVAILABLE` means:

- authentication valid
- no known quota problem
- required runtime operational
- no billing-policy violation

### DEGRADED

Provider remains eligible but has a known concern.

Examples:

- quota lower than configured warning threshold
- unstable session
- intermittent provider failures

New long-duration tasks may prefer another provider.

### DRAINING

Provider should not receive new work.

The current agent may finish a bounded atomic operation before handoff.

Example:

```text
Claude approaching 5-hour limit.
```

Behavior:

```text
current action
    ↓
finish safely
    ↓
checkpoint
    ↓
handoff
```

### EXHAUSTED

Provider has no usable subscription quota.

No work may be assigned.

### COOLDOWN

Provider is exhausted but has a known or estimated reset window.

```json
{
  "state": "cooldown",
  "resetAt": "..."
}
```

### AUTH_REQUIRED

Interactive authentication is missing or expired.

Automatic workflows may not use that provider.

### DISABLED

Administrator/user has disabled the provider.

### UNKNOWN

Current quota state cannot be determined reliably.

This is not equivalent to unavailable.

Eligibility policy determines whether UNKNOWN providers may be selected.

Default:

```text
UNKNOWN = usable only if no direct evidence of exhaustion exists
```

---

## 13. Provider Health Record

```typescript
interface ProviderHealth {
  provider: "openai" | "anthropic" | "google";
  runtime: string;
  accountId?: string;

  state: ProviderHealthState;

  quota?: {
    remainingPercent?: number;
    remaining?: number;
    unit?: string;
    resetAt?: string;
  };

  signalSource:
    | "provider_exact"
    | "provider_warning"
    | "provider_error"
    | "local_heuristic"
    | "manual"
    | "unknown";

  confidence:
    | "exact"
    | "direct"
    | "estimated"
    | "unknown";

  reason?: string;

  checkedAt: string;
}
```

---

## 14. Do Not Fabricate Quota Precision

The system must distinguish:

```text
exact quota
```

from:

```text
provider warning
```

from:

```text
local estimate
```

For example, if Claude reports an approaching limit but does not expose a machine-readable percentage:

Good:

```text
Claude
State: DRAINING
Signal: provider warning
Remaining: unknown
```

Bad:

```text
Claude
12% remaining
```

unless Anthropic actually provided that value.

---

## 15. Quota Broker

Introduce:

```text
ProviderQuotaService
```

or equivalent OpenRig domain service.

Responsibilities:

1. collect provider-specific signals
2. normalize signals
3. persist health
4. expose health to workflows
5. generate health-change events
6. determine cooldown transitions
7. trigger routing when required

Conceptually:

```text
Claude signals ───────┐
Codex signals ────────┼──→ Quota Broker
AGY quota ────────────┘
                           │
                           ▼
                  Normalized ProviderHealth
```

---

## 16. Provider Polling

Quota checks should not occur excessively.

Default:

```yaml
quota:
  poll_interval: 60s
```

Providers may define different strategies.

---

## 17. Antigravity Quota Adapter

Antigravity is the strongest initial candidate for direct quota reporting.

The adapter should collect:

```text
model
remaining usage
reset information where available
credit state
```

Where interactive TUI parsing proves fragile, prefer any underlying structured state or documented local quota representation exposed by the CLI.

Do not tightly couple core routing logic to rendered terminal text.

---

## 18. Claude Quota Adapter

Claude signals may include:

```text
usage warnings
rate-limit events
reset timestamps
provider errors
```

The implementation should extend OpenRig's existing Claude provider/context hooks where possible instead of creating a parallel monitoring subsystem.

Claude quota handling must support:

```text
warning → DRAINING
hard limit → COOLDOWN
```

---

## 19. Codex Quota Adapter

Codex health collection should extend OpenRig's existing provider signal model.

Priority:

1. structured provider state
2. existing OpenRig provider signals
3. CLI status parsing
4. hard error detection
5. local heuristic only as fallback

---

## 20. Antigravity Runtime Adapter

Add a native runtime:

```text
antigravity
```

CLI:

```text
agy
```

It should behave as a first-class OpenRig seat.

---

## 21. Runtime Requirements

The adapter MUST support:

```text
detect installation
detect authentication
launch
attach
resume
send
readiness
activity detection
shutdown
session identity
restore compatibility
provider-health association
```

Optional initially:

```text
adopt existing unmanaged Antigravity session
```

---

## 22. Antigravity Permissions

Default OpenRig Antigravity configuration should NOT use:

```text
--dangerously-skip-permissions
```

unless an explicit seat policy requests full bypass.

Recommended implementer policy:

```json
{
  "permissions": {
    "allow": [
      "command(git)",
      "command(regex:npm run (build|lint|test))",
      "write_file(src/)",
      "write_file(test/)",
      "write_file(tests/)"
    ]
  }
}
```

Exact policy remains project configurable.

---

## 23. Roles

Introduce formal workflow-role metadata.

Initial roles:

```text
planner
verifier
implementer
reviewer
approver
```

Roles are not agents.

Roles are requirements that an eligible seat fulfills.

---

## 24. Default Role Preferences

```yaml
roles:

  planner:
    prefer:
      - codex:sol
      - claude
      - antigravity

  verifier:
    prefer:
      - claude
      - codex:sol
      - antigravity

  implementer:
    prefer:
      - antigravity
      - codex:sol
      - claude

  reviewer:
    prefer:
      - claude
      - codex:sol
      - antigravity

  approver:
    prefer:
      - codex:sol
      - claude
      - antigravity
```

---

## 25. Separation of Duties

Default constraints:

```yaml
constraints:

  verifier:
    different_provider_from:
      - planner

  reviewer:
    different_provider_from:
      - implementer

  approver:
    different_provider_from:
      - implementer
```

The required minimum invariants are:

```text
implementer != reviewer

implementer != approver
```

---

## 26. Provider vs Model Independence

Version 1 should treat independence primarily at the provider/runtime level.

Example:

```text
Gemini implements.
Another Gemini seat should not independently review.
```

Even if it uses a different Gemini model.

Likewise:

```text
Codex/Sol implementer
```

should generally not be reviewed by another Codex seat under strict provider separation.

Future policy may support:

```text
provider separation
model separation
session separation
account separation
```

as distinct levels.

---

## 27. Role History

Each workflow instance must persist who actually performed each role.

```typescript
interface RoleExecution {
  workflowInstanceId: string;
  stepId: string;
  role: string;

  seatId: string;
  runtime: string;
  provider: string;
  model?: string;

  startedAt: string;
  endedAt?: string;

  outcome?: string;
}
```

This history becomes an input to future routing.

---

## 28. Eligibility Engine

Introduce:

```text
RoleEligibilityService
```

A seat is eligible only if:

```text
seat exists
AND
seat operational
AND
provider authenticated
AND
subscription-only policy satisfied
AND
provider state permits assignment
AND
runtime can perform role
AND
role constraints satisfied
AND
task-history constraints satisfied
```

---

## 29. Selection Algorithm

Candidate evaluation:

```text
all seats
   ↓
enabled?
   ↓
healthy?
   ↓
quota available?
   ↓
role capable?
   ↓
independence valid?
   ↓
preference rank
   ↓
best eligible seat
```

Possible scoring:

```text
role preference           100
provider health            40
existing task context      20
continuation affinity      15
available quota            15
```

Hard constraints are always evaluated before scores.

A higher score can never override:

```text
provider exhausted
```

or:

```text
reviewer implemented task
```

---

## 30. Assignment Decision Record

Every automatic selection MUST be explainable.

```json
{
  "workflow": "feature-build",
  "step": "review",
  "role": "reviewer",

  "selected": "sol-reviewer",

  "candidates": [
    {
      "seat": "claude-reviewer",
      "eligible": false,
      "reason": "provider_draining"
    },
    {
      "seat": "gemini-implementer",
      "eligible": false,
      "reason": "performed_role:implementer"
    },
    {
      "seat": "sol-reviewer",
      "eligible": true,
      "score": 142
    }
  ]
}
```

Persist this record.

---

## 31. Preferred Workflow

Default workflow:

```text
TASK
 │
 ▼
PLAN
 │
 ▼
VERIFY
 │
 ├──── revise ───→ PLAN
 │
 ▼
IMPLEMENT
 │
 ▼
REVIEW
 │
 ├──── changes ─→ IMPLEMENT
 │
 ▼
APPROVE
 │
 ├──── blocked
 │
 ▼
READY FOR HUMAN
```

Preferred assignments:

```text
PLAN        Sol
VERIFY      Claude
IMPLEMENT   Antigravity
REVIEW      Claude
APPROVE     Sol
```

---

## 32. OpenRig Workflow Integration

Use OpenRig's existing durable workflow mechanism.

Do NOT create a second state machine.

Each step should gain metadata such as:

```yaml
role: reviewer
routing: quota-aware
```

Conceptual workflow definition:

```yaml
steps:

  plan:
    role: planner

  verify:
    role: verifier
    after: plan

  implement:
    role: implementer
    after: verify

  review:
    role: reviewer
    after: implement

  approve:
    role: approver
    after: review
```

OpenRig remains responsible for workflow projection and durable step state.

---

## 33. Soft Handoff

Soft handoff occurs before a provider becomes unusable.

Trigger examples:

```text
provider approaching limit
quota below draining threshold
provider-issued low-capacity warning
```

Flow:

```text
Claude working
     ↓
LIMIT_WARNING
     ↓
state = DRAINING
     ↓
block new work
     ↓
allow active atomic action to finish
     ↓
OpenRig checkpoint/restore packet
     ↓
queue handoff
     ↓
next eligible seat
```

---

## 34. Atomic Operation

For V1, an atomic operation is defined conservatively as:

```text
current provider turn
```

or:

```text
currently executing approved tool command
```

The system should not attempt to interrupt arbitrary source-file modification halfway through a write.

After the current safe boundary:

```text
handoff
```

---

## 35. Hard Handoff

A hard handoff occurs when the provider can no longer complete the current operation.

Examples:

```text
usage exhausted
rate limit reached
subscription limit reached
provider refuses next model call
```

Flow:

```text
hard limit
   ↓
record failure
   ↓
Provider → COOLDOWN/EXHAUSTED
   ↓
capture current work state
   ↓
generate restore packet
   ↓
transactional queue handoff
   ↓
eligible replacement
```

---

## 36. The Failed Model Must Not Be Needed

Critical invariant:

> A provider that has already hit its limit must not be required to explain what it was doing.

The control plane must already possess sufficient durable state to resume.

Handoff inputs should include:

```text
OpenRig workflow state
queue item
restore packet
repository state
current branch
current SHA
git diff
provider events
test evidence
previous role outputs
remaining objective
```

---

## 37. Restore Packet Extension

If necessary, extend OpenRig's restore-packet metadata rather than replacing the format.

Additional optional fields:

```json
{
  "handoffReason": "quota_exhausted",
  "sourceProvider": "anthropic",
  "sourceRole": "reviewer",
  "targetRole": "reviewer",
  "workflowInstance": "...",
  "workflowStep": "...",
  "roleHistoryRef": "...",
  "evidenceRefs": []
}
```

Maintain compatibility with the base OpenRig restore schema where possible.

---

## 38. Quota-Aware Handoff

Introduce:

```text
rig queue auto-handoff
```

or internal equivalent.

Example:

```bash
rig queue auto-handoff <qitem>
```

Behavior:

1. determine qitem's role
2. read current role history
3. read provider health
4. evaluate eligible seats
5. select preferred valid target
6. create restore packet
7. execute OpenRig transactional handoff
8. persist routing decision
9. wake target seat

---

## 39. No Valid Replacement

If no seat qualifies:

```text
DO NOT VIOLATE CONSTRAINTS
```

Instead:

```text
queue item → HELD
```

Attach a wake condition/watchdog.

Example:

```text
REVIEW PAUSED

Claude:
COOLDOWN until ~14:00

Sol:
COOLDOWN until ~14:12

Gemini:
AVAILABLE
but ineligible because Gemini implemented this task
```

---

## 40. Automatic Resume

When a provider has a known reset time, OpenRig's existing timed/watchdog wake mechanisms should be used.

When the reset window passes:

```text
COOLDOWN
   ↓
re-probe
   ↓
AVAILABLE
```

Only after a successful probe should the provider become eligible.

---

## 41. Provider Health Changes

Health transitions should emit OpenRig events.

Examples:

```text
provider.anthropic.draining
provider.anthropic.exhausted
provider.anthropic.available

provider.google.quota_low
provider.google.cooldown

provider.openai.auth_required
```

These should appear in:

```text
TUI
event feed
JSON CLI output
logs
```

---

## 42. Watchdogs

Extend OpenRig watchdog types with:

```text
provider-health-threshold
provider-reset
workflow-provider-invalid
```

### provider-health-threshold

Trigger when:

```text
AVAILABLE → DEGRADED
DEGRADED → DRAINING
```

### provider-reset

Wake work after expected provider reset and re-probe.

### workflow-provider-invalid

Trigger when an active workflow owner becomes:

```text
EXHAUSTED
AUTH_REQUIRED
DISABLED
```

---

## 43. Configuration

Proposed RigSpec extension:

```yaml
quota_routing:
  enabled: true

  billing:
    mode: subscription_only
    allow_api_fallback: false
    allow_paid_overage: false

  polling:
    interval_seconds: 60

  health:
    degraded_threshold_percent: 25
    draining_threshold_percent: 10

  unknown_provider_policy: allow

  constraints:
    verifier_must_differ_from_planner: true
    reviewer_must_differ_from_implementer: true
    approver_must_differ_from_implementer: true

  roles:

    planner:
      prefer:
        - codex:sol
        - claude
        - antigravity

    verifier:
      prefer:
        - claude
        - codex:sol
        - antigravity

    implementer:
      prefer:
        - antigravity
        - codex:sol
        - claude

    reviewer:
      prefer:
        - claude
        - codex:sol
        - antigravity

    approver:
      prefer:
        - codex:sol
        - claude
        - antigravity
```

---

## 44. CLI Additions

### Provider quota

```bash
rig provider quota
```

Example:

```text
PROVIDER      STATE       QUOTA        RESET       SOURCE
Claude        DRAINING    unknown      unknown     warning
Codex/Sol     AVAILABLE   62%          2h 14m      provider
Gemini Flash  AVAILABLE   74%          --          provider
Gemini Pro    DEGRADED    18%          --          provider
```

### Explain eligibility

```bash
rig route explain --role reviewer --workflow <id>
```

Example:

```text
ROLE: reviewer

claude-reviewer
  ✗ DRAINING

gemini-builder
  ✗ implemented current task

sol-reviewer
  ✓ AVAILABLE
  ✓ independent
  ✓ role supported
  ✓ subscription-only

SELECTED:
sol-reviewer
```

### Show role history

```bash
rig workflow roles <instance>
```

Example:

```text
PLAN
  sol-planner
  openai
  completed

VERIFY
  claude-verifier
  anthropic
  completed

IMPLEMENT
  gemini-builder
  google
  completed

REVIEW
  claude-reviewer
  anthropic
  draining
```

### Billing validation

```bash
rig provider billing-check
```

Example:

```text
Codex
✓ interactive authentication
✓ API key removed from managed environment

Claude
✓ subscription authentication
✓ API credential fallback blocked

Antigravity
✓ Google authentication
✓ useG1Credits=false

Subscription-only policy satisfied.
```

---

## 45. Doctor Integration

Extend:

```bash
rig doctor
```

with:

```text
Quota routing
✓ enabled

Subscription-only
✓ OpenAI
✓ Anthropic
✓ Google

Antigravity
✓ agy installed
✓ authenticated
✓ quota readable
✓ paid credit fallback disabled
```

Failure example:

```text
✗ GEMINI_API_KEY detected
  Managed Antigravity seats will not launch while subscription_only is enforced.
```

---

## 46. TUI Additions

Add a provider-health panel.

Example:

```text
Providers

Claude
anthropic
DRAINING
warning received 17:11

Codex / Sol
openai
AVAILABLE
62% remaining

Antigravity / Gemini
google
AVAILABLE
74% remaining
```

Seat listing should additionally show:

```text
role
provider
quota status
```

---

## 47. Routing UX

When an automatic handoff occurs:

```text
⚠ claude-reviewer is approaching its usage limit.

Provider:
Anthropic → DRAINING

Current role:
REVIEW

Checkpoint:
✓ workflow state
✓ restore packet
✓ repository state
✓ findings

Evaluating replacements...

gemini-builder
✗ implemented task

sol-reviewer
✓ eligible

Handoff:
claude-reviewer → sol-reviewer
```

---

## 48. Repository Evidence

For implementation and review stages, capture:

```text
base SHA
current SHA
branch
dirty status
changed paths
git diff
test results
build result
lint result
```

OpenRig's existing artifact/evidence mechanisms should be reused where practical.

---

## 49. Completion Authority

An agent does not become authoritative merely because it claims:

```text
done
```

Workflow transitions should remain governed by explicit role outputs.

Example:

```text
IMPLEMENT
agent says complete
       ↓
REVIEW still required
```

Likewise:

```text
REVIEW
pass
       ↓
APPROVAL still required
```

---

## 50. Standard Role Contracts

### Planner

```json
{
  "status": "complete",
  "planRef": "...",
  "acceptanceCriteria": []
}
```

### Verifier

```json
{
  "verdict": "approved",
  "findings": [],
  "requiredChanges": []
}
```

or:

```json
{
  "verdict": "revision_required",
  "requiredChanges": []
}
```

### Implementer

```json
{
  "status": "implemented",
  "changedFiles": [],
  "testsRun": [],
  "knownGaps": []
}
```

### Reviewer

```json
{
  "verdict": "pass",
  "findings": [],
  "verification": []
}
```

or:

```json
{
  "verdict": "changes_required",
  "findings": []
}
```

### Approver

```json
{
  "verdict": "approved",
  "criteriaSatisfied": [],
  "unverified": []
}
```

or:

```json
{
  "verdict": "blocked",
  "blockingReasons": []
}
```

---

## 51. Source Write Permissions

Default roles:

| Role | Source writes |
|---|---:|
| Planner | No |
| Verifier | No |
| Implementer | Yes |
| Reviewer | No |
| Approver | No |

Reviewers may execute safe verification commands but should not silently fix what they discover.

A finding should route back to:

```text
IMPLEMENT
```

---

## 52. Git Safety

Default:

```yaml
git:
  auto_commit: false
  auto_push: false
  auto_merge: false
```

Disallow automatically:

```text
git push --force
git reset --hard
git clean -fd
branch deletion
automatic PR merge
```

unless explicitly configured outside the default policy.

---

## 53. Security Boundary

All of the following are untrusted input:

```text
repository files
retrieved documents
agent messages
agent-generated commands
tool output
handoff summaries
restore-packet text
test output
```

The routing engine must never execute arbitrary commands contained in a handoff.

Routing actions must come from deterministic application logic.

---

## 54. Fail Closed for Billing

If the application cannot determine whether an API credential will override subscription authentication:

```text
DO NOT LAUNCH
```

when:

```yaml
billing.mode: subscription_only
```

The user should receive a concrete reason.

---

## 55. Fail Conservatively for Independence

If role provenance cannot be determined:

```text
reviewer eligibility = false
```

for strict workflows.

Do not assume independence.

---

## 56. Failure Modes

The system must explicitly support:

### Provider quota warning

```text
DRAINING → handoff
```

### Hard quota exhaustion

```text
COOLDOWN → immediate recovery
```

### Provider authentication expiry

```text
AUTH_REQUIRED
```

### Runtime crash

```text
restore packet → replacement seat
```

### OpenRig daemon restart

Use existing persistent workflow/watchdog state.

### Machine sleep

Re-probe providers after wake.

### Missing target provider

Hold work.

### All independent reviewers exhausted

Hold work.

### Antigravity quota parser failure

```text
UNKNOWN
```

not fabricated quota.

### Dirty working tree

Preserve state; do not destructive-reset.

---

## 57. Persistence

Extend OpenRig's existing SQLite schema rather than adding a second database.

Likely entities:

```text
provider_health
provider_health_events
role_executions
routing_decisions
quota_observations
```

Migration must be forward/reversible where OpenRig conventions allow.

---

## 58. Suggested Internal Modules

Conceptual only; actual placement should follow the upstream package organization.

```text
provider-health/
  normalize.ts
  service.ts
  types.ts

providers/
  antigravity/
    runtime.ts
    auth.ts
    quota.ts
    events.ts

routing/
  eligibility.ts
  selector.ts
  constraints.ts
  decisions.ts

billing/
  subscription-policy.ts
  sanitize-env.ts

workflow/
  role-history.ts
  quota-handoff.ts
```

---

## 59. Upstream Compatibility Requirement

Avoid invasive changes to OpenRig core.

Preferred implementation pattern:

```text
new runtime adapter
new provider-health service
workflow metadata extension
queue routing extension
new watchdog policies
```

rather than modifying unrelated core behavior.

---

## 60. Fork Strategy

Initial development may use a fork.

Branch model:

```text
upstream/main
    │
    ▼
fork/main
    │
    ├── feat/antigravity-runtime
    ├── feat/provider-health
    ├── feat/quota-router
    └── feat/role-constraints
```

Keep changes separable enough to upstream individually.

---

## 61. Upstream Candidates

Good candidates for upstream contribution:

```text
Antigravity runtime adapter
generic ProviderHealth type
provider-neutral quota signal interface
role metadata
provider-neutral eligibility hooks
```

Potentially project-specific:

```text
strict subscription-only policy
specific preferred workflow
specific separation-of-duty defaults
```

---

## 62. Phase 0 — OpenRig Audit

Before writing code:

1. pin an exact OpenRig commit
2. map runtime-adapter interfaces
3. map provider signal storage
4. map provider account/binding model
5. map workflow schemas
6. map queue handoff transaction
7. map watchdog implementation
8. map restore packet schema
9. map current database migrations
10. identify lowest-change extension seams

Deliverable:

```text
OPENRIG_EXTENSION_MAP.md
```

Hard stop:

Do not implement until the extension map identifies which existing primitives replace proposed custom code.

---

## 63. Phase 1 — Antigravity Runtime

Implement:

```text
runtime discovery
auth detection
launch
readiness
seat lifecycle
managed environment
session identity
shutdown
```

Success criteria:

```text
rig up
```

can boot:

```text
Claude
Codex
Antigravity
```

in one rig.

---

## 64. Phase 2 — Subscription Guard

Implement:

```text
billing.mode=subscription_only
environment sanitization
Antigravity useG1Credits validation
doctor checks
launch blocking
```

Success criteria:

With fake API credentials present:

```text
managed provider still cannot use API billing
```

or launch is blocked.

---

## 65. Phase 3 — Provider Health

Implement normalized health records.

Start with:

```text
Antigravity quota
Claude provider signals
Codex provider signals
```

Success criteria:

```bash
rig provider quota --json
```

returns all provider states using one schema.

---

## 66. Phase 4 — Role Metadata

Add:

```text
workflow step role
role preference
role history
```

No automatic rerouting yet.

Success criteria:

```bash
rig workflow roles
```

shows who performed each workflow responsibility.

---

## 67. Phase 5 — Eligibility Engine

Implement deterministic filtering.

Tests must prove:

```text
implementer cannot review itself
implementer cannot approve itself
exhausted provider cannot receive work
draining provider cannot receive new work
```

---

## 68. Phase 6 — Hard Quota Failover

Simulate provider exhaustion.

Expected:

```text
LIMIT
 ↓
provider unavailable
 ↓
restore packet
 ↓
transactional handoff
 ↓
replacement
```

No work loss.

---

## 69. Phase 7 — Proactive Drain

Implement low-quota/warning transitions.

Expected:

```text
AVAILABLE
 ↓
DRAINING
 ↓
safe boundary
 ↓
handoff
```

This phase turns limit recovery into limit avoidance.

---

## 70. Phase 8 — Automatic Resume

Implement cooldown watchdogs.

Expected:

```text
no eligible reviewer
 ↓
queue held
 ↓
Claude reset
 ↓
probe
 ↓
Claude available
 ↓
workflow wakes
```

---

## 71. Phase 9 — TUI and Operator UX

Only after routing works reliably:

```text
provider panel
quota state
role history
routing explanation
handoff feed
```

Do not prioritize UI over correctness.

---

## 72. Acceptance Test — Normal Flow

Input:

```text
Implement feature X.
```

Expected:

```text
Sol
PLAN ✓

Claude
VERIFY ✓

Antigravity
IMPLEMENT ✓

Claude
REVIEW ✓

Sol
APPROVE ✓

READY FOR HUMAN
```

---

## 73. Acceptance Test — Claude Soft Limit

During review:

```text
Claude approaching limit
```

Expected:

```text
Claude → DRAINING

finish current safe operation

restore/checkpoint

Claude receives no new task

Sol selected as reviewer

review continues
```

---

## 74. Acceptance Test — Claude Hard Limit

Claude dies during review.

Expected:

```text
Claude → COOLDOWN

No Claude-generated handoff required.

OpenRig reconstructs state.

Sol receives review role.

Workflow continues.
```

---

## 75. Acceptance Test — Implementer Exhausted

Antigravity reaches quota during implementation.

Expected:

```text
Antigravity → COOLDOWN

current repository preserved

replacement implementer selected

role history records:
Gemini + replacement both participated
```

This matters later because neither should automatically qualify as independent reviewer if strict provider independence would be violated.

---

## 76. Acceptance Test — No Independent Reviewer

Scenario:

```text
Gemini implemented
Claude exhausted
Sol implemented fallback portion
```

Available:

```text
Gemini
Sol
```

Expected:

```text
REVIEW HELD
```

not:

```text
Gemini reviews Gemini
```

or:

```text
Sol reviews Sol
```

---

## 77. Acceptance Test — Reset

Claude reset time arrives.

Expected:

```text
provider watchdog fires
 ↓
health re-probe
 ↓
Claude AVAILABLE
 ↓
held review wakes
 ↓
Claude resumes review
```

---

## 78. Acceptance Test — API Key Present

Environment:

```text
ANTHROPIC_API_KEY=...
```

Policy:

```text
subscription_only
```

Expected:

Either:

```text
managed environment strips credential
```

with verifiable subscription authentication,

or:

```text
Claude seat launch blocked
```

Never API billing.

---

## 79. Acceptance Test — Google Credits

Configuration:

```text
useG1Credits=true
```

Policy:

```text
allow_paid_overage=false
```

Expected:

```text
doctor failure
```

and managed seat may not begin until the unsafe configuration is corrected or overridden explicitly.

---

## 80. Acceptance Test — Daemon Restart

Kill OpenRig daemon mid-workflow.

Restart.

Expected:

```text
workflow recovered
queue ownership recovered
role history recovered
provider states re-probed
watchdogs restored
```

No duplicate workflow stage.

---

## 81. Acceptance Test — Machine Sleep

Sleep laptop through provider reset time.

On wake:

```text
do not assume provider available
```

Instead:

```text
re-probe
```

then update state.

---

## 82. Acceptance Test — Unknown Quota

Provider quota endpoint/parser unavailable.

Expected:

```text
state: UNKNOWN
confidence: unknown
```

No invented percentage.

Routing follows configured unknown-provider policy.

---

## 83. Testing Layers

### Unit

Test:

```text
quota normalization
eligibility
constraint resolution
scoring
environment sanitization
health transitions
```

### Integration

Test:

```text
OpenRig queue handoff
workflow projection
restore packet
watchdogs
provider adapters
```

### Failure injection

Simulate:

```text
warning
hard limit
auth expiry
process death
daemon death
quota parser failure
network failure
```

### End-to-end

Run real:

```text
Codex
Claude
Antigravity
```

against a disposable repository.

---

## 84. Logging

Each routing transition should log:

```text
timestamp
workflow instance
step
role
source seat
target seat
provider states
constraints evaluated
reason
restore packet ID
queue item ID
```

Never log:

```text
OAuth tokens
API credentials
session secrets
```

---

## 85. Metrics

Local metrics:

```text
handoffs per workflow
quota-triggered handoffs
hard-limit recoveries
soft-limit recoveries
workflows paused for independence
provider time by role
provider failures
restore success rate
```

No external telemetry requirement.

---

## 86. Success Metrics

### Recovery

```text
≥ 95% simulated provider-limit events resume
without manual reconstruction
```

### Independence

```text
100% strict workflows prevent
implementer self-review/self-approval
```

### Billing safety

```text
0 API fallback events
```

### Context preservation

```text
replacement can identify:
objective
completed work
remaining work
repo state
evidence
```

after every successful handoff.

---

## 87. MVP Definition

MVP requires:

```text
OpenRig base
+
Antigravity runtime
+
subscription-only guard
+
normalized provider health
+
role history
+
eligibility engine
+
hard-limit failover
+
soft draining
+
review independence
+
automatic cooldown wake
```

Not MVP:

```text
web dashboard
complex scoring customization
parallel swarms
remote machines
cloud coordinator
mobile alerts
automatic PR merge
semantic Foreman-style supervision
```

---

## 88. Future — Semantic Supervisor

A later version may add a separate supervision layer inspired by systems such as Foreman/ThruWire.

Possible questions:

```text
Is the implementer stuck?

Is progress meaningful?

Did implementation drift from the plan?

Is verification evidence sufficient?

Is the task actually complete?
```

This is deliberately excluded from V1.

V1 should first make deterministic orchestration reliable.

---

## 89. Future — Additional Harnesses

Provider-neutral design should allow:

```text
OpenCode
Muse
Pi
future coding agents
```

without rewriting quota routing.

A runtime without quota telemetry can simply report:

```text
UNKNOWN
```

until a quota adapter exists.

---

## 90. Future — Multiple Accounts

OpenRig already understands provider accounts and bindings.

Future routing could support:

```text
Claude Account A exhausted
          ↓
Claude Account B eligible
```

but only where doing so is legitimate under the provider's subscription/account rules.

No mechanism should be designed to circumvent provider limits.

---

## 91. Final Architecture

```text
                       USER
                         │
                         ▼
                  OpenRig Workflow
                         │
                      ROLE
                         │
                         ▼
                 Eligibility Engine
                         │
            ┌────────────┼────────────┐
            │            │            │
            ▼            ▼            ▼
        Role History   Quota       Capability
                       Broker        Rules
            │            │            │
            └────────────┼────────────┘
                         │
                         ▼
                    Scheduler
                         │
            ┌────────────┼────────────┐
            ▼            ▼            ▼
         Codex         Claude       Antigravity
          Sol                         Gemini
            │            │            │
            └────────────┼────────────┘
                         │
                         ▼
                 Native subscriptions
                         │
                         ▼
                   OpenRig Queue
                         │
                         ▼
                 Restore / Handoff
                         │
                         ▼
                  Next workflow role
```

---

## 92. Scope Summary

### OpenRig already provides

```text
daemon
SQLite
tmux
seats
topologies
workflow persistence
queue ownership
transactional handoffs
restore packets
watchdogs
provider state
auth profiles
Claude
Codex
```

### We add

```text
Antigravity
quota normalization
subscription enforcement
paid-overage prevention
role history
eligibility engine
separation of duties
quota-driven handoff
automatic cooldown wake
routing explanations
```

---

## 93. Final Product Behavior

Normal:

```text
Sol
 ↓
Claude
 ↓
Gemini
 ↓
Claude
 ↓
Sol
```

Claude limited:

```text
Sol
 ↓
Claude
 ↓
Gemini
 ↓
Claude 🟡
 ↓
checkpoint
 ↓
Sol
```

Gemini limited:

```text
Sol
 ↓
Claude
 ↓
Gemini 🔴
 ↓
restore packet
 ↓
next eligible implementer
```

Nobody independent available:

```text
PAUSE
 ↓
preserve everything
 ↓
watch provider reset
 ↓
resume
```

At no point should the system:

```text
silently use an API key
silently buy credits
discard task state
require the exhausted model to create its own handoff
allow an implementer to approve itself
change workflow requirements simply to stay active
```

---

## 94. Guiding Rule

> **Providers may come and go during a task, but the work, evidence, authority boundaries, and workflow remain intact.**
