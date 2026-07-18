# SPEC — void orchestration gaps (follow-up channel, concurrency, resume, isolation, Copilot OAuth)

Status: approved (scope fixed by two prior audits, user-confirmed 2026-07-17; no clarifying-question
gate for this build). `SPEC.md` remains the whole-product spec; `SPEC-void-subagent-orchestration.md`
is the prior scoped change this one builds directly on top of (its "Out of scope" section explicitly
deferred item 1 below — that deferral is now lifted). This file is scoped to the five gaps below only.

Diff base for this change: commit `f7e9c7b3` (the tip of `main` at the start of this build; the
owner's own in-flight dirty-tree work — Kimi OAuth, orchestrator/harness/TUI touch-ups — stays
uncommitted throughout, is read-only context, and is not part of this change's diff).

Note on process: per standing owner instruction, no worker (including this planner) commits
anything. Every task below lands as uncommitted working-tree changes; `TASKS-autobuild.md` records
the logical commit boundaries and suggested conventional-commit messages so the owner commits them
personally once satisfied.

## Problem

Two independent audits (file:line evidence, re-verified against source while drafting this spec)
found five real gaps in void's already-substantial subagent orchestration (core subagent tool,
markdown agent defs, in-process children via `VoidHarness`, background execution with
`followUp`-delivered completion notifications, `subagent_output` polling, per-agent tool
aliasing/model override, external claude/codex/generic harnesses — all already built and NOT part of
this change):

### 1. No parent-model follow-up channel; subagent-tool children are not human-resumable either

The orchestrating **model** can `subagent` (spawn) and `subagent_output` (poll), but has no way to
send a *second* message into a child that is still running or has already finished with its context
intact. `notifyParent` (`packages/coding-agent/src/core/tools/subagent.ts:182-207`) only pushes one
one-shot completion notification via `session.sendUserMessage(text, { deliverAs: "followUp" })` —
that is the parent session receiving news *from* a finished child, not the model continuing a
conversation *with* one.

The root cause is structural: `createSubagentToolDefinition` always starts a run via
`harnessRunManager.startRun(harnessId, cfg)` with **no `sessionId`** (`subagent.ts:271`, `:287`),
which routes through `Orchestrator.startTaskRun` — a fire-and-forget `TaskRun`, explicitly
**not** a `Session` (`packages/orchestrator/src/orchestrator.ts:238-244`, and see `TASKS.md`'s own
decision: "TaskRuns are process-lifetime, not persisted or resumable"). `HarnessRunManager` already
has everything needed to continue a live conversation — `submitPrompt(sessionId, prompt)`
(`runs.ts:301-312`, itself backed by `Orchestrator.submitSessionPrompt` — queues while a run is live,
resumes via `providerSessionId` when idle) — but the subagent tool never creates a `Session` to call
it against.

This also explains the second half of the gap, the human-resumability side: `getChildComposerRoute`
(`packages/coding-agent/src/modes/interactive/components/child-session-view.ts:43-57`)
unconditionally disables the composer for `kind: "task"` and `kind: "external"` — and every
subagent-tool run, void/claude/codex alike, lands in one of exactly those two kinds. Confirmed by
reading `openChildRun`/`openChildTarget`
(`packages/coding-agent/src/modes/interactive/interactive-mode.ts:2406-2460`): it resolves session
targets exclusively against `getActiveOrchestrationHost().snapshot()` — the **separate**
`ProcessLifetimeOrchestrationHost` `Orchestrator` instance that only `/spawn`/`/agent-resume` use —
never against `harnessRunManager`. A subagent-tool run that *did* get a `HarnessRunManager` Session
would still fall through to `kind: "external"` today, because nothing teaches `openChildTarget` to
look there. `SPEC-void-subagent-orchestration.md`'s "Out of scope" section named this exact
cross-cutting fix and deferred it ("Needs its own scoped design if a human wants it"); this build is
that scoped design.

### 2. Unbounded background subagent fan-out

`Orchestrator.startTaskRun` (`orchestrator.ts:238`) starts its Provider immediately, no gate. The
only existing cap anywhere near this path, `CHILD_CAP = 32` in
`packages/coding-agent/src/core/harness/void.ts:197`, bounds how many **live, resumable** void
children stay retained in memory for future resume — it does not throttle how many can be *running
concurrently* right now, and it says nothing about claude/codex/generic harness fan-out at all. A
model that calls `subagent` with `run_in_background: true` in a loop can start unbounded concurrent
child processes/sessions.

