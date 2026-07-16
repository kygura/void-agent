# void — TypeScript specification

## Product

`void` is a Bun-powered TypeScript coding agent. It retains the complete pi-mono coding-agent stack and the owner's committed customizations, while adding provider-agnostic orchestration of headless coding-agent CLIs.

The existing direct-model agent remains the focused parent agent: it owns the coding loop, tools, model APIs, terminal TUI, sessions, extensions, web UI, and the other monorepo packages. The new orchestration path runs `claude`, `codex`, generic configured commands, and a built-in mock as child processes. Child output is normalized, shown beside the parent session, and persisted independently.

The Go repository at `/home/athan/projects/agents/void` is a read-only behavioral reference. It is never imported, generated into, or modified.

## Identity and runtime

- Workspace packages are renamed as follows: `@mariozechner/pi-ai` → `@void/ai`, `@mariozechner/pi-agent-core` → `@void/agent`, `@mariozechner/pi-coding-agent` → `@void/coding-agent`, and likewise `@void/tui`, `@void/web-ui`, `@void/mom`, and `@void/pods`. The new package is `@void/orchestrator`.
- The application and executable are named `void`; the compiled Bun executable is `packages/coding-agent/dist/void`.
- The canonical global configuration root is `~/.void`. Project-local configuration uses `.void`.
- `VOID_CODING_AGENT_DIR` overrides the global configuration root. New product-owned environment variables use the `VOID_` prefix.
- Bun is the runtime and package manager. The repository has one authoritative `bun.lock`; normal development uses `bun install`, `bun run …`, and Bun-backed tests. Existing publish/release behavior is not expanded in v1.
- No existing pi capability or committed local customization is intentionally removed. Extension package manifests may use the new `void` key; the legacy `pi` manifest key remains readable because migrated extensions require it, with `void` taking precedence when both exist.

## One-time pi configuration migration

At startup, before normal void migrations load configuration, void performs an idempotent copy migration from `~/.pi/agent` to `~/.void`.

Only these entries are copied:

- `settings.json`
- `extensions/`
- `chains/`
- `APPEND_SYSTEM.md`

The source is never renamed, deleted, truncated, chmodded, or otherwise mutated. Existing destination entries win and are never overwritten. Directories are merged by copying only missing descendants. Symlinks are copied as symlinks rather than followed. `~/.void` is owner-only; copied settings retain owner-only file permissions. A migration marker is written only after every requested copy succeeds. Partial failure produces a non-fatal startup warning and is retried next launch. Tests compare the source tree before and after migration and cover an existing destination, a partial retry, and a missing source.

Credentials, auth files, model registries, sessions, binaries, and unspecified project-local `.pi` data are not migrated.

## Domain model and module seams

The following names are canonical in code, tests, docs, and UI copy:

- **Provider** — an external coding-agent CLI invocation contract plus its Adapter. A Provider starts one Run and may advertise resume support.
- **Adapter** — the parser that converts raw provider stdout into normalized Events.
- **Run** — one provider invocation from start through exit.
- **Session** — an ordered chain of Runs for one Provider, carrying its provider-native resume identifier.
- **Event** — one normalized item from a Run.
- **Orchestrator** — the pure library module that starts, tracks, cancels, resumes, and fans in Runs.
- **TaskRun** — a named, fire-and-forget background Run that is not attached to a Session.
- **Transcript** — the ordered, persisted Event history for a Session or the rendered history of a Run.

`@void/orchestrator` is a deep, pure library module. Its public interface is the test seam. It has no imports from `@void/tui`, `@void/coding-agent`, or interactive components. It exposes typed configuration, snapshots, subscription, start/resume/cancel/close operations, and Provider registration/resolution. Process mechanics, parser state, mutable maps, locks, and persistence details stay inside the module.

The coding-agent integration is an Adapter at the existing extension seam. It may depend on `@void/orchestrator`; the orchestrator package never depends back on it.

## Normalized Event contract

Events retain the Go void JSON field names so recorded fixtures and persisted transcripts are directly comparable:

