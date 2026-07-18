# SPEC — void in-process subagent orchestration

Status: approved (design brainstormed and approved by user prior to this build). No UI/interface
design pass is needed — zero new components, this reuses the existing session-kind UI path.

Note: `SPEC.md` already exists in this repo as the whole-product spec. This file is scoped to one
change only; it does not replace or duplicate `SPEC.md`.

## Problem

1. **Bug**: in-process void subagents spawn with an empty tool list. `resolveAgentTools`
   (`packages/coding-agent/src/core/tools/subagent.ts:83`) maps agent-file `tools:` names
   literally against void's registry keys (`read, bash, edit, write, grep, find, ls` —
   `packages/coding-agent/src/core/tools/index.ts:113`, the `allTools` map). But `discoverAgents`
   (`packages/coding-agent/src/core/agents.ts:92`) loads `~/.claude/agents/*.md` for Claude Code
   compatibility, and those use names like `Read, Grep, Glob, WebFetch, WebSearch`. Every name
   gets filtered out by the literal-key lookup on line 86 → a tool-less child.

2. **Feature**: in-process void children (the default `subagent` tool path, harness id `"void"`)
   are invisible in the UI. `runVoidChild` (`subagent.ts:145`) spawns a full `AgentSession`, awaits
   the prompt, grabs the last assistant text via `getLastAssistantText()`, and disposes the session
   in `finally` — its event stream is never surfaced anywhere. Harness children (claude/codex CLIs,
   which go through `HarnessRunManager.startRun`) already get a rich UI: the Sidebar and `/agents`
   overlay list runs, Enter → `openChildRun` (`interactive-mode.ts:2428`) →
   `ChildSessionView` with `kind: "session"` — live transcript, cancel, queue-while-running, and a
   resume composer (`getChildComposerRoute`,
   `packages/coding-agent/src/modes/interactive/components/child-session-view.ts:43`). Void
   children only reach the `kind: "external"` branch of `ChildSessionView` (output text only,
   composer permanently `disabled`).

## Approved approach

Route in-process void children through the orchestrator exactly like claude/codex children
already are, instead of the separate `runVoidChild` ad hoc path.

### Part 1 — tools bug fix (independent, land first, parallel-safe)

In `resolveAgentTools` (`packages/coding-agent/src/core/tools/subagent.ts:83`):

- Add a Claude Code → void alias map: `Read→read, Grep→grep, Glob→find, Bash→bash, Edit→edit,
  Write→write, LS→ls`.
- Match case-insensitively.
- Drop unknown names (`WebFetch`, `WebSearch`, `Task`, …) with a `console.error`/stderr warning —
  do not throw.
- If nothing resolves (all names unknown, or the alias map + registry both miss), fall back to
  `createReadOnlyTools(cwd)` (`packages/coding-agent/src/core/tools/index.ts:179`) — never produce
  a tool-less child.
- Preserve existing behavior: `toolNames` undefined/empty still returns `createCodingTools(cwd)`.

Unit tests: the alias map, case-insensitivity, unknown-name-dropped-with-warning, and the
empty-resolution → read-only fallback.

### Part 2 — feature: void children through the orchestrator

**Seam — the local `Harness` interface**
(`packages/coding-agent/src/core/harness/types.ts:74`), the same one `ClaudeHarness` and
`CodexHarness` implement:

```ts
export interface Harness {
  id: string;
  resumable: boolean;
  start(cfg: HarnessRunConfig, signal: AbortSignal): AsyncIterable<HarnessEvent>;
}
```

`HarnessRunManager.registerHarness(harness: Harness)` wraps it into an orchestrator `Provider`
(`packages/orchestrator/src/types.ts:59`) via `providerFromHarness` — the new void harness must
NOT implement `Provider` directly and must NOT live in `packages/orchestrator` (that package stays
dependency-free of `packages/coding-agent`; it needs `spawnVoidChild`, which lives in
`packages/coding-agent/src/core/sdk.ts`).

