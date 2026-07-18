# void orchestration-gaps build map

## Destination

Close five confirmed gaps in void's subagent orchestration — parent-model follow-up channel +
human-resumable subagent children, bounded background fan-out, session-file child resume, opt-in
per-child git worktree isolation, and GitHub Copilot OAuth registration — per
`SPEC-void-orchestration-gaps.md`, with `bun run check` and the full test suite green.

## Standing instructions

- Specification: `SPEC-void-orchestration-gaps.md`. Prior related spec (context only, already
  implemented): `SPEC-void-subagent-orchestration.md`. Product spec: `SPEC.md`.
- **No worker commits anything, ever.** Leave all changes as uncommitted working-tree edits. The
  owner commits personally; this file records the intended commit boundaries (see "Commit plan"
  at the bottom) so they can do that in one pass.
- Diff base for review/verification: commit `f7e9c7b3`. The owner's own in-flight dirty-tree
  changes (Kimi OAuth, orchestrator/harness/TUI touch-ups) are pre-existing, uncommitted, and not
  part of this build's diff — do not revert, stash, or commit them; treat them as read-only
  background state that happens to already be in the working tree.
- Workers do not delegate further. They modify only their task's declared write set, disclose
  deviations, and run their task's focused tests plus `bun run check` when the whole workspace is
  expected to compile.
- If two tasks run in parallel, their declared write sets must not overlap. `subagent.ts` is a
  hotspot touched by four of the five gaps — the execution waves below serialize every task that
  touches it into one dependency chain for exactly that reason; only genuinely disjoint-file tasks
  run in parallel.