- `started`: `providerSessionId` when learned.
- `text`: incremental `text`.
- `thinking`: incremental `text`.
- `tool`: `tool`, `detail`, and `done`.
- `result`: final `text`, `isError`, and optional `usage` (`inputTokens`, `outputTokens`, `costUsd`).
- `exit`: `exitCode`.
- `subagentResult`: `childSessionId`, `childName`, terminal `state`, final `text`, and elapsed duration. This is synthesized by integration/persistence, never by a Provider Adapter.

Wire compatibility is exact rather than approximate. Go `time.Duration` values, including `subagentResult` elapsed duration, are JSON integers measured in nanoseconds. Timestamps use Go-compatible RFC 3339 encoding, and optional fields follow the Go fixtures' omission behavior rather than being emitted as `null`. Fixture tests compare serialized records byte-for-byte where object-key order is defined by the writer.

Every started Run terminates with exactly one `result` and one `exit`. If a structured provider exits without a result, the process layer synthesizes one. Non-zero exit, launch failure, missing binary, stream read failure, and parser failure become terminal Events and a failed Run; they do not throw across the Orchestrator/extension seam. Unknown JSONL event types are skipped. A non-JSON line on a structured stream becomes a raw `text` Event. Per-Run Event order is preserved. Cross-Run fan-in order is the order Events are observed, with no dropped terminal Events.

## Providers and process safety

All external processes are launched with `Bun.spawn` using an argv array. No provider invokes a shell. A prompt is one discrete argv element, or explicit stdin where a Provider contract requires it. Generic templates replace only an argument exactly equal to `{{prompt}}`; substring interpolation is invalid.

The process module pipes stdout and stderr, bounds retained stderr and individual line size, drains both streams, and always reaps the child. Cancellation sends SIGTERM and escalates to SIGKILL after a bounded grace period. On POSIX, the child is placed in its own process group and the group is signalled so grandchildren are not orphaned. Closing the Orchestrator cancels and awaits all live Runs before completing.

### Claude

Invocation starts with:

`claude -p <prompt> --output-format stream-json --verbose --include-partial-messages`

It adds `--resume <providerSessionId>` and `--model <model>` when set, followed by configured `extraArgs`. The Adapter parses Claude stream-json JSONL. Incremental stream events are the text/thinking source; full assistant messages are used for tool activity without duplicating text.

### Codex

A new Run starts with `codex exec <prompt> --json`; a resumed Run uses `codex exec resume <providerSessionId> <prompt> --json`. It adds `-m <model>`, `-C <workdir>`, and configured `extraArgs` when set. The Adapter parses the recorded Codex JSONL fixture and tolerates unknown newer event kinds.

### Generic

A generic Provider is defined by `command`, `args`, optional `model`, `modelFlag`, `effort`, `effortFlag`, `models`, `extraArgs`, `env`, and `auth`. `auth` is the Go-compatible mode string `auto`, `subscription`, or `api`; the empty/default value selects automatic behavior. Exactly one argv element in `args` must be `{{prompt}}`. Model and effort values are inserted only through their configured discrete argv flags; they are never interpolated into a shell string. Output is plain text. Generic Providers are not resumable in v1 because their resume contracts are unknown.

The built-in generic definitions include `pi` and `opencode` alongside Claude, Codex, and mock. Their invocation, model, effort, discovery, and authentication contracts match the Go reference. Mock remains an additional TypeScript-only built-in for deterministic tests and demonstrations.

### Child CLI authentication

Child-process authentication is separate from pi's direct-model credentials. The orchestration host ports Go void's auth status, login, cache, credential-store, and platform-keychain behavior for supported child CLIs. `/login [provider]` reports status and starts the provider's supported login flow without exposing tokens. Claude OAuth and Codex device login remain provider adapters behind one authentication interface. Codex status parsing is line-scoped: an affirmative status line is required, negative evidence wins, and stderr is included where the CLI writes status there. Generic and mock Providers have no login command contract in v1; their optional `auth` field only selects the Go-compatible effective authentication mode.