1. **New in-process `VoidHarness`** — new file under `packages/coding-agent/src/core/harness/`
   (e.g. `void.ts`), registered alongside claude/codex. `createDefaultHarnesses()`
   (`packages/coding-agent/src/core/harness/index.ts:39`) currently returns
   `[new ClaudeHarness(), new CodexHarness()]` and is zero-arg; `VoidHarness` needs
   `spawnVoidChild` (`packages/coding-agent/src/core/sdk.ts:288`) at construction, which
   `createDefaultHarnesses()` doesn't have. Read `sdk.ts` around `createAgentSession` (~line
   189+) to see where `harnessRunManager.registerHarness(...)` is currently called for
   claude/codex, and register `VoidHarness` there directly instead of forcing it through
   `createDefaultHarnesses()`. State this decision plainly in the PR/commit — it's a deliberate
   deviation from "just add it to the array" once the constructor dependency makes that
   impossible cleanly.

   - `id = "void"`, `resumable = true`.
   - **Fresh run** (`cfg.providerSessionId` unset): spawn a child via the existing
     `spawnVoidChild` callback (type `SpawnVoidChild` in `subagent.ts:123`), subscribe to the
     child `AgentSession`'s event stream, and translate each event to `HarnessEvent`
     (`packages/coding-agent/src/core/harness/types.ts:26`): `"started"` (`providerSessionId` =
     the child session's id), `"text"`, `"thinking"`, `"tool"` (`tool`/`toolInput`/`toolDone`),
     `"result"` (final text + `usage`), `"exit"`.
   - **Resume**: keep live children in a `Map<providerSessionId, AgentSession>`. A known
     `cfg.providerSessionId` → submit the new prompt to that same living session instead of
     spawning. Children are NOT disposed after a run — they live until the harness (or process)
     closes, so resume works. Resuming an unknown/dead `providerSessionId` → the run fails as data
     (an `"exit"`/error-carrying event), not a thrown exception the caller has to catch specially.
     v1 is live-children-only; respawn-from-session-file is a documented upgrade path — leave a
     `ponytail:` comment naming it.
   - **Abort**: `signal` abort → call the child `AgentSession`'s `.abort()` → run ends cancelled.
   - **Spawn-config handoff**: `HarnessRunConfig` (`harness/types.ts:55`) carries `prompt, model,
     effort, cwd, env, providerSessionId, extraArgs` — no `systemPrompt` or `toolNames` field, and
     the design does not want one added to that shared type (every other harness would have to
     ignore it). Instead, the subagent tool (Part 2, item 2 below) pre-registers the agent def's
     `systemPrompt`/`toolNames` on the `VoidHarness` instance keyed by a token immediately before
     calling `startRun` (e.g. a `harness.prepareSpawn(token, {systemPrompt, toolNames})` method,
     with the token threaded through `cfg.extraArgs` or a dedicated `HarnessRunConfig` field if
     that's cleaner — implementer's call, state which). Keep it minimal: this is in-process, same
     event loop, no serialization needed, just a lookup map keyed by a generated id.
   - **Error handling**: child spawn failure → a `"result"` event with `isError: true` and the
     error text, followed by `"exit"` — a failed run with the error as its result text, not an
     unhandled rejection.

2. **Subagent tool rewiring** — `packages/coding-agent/src/core/tools/subagent.ts`. Change the
   `"void"` branch to start through the same `harnessRunManager.startRun("void", cfg)` seam the
   claude/codex branches already use, and populate `harnessRunId` on `SubagentRunRecord`
   (`subagent.ts:26`) so live transcript, cancel, and background-notify work for void the same as
   they already do for claude/codex subagent-tool runs. Delete `runVoidChild` (`subagent.ts:145`)
   and any void-specific `kind: "external"` plumbing that becomes dead once this lands.

   **Correction (post-implementation, verified against source by an independent review pass):**
   the paragraph originally here claimed calling `harnessRunManager.newSession("void")` +
   `startRun("void", cfg, sessionId)` would route void children to `kind: "session"`
   `ChildSessionView` (resume composer, queue-while-running) "same as claude/codex children."
   That premise was wrong — it conflated two separate `Orchestrator` instances. `openChildRun`
   (`interactive-mode.ts:2428`) only reaches `kind: "session"`/`"task"` for runs whose `origin` is
   `"session"`/`"task"`, and those origins come exclusively from
   `ProcessLifetimeOrchestrationHost` (the `/spawn`/`/agent-resume` slash-command system).
   Runs started via the **subagent tool** — void, claude, or codex alike — get `origin: "subagent"`
   or `"harness"` from `HarnessRunManager`'s own, separate `Orchestrator` instance, which
   `openChildRun` never checks; they always fall to `kind: "external"`, whose composer
   (`getChildComposerRoute`, `child-session-view.ts:44`) is unconditionally disabled regardless of
   `ProviderType`. So claude/codex subagent-tool children never had a resume composer either — the
   "same as claude/codex" comparison point was accurate, just not to the rich session UI this
   spec assumed. See the corrected "Done means" and "Out of scope" sections below.

3. **`ProviderType` union** — add `"void"` to `packages/orchestrator/src/types.ts:38`
   (`export type ProviderType = "claude" | "codex" | "generic" | "mock";` → add `"void"`).
   `packages/orchestrator/src/providers.ts`'s exhaustive `switch (config.type)` in
   `createProvider` needs (and, as implemented, has) an explicit `case "void": throw ...` since
   void is registered directly by coding-agent's `sdk.ts`, not config-driven.
   `packages/orchestrator/src/config.ts`'s `PROVIDER_TYPES` Set is a deliberately curated
   **subset** for validating user-supplied config, not an exhaustive switch — it correctly
   excludes `"void"` since a user can never legally write `type: "void"` in settings. (Original
   drafting of this section incorrectly implied `config.ts` needed a `"void"` case too; verified
   against source post-implementation, it does not.)

4. **UI**: zero new components. Everything routes through the existing `kind: "session"`
   `ChildSessionView` path already built for claude/codex. No design brief needed, no design pass
   — this step is explicitly skipped per the interface-design-pass rule ("don't invent interface
   work that isn't there").

## Testing

- Unit tests for `VoidHarness`'s event translation (fresh run, resume, abort, spawn failure). Check
  `packages/coding-agent/test/harness-run-manager.test.ts` and
  `packages/coding-agent/test/subagent-tool.test.ts` for existing fakes/mocks for `AgentSession`
  and `HarnessRunManager` before writing new ones.
- Extend `packages/coding-agent/test/orchestration-ui-interactions.test.ts` to cover entering a
  void child. **Corrected**: as implemented and verified, this stays `kind: "external"` (same as
  claude/codex subagent-tool runs) — the test proves live transcript + cancel work, not a resume
  composer (see the Part 2 item 2 correction above and "Done means" below).
- Unit tests for `resolveAgentTools`'s alias map (Part 1).

## Done means

- `bun install` (if needed), build in dependency order (`packages/orchestrator` before
  `packages/coding-agent` — see commit `63c5b9a6`), `bun test` green across
  `packages/orchestrator` and `packages/coding-agent`, plus whatever lint/typecheck scripts
  `package.json` defines, all green.
- A void subagent spawned via `~/.claude/agents/*.md` (Claude Code tool names) gets a working
  non-empty tool list.
- A void subagent's run is visible and interactive in the Sidebar/`/agents` overlay **on par with
  a claude/codex subagent-tool child**: live transcript, cancel, background-notify. **Corrected**:
  the original bullet also promised "queue-while-running, resume composer" — verified
  unreachable through this seam for any subagent-tool-spawned harness (void, claude, or codex),
  not just void; see the Part 2 item 2 correction. Not delivered here, not a void-specific gap.
- `runVoidChild` and dead void-`"external"` plumbing are deleted, not left dangling.

## Out of scope

- Any new UI component or visual redesign.
- Respawn-from-session-file resume (v1 is live-children-only; leave the `ponytail:` comment).
- Changes to claude/codex harness behavior.
- **Follow-up, explicitly deferred, not started**: giving subagent-tool runs (any harness) a
  resume composer / `kind: "session"` UI would require either unifying `HarnessRunManager`'s
  `Orchestrator` with `ProcessLifetimeOrchestrationHost`'s, or teaching `openChildRun`/
  `agent-runs.ts`'s origin classification and `ChildSessionView` to treat `HarnessRunManager`
  sessions as session-kind targets too. Both are cross-cutting changes affecting all harness
  types, not a void-only fix, and were never actually requested outside this spec's mistaken
  premise that claude/codex already had it. Needs its own scoped design if a human wants it.