### 3. No session-file resume — process restart loses every child

`VoidHarness.resolveSession` (`void.ts:136-154`) resolves a resume exclusively against
`this.children`, a live in-memory `Map<providerSessionId, AgentSession>`. An unknown id — including
one from a child that spawned in a previous process (restart) or was LRU-evicted past `CHILD_CAP` —
fails as data ("void: unknown or dead child session"). The code's own `ponytail:` comment
(`void.ts:43-54`) already names the upgrade path: respawn from the child's persisted session file.
That file already exists and needs no new persistence format — `spawnVoidChild` in `sdk.ts:285-309`
calls `createAgentSession` for every child with **no explicit `sessionManager`**, so it defaults to
`SessionManager.create(cwd, getDefaultSessionDir(cwd, agentDir))` (`sdk.ts:201`) — the exact same
on-disk session-file mechanism a normal top-level session uses, keyed by that child's own
`sessionManager.getSessionId()` (which, per `TASKS.md`'s own decision, doubles as the orchestration
`providerSessionId`). `SessionManager.open(path, sessionDir?, cwdOverride?)`
(`session-manager.ts:1275`) is the existing "load a session file by id and replay its entries" seam
already used elsewhere for `/resume`-style flows — nothing new needs inventing, just wiring.

### 4. No per-child cwd isolation

Every child, void or external harness, spawns with `cwd: opts.cwd` — the parent's own working
directory (`subagent.ts:272`, `:289`). Two children editing the same repo concurrently (the exact
scenario the new concurrency gate in gap 2 makes more likely, not less) can collide on the same
files with no isolation option at all.

### 5. GitHub Copilot OAuth is implemented but unreachable from `/login`

`packages/ai/src/utils/oauth/index.ts` exports `githubCopilotOAuthProvider` (from
`./github-copilot.js`, itself fully implemented) but never adds it to the `BUILT_IN_OAUTH_PROVIDERS`
array (`index.ts:51-57`), which currently lists `anthropicOAuthProvider, openaiCodexOAuthProvider,
geminiCliOAuthProvider, antigravityOAuthProvider, kimiCodingOAuthProvider` — five entries, Copilot
missing from all of them. `getOAuthProvider("github-copilot")` and therefore `/login` can never
offer it. A one-line registration fix.

Out of scope for all five (per owner instruction): porting xAI/Radius OAuth from `pi`, keychain
storage work, any new OAuth provider beyond registering the already-implemented Copilot flow.

## Approved approach

### Part 1 — Parent-model follow-up channel + human-resumable subagent children (the big one)

Split into two dependent slices so the harder backend primitive and the more mechanical UI wiring
can be reviewed and tested independently.

**1A — Backend primitive: session-backed subagent spawns + a `subagent_send` tool.**

- Give the subagent tool an opt-in **session-backed** spawn path: when a caller wants to keep
  talking to a child (see the new tool below), spawn it via
  `harnessRunManager.newSession(harnessId)` then `harnessRunManager.startRun(harnessId, cfg,
  sessionId)` instead of the current sessionless `startRun(harnessId, cfg)`. Store the resulting
  `sessionId` on `SubagentRunRecord` (`subagent.ts:27-40`) alongside the existing `harnessRunId` —
  every run keeps a `harnessRunId`; only ones spawned through this path also get a `sessionId`.
  Keep the existing sessionless path available for genuinely fire-and-forget calls (no behavior
  change for callers that never touch the new tool) — the implementer decides whether "session-backed
  by default" or "session-backed only when needed" is the shorter diff; either is acceptable as long
  as `subagent_send` (below) only ever needs a `sessionId`-bearing record to act on.
