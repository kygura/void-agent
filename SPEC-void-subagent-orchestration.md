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

2. **Subagent tool rewiring** — `packages/coding-agent/src/core/tools/subagent.ts`. Read the
   current `execute()` body first (the harness-branch dispatch, including the `"void"` case,
   wasn't fully visible during spec drafting — confirm the exact current branch before editing,
   do not assume the line number). Change the `"void"` branch to do what the claude/codex
   branches already do: create/reuse an orchestrator session via
   `harnessRunManager.newSession("void")`, call `harnessRunManager.startRun("void", cfg,
   sessionId)`, and reuse the existing `waitForHarnessRun` (`subagent.ts:181`) and
   `harnessOutcome` (`subagent.ts:199`) helpers for both foreground (await) and background
   (fire-and-forget + `notifyParent`) results — same as the claude/codex path already does.
   Populate `harnessRunId` on the `SubagentRunRecord` (`subagent.ts:26`) so `openChildRun`
   (`interactive-mode.ts:2428`) routes void children to the rich `kind: "session"`
   `ChildSessionView`, same as claude/codex children. Delete `runVoidChild` (`subagent.ts:145`)
   and any void-specific `kind: "external"` plumbing that becomes dead once this lands — grep
   `interactive-mode.ts` and `agent-runs.ts` for callers before deleting anything.

3. **`ProviderType` union** — add `"void"` to `packages/orchestrator/src/types.ts:38`
   (`export type ProviderType = "claude" | "codex" | "generic" | "mock";` → add `"void"`).
   This is what makes `getChildComposerRoute` (`child-session-view.ts:43`) treat void children as
   resumable instead of falling through to `generic`'s `disabled` branch. Grep the repo for
   exhaustive `switch`/matching over `ProviderType` (e.g. `packages/orchestrator/src/config.ts`,
   `packages/coding-agent/src/modes/interactive/components/agent-runs.ts`) and add the `"void"`
   case everywhere TypeScript's exhaustiveness check would otherwise fail to compile — do not
   leave a silent fallthrough.

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
  void child (`kind: "session"`, not `"external"`) and submitting a follow-up through the resume
  composer.
- Unit tests for `resolveAgentTools`'s alias map (Part 1).

## Done means

- `bun install` (if needed), build in dependency order (`packages/orchestrator` before
  `packages/coding-agent` — see commit `63c5b9a6`), `bun test` green across
  `packages/orchestrator` and `packages/coding-agent`, plus whatever lint/typecheck scripts
  `package.json` defines, all green.
- A void subagent spawned via `~/.claude/agents/*.md` (Claude Code tool names) gets a working
  non-empty tool list.
- A void subagent's run is visible and interactive in the Sidebar/`/agents` overlay exactly like a
  claude/codex child: live transcript, cancel, queue-while-running, resume composer.
- `runVoidChild` and dead void-`"external"` plumbing are deleted, not left dangling.

## Out of scope

- Any new UI component or visual redesign.
- Respawn-from-session-file resume (v1 is live-children-only; leave the `ponytail:` comment).
- Changes to claude/codex harness behavior.