Authentication failures are diagnostics and terminal Run Events, not uncaught exceptions. Automated tests use fixtures and fake executables only; they never read or mutate live credentials or keychains.

### Mock

The mock Provider has no child process. It emits scripted Events, supports controllable delay/failure/resume behavior, and is production code used by tests and the no-credential demonstration.

## Configuration

Provider configuration lives in `~/.void/settings.json` under `orchestrator`:

```json
{
  "orchestrator": {
    "defaultProvider": "claude",
    "providers": {
      "claude": {
        "type": "claude",
        "models": ["claude-fable-5", "claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5"]
      },
      "codex": { "type": "codex" },
      "pi": {
        "type": "generic",
        "command": "pi",
        "args": ["-p", "{{prompt}}"],
        "modelFlag": "--model",
        "effortFlag": "--thinking"
      },
      "opencode": {
        "type": "generic",
        "command": "opencode",
        "args": ["run", "{{prompt}}"],
        "modelFlag": "-m",
        "effortFlag": "--variant"
      },
      "gemini": {
        "type": "generic",
        "command": "gemini",
        "args": ["-p", "{{prompt}}"],
        "modelFlag": "--model",
        "effortFlag": "--effort",
        "models": ["gemini-2.5-pro"],
        "extraArgs": ["--yolo"],
        "env": ["GEMINI_API_KEY=..."]
      }
    }
  }
}
```

The schema matches Go void's `defaultProvider + providers` document inside the `orchestrator` key, including `modelFlag`, `effortFlag`, `effort`, `models`, and the `auth` mode. Provider types are `claude`, `codex`, `generic`, and `mock`. A missing key supplies the exact Go defaults: claude with its ordered model list, codex, pi with `--model`/`--thinking`, and opencode with `-m`/`--variant`; `defaultProvider` is claude. Mock is a supported TypeScript-only Provider but is not injected into the default configuration. The default provider must exist. Generic commands, the exact-one prompt placeholder rule, model/effort flags, and Provider `env` entries are validated before spawn. Environment entries use `KEY=VALUE`, overlay the parent environment, and are never logged. Invalid configuration is reported as a startup diagnostic; it does not corrupt or rewrite settings.

The orchestrator discovers available child models through provider-specific CLI output when supported, merges them with configured `models`, and keeps a bounded most-recently-used list per Provider. A Session may select a child model and reasoning effort for its next Run. Switching Provider clears incompatible resume, model, and effort state. Selection affects child Runs only and never changes the parent direct-model agent.

### Intentional TypeScript divergences from the Go reference

- Provider configuration is embedded under `orchestrator` in `~/.void/settings.json` instead of using Go void's standalone `~/.void/config.json`.
- `mock` is a supported production Provider for deterministic tests and demonstrations, but it is not added to the exact Go default Provider map.
- Generic argv validation is stricter: TypeScript requires exactly one discrete `{{prompt}}` argument and validates flags/environment entries before spawn; Go only requires a non-empty generic command.
- Unsupported generic resume produces an inspectable failed Run instead of Go void's warning followed by a fresh chain.
- TypeScript exposes a distinct `TaskRun` snapshot for a sessionless Run and a callback subscription interface; Go represents a TaskRun as `Run.SessionID == ""` and exposes a fan-in channel.
- The existing pi-derived parent TUI replaces the standalone Go Bubble Tea shell and follows the visual divergences recorded in `DESIGN.md`.

## Orchestration and persistence

The Orchestrator tracks pending, running, done, failed, and cancelled Runs; live Sessions; TaskRuns; start/end time; last activity; Provider; prompt; selected model/effort; and final output. It supports multiple concurrent Runs, one ordered fan-in stream, cancellation, Session resume, and orderly shutdown.

Each Session permits exactly one live Run. Submitting while that Run is live enqueues the prompt FIFO; completion or cancellation atomically starts the oldest queued prompt. Removing a queued prompt removes the newest queued item, matching Go void. Queue operations, Run completion, cancellation, and Session close share one serialization discipline so a prompt is never started twice, skipped, or started after close. Queue state is visible in snapshots and covered by repeated race tests.