- New tool, **`subagent_send`** (or `subagent_message` — name it clearly, this is the SendMessage-style
  primitive named in the brief): parameters `{ id: string, message: string }` where `id` is the run id
  returned by `subagent`. Looks up the `SubagentRunRecord`, requires it to have a `sessionId` (error
  otherwise — "this run cannot receive follow-up messages" — a plain, catchable tool error, not a
  crash), and calls `harnessRunManager.submitPrompt(sessionId, message)`. That call already does the
  right thing per `runs.ts:301-312`/`Orchestrator.submitSessionPrompt`: queues the message (FIFO) if a
  run is still live, or starts a fresh run resuming the harness's own conversation
  (`providerSessionId`) if the child is idle. Reject (clear tool error) if the harness for that
  session is not resumable (mirrors `getChildComposerRoute`'s existing `"generic providers are not
  resumable"` check) — that rejection is data returned to the model, not a thrown exception that
  kills the parent turn.
- **Regression discipline, not new work**: this must not weaken any of the three parent/child bridge
  guarantees `TASKS.md` already recorded as closed for the `/spawn` path (exactly one parent
  completion notification per child, session-switch routes a background completion to the
  *original* parent, reload restores rather than duplicates). Extend the same discipline to
  `subagent`/`subagent_send`: a child that receives a `subagent_send` follow-up and later completes
  again must still notify the parent exactly once for *that* run of the FIFO turn, not once per
  queued message and not zero times. Write this as an explicit test, not an assumption.
- Depth/registry bookkeeping: reuse the existing `MAX_SUBAGENT_DEPTH` guard and `SubagentRegistry`
  exactly as they exist; `subagent_send` is a new tool alongside `subagent`/`subagent_output`, wired
  into `sdk.ts` the same way (new `initialActiveToolNames` entry, new `createSubagentSendToolDefinition`
  factory parallel to the existing two).

**1B — UI unification: make subagent-tool children human-resumable, not just model-resumable.**

Depends on 1A landing first (needs a `sessionId`-bearing subagent run to point at). This slice is
implementation of an *existing, fully-specified* interaction pattern extended to a new data source —
not new visual design, so it does not need a fresh Opus/Fable design pass (see "UI design pass"
below for the explicit reasoning).

- `openChildTarget`/`openChildRun` (`interactive-mode.ts:2406-2460`) must also resolve a target id
  against `harnessRunManager.session(id)` when `getActiveOrchestrationHost().snapshot()` doesn't have
  it, and mount a resumable child view for it — mirroring, not reinventing, the existing `kind:
  "session"` branch's states (running/queue/resume/disabled-for-generic).
- `ChildSessionView`/`ChildSessionTarget` (`child-session-view.ts:14-57`) needs a way to represent a
  `HarnessRunManager`-backed session alongside the existing `ProcessLifetimeOrchestrationHost`-backed
  one. The two differ only in which object owns `resume`/`cancel`/`removeQueuedPrompt`/`subscribe`
  (`host.resume(...)` at `child-session-view.ts:291` vs. the `harnessRunManager` equivalents
  `submitPrompt`/`cancel`/none-yet-for-queue-drop/`subscribe`). Prefer the smallest change that
  reuses `getChildComposerRoute`'s existing queue/resume/disabled decision logic verbatim (it already
  reads `providerType`/`run.state`/`session.providerSessionId` generically) — either a new
  `ChildSessionTarget` variant that carries the same shape as `kind: "session"` plus which backing
  store it points at, or a tiny shared interface with two implementations. Do not build a general
  "any backing store" abstraction beyond what these two call sites need — two implementers is not
  a speculative-abstraction case, but don't over-generalize past exactly those two either.
- Sidebar/`/agents` overlay: a subagent-tool run with a `sessionId` should be enterable the same way
  a `/spawn` child already is. Reuse `AgentRunSummary`/`collectAgentRuns` (already aggregate both
  sources per `TASKS.md`'s V015 note) — the origin classification (`origin === "session"` vs. the
  existing `subagent`/`harness` origins) is what `openChildRun` branches on, so extending that
  branch is the actual fix, not a new aggregation path.
- Composer behavior once wired: identical to the existing `kind: "session"` rules — queue while
  running, resume when idle and a `providerSessionId` is known, disabled with a clear reason for a
  non-resumable harness (generic) or a run with no `sessionId` at all (still a plain sessionless
  `TaskRun`, e.g. anything spawned before this change or intentionally fire-and-forget).

### Part 2 — Concurrency cap on background subagent fan-out

- Add a run-slot limit scoped to **subagent-tool** background starts specifically (not a
  global change to `Orchestrator.startTaskRun`, which other callers — e.g. `/run` — also use and
  which this spec does not touch). The natural seam is inside `createSubagentToolDefinition`
  (`subagent.ts:233-345`): before calling `harnessRunManager.startRun(...)` for a
  `run_in_background: true` call, check a small in-memory counter/semaphore of currently-running
  subagent-tool runs; if at the cap, hold the call in a FIFO queue and start it once a slot frees
  (a run's `waitForHarnessRun`/registry `finish` completion is already the exact signal to drain the
  next queued start). Foreground (blocking) `subagent` calls may reasonably share the same slot
  accounting (they already block the parent turn, so unbounded foreground fan-out isn't the actual
  problem this gap describes, but a shared counter is simpler than two separate ones — implementer's
  call, state which).
