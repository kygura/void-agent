# void build map

## Destination

A verified Bun/TypeScript `void` that preserves pi and the owner's customizations while adding persisted, resumable, provider-agnostic child orchestration through the existing coding-agent extension seam.

## Standing instructions

- Specification: `SPEC.md`. UI brief: `DESIGN.md` from the separate Claude Opus pass. Go reference: `/home/athan/projects/agents/void`, read-only.
- This file is the local-Markdown tracker. Update a task to `done` immediately after its acceptance command passes, and append one concise result to **Decisions so far**. A task is `frontier` only when all dependencies are done and no executor has claimed it; otherwise it is `blocked`.
- Workers do not delegate. They modify only their task's declared write set, disclose deviations, and do not commit unless the human separately asks.
- If two tasks are run in parallel, their declared write sets must not overlap. The execution waves below are chosen so parallel tasks are disjoint.
- After every code task, run the task's focused test and `bun run check` when the whole workspace is expected to compile. If a task creates or changes a test, run that exact test and iterate until it passes.
- Never run real provider APIs or use paid tokens. Coding-agent integration tests use `test/suite/harness.ts` and its faux parent Provider. Orchestrator tests use the mock Provider and recorded fixtures.
- Preserve unrelated user changes. The current untracked `bun.lock` is user-owned until the identity task inspects and intentionally adopts or replaces it; never sweep it up blindly.
- Do not modify the Go reference, the user's live `~/.pi`, or any real credentials.

### Coding philosophy

Question whether code needs to exist at all. Reuse what the repository already has. Prefer Bun/platform and standard-library capabilities before adding a dependency. Choose the shortest working diff and avoid speculative abstractions. Never simplify away input validation at trust boundaries, error handling that prevents data loss, security measures, or accessibility basics. Keep modules deep: expose a small interface, hide mechanics behind it, and test through the same seam callers use.

## Decisions so far

- Product direction is binding: keep pi's direct-model agent and TUI; add Go void's headless CLI orchestration as a library plus built-in extension, not a second application shell.
- All workspace package names become `@void/*`; the executable and app name become `void`; project-local config becomes `.void`.
- `~/.void` is the canonical global agent root. The one-time migration copies selected entries from `~/.pi/agent` directly into it. This makes the binding `~/.void/settings.json` path unambiguous.
- Migration copies only `settings.json`, `extensions/`, `chains/`, and `APPEND_SYSTEM.md`; destination files win; symlinks are copied without dereferencing; the source is never mutated.
- The extension manifest's new key is `void`. The legacy `pi` key remains readable only because copied extensions need it; `void` wins when both exist.
- Bun is the runtime and package manager. v1 adds no npm publication work and does not delete existing release functionality merely to tidy it.
- `@void/orchestrator` is a TUI-free deep module. Its public start/resume/cancel/subscribe/snapshot interface is the test seam; process, parser, locking, and append details stay private.
- Canonical vocabulary is copied from Go void's `CONTEXT.md`: Provider, Adapter, Run, Session, Event, Orchestrator, TaskRun, Provider session ID, focused session, Transcript, and generic Provider.
- External commands always use `Bun.spawn` argv arrays. Generic prompt replacement is allowed only for an argv element exactly equal to `{{prompt}}`; no shell is involved.
- POSIX children use their own process group; cancel/close sends SIGTERM then bounded SIGKILL to the group. Bun's documented `detached` process-group behavior and `Subprocess.kill`/AbortSignal support are the platform basis.
- Provider/process failures are data: every started Run ends with one `result` and one `exit`; missing binary, malformed stream, bad exit, and unsupported resume never escape the orchestrator/extension seam as an uncaught exception.
- Persistence matches Go void's actual append-only JSONL record shape despite the `.json` filename. Files live under `~/.void/orchestrator/sessions/`; latest metadata wins and a corrupt tail is tolerated with a warning.
- Store reads and every append path share per-session serialization. The final Go regression—load racing event/rename/parent-result appends—is a required port.
- A coding-agent session ID is also its top-level orchestration Session ID. `/spawn` children are persisted Sessions with `parentSessionId`; TaskRuns are process-lifetime, not persisted or resumable, matching Go void.
- Command surface: `/spawn <provider> <prompt>`, `/run <provider> <prompt>`, `/agent-resume <session-id> <prompt>`, `/provider [name]`, `/cancel <run-or-session-id>`, and `/agents`. Repeated concurrent `/spawn` calls are fan-out. `/agent-resume` avoids colliding with pi's existing `/resume`.
- A process-lifetime extension host owns the Orchestrator so child work survives parent session switches. Extension instances attach/detach UI subscriptions without closing it.
- Each spawn creates one non-triggering `void:spawn` custom message keyed by child Session ID. Its registered renderer resolves live/restored state so that same inline entry reaches terminal state without moving or duplicating; `pi.appendEntry` holds non-LLM ownership/status data. Sidebar, overlay, footer, and notifications follow `DESIGN.md`'s existing extension UI surfaces.
- The new `/agents` extension command replaces the current built-in dispatch entry and aggregates orchestrator Runs with the owner's existing subagent/harness sources rather than hiding either system.
- New orchestration UI implementation is blocked on root `DESIGN.md`. Command semantics, library code, persistence, and non-visual integration may proceed before it.
- Baseline audit on 2026-07-15 found the latest customization commit references absent files (`core/harness`, `core/tools/subagent.ts`, `merge-config.ts`, status-line/sidebar/agents-overlay, and TUI columns), and the current dependency/model snapshot does not pass a no-emit check. These are preservation gaps to repair, never justification to remove the customized call sites.
- The untracked root `bun.lock` already contains dependencies absent from the current installed `node_modules`; the identity task must inspect it, converge manifests and lock deliberately, and remove `package-lock.json` only after the Bun graph is reproducible.
- No credential is required for the automated gate. Real Claude/Codex/generic demonstrations are manual follow-ups when their already-authenticated CLIs exist.
- Child CLI authentication is a separate capability from pi's direct-model auth. Port the Go auth adapter/status/login/cache/keychain behavior and its Codex stderr/negative-precedence regression using fakes only.
- Provider parity includes `modelFlag`, `effortFlag`, `effort`, `models`, and the Go-compatible `auth` mode enum. Exact defaults are claude with its ordered model list, codex, pi with `--model`/`--thinking`, and opencode with `-m`/`--variant`. Mock is an intentional additional TypeScript Provider but is not injected into that default map.
- Child model/effort discovery and bounded per-Provider MRU state are retained. Provider changes clear incompatible resume/model/effort state without changing the parent model.
- Claude agent preset discovery retains user/project precedence and invocation filters; `/spawn` supports a count from 1 through 8.
- One Session has one live Run and a FIFO prompt queue. Removing queued work removes the newest item; completion/cancel/dequeue races are serialized and regression-tested.
- Go wire compatibility means elapsed durations are integer nanoseconds, timestamps use the recorded RFC 3339 form, and optional-field omission matches fixtures.
- Intentional divergences are explicit: TypeScript adds the mock Provider; unsupported generic resume terminates as a failed Run rather than silently starting a fresh chain; pi's existing parent TUI replaces the standalone Go Bubble Tea shell.
- V001 completed in its isolated worktree and transferred byte-for-byte without a commit: the workspace is Bun-locked, active packages/imports use `@void/*`, the binary/config identity is `void`/`.void`/`VOID_*`, and legacy extension manifests remain readable behind `void` precedence. The remaining check failures are the already-mapped V001A missing customization closure.