A coding-agent parent session uses its existing session ID as the top-level orchestration Session ID. `/spawn` creates persisted child Sessions with `parentSessionId` pointing to that ID. Provider session IDs learned from `started` Events are stored on the child Session and used by later resume Runs. Multiple child Sessions may run simultaneously. TaskRuns are process-lifetime background work, matching Go void: they are shown live but are not persisted or resumable.

Session transcripts live at `~/.void/orchestrator/sessions/<session-id>.json`. Despite the `.json` suffix, each file is the same append-only JSONL shape as Go void:

- metadata line: `{ "meta": { "id", "provider", "providerSessionId", "name", "parentSessionId", "created" } }`
- prompt line: `{ "runId", "prompt" }`
- event line: `{ "runId", "event": { ...normalized Event... } }`

The latest metadata line wins. Event order is append order. Completed earlier Runs survive a crash during a later Run. A truncated final line is skipped with a reported warning; valid preceding data remains usable. The store uses owner-only directory/file modes. Reads, metadata updates, parent-result appends, and Event appends share one per-session serialization discipline so a read can never observe a half-written append. The cross-stream regression from Go void's final commit is ported: event appends racing a load/rename/parent-result path must not produce torn or lost records.

## Coding-agent extension integration

A built-in extension is loaded through `DefaultResourceLoader`'s existing `extensionFactories` path, even when user extensions are disabled. A process-lifetime host owns the Orchestrator so background Runs survive coding-agent session switches; each active extension instance attaches/detaches its UI subscription without closing the host.

Commands:

- `/spawn <provider> <prompt>` — create a persisted child Session and start its first Run. Repeating this while other children run is fan-out.
- `/run <provider> <prompt>` — start a named process-lifetime TaskRun.
- `/agent-resume <session-id> <prompt>` — resume a persisted child Session using its Provider session ID.
- `/provider [name]` — show or select the child-run default Provider for the current parent session.
- `/cancel <run-id-or-session-id>` — cancel the matching live Run.
- `/agents` — show Runs grouped by the current parent Session, with standalone TaskRuns grouped separately.
- `/login [provider]` — inspect or initiate child-CLI authentication through the Provider auth adapter.
- `/agent-model [provider] [model]` — show or arm a child model; selection commits to the next child Run and is tracked in Provider MRU state.
- `/agent-effort [level]` — show or arm child reasoning effort for the next Run.

`/spawn` also accepts a discovered Claude agent preset and a count from 1 through 8. Presets are discovered from user and project `.claude/agents/*.md`; project definitions override user definitions of the same name, names beginning with `_` and `user-invocable: false` are excluded, and preset model/system-prompt metadata is honored. Count fan-out creates independent child Sessions with stable names and parentage.

The names `/agent-resume` and `/run` avoid changing the existing parent-agent `/resume` behavior. Argument completion lists configured Providers and known child Sessions where applicable. Invalid arguments and unknown IDs produce concise UI errors and do not start work.

At spawn time the extension appends exactly one non-triggering `void:spawn` custom message to the parent transcript. Its stable child Session ID lets the registered message renderer resolve current state from the live registry or restored store, so the same entry progresses from pending through its terminal result without moving or duplicating. `pi.appendEntry` persists extension ownership/status data that is not sent to the LLM. The sidebar, `/agents` overlay, provider footer status, notifications, and inline renderer use the existing extension UI/widget surfaces specified by `DESIGN.md`; no parallel rendering framework is introduced.

`/agents`, live inline entries, sidebar presentation, focus/cancel interactions, and narrow-terminal behavior follow the root `DESIGN.md`. Existing pi TUI idioms, components, keybindings, and the owner's agent/sidebar customizations are reused rather than replaced.

## Core user flows

### Spawn and fan out

1. The user enters `/spawn claude review the auth changes`.
2. The extension validates the Provider and prompt, ensures the parent orchestration Session exists, and asks the Orchestrator to create a child Session.
3. The Claude Provider builds argv, Bun starts the child, and its Adapter emits normalized Events.
4. The existing inline spawn entry, sidebar, and `/agents` view update from the fan-in stream while the append store persists the child transcript.
5. Terminal state produces a `subagentResult` in the orchestration parent and updates that same coding-agent spawn entry to its final state.
6. Additional `/spawn` commands run concurrently and complete independently.