- Never run real provider APIs or spend paid tokens. Use existing fakes/mocks
  (`packages/coding-agent/test/subagent-tool.test.ts`, `test/harness-run-manager.test.ts`,
  `test/harness-void.test.ts`, orchestrator's mock Provider) before writing new ones.
- Ponytail (full intensity) governs every code-writing task here: question whether code needs to
  exist at all, reuse before adding, stdlib/existing-pattern before a new dependency, shortest
  working diff. Never simplify away input validation, error handling that prevents data loss, or
  the parent/child bridge correctness guarantees named below.
- Preserve the closed-out correctness guarantees from the repo's own `TASKS.md` (V014/V018): exactly
  one parent completion notification per child run, correct session-switch routing, no duplicate
  entries on reload. Any task touching the subagent/harness bridge must not regress these — write a
  test proving it, don't just assume it.

## Decisions so far

- (planning) Diff base fixed at `f7e9c7b3` per owner amendment; the in-flight Kimi OAuth/orchestrator
  dirty-tree work is pre-existing context, left uncommitted and untouched throughout this build.
- (planning) Part 1 (follow-up channel + UI unification) is split into 1A (backend primitive) and
  1B (UI wiring), with 1B depending on 1A — 1A is the architecturally significant half; 1B is a
  mechanical extension of the already-fully-specified `kind: "session"` composer pattern to a second
  backing store, not new visual design, so it skips a fresh Opus/Fable design pass (reasoning
  recorded in `SPEC-void-orchestration-gaps.md`'s "UI design pass" section).
- (planning) `subagent.ts` is touched by Parts 1A, 2 (wiring), 3 (type only), and 4 (wiring) — these
  four are serialized into one dependency chain (waves 2a-2d below) rather than parallelized, exactly
  matching this repo's own `TASKS.md` convention for hotspot files (see its V008→V009 precedent).
  Parts 4's low-level git-worktree mechanics and 2's settings field are pulled out into their own
  standalone-file wave-1 tasks specifically so only the *wiring* into `subagent.ts` needs to serialize,
  not the underlying logic.
- G5 (Haiku) done: `packages/ai/src/utils/oauth/index.ts` imports `githubCopilotOAuthProvider` as a
  value and adds it to `BUILT_IN_OAUTH_PROVIDERS`; new test `packages/ai/test/oauth-registry.test.ts`
  (2 passed); `bun run check` no new failures.
- G4-lib (Sonnet) done: new `packages/coding-agent/src/core/worktree.ts` (`worktreePath`,
  `createWorktree`, `isWorktreeClean`, `removeWorktree`, `cleanupWorktree` check-then-remove
  convenience) using `Bun.spawn` argv arrays mirroring `process.ts`'s pattern, no orchestrator
  Adapter machinery (one-shot git commands, not streaming). 7/7 real-git-repo tests pass via `bun
  test` (not vitest — see follow-up below). **Follow-up folded into G4-wire**: this repo's vitest
  runs under Node where `globalThis.Bun` is undefined (same reason `harness-proc.test.ts`/
  `harness-glue.test.ts` are already carved out of vitest and run via `bun test` in
  `packages/coding-agent/package.json`'s script) — `worktree.test.ts` needs the same carve-out
  addition to that script; G4-wire must add it, not just trust it runs standalone.
- G2-config (Sonnet) done: field named `maxConcurrentSubagents`, default `6`. New
  `resolveMaxConcurrentSubagents()` in `packages/coding-agent/src/core/orchestrator-config.ts`
  (positive-integer validation, diagnostic + default fallback on invalid, never throws); that field
  is stripped before handing the raw `orchestrator` settings object to `@void/orchestrator`'s
  `parseSettings` (its `CONFIG_FIELDS` set doesn't know this field and would otherwise reject it as
  unknown) — `@void/orchestrator` package itself untouched. `SettingsManager.getMaxConcurrentSubagents()`
  getter added to `settings-manager.ts`. 20/20 focused tests, 49/49 full settings/orchestrator suite,
  `bun run check` exit 0. G2-wire must call `settingsManager.getMaxConcurrentSubagents()` for its cap.
- Wave 1 complete (G5, G4-lib, G2-config all done, disjoint diffs confirmed by each worker via
  `git status`/`git diff --stat`). Proceeding to the wave-2 serial `subagent.ts` chain: G3 dispatched
  next.
- G3 (Sonnet) done: `resumeSessionId?: string` added to `SpawnVoidChild`'s config type (subagent.ts,
  type-only); `sdk.ts`'s `spawnVoidChild` resolves it to a session file via `getDefaultSessionDir` +
  filename match (same convention `SessionManager.create`/`forkFrom` use) and passes
  `SessionManager.open(...)` into `createAgentSession` instead of a fresh `SessionManager.create`;
  `VoidHarness.resolveSession` (void.ts) now attempts this respawn before failing on a
  `this.children` miss, reusing a new shared `registerChild` helper for LRU/touch accounting; the
  `ponytail:` comment was rewritten (not deleted) to describe the smaller remaining ceiling
  (CHILD_CAP still bounds live memory, no longer bounded by process lifetime). 16/16 focused tests
  (`harness-void.test.ts` + new `void-resume-session-file.test.ts`, the latter proving the
  respawned session's transcript survives, not just "didn't fail"). `bun run check` clean. Full
  `packages/coding-agent` suite: 1184 passed, 7 failed — all 7 confirmed pre-existing in
  `test/worktree.test.ts` (G4-lib's `bun`-only test, not runnable under this package's default
  vitest runner — the flagged follow-up above), not caused by G3. Proceeding to G1A.
- G1A model fallback: `codex exec --model gpt-5.6-sol` hit its usage limit (resets 2026-07-23,
  confirmed via a live model-availability check, not assumed). Per this file's own G1A row and the
  autobuild skill's stated fallback, routing G1A to native Claude Opus instead of Sol — not silently
  substituting a different Codex model, and not stalling the build on a multi-day wait.
- G1A (Opus) done: every subagent spawn (fg+bg, void+external) is now session-backed — chosen
  "always" over opt-in as the shorter correct diff, since human-resumability (1B) needs it uniformly
  anyway. Judgment call found and fixed: the spec's literal `newSession`+`startRun(_,cfg,sessionId)`
  recipe drops `cwd`/`workdir` and void's out-of-band spawn token, because
  `Orchestrator.reserveSessionRun` rebuilds run config from session fields only — fixed at the
  coding-agent layer (`newSession(harnessId, {workdir?, providerSessionId?})` in `runs.ts`; new
  `VoidHarness.spawnChild` for eager/resume-from-birth void spawns) rather than touching
  `@void/orchestrator` (left frozen, per spec's explicit boundary). New `subagent_send` tool
  (`{id, message}`) in `subagent.ts`, wired into `sdk.ts` alongside the existing two subagent tools.
  Exactly-once-notification regression traced and fixed: replaced the old single-run
  `waitForHarnessRun` background waiter with a per-session subscriber deduped by runId (the old one
  would have dropped a `subagent_send`-triggered follow-up run's notification entirely). 39/39
  focused tests (new `subagent-send.test.ts` 6/6 including the exactly-once proof), full
  `packages/coding-agent` suite 1190 passed / 7 known-pre-existing `worktree.test.ts` failures
  (G4-lib's `bun`-only test under vitest — same follow-up as before, not new). `bun run check`
  clean. `VoidHarness.prepareSpawn`/token path left in place (now unused by the subagent tool,
  still exercised by its own tests) rather than deleted — flag for G-VERIFY to check this isn't dead
  weight worth trimming. Proceeding to G2-wire, then G4-wire (both depend on G1A and each other via
  the `subagent.ts` chain).
- G2-wire (Sonnet) done: separate (not shared) foreground/background slot counters — foreground
  already blocks the turn so it can't itself unbounded-fan-out, and it's the smaller diff. FIFO
  queue/counter live in closure state inside `createSubagentToolDefinition`; at-cap calls register a
  placeholder record immediately (pollable via `subagent_output`), return `backgroundResult(...,
  queued: true)` with a "may be queued" note, and a deferred continuation drains via the existing
  `waitForHarnessRun(...).finally(release)` signal — no second completion detector built. Cap is
  re-read fresh on every acquire (`ponytail:` comment flags this — a raised cap doesn't retroactively
  help already-parked calls). `sdk.ts` threads `settingsManager` into subagent tool options (one
  line). 47/47 focused tests (3 new: FIFO order under a controllable gated mock harness, cap=1
  drain-one-at-a-time, cap-value-from-settings-drives-behavior proof). Full suite 1193 passed / same
  7 known-pre-existing `worktree.test.ts` failures. `bun run check` clean (fixed two type errors
  surfaced by the stricter `SubagentToolOptions` shape along the way, not worked around). Proceeding
  to G4-wire.

## Execution waves

1. **Independent library/config pieces (parallel, disjoint files):** G5 (Copilot OAuth), G4-lib
   (worktree git helper module), G2-config (concurrency-cap settings field). No shared files, no
   dependencies among them.
2. **Serial chain on `subagent.ts`** (each depends on the previous landing and passing its tests):
   G3 (session-file resume) → G1A (follow-up channel backend primitive) → G2-wire (concurrency cap
   wiring, depends on G2-config from wave 1) → G4-wire (worktree wiring, depends on G4-lib from
   wave 1).
3. **UI unification:** G1B, depends on G1A (needs a `sessionId`-bearing subagent run to point at).
   Touches `interactive-mode.ts`/`child-session-view.ts`/`agent-runs.ts` — disjoint from the wave-2
   chain's files, but ordered after it since it depends on G1A's data shape.
4. **Verification gate:** review lenses, `feature-finalizer`, `ponytail:ponytail-review`,
   `mp-standards-spec-review`, design-drift check on G1B against the existing composer pattern, full
   `bun run check` + test suite, fix → re-verify loop (cap 3).

## Ordered tasks

### G5 — Register GitHub Copilot OAuth

- **Executor:** Haiku
- **Depends on:** none
- **Status:** frontier
- **Description:** Import `githubCopilotOAuthProvider` as a value (not just the existing re-export)
  in `packages/ai/src/utils/oauth/index.ts` and add it to `BUILT_IN_OAUTH_PROVIDERS`
  (currently `[anthropicOAuthProvider, openaiCodexOAuthProvider, geminiCliOAuthProvider,
  antigravityOAuthProvider, kimiCodingOAuthProvider]`, lines 51-57). Check
  `githubCopilotOAuthProvider.id`'s actual value before writing the test assertion.
- **Files/areas:** `packages/ai/src/utils/oauth/index.ts`; one new/extended test file under
  `packages/ai/test/`.
- **Acceptance:** a focused test proves `getOAuthProvider(<copilot id>)` returns a defined provider
  and `getOAuthProviders()` includes it; `bun run check` stays green for `packages/ai`.

### G4-lib — Git worktree helper module

- **Executor:** Sonnet
- **Depends on:** none
- **Status:** frontier
- **Description:** New standalone module implementing the git-worktree mechanics Part 4 needs:
  create a worktree (`git worktree add <path> <ref>` via `Bun.spawn` argv array, no shell — match
  this repo's existing external-command convention), default ref = current `HEAD`; check whether a
  worktree path is clean (`git status --porcelain`); remove a clean worktree
  (`git worktree remove`). Pure library code — no wiring into `subagent.ts` yet (that's G4-wire).
  Scratch location convention: under `<agentDir>/worktrees/<runId>`.
- **Files/areas:** new file, e.g. `packages/coding-agent/src/core/worktree.ts`; its own focused test
  file.
- **Acceptance:** focused tests pass for create-with-default-ref, create-with-explicit-ref,
  clean-detection true/false, remove-when-clean, and refuse-to-remove-when-dirty (returns the dirty
  path instead of deleting anything). No changes to any other file.

### G2-config — Concurrency-cap settings field

- **Executor:** Sonnet
- **Depends on:** none
- **Status:** frontier
- **Description:** Read `packages/coding-agent/src/core/settings-manager.ts` and its `orchestrator`
  settings key / resolver module (added by this repo's own prior `TASKS.md` V011) first, to match its
  existing validation/diagnostics conventions. Add a `maxConcurrentSubagents` (or equally clear name)
  field, default in the 4-8 range (pick one, state why), with the same invalid-value-is-a-diagnostic-
  not-a-crash behavior the existing fields already have. Expose a simple getter the subagent tool
  layer can read (no `subagent.ts` changes here — that's G2-wire).
  **Deferred UI thread**: implementers of this piece do not consume Codex; use native Claude tools
  only, since this task never shells out to Codex or another CLI.
- **Files/areas:** `packages/coding-agent/src/core/settings-manager.ts`; its orchestrator config/
  resolver module; focused settings/resolver tests.
- **Acceptance:** focused tests cover missing-config default, invalid-value diagnostic (not a
  rewrite/crash), and the new getter surfacing the resolved value; existing settings tests still pass.

### G3 — Session-file resume for void children

- **Executor:** Sonnet
- **Depends on:** G5, G4-lib, G2-config landing is not required (disjoint files) but this is first
  in the `subagent.ts` chain by convention — start once wave 1 is dispatched.
- **Status:** blocked (waits for wave 1 to be dispatched so its `subagent.ts` slice starts from a
  known-clean base; no actual file dependency)
- **Description:** Implement `SPEC-void-orchestration-gaps.md` Part 3. Give `SpawnVoidChild`
  (`packages/coding-agent/src/core/tools/subagent.ts:130-134`) an optional `resumeSessionId` field.
  In `sdk.ts`'s `spawnVoidChild` implementation (`sdk.ts:285-309`), when that field is set, resolve
  the session file path the same way `SessionManager.create`/`getDefaultSessionDir` already do, and
  pass `sessionManager: SessionManager.open(path, sessionDir, cwd)` into `createAgentSession` instead
  of letting it default to a fresh `SessionManager.create(...)`. In `VoidHarness.resolveSession`
  (`void.ts:136-154`), when `cfg.providerSessionId` is set but missing from `this.children`, attempt
  this resume path before falling back to today's "unknown or dead child session" failure; a
  successfully respawned session re-enters `this.children` via the existing `touch`/LRU accounting
  exactly like a fresh spawn. Reuse `SessionManager`'s own corrupt-file tolerance; do not add a
  second one. Update or remove the `ponytail:` comment at `void.ts:43-54` once this lands (it
  currently documents this as future work).
- **Files/areas:** `packages/coding-agent/src/core/harness/void.ts`; `packages/coding-agent/src/core/sdk.ts`;
  the `SpawnVoidChild` type in `packages/coding-agent/src/core/tools/subagent.ts` (type-only addition,
  no logic changes to the rest of that file); focused tests in
  `packages/coding-agent/test/harness-void.test.ts` and/or a new resume-specific test file.
- **Acceptance:** focused tests pass for: live-child resume (existing behavior, unchanged),
  evicted-or-restarted child with a valid session file (now succeeds via respawn, and the respawned
  session preserves prior transcript), and a truly-unknown id (still fails as data, unchanged
  message). `bun run check` green.

### G1A — Parent-model follow-up channel: session-backed subagent spawns + `subagent_send`

- **Executor:** GPT-5.6 Sol via `~/.claude/skills/claude-to-codex/SKILL.md` (`workspace-write`
  sandbox); Opus fallback only if Codex is unavailable when this task is dispatched.
- **Depends on:** G3 (serialized on `subagent.ts`/`void.ts` — read G3's landed diff first so this
  doesn't clobber its `SpawnVoidChild`/`VoidHarness` changes)
- **Status:** blocked
- **Description:** Implement `SPEC-void-orchestration-gaps.md` Part 1A in full. Give the subagent
  tool a session-backed spawn path: `harnessRunManager.newSession(harnessId)` then
  `startRun(harnessId, cfg, sessionId)` instead of today's sessionless `startRun(harnessId, cfg)`
  (`subagent.ts:271`, `:287`). Store the resulting `sessionId` on `SubagentRunRecord` alongside the
  existing `harnessRunId`. Add a new tool, `subagent_send` (params: `{ id: string, message: string }`),
  parallel to the existing `createSubagentToolDefinition`/`createSubagentOutputToolDefinition`
  factories, wired into `sdk.ts` the same way (new `initialActiveToolNames` entry). It must: require
  the target run to have a `sessionId` (clear tool-error otherwise, not a crash); call
  `harnessRunManager.submitPrompt(sessionId, message)`, which already queues if live or resumes via
  `providerSessionId` if idle; reject clearly for a non-resumable (generic) harness, mirroring
  `getChildComposerRoute`'s existing `"generic providers are not resumable"` message.
  **Regression discipline**: write a test proving a spawn → `subagent_send` → second-completion
  sequence still notifies the parent exactly once for that run, per the existing (already-closed)
  parent/child bridge guarantee this repo's `TASKS.md` recorded for the `/spawn` path — do not let
  the new send path duplicate or drop that notification.
- **Files/areas:** `packages/coding-agent/src/core/tools/subagent.ts` (primary); `packages/coding-agent/src/core/sdk.ts`
  (tool wiring); focused tests extending `packages/coding-agent/test/subagent-tool.test.ts` and/or a
  new `subagent-send.test.ts`.
- **Acceptance:** focused tests pass for: session-backed spawn + later `subagent_send` while the
  child is still running (queues); `subagent_send` against an idle/done resumable child (resumes,
  continues the same harness conversation); rejection for a sessionless/unknown run id; rejection
  for a non-resumable harness; the exactly-once-notification regression test above. `bun run check`
  green. Report explicitly which of "session-backed by default" vs. "session-backed only when
  needed" was chosen and why (spec left this as the implementer's call).

### G2-wire — Wire the concurrency cap into the subagent tool

- **Executor:** Sonnet
- **Depends on:** G1A (serialized on `subagent.ts`), G2-config (needs its settings getter)
- **Status:** blocked
- **Description:** Implement `SPEC-void-orchestration-gaps.md` Part 2's integration half (the
  config field itself is G2-config's job). Inside `createSubagentToolDefinition`'s `execute` body,
  before starting a `run_in_background: true` call via `harnessRunManager.startRun(...)`, check an
  in-memory counter of currently-running subagent-tool runs against G2-config's resolved cap; if at
  the cap, hold the start in a FIFO queue and drain it once a running slot's `waitForHarnessRun`
  resolves (that completion is already the exact signal this needs). A queued call must still return
  its existing `backgroundResult` text immediately, with a note that it may be queued behind the cap.
  State plainly whether foreground (blocking) calls share the same slot counter or not, and why.
- **Files/areas:** `packages/coding-agent/src/core/tools/subagent.ts` only (the settings field
  already exists from G2-config).
- **Acceptance:** focused tests prove: N background calls past the cap are held and started in FIFO
  order as slots free; the cap value comes from G2-config's getter, not a hardcoded number; a queued
  call's immediate tool result mentions it may be queued. `bun run check` green.

### G4-wire — Wire opt-in worktree isolation into the subagent tool

- **Executor:** Sonnet
- **Depends on:** G2-wire (serialized on `subagent.ts`), G4-lib (needs its worktree helper)
- **Status:** blocked
- **Description:** Implement `SPEC-void-orchestration-gaps.md` Part 4's integration half. Add
  `isolation?: "worktree"` to the markdown agent-def frontmatter (`AgentFrontmatter` in
  `packages/coding-agent/src/core/agents.ts`, parsed alongside the existing `harness`/`model`/`tools`
  fields) and/or to `subagentSchema` (`subagent.ts:220-229`) — implementer's call, state which (or
  both). Default unset/off, no behavior change for existing callers. When set, before spawning: call
  G4-lib's worktree-create helper, pass its path as the child's `cwd` instead of the parent's. After
  the run reaches a terminal state, call G4-lib's clean-check/remove helpers: remove if clean, leave
  in place and surface its path in the tool's result text if dirty — never silently discard
  uncommitted child work.
- **Files/areas:** `packages/coding-agent/src/core/tools/subagent.ts`;
  `packages/coding-agent/src/core/agents.ts` (frontmatter field, if used); focused tests.
- **Acceptance:** focused tests prove: default off (no worktree unless requested); worktree created
  and used as `cwd` when `isolation: "worktree"` is set; clean worktree auto-removed after
  completion; dirty worktree preserved with its path surfaced in the result text; opt-in via
  frontmatter and/or tool param works as implemented. `bun run check` green.

### G1B — UI unification: human-resumable subagent-tool children

- **Executor:** Sonnet
- **Depends on:** G1A (needs a `sessionId`-bearing subagent run to point at)
- **Status:** blocked
- **Description:** Implement `SPEC-void-orchestration-gaps.md` Part 1B. Do not redesign — mirror the
  existing, fully-specified `kind: "session"` branch and `getChildComposerRoute`
  (`child-session-view.ts:43-57`) exactly; this is a mechanical extension to a second backing store,
  not new visual design (see the spec's "UI design pass" section for why no fresh Opus/Fable brief
  is needed here). `openChildTarget`/`openChildRun`
  (`packages/coding-agent/src/modes/interactive/interactive-mode.ts:2406-2460`) must also resolve a
  target id against `harnessRunManager.session(id)` when
  `getActiveOrchestrationHost().snapshot()` doesn't have it. `ChildSessionTarget`
  (`child-session-view.ts:14-29`) needs a way to represent a `HarnessRunManager`-backed session
  alongside the existing host-backed one — prefer reusing `getChildComposerRoute`'s decision logic
  verbatim (it already reads generically off `providerType`/`run.state`/`session.providerSessionId`)
  over building a new abstraction; two implementers (host-backed, harness-run-manager-backed) do not
  need more than a small shared shape. Wire `subagent_send` (from G1A) as this path's `resume`/queue
  submit call instead of `host.resume(...)`. Sidebar/`/agents` overlay already aggregate both sources
  per this repo's own prior `TASKS.md` (V015) — extend the existing origin classification, don't add
  a new aggregation path.
- **Files/areas:** `packages/coding-agent/src/modes/interactive/interactive-mode.ts`;
  `packages/coding-agent/src/modes/interactive/components/child-session-view.ts`;
  `packages/coding-agent/src/modes/interactive/components/agent-runs.ts` if the origin
  classification lives there; extend
  `packages/coding-agent/test/orchestration-ui-interactions.test.ts`.
- **Acceptance:** a subagent-tool child with a `sessionId` is enterable from the Sidebar/`/agents`
  overlay and gets a resumable composer (queue while running, resume once idle with a known
  `providerSessionId`, disabled-with-reason for a non-resumable/sessionless run) — not the old
  permanently-disabled state. A design-drift check confirms every state matches the existing `kind:
  "session"` pattern with no invented visuals. `bun run check` green; full interactive-mode test
  suite still passes.

### G-VERIFY — Full verification gate

- **Executor:** this planner, delegating each lens/fix as its own task per the autobuild skill's
  step 5 (not a single monolithic task)
- **Depends on:** G5, G3, G1A, G2-wire, G4-wire, G1B all landed
- **Status:** blocked
- **Description:** Run `review-risk` (mandatory on G1A and G4-wire specifically, per the build
  brief), `review-resilience`, `review-readability`, `review-reliability` (full 4R — this build's
  total diff is expected to exceed 400 changed lines across many files), `feature-finalizer`,
  `ponytail:ponytail-review`, and `mp-standards-spec-review` (fixed point `f7e9c7b3`, spec source
  `SPEC-void-orchestration-gaps.md`). Check G1B's implementation against the existing composer
  pattern for drift. Run `bun run check` and the full test suite for real, not "looks right."
  Fix confirmed findings via a Sonnet (or Opus, for judgment calls) worker per finding, then
  re-verify. Cap at 3 full fix→re-verify loops; a still-red loop after 3 is a blocker, reported
  plainly, not silently shipped.
- **Files/areas:** whatever confirmed findings require, serially, with each fix's own focused test.
- **Acceptance:** all lenses run with findings triaged; confirmed findings fixed and re-verified;
  `bun run check` green with full output; full test suite green; a design-drift checklist for G1B
  exists in the final report.

## Commit plan (owner commits personally — no worker/planner commit)

Suggested logical commit boundaries, each a conventional-commit message, in landing order:

1. `feat(ai): register github copilot in built-in oauth providers` — G5's files.
2. `feat(coding-agent): add opt-in git worktree isolation helper` — G4-lib's new module + tests.
3. `feat(coding-agent): add configurable subagent concurrency cap setting` — G2-config's files.
4. `feat(coding-agent): resume void subagent children from persisted session files` — G3's files.
5. `feat(coding-agent): add subagent_send tool for parent-model follow-up messages` — G1A's files.
6. `feat(coding-agent): bound background subagent fan-out with a FIFO queue` — G2-wire's files.
7. `feat(coding-agent): wire opt-in worktree isolation into the subagent tool` — G4-wire's files.
8. `feat(coding-agent): make subagent-tool children human-resumable in the UI` — G1B's files.
9. Any fix commits from the verification gate, grouped by the finding(s) they address.