- Default cap: a small number in the 4–8 range (pick one, e.g. 6, and say why in the commit/report),
  **configurable** — add it to the existing `orchestrator` settings key introduced by `TASKS.md`'s
  V011 (`packages/coding-agent/src/core/settings-manager.ts` + its resolver module) rather than
  hardcoding it; read that module first to match its existing validation/diagnostics conventions
  before adding a field.
- A queued-but-not-yet-started background subagent call should still return its `backgroundResult`
  text immediately (per the existing tool contract) — just note in that text that it may be queued
  behind the concurrency cap, so the model doesn't assume it's already running.

### Part 3 — Session-file resume

- Give `SpawnVoidChild` (`subagent.ts:130-134`) a second mode: resuming a specific persisted session
  by id, not just spawning fresh. The natural shape is an optional `resumeSessionId` field on its
  config, handled in `sdk.ts`'s `spawnVoidChild` implementation (`sdk.ts:285-309`) by passing
  `sessionManager: SessionManager.open(pathForId(resumeSessionId), sessionDir, cwd)` into
  `createAgentSession` instead of letting it default to `SessionManager.create(...)`. Compute the
  session file path the same way `getDefaultSessionDir`/`SessionManager.create` already do — do not
  invent a second path convention.
- In `VoidHarness.resolveSession` (`void.ts:136-154`), when `cfg.providerSessionId` is set but not
  found in `this.children` (today's unconditional failure path), attempt the session-file resume
  before giving up: call the new `spawnVoidChild({ resumeSessionId: cfg.providerSessionId, ... })`
  variant, and only fall through to the existing "unknown or dead child session" failure-as-data
  result if that also finds nothing (id truly never existed, or its session file is missing/corrupt
  — reuse `SessionManager`'s own existing corrupt-file tolerance, don't add a second one). A
  successfully respawned session goes back into `this.children` (and through `touch`/LRU accounting)
  exactly like a fresh spawn.
- Update the `ponytail:` comment at `void.ts:43-54` once this lands — it currently documents this as
  future work; either remove it or rewrite it to describe the new, smaller remaining ceiling (if
  any — e.g. still bounded by `CHILD_CAP` in memory, but no longer bounded by process lifetime).
- This directly serves gap-1's human-resumability slice too: a resumed child (session-file or
  in-memory) must look identical to the UI/`subagent_send` seam either way — resume should be
  transparent to callers above `VoidHarness`.

### Part 4 — Opt-in per-child worktree isolation

- New opt-in switch, `isolation: "worktree"`, settable two ways (implementer's call which is
  cleaner, or both): as a new frontmatter field on markdown agent defs (`AgentFrontmatter` in
  `packages/coding-agent/src/core/agents.ts`, parsed alongside the existing `harness`/`model`/`tools`
  fields) and/or as a param on the `subagent` tool's own schema (`subagentSchema`,
  `subagent.ts:220-229`). Default: unset/off — no behavior change for existing callers.