### Resume

1. A child `started` Event records the Provider session ID.
2. The user enters `/agent-resume <child-session-id> continue with the failing tests`.
3. A new Run is appended to the same child Session with the provider-native resume argument.
4. Generic Sessions reject resume with a terminal failed Run/Event rather than an exception.

### Background TaskRun and cancel

1. `/run codex inspect dependency drift` starts a TaskRun not attached to a Session.
2. `/agents` shows it under background work.
3. `/cancel <id>` requests termination, escalates if necessary, and ends it in `cancelled` state without affecting other Runs or the parent agent.

### Restart and restore

1. On startup the store loads valid child Session metadata and transcripts.
2. `/agents` groups restored children under the matching coding-agent session ID.
3. A resumable restored child can receive `/agent-resume`; already terminal historical Runs remain read-only.

## Observable definition of done

The implementation is done only when all of the following are green from a clean checkout with no live provider calls or paid tokens:

```sh
bun install --frozen-lockfile
bun run check
bun run build
bun run test
bun --cwd packages/orchestrator test
bun --cwd packages/coding-agent run build:binary
./packages/coding-agent/dist/void --version
```

The following focused coding-agent regression also passes from `packages/coding-agent`:

```sh
bun ../../node_modules/vitest/dist/cli.js --run test/suite/orchestrator-spawn.test.ts
```

The automated suite proves:

- package imports and workspace links use `@void/*`; the compiled executable is `void`;
- pi migration copies only the approved entries, never mutates the source, and is idempotent;
- Claude and Codex recorded fixtures produce the expected Event sequence; generic parsing and argv injection safety are covered;
- missing binaries, malformed lines, non-zero exits, cancellation, and stream failures terminate as Events without an uncaught exception;
- fan-in preserves each Run's order, does not drop terminal Events, and isolates one failed Run from others;
- resume passes the stored Provider session ID for Claude and Codex and refuses unsupported generic resume safely;
- live-Session prompt submission is FIFO, remove-newest is deterministic, and repeated completion/cancel/dequeue races never duplicate or lose a prompt;
- the store restores the exact Go-compatible JSONL shape, tolerates a corrupt tail, and passes concurrent append/load/parent-result tests;
- serialized elapsed durations use integer nanoseconds; timestamps and omitted fields match recorded Go fixtures;
- child auth uses fake CLIs/keychains, includes the Codex negative-precedence stderr regression, and never exposes credentials;
- model/effort flags are discrete argv elements, discovery plus MRU is deterministic, and Provider switches clear incompatible state;
- Claude preset discovery obeys precedence/filtering and `/spawn` count 1–8 fans out the requested number of independent children;
- `/spawn mock <prompt>` produces one persistent inline child message that reaches a terminal result in the parent transcript using the suite harness and faux parent Provider;
- two delayed mock spawns run concurrently, `/agents` groups them, and cancelling one leaves the other running;
- restored mock child Sessions remain visible and resumable in the test fixture;
- the shipped TUI implementation matches `DESIGN.md` in normal and narrow layouts.

A manual demonstration with the normal TUI must also be possible:

1. launch `packages/coding-agent/dist/void`;
2. run two `/spawn mock …` commands before the first finishes;
3. observe both in `/agents`, cancel one, and see the other's result in the parent transcript;
4. restart void and observe the persisted child under the same parent session;
5. when authenticated CLIs are available, spawn and resume one Claude and one Codex child and run one configured generic Provider.

No real Claude/Codex invocation, credential, or network access is part of the automated done gate.

## Out of scope for v1

- npm publication or new release automation
- a second standalone TUI or replacement of pi's parent agent loop
- PTY embedding of interactive child CLIs
- shell-based command templates
- generic-provider resume guessing
- inter-agent message routing
- git worktree management
- remote/server mode or SQLite
- modifying or importing the Go reference repository