- V001A (Sol) recovered the full 32-file customization closure — harness manager, subagent tool, agents, merge-config, sdk, status-line, sidebar, agents overlay, agent-runs, TUI columns, 15 test files, Bun dev scripts — with `@void/*` identity applied; 138 focused Vitest + 7 bun tests pass, full root `bun run check` green, pi-mono fingerprints byte-for-byte unchanged. Green personalized baseline established.

- V002 (Luna) added the pre-migration pi→void config copy in migrations.ts with injectable paths and a versioned completion marker; 8/8 focused tests pass, root check green. Note: vitest is package-local, not root-hoisted — acceptance commands should use `./node_modules/.bin/vitest` from each package root.- V003 (Luna) scaffolded `@void/orchestrator`: frozen public types (Event/Usage, Provider/Adapter, Run/Session/TaskRun, queue, subscriptions), strict config with exact Go provider defaults, scripted mock Provider; 6/6 bun tests and build pass, no TUI/coding-agent dependency. Codex-sandbox note: `bun scripts/check-browser-smoke.mjs` hangs inside the sandbox only; it passes outside — workers should report it and move on rather than retry.
- V005 (Sol) implemented the Go-compatible append store: JSONL-in-`.json` wire format with byte-level fixtures, per-session serialization shared by reads and all append paths, last-metadata-wins load with corrupt-tail warning, 0700/0600 POSIX permissions; 4/4 tests pass including the 300-iteration concurrent append/load case.
- V004 (Sol) implemented the private Bun subprocess engine: argv-only spawn, bounded stdout/stderr streaming, spawn/read/exit errors as data, SIGTERM→bounded-SIGKILL process-group cancellation, zombie-free reaping; 9/9 process tests pass. Orchestrator hotfix: Sol validated only the build tsconfig, missing root no-emit failures in test files — the `bun:test` shim (`test/bun-test.d.ts`) now declares `toBeNull` and a minimal `Bun` global (`sleep`, `spawn`); workers must verify with the root check's tsgo pass, not just `tsconfig.build.json`.
- V007 (Sol) built the Orchestrator core: atomic Run registry, single ordered fan-in, lock-free Provider starts, cancel/close with bounded shutdown, terminal-event backpressure, per-Run failure isolation; 6/6 lifecycle tests (151 assertions) pass. Deliberately did not touch `src/index.ts` (V006 owns shared src glue concurrently) — V008 must add the `Orchestrator` re-export to the package root.
- V006 (Sol) ported Claude/Codex/generic Providers and Adapters with exact argv parity, structured parsers, one-result-one-exit glue, fake-only auth seams (including the Codex stderr/negative-precedence regression), deterministic discovery/MRU, and byte-for-byte Go fixtures; 23/23 adapter tests pass, fixtures verified free of real secrets and machine paths. Sol self-caught and fixed a duplicate application of generic extra args. Full orchestrator suite now 48 tests green; root check green.
- V008 (Sol) added Sessions/resume/fan-out/TaskRuns to the core and published the public Orchestrator API from the package root; 6/6 session tests (196 assertions), full suite 54 green, root check green.
- V009 (Sol) wired serialized incremental persistence (metadata-first, learned session IDs, exactly-once parent `subagentResult`, restore, injected-failure isolation) and ported the Go cross-stream lock regression; race suite green 5 consecutive Sol runs + 3 orchestrator re-runs, full suite 57 green, root check green. The `@void/orchestrator` library (V003–V009) is complete.
- Executor switch (2026-07-16, user-directed): Codex is approaching usage limits. V010/V011 finish on their in-flight Codex workers (or are re-delegated natively if they die); all subsequent tasks run as native Claude subagents — V012/V013/V014/V018 on Opus, V015/V016/V017 on Sonnet (user ruled Haiku out as not comparable to Luna for this work). Task contracts, write sets, and acceptance commands are unchanged.
- V010 (Luna) added the public-interface smoke suite (root-only imports: start/resume/cancel/subscribe/snapshot with MockProvider) and removed the unused credential-shaped `codex_auth.json` fixture (verified unreferenced); package at 58 green tests, fixture audit clean, no production defects found.
- Executor reversal and concurrency ruling (2026-07-16, user-directed): Codex limits have reset, so this supersedes the native-Claude switch above—remaining complex integration/UI/verification work runs on GPT-5.6 Sol and bounded tests/docs/mechanical ports run on GPT-5.6 Luna. V011 and V012 may run concurrently: V011 owns `settings-manager.ts` plus a new orchestrator resolver and focused tests, while V012 owns the recovered harness/subagent/sidebar/customization convergence set; their declared write sets do not overlap.
- Design pass (2026-07-16, Fable): DESIGN.md amended with §3A interactive child-session view — enter from spawn entry/sidebar/`/agents`, composer routes to live-Run FIFO queue or resume Run, generic/TaskRun composers disabled with reason line, esc detaches with child running, five configurable keybinding actions, no auto-detach on completion. V015's design dependency is satisfied; V015 still waits on V014.
- V011 (Sol) added the `orchestrator` settings key with unknown-field preservation and the config/resolver module (`orchestrator-config.ts`) resolving claude/codex/generic/mock into `@void/orchestrator` instances with diagnostics-not-rewrites for invalid config; 9/9 focused tests, tsgo and Biome green, verified with Bun outside the sandbox. Note: Bun-vitest hangs inside the Codex sandbox — workers should fall back to `node <path>/vitest/dist/cli.js` there; orchestrator re-verifies with Bun outside.
- V012 (Sol) replaced the recovered harness child-process code with compatibility adapters over `@void/orchestrator` (one process engine, harness API/JSONL store/direct-model subagent path preserved), reconciled workspace manifests and `bun.lock` (frozen install now passes), split Bun-runtime process tests from Node-hosted Vitest; 233 focused tests green, root `bun run check` fully green outside the sandbox including browser-smoke, no write-set deviation. Orchestrator cross-verified V011+V012 coexistence (35/35).
- V019 (Luna) ported the Go splash: `SplashComponent`/`SplashAnimator` render the shaded pyramid + orbiters in the startup/empty state, deterministic three-axis motion, clamped art box, static `void` wordmark below minimum height, frame timer stops when transcript content appears; 7/7 tests, verified outside sandbox. Root tsgo deferred until concurrent V013 lands (its in-flight files caused 11 unrelated errors at V019's check time).
- V013 (Sol) installed the process-lifetime orchestration host (`src/core/orchestration/{host,extension,claude-agent-presets}.ts`) wired through agent-session services/runtime and `main.ts`; all eight commands registered with validation/completions, presets with precedence/filters, session-switch survival, shutdown reaping, `--no-extensions` still loads the built-in; 37/37 isolated tests, tsgo zero diagnostics. Orchestrator verified combined V013+V019 tree: 36/36 focused + full root check green outside sandbox. Runtime-test note: suites touching `~/.void` need `VOID_CODING_AGENT_DIR` pointed at a temp dir inside the sandbox.
- V014 (Sol) wired the persistence bridge: one `void:spawn` custom message per child (state updates via `VOID_SPAWN_STATE_CUSTOM_TYPE`), exactly-once parent `subagentResult` through the Persister, session-switch routing to the original parent, reload restores without duplicates, zero faux-parent turns; 10/10 tests (6 bridge + 4 V013 regression), tsgo clean, verified outside sandbox.
- V015 (Sol, one capacity-error retry with clean tree) implemented the full orchestration UI: inline spawn entry, focusable sidebar, grouped `/agents` overlay aggregating direct subagents/harness runs/child Sessions/TaskRuns, §3A full-screen `child-session-view.ts` (three entry origins, composer routing table, FIFO queue strip with remove-newest, esc detach, confirmed cancel), footer provider status, focus-aware notifications, five configurable key actions, no hardcoded keys; 85 worker tests, complete design-drift checklist §1–§9 in report, verified outside sandbox (63 focused + full root check green).
- V016 (Luna) added the suite-harness `/spawn mock hello` regression through the real extension command path: one persisted inline child entry, terminal `done` state with complete `subagentResult`, exactly one persisted parent result, zero faux-parent consumption; 1/1 passing, verified outside sandbox, no production defect found.
- V017 (Luna) rewrote root/package READMEs, development/settings docs, orchestrator README, and single Unreleased changelog sections per package; spot-checks confirm no active `~/.pi` write instructions (only historical/migration mentions) and no duplicated changelog subsections.
- V018 (Sol) ran the full adversarial closure: clean frozen install, SPEC gate, manual mock flow (fan-out, cancel isolation, restore without duplication, zero faux-parent calls) demonstrated. Fixed HIGH: session-ID path traversal in store.ts (IDs can no longer escape the storage directory; regression added). Fixed MEDIUM: direct Tailwind dep, package-local binary asset copying, deterministic WSL detection under injected env, reserved `app.child.cancel` against extension shadowing. Hostile-prompt/redaction/permissions/duplicate/session-switch/lock inspections all passed. Credential-dependent Claude/Codex/generic live spawns remain manual follow-ups.
- Orchestrator verdict on V018's residual blockers (verified outside sandbox): root check + browser smoke GREEN; orchestrator suite 59/59 (aggregate cancellation flake did not reproduce); the 8 TUI test failures are INHERITED — pi-mono fails the identical 8 tests (506/514, same names: markdown style-leak, pre-styled text, short-content overlay, Termux resize, differential rendering) — a pre-existing customization/upstream-test divergence in the owner's baseline, preserved byte-for-byte, recorded as a user follow-up rather than fixed by guesswork.
- Verification gate (2026-07-16, four native review lenses + finalizer after V018): confirmed findings dispatched as two parallel Sol fix tasks (disjoint write sets: orchestrator vs coding-agent UI). Orchestrator: subscription auth API-key stripping bypassed via env-entry overlay onto live process.env (BLOCKER); late cancel relabels a naturally-completed Run as cancelled (CRITICAL); unbounded restore I/O gates session start and shutdown (CRITICAL); unbounded post-SIGKILL reap wait; JSONL torn-write can lose the following good record; non-abort-aware DelayedProvider test helper (adjudicated as the aggregate-run flake source — environmental, not a logic bug). UI: sidebar substring 'agents' row lookup mis-selects (CRITICAL); §3A inline-entry origin unreachable (design drift); harness-origin child view empty + silent sidebar cancel no-op; /login completions hidden by collision filter (bare /login stays parent OAuth by design); dead export removal; vitest forbidOnly guard. Recorded, not fixed: migration preserves symlinks without 0600 (SPEC-mandated behavior — owner should review the security note); unbounded host/persister maps over process lifetime (deliberate-ceiling suggestion); stale confirm-message TOCTOU (low impact).
- Fix wave complete and re-verified (loop 1, 2026-07-16): orchestrator worker fixed all six findings (authoritative env deny-list at spawn with end-to-end regression, terminal-state captured before awaits so late cancel is a label no-op, bounded restore with `restoreTimeoutMs`, bounded post-SIGKILL wait resolving as terminal error data, torn-tail leading-newline guard, abort-aware DelayedProvider) — package suite 65/65. UI worker fixed all six (structural sidebar section indexing with collision tests, real focus path for the inline spawn entry satisfying §3A's third origin, harness-origin child views render `getRunOutputText` with shared cancel path and explicit unsupported-cancel reason, merged /login completions with bare /login kept as parent OAuth, dead export removed, vitest `allowOnly: false` guard) — 71/71 focused. Consolidated outside-sandbox gate: root check exit 0 (incl. browser smoke), orchestrator 65/65, coding-agent 1154 vitest + 11 bun-runtime green. Build verification CLOSED; only the 8 inherited TUI failures remain, as a recorded owner follow-up.
- Legacy retirement (2026-07-16): `void/` (41MB, no remote — history preserved), `pi-mono/` (47 uncommitted customization files, all ported and test-proven in void-ts), and `void-worktrees/` (v001 worktree, content long transferred; removed via `git worktree remove`) were tar-archived WITH full `.git` history to `~/projects/agents/legacy-archives/{void,pi-mono,void-worktrees}-final-2026-07-16.tar.gz` (76MB total, integrity-verified), then deleted. `oh-my-pi/` and `claude-code/` untouched. The build is closed: void-ts is the single successor codebase.

## Execution waves

1. **Identity and recovery:** finish V001 in its existing isolated worktree, then V001A restores the complete local pi customization source/test closure and establishes a green personalized baseline.
2. **Foundations:** V002 and V003 in parallel after V001A; their write sets are coding-agent migration files versus the new orchestrator package.
3. **Library internals:** V004 and V005 in parallel after V003; process and store files do not overlap.
4. **Execution core:** V006 and V007 in parallel after V004; Provider/Adapter files versus Orchestrator registry files do not overlap.
5. **State and durability:** V008, then V009; both extend shared orchestration behavior and therefore run serially.
6. **Convergence:** V011 and V012 may run in parallel now that their dependencies are done; coding-agent settings/resolver files and the recovered customization convergence set do not overlap.
7. **Integration and splash:** V013 and V019 may run in parallel after their dependencies; the built-in orchestration host/command bridge and startup splash files are disjoint. V014 follows V013. V015 follows V014 and remains blocked until a separate design pass specifies interactive child-session entry and follow-up prompting.
8. **Handoff:** V016 and V017 may run in parallel after V015; tests and docs do not overlap. V018 is last and also waits for V019.

## Ordered tasks

### V001 — Cut over identity and Bun workspace

- **Executor:** `luna`
- **Depends on:** none
- **Status:** `done`
- **Claim:** implementation is already in progress at `/home/athan/projects/agents/void-worktrees/v001-identity`; preserve its uncommitted tracked and untracked files.
- **Description:** Mechanically rename workspace packages to `@void/*`, application/binary `pi` to `void`, global/project config identity to `~/.void`/`.void`, and product-owned environment variables to `VOID_*`. Convert development/build/test scripts to Bun without expanding publish scope. Rename helper scripts and compiled output where identity-bearing. Update static imports, examples, docs paths, and internal package references. Add `@void/orchestrator` only to the workspace list if the directory already exists at task execution; V003 owns its files. Support `void` extension manifests with legacy `pi` fallback for migrated extensions. Inspect the existing untracked `bun.lock`, regenerate it only from reviewed manifests, and make it authoritative before removing the npm lock.
- **Files/areas:** root/package manifests and lockfiles; all workspace `package.json` files; workspace TypeScript import specifiers; root scripts and shell helpers; `packages/coding-agent/src/config.ts`, CLI identity strings, package/extension manifest loading; mechanically identity-bearing README/docs text.
- **Acceptance:** `bun install --frozen-lockfile` succeeds; `bun pm ls` resolves local `@void/*` workspaces; a repository search for `@mariozechner/pi-` in active manifests/source prints no matches; `packages/coding-agent/package.json` exposes only the `void` binary and `build:binary` targets `dist/void`; no files under `~/.pi` were touched.

### V001A — Restore the complete local pi customization closure

- **Executor:** `sol`
- **Depends on:** V001
- **Status:** `done`
- **Description:** Recover the omitted user-owned source files and tests from the untracked customization work in `/home/athan/projects/agents/pi-mono`: agents, harness, subagent tools, merge-config, status-line, agent-run presentation, sidebar, overlay, Columns, focused tests, and Bun development helpers. Preserve behavior; apply only the completed `@void/*`/`.void`/`VOID_*` identity. Do not stub missing imports or delete their callers. Reconcile dependencies and current generated-model expectations without weakening types or deleting tests.
- **Files/areas:** the coherent missing customization subsystem under `packages/coding-agent/src/core/`, `src/modes/interactive/components/`, `packages/tui/src/components/`; its focused tests; `scripts/dev.bun.ts`, `scripts/dev.sh`; manifests/lock only where required.
- **Acceptance:** all recovered focused tests pass from their package roots; `npm run check` is green with full output; no missing local import remains; no `any` or inline/dynamic import is introduced; source files in sibling `pi-mono` remain unchanged.

### V002 — Add the non-destructive pi configuration copy

- **Executor:** `luna`
- **Depends on:** V001A
- **Status:** `done`
- **Description:** Add the startup migration from `~/.pi/agent` to the canonical void root. Copy exactly the approved files/directories, merge missing descendants, preserve symlinks without following them, refuse to overwrite destination data, warn non-fatally on failure, and write a versioned completion marker only after success. Run it before existing in-place void migrations.
- **Files/areas:** `packages/coding-agent/src/migrations.ts`; config-path helpers if needed; a new focused migration test under `packages/coding-agent/test/`.
- **Acceptance:** from `packages/coding-agent`, `bun ../../node_modules/vitest/dist/cli.js --run test/void-config-migration.test.ts` passes and proves missing-source, copy, existing-destination, partial-retry, permissions, symlink, idempotency, and source-byte-for-byte-unchanged cases.

### V003 — Scaffold `@void/orchestrator` and freeze its public types/config

- **Executor:** `luna`
- **Depends on:** V001A
- **Status:** `done`
- **Description:** Create the package with Bun test/build scripts, top-level imports only, and no TUI dependency. Define the canonical Event/Usage, Provider/Adapter, auth adapter, Run/Session/TaskRun snapshots, queue state, exact wire units/omission rules, state, configuration, model/effort/auth fields, and subscription types. Implement strict config parsing with the exact Go defaults for Claude, Codex, pi, and opencode; support mock without injecting it into the default map; add the scripted mock Provider. Keep the public interface small enough that the later process/store implementations remain hidden.
- **Files/areas:** `packages/orchestrator/package.json`, TypeScript configs, `src/index.ts`, `src/types.ts`, `src/config.ts`, `src/providers/mock.ts`, and focused config/mock tests.
- **Acceptance:** from `packages/orchestrator`, `bun test test/config.test.ts test/mock-provider.test.ts` passes; `bun run build` passes; dependency inspection shows no `@void/tui` or `@void/coding-agent` import/dependency.

### V004 — Implement the Bun subprocess engine

- **Executor:** `sol`
- **Depends on:** V003
- **Status:** `done`
- **Description:** Implement the private argv-only Bun process module. Stream bounded stdout lines and a bounded stderr tail, handle read/spawn/exit errors, reap every child, and implement POSIX process-group SIGTERM→SIGKILL cancellation plus portable best effort elsewhere. The module returns terminal process data; it does not know Provider event schemas.
- **Files/areas:** `packages/orchestrator/src/process.ts`; process fixture scripts; `packages/orchestrator/test/process.test.ts`.
- **Acceptance:** `bun test test/process.test.ts` passes, including discrete hostile prompt argv, stdout streaming, final unterminated line, bounded long line/stderr, missing executable, non-zero exit, cancel escalation, process-group grandchild cleanup on POSIX, and no zombie after close.

### V005 — Implement the Go-compatible append store

- **Executor:** `sol`
- **Depends on:** V003
- **Status:** `done`
- **Description:** Implement owner-only session storage using Go void's metadata/prompt/event JSONL line shapes and `.json` filenames. Serialize all operations per Session, append incrementally, load with last-metadata-wins semantics, tolerate only corrupt/truncated lines while returning a warning, and expose list/load/append methods through a narrow persistence interface. Freeze Go-compatible integer-nanosecond durations, RFC 3339 timestamps, key names, and optional-field omission with byte-level fixtures.
- **Files/areas:** `packages/orchestrator/src/store.ts`; `packages/orchestrator/test/store.test.ts`; store fixtures.
- **Acceptance:** `bun test test/store.test.ts` passes and byte-level fixture comparison shows compatible line keys/omission behavior; directory is `0700`, files are `0600` on POSIX; valid records survive a truncated tail; 300 concurrent append/load iterations produce no torn, missing, or reordered record.

### V006 — Port Claude, Codex, and generic Providers/Adapters

- **Executor:** `sol`
- **Depends on:** V003, V004
- **Status:** `done`
- **Description:** Port the Go invocation builders, structured parsers, duplicate-text avoidance, result synthesis, child auth adapters, model/effort argv handling, model discovery/MRU state, and resilience rules. Copy the Go recorded stream/auth fixtures into this repository without changing the Go source. Validate generic templates, flags, auth argv, and env entries at the trust boundary. Include built-in pi/opencode generic Providers. Provider start paths convert every post-request failure to Events.
- **Files/areas:** `packages/orchestrator/src/providers/{claude,codex,generic}.ts`, shared Adapter glue, `packages/orchestrator/test/adapters.test.ts`, and `packages/orchestrator/test/fixtures/`.
- **Acceptance:** adapter/auth/model tests pass and assert exact argv for new/resumed/model/effort/workdir cases, fixture Event sequences, no Claude text duplication, unknown-event skip, malformed-line raw text, prompt injection safety, generic placeholder/flag validation, one result + one exit for clean/error/resultless streams, fake-only auth/login, Codex stderr plus negative-precedence status parsing, deterministic discovery/MRU, and no secret logging.

### V007 — Build Run lifecycle, fan-in, cancel, and isolation

- **Executor:** `sol`
- **Depends on:** V003, V004
- **Status:** `done`
- **Description:** Implement the Orchestrator's live Run registry and single ordered fan-in surface. Reserve Run IDs atomically, track snapshots and transcripts, start Providers without holding registry locks, cancel one Run, close all Runs, backpressure rather than drop terminal Events, and isolate a consumer/Provider failure from other Runs. Unknown Provider and launch failure still create an inspectable failed Run with terminal Events.
- **Files/areas:** `packages/orchestrator/src/orchestrator.ts`; `packages/orchestrator/test/orchestrator-lifecycle.test.ts`.
- **Acceptance:** `bun test test/orchestrator-lifecycle.test.ts` passes, including two interleaved delayed mocks, per-Run order, global observed order, no terminal drop under buffer pressure, one-run failure isolation, cancel-one/other-completes, unknown Provider, and bounded close.

### V008 — Add Sessions, resume, child fan-out, and TaskRuns

- **Executor:** `sol`
- **Depends on:** V006, V007
- **Status:** `done`
- **Description:** Extend the registry with parent/child Sessions, stored Provider session IDs, exactly one live Run plus a FIFO prompt queue per Session, remove-newest queue behavior, concurrent Runs across Sessions, restored Session registration, resume capability checks, child model/effort state, and process-lifetime TaskRuns. Use the coding-agent session ID as a valid caller-supplied top-level Session ID. A child Session is full, persisted, resumable, and linked to its parent; a TaskRun is neither.
- **Files/areas:** `packages/orchestrator/src/orchestrator.ts` and Session-focused tests.
- **Acceptance:** `bun test test/orchestrator-sessions.test.ts` passes and proves Claude/Codex resume configs receive the learned ID, generic resume becomes a failed terminal Run, two child Sessions fan out concurrently, one Session never has two live Runs, FIFO/remove-newest semantics survive repeated completion/cancel/dequeue races, restored Sessions resume, TaskRuns remain sessionless, and Provider switching clears incompatible resume/model/effort state.

### V009 — Wire incremental persistence and port the cross-stream seam regression

- **Executor:** `sol`
- **Depends on:** V005, V008
- **Status:** `done`
- **Description:** Connect Session/Run lifecycle to the append store without making the Orchestrator depend on UI. Persist metadata before prompt/Event data, update Provider session IDs, restore Sessions, and append `subagentResult` to the parent through one persistence owner. Port the final Go tests for event appends racing rename/load/parent-result writes. Persistence failure becomes a warning/terminal state where appropriate and never crashes unrelated Runs.
- **Files/areas:** `packages/orchestrator/src/persister.ts`, minimal orchestrator hooks, `packages/orchestrator/test/persistence-seam.test.ts`.
- **Acceptance:** `bun test test/persistence-seam.test.ts` passes under repeated runs; every child file has metadata first, the parent result is present exactly once, concurrent load/rename/Event/result activity loses no record, restored grouping is correct, and injected disk failure is observable without taking down another Run.

### V010 — Complete the orchestrator package contract suite

- **Executor:** `luna`
- **Depends on:** V006, V009
- **Status:** `done`
- **Description:** Add narrow regression tests for any uncovered specification clauses without changing production interfaces unless a test exposes a defect. Add a package-level public-interface smoke test and ensure fixtures contain no credentials or machine-specific paths.
- **Files/areas:** `packages/orchestrator/test/` only, excluding files actively owned by an unfinished prior task.
- **Acceptance:** from `packages/orchestrator`, `bun test` and `bun run build` both pass; a search of fixtures finds no home-directory path, token, API key, or auth payload.

### V011 — Add orchestrator settings and Provider resolution to coding-agent

- **Executor:** `sol`
- **Depends on:** V002, V006
- **Status:** `done`
- **Resumption audit:** The previous worker left no usable V011 implementation. `settings-manager.ts` contains only earlier identity/environment changes, and there is no orchestrator config/resolver source module or focused resolver test. Start this task from its contract; preserve all unrelated working-tree changes.
- **Description:** Extend the existing typed settings model with the `orchestrator` key, preserving unknown settings and existing merge/write locking. Resolve defaults plus configured claude/codex/generic/mock Providers into `@void/orchestrator` instances. Report invalid config as diagnostics without rewriting it or exposing env values. Keep parent direct-model provider settings separate from child Provider selection.
- **Files/areas:** `packages/coding-agent/src/core/settings-manager.ts`; a new coding-agent orchestrator config/resolver module; settings/resolver tests.
- **Acceptance:** focused Vitest settings/resolver files pass from `packages/coding-agent`; tests cover missing config defaults, invalid default reference/type/template/env, unknown-field preservation, secret redaction, and all four Provider resolutions.

### V012 — Restore and converge the committed local customization surfaces

- **Executor:** `sol`
- **Depends on:** V001, V009
- **Status:** `done`
- **Description:** Repair the incomplete customization snapshot without deleting intended behavior. Recover or faithfully reconstruct the missing merge-config, status-line, columns, sidebar, agents overlay, harness manager, and subagent tool modules referenced by the last commit. Reuse `@void/orchestrator` behind external-CLI harness/run behavior instead of creating a second child-process engine. Preserve direct-model subagent behavior and existing settings/footer/keybindings. Reconcile dependency and generated-model test drift uncovered by the baseline no-emit check by updating dependencies/data—not by weakening types or deleting tests.
- **Files/areas:** the currently missing files under `packages/coding-agent/src/core/`, `src/core/tools/`, and `src/modes/interactive/components/`; `packages/tui/src/components/columns.ts`; the SDK/runtime call sites already changed by the customization commit; focused recovery tests and dependency manifests as necessary.
- **Acceptance:** `bun run check` is green; existing settings/footer/args/keybindings tests pass; new harness/subagent/sidebar tests prove the committed features work; no referenced module is stubbed, no `any` or inline/dynamic import is introduced, and no customization call site is removed merely to compile.

### V013 — Install the process-lifetime built-in extension and command bridge

- **Executor:** `sol`
- **Depends on:** V011, V012
- **Status:** `done`
- **Description:** Create a process-lifetime orchestration host and expose it through a built-in extension factory loaded by the existing resource-loader path. Register `/spawn`, `/run`, `/agent-resume`, `/provider`, `/cancel`, `/login`, `/agent-model`, and `/agent-effort`; parse/validate arguments and completions; discover Claude user/project agent presets with precedence/filter rules; support spawn count 1–8; map the current coding-agent session ID to the parent Session; keep Runs alive across parent session switches; detach on extension shutdown and close the host only on application shutdown. Do not implement the new visual presentation yet.
- **Files/areas:** a new built-in orchestration extension/host directory in `packages/coding-agent/src/`; `main.ts`/runtime service injection; resource-loader factory wiring; command tests.
- **Acceptance:** focused command/lifecycle Vitest tests pass and show commands consume no faux parent response, two parent session switches do not cancel a delayed mock child, shutdown reaps it, invalid input starts nothing, and `--no-extensions` still loads this built-in while disabling user extensions.

### V014 — Bridge each child into both persistence layers

- **Executor:** `sol`
- **Depends on:** V013
- **Status:** `done`
- **Description:** Subscribe once to orchestrator Events. At spawn, send exactly one non-triggering `void:spawn` custom message containing the stable child Session ID. Update live extension state as Events arrive, append the terminal `subagentResult` through the orchestrator Persister, and persist ownership/status metadata with `pi.appendEntry` so the renderer can resolve the same entry after reload. Prevent duplicate entries/results when lifecycle/result/exit notifications converge or extension instances reattach.
- **Files/areas:** built-in orchestration extension/host and its non-visual custom-message data contract; persistence bridge tests.
- **Acceptance:** focused bridge tests pass and prove exactly one parent custom message per spawned child from pending through terminal state, no faux parent LLM turn is triggered, success/failure/cancel payloads are complete, a session switch routes completion to the original parent, and reload restores rather than duplicates the entry/result.

### V015 — Implement orchestration UI exactly from `DESIGN.md`

- **Executor:** `sol`
- **Depends on:** V014 and a separate design pass has amended root `DESIGN.md` with interactive child-session entry and follow-up prompting
- **Status:** `done`
- **Design gap:** Current `DESIGN.md` §3 makes Enter attach to a read-only transcript with the composer hidden. That does not satisfy entering a spawned child Session as an interactive chat. Do not infer or design the missing full-screen/session-header/composer/follow-up states in this task; dispatch it only after the design brief is amended.
- **Description:** Implement, but do not redesign, the root design brief: one live inline spawn entry, the already-forward-referenced sidebar and `/agents` overlay, provider footer status, notifications, expand/collapse/focus/cancel behavior, status/error states, and narrow-terminal layout. Replace the existing hard-coded `/agents` dispatch with the built-in extension command while aggregating existing direct subagents, harness runs, child Sessions, and standalone TaskRuns. All keybindings must use configurable keybinding maps; no hardcoded key match is allowed.
- **Files/areas:** orchestration UI files under the built-in extension; existing agents overlay/sidebar integration and slash-command catalog/dispatch; focused rendering/interaction tests. `DESIGN.md` is read-only to this executor.
- **Acceptance:** focused TUI tests pass for running/done/failed/cancelled, empty/filter states, grouping, selection, expand/collapse, and narrow widths; a design-drift checklist maps every implemented state to `DESIGN.md`; `/agents` has one discoverable command and still shows the owner's pre-existing agent sources.

### V016 — Add the required `/spawn mock` coding-agent regression

- **Executor:** `luna`
- **Depends on:** V015
- **Status:** `done`
- **Description:** Add one suite-harness integration test using the faux parent Provider and built-in mock child. Exercise the real extension command path and SessionManager transcript, not private methods. Include concurrent fan-out and cancel isolation if it stays within the same public seam.
- **Files/areas:** `packages/coding-agent/test/suite/orchestrator-spawn.test.ts` and test-only fixtures/utilities.
- **Acceptance:** from `packages/coding-agent`, `bun ../../node_modules/vitest/dist/cli.js --run test/suite/orchestrator-spawn.test.ts` passes and proves `/spawn mock hello` produces one persisted inline child entry that reaches a displayable terminal result without consuming a faux parent response.

### V017 — Update user and developer documentation

- **Executor:** `luna`
- **Depends on:** V015
- **Status:** `done`
- **Description:** Document void identity, Bun setup/build/test commands, migration safety, config schema, commands, persistence location/format, Provider prerequisites, manual spawn/resume examples, and extension architecture. Add concise Unreleased changelog entries only in affected packages. Remove stale active-product pi paths while retaining attribution/history where it is genuinely historical. Do not add publish instructions.
- **Files/areas:** root and affected package READMEs/docs; `packages/orchestrator/README.md`; affected `CHANGELOG.md` Unreleased sections only.
- **Acceptance:** documentation commands match package scripts and paths; searches find no active instructions that write `~/.pi` or run a `pi` binary; changelog subsections are not duplicated and released sections are unchanged.

### V018 — Full verification and adversarial closure

- **Executor:** `sol`
- **Depends on:** V002–V017, V019
- **Status:** `done` (with recorded inherited-failure verdict)
- **Description:** Run the complete SPEC gate from a clean dependency install, review the diff for standards/spec/reliability/security/data-loss/overengineering and `DESIGN.md` drift, fix confirmed findings, and rerun. Inspect hostile prompt handling, env redaction, file permissions, process cleanup, duplicate completion, session-switch lifetime, and lock coverage explicitly. No real provider calls. Stop after three unsuccessful fix/verify loops and report the exact blocker rather than declaring success.
- **Files/areas:** initially read-only verification; confirmed fixes may touch the owning task's files serially, followed by their focused tests.
- **Acceptance:** all commands in `SPEC.md`'s observable definition of done pass with full output; the manual mock flow is demonstrated; `git status` contains no generated test junk or accidental Go/live-config changes; final report lists commands, behavior demonstrated, review findings fixed, and any manual real-provider checks left credential-dependent.

### V019 — Port the animated ASCII startup splash

- **Executor:** `luna`
- **Depends on:** V012
- **Status:** `done`
- **Description:** Mechanically port the startup splash/banner behavior from read-only Go reference `internal/tui/components/splash/splash.go`, mining `splash_test.go` for acceptance criteria. Show the animated shaded pyramid and background orbiters only in the coding-agent startup/empty state, stop its frame timer once real transcript content exists, clamp its art box, and fall back to the existing static void wordmark when the terminal is below the minimum size. Reuse existing void-ts TUI components/theme tokens and timer/render invalidation seams; add no new rendering framework or dependency.
- **Files/areas:** `packages/coding-agent/src/modes/interactive/components/splash.ts`; the startup header/empty-state integration in `packages/coding-agent/src/modes/interactive/interactive-mode.ts`; `packages/coding-agent/test/splash.test.ts` (or the nearest focused existing interactive startup test if that is the established seam).
- **Acceptance:** from `packages/coding-agent`, `bun ../../node_modules/vitest/dist/cli.js --run test/splash.test.ts` passes and proves minimum-size fallback, exact/clamped bounds, visible pyramid and orbiter glyphs, deterministic finite three-axis motion, frame changes over time, timer shutdown after transcript content appears, and preservation of the static wordmark fallback; then root `bun run check` passes with full output.