- When set, before spawning: create a git worktree via `git worktree add <path> <ref>` (argv array
  through `Bun.spawn`, matching this repo's existing "external commands always use argv arrays, no
  shell" convention per `TASKS.md`'s decisions) rooted at a scratch location under the agent dir
  (e.g. `<agentDir>/worktrees/<runId>`), and pass that path as the child's `cwd` instead of the
  parent's. Ref defaults to the parent's current `HEAD`.
- Lifecycle cleanup: after the run reaches a terminal state, inspect the worktree for uncommitted
  changes (`git status --porcelain`). If clean (no diff — the child made no changes, or committed
  everything itself), remove the worktree (`git worktree remove`). If dirty, leave it and surface its
  path in the tool's result text so the model/human can inspect or manually clean up — never silently
  discard a child's uncommitted work. This mirrors the "safe cleanup" pattern already established
  elsewhere in this codebase for `TaskRun`s (process-lifetime, cleaned up on close, but never at the
  cost of losing data).
- Not required: a full pool/reuse mechanism for worktrees, or automatic conflict resolution between
  concurrent worktrees on the same ref. One worktree per opted-in child, created fresh and either
  cleaned up or left behind — nothing more.

### Part 5 — Register GitHub Copilot OAuth (one-liner)

- `packages/ai/src/utils/oauth/index.ts`: import `githubCopilotOAuthProvider` (already imported for
  re-export at line 17 — add the value import alongside the other providers already imported at
  lines 44-48) and add it to the `BUILT_IN_OAUTH_PROVIDERS` array (line 51-57). That is the entire
  functional change; `getOAuthProvider`/`getOAuthProviders`/`/login` pick it up automatically since
  they all read from this one array.
- One regression test: `getOAuthProvider("github-copilot")` (or whatever `githubCopilotOAuthProvider.id`
  actually is — check it) returns a defined provider, and `getOAuthProviders()`'s list includes it.

## UI design pass — explicit reasoning for skipping a fresh Opus/Fable brief

Per the interface-design-pass rule, this is stated plainly rather than silently skipped: the only
user-facing surface touched by this build is Part 1B (composer enablement for subagent-tool children)
and, incidentally, whatever text `subagent`/`subagent_send`/the worktree tool return (plain tool
output text, not a rendered UI). Part 1B does not invent any new layout, color, interaction state, or
component — it extends `getChildComposerRoute`'s already-fully-specified queue/resume/disabled states
(built for `/spawn` children, `DESIGN.md` §3A, and implemented in `child-session-view.ts`) to a second
backing data source. There is no new visual surface for Opus/Fable to design. Workers implementing
Part 1B are pointed directly at the existing `kind: "session"` branch and `getChildComposerRoute` as
their pattern to mirror, not to redesign.

## Testing

- **1A**: unit tests for the session-backed spawn path (a `subagent` call that later succeeds via
  `subagent_send`), `subagent_send` against a running child (queues), against an idle/done resumable
  child (resumes via `providerSessionId`), against a non-resumable (generic) harness (clear rejection),
  and against an unknown/sessionless run id (clear rejection). One test proving exactly-one-parent-
  notification holds across a spawn → `subagent_send` → second completion sequence.
- **1B**: extend `packages/coding-agent/test/orchestration-ui-interactions.test.ts` (already the
  seam `SPEC-void-subagent-orchestration.md` used for this exact kind of coverage) with a subagent-tool
  child that has a `sessionId`: entering it produces a resumable composer (queue while running, resume
  once idle), not the old permanently-disabled state.
- **Part 2**: unit tests proving a background subagent past the cap is held and started once a slot
  frees (FIFO order), and that the cap is read from settings, not hardcoded.
- **Part 3**: unit tests for `VoidHarness` resume: live child (existing behavior, unchanged), evicted/
  restarted child with a valid session file (now succeeds via respawn), and a truly unknown id
  (still fails as data, unchanged).
- **Part 4**: unit tests for worktree creation with the right ref/cwd, cleanup-on-clean, preserve-on-
  dirty, and the opt-in default-off behavior (no worktree unless requested).
- **Part 5**: the one-liner registry test described above.
- Check `packages/coding-agent/test/subagent-tool.test.ts`, `test/harness-run-manager.test.ts`, and
  `test/harness-void.test.ts` for existing fakes/mocks before writing new ones — this repo has already
  built the scaffolding this change needs (`TASKS.md`'s own convention).

## Done means

- `bun run check` (biome + tsgo --noEmit) green from repo root, full output.
- Full test suite green: `./test.sh` and/or each package's own test command, per `TASKS.md`'s
  documented per-package commands (`packages/orchestrator`, `packages/coding-agent`,
  `packages/ai`, `packages/tui`).
- A parent model can spawn a subagent, later send it a follow-up message via `subagent_send` with
  its context intact, and a human can enter that same child from the Sidebar/`/agents` overlay and
  type a follow-up themselves.
- Background subagent fan-out is bounded and configurable; queued starts are visible as such.
- A void child survives process restart: resuming its `providerSessionId` after restart succeeds via
  session-file respawn instead of failing as "unknown or dead."
- An agent def or `subagent` call with `isolation: "worktree"` gets an isolated git worktree as its
  `cwd`; the worktree is cleaned up automatically only when left clean, never when dirty.
- `githubCopilotOAuthProvider` is reachable via `getOAuthProvider`/`/login`.
- None of the pre-existing parent/child bridge guarantees (`TASKS.md` V014/V018) regress: still
  exactly one parent notification per child run, still correct session-switch routing, still no
  duplicate entries on reload.

## Out of scope

- Porting xAI/Radius OAuth, keychain credential storage, any OAuth provider beyond Copilot.
- A general "any orchestrator backing store" UI abstraction beyond what Part 1B's two call sites need.
- Worktree pooling/reuse, or automatic multi-worktree conflict resolution.
- Changing `Orchestrator.startTaskRun`'s behavior for non-subagent-tool callers (e.g. `/run`).
- Any new visual design, color, or layout — see "UI design pass" above.
