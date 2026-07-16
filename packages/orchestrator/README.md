# @void/orchestrator

`@void/orchestrator` is the TUI-free library for running headless coding-agent Providers as child processes. It tracks Runs and Sessions, normalizes Provider output into Events, supports cancellation and native resume, fans in concurrent work, and persists child Session transcripts.

The package is part of the Bun workspace and is used by the built-in orchestration extension in `@void/coding-agent`.

## Development

From the repository root:

```bash
bun install --frozen-lockfile
bun --cwd packages/orchestrator run build
bun --cwd packages/orchestrator test
```

Tests use the built-in mock Provider and recorded Claude/Codex fixtures. They do not call external Providers, use credentials, or spend paid tokens.

## Providers

The Provider contract starts one Run and yields normalized Events. Built-in process-backed Providers are:

- `claude` — invokes the `claude` CLI with stream-json output and supports Provider-native resume.
- `codex` — invokes `codex exec --json` and supports Provider-native resume.
- `generic` — invokes a configured executable with plain-text output. Generic resume is not supported in v1.
- `mock` — emits scripted Events without a child process; use it for deterministic tests and demonstrations.

Claude and Codex require their CLIs to be installed and authenticated before a real Run. The coding-agent `/login [provider]` command checks status or starts the supported login flow. Generic Providers use the executable's own prerequisites and have no library login contract. Child authentication is separate from direct-model credentials.

All process launches use Bun argv arrays. No Provider invokes a shell. A generic `args` array must contain exactly one element equal to `{{prompt}}`; the prompt is passed as that single argument. Model and effort values are inserted only through configured discrete flags.

Example generic configuration:

```json
{
  "orchestrator": {
    "defaultProvider": "reviewer",
    "providers": {
      "reviewer": {
        "type": "generic",
        "command": "reviewer-cli",
        "args": ["run", "{{prompt}}"],
        "modelFlag": "--model",
        "effortFlag": "--effort",
        "models": ["reviewer-default"],
        "env": ["REVIEWER_API_KEY=..."]
      },
      "mock": { "type": "mock" }
    }
  }
}
```

The coding-agent settings loader reads this object from `~/.void/settings.json` or `.void/settings.json` and validates it before any child process starts. See [the settings schema](../coding-agent/docs/settings.md#child-orchestration).

## Persistence

The coding-agent host stores child Sessions at:

```text
~/.void/orchestrator/sessions/<session-id>.json
```

The `.json` suffix contains append-only JSONL records:

```json
{"meta":{"id":"...","provider":"claude","providerSessionId":"...","name":"...","parentSessionId":"...","created":"..."}}
{"runId":"...","prompt":"review the changes"}
{"runId":"...","event":{"kind":"text","text":"..."}}
```

Metadata records are replace-on-read: the latest metadata line wins. Prompt and Event records remain in append order. A corrupt or truncated tail is skipped with a warning, and valid preceding records remain usable. The store serializes reads and appends per Session and uses owner-only directory and file modes. TaskRuns are process-lifetime work and are not persisted.

## Extension architecture

The library does not import `@void/tui` or `@void/coding-agent`. The coding-agent integration is an adapter at the existing extension seam:

1. A process-lifetime host owns the Orchestrator and survives parent session switches.
2. `DefaultResourceLoader` injects the built-in extension through `extensionFactories`, even when user extensions are disabled.
3. Each active extension instance attaches or detaches its UI subscription without closing the host.
4. A spawn appends one non-triggering `void:spawn` message and `void:spawn-state` ownership entries to the parent transcript.
5. The registered renderer resolves the same child Session ID from the live registry or restored store; the sidebar, `/agents` overlay, child-session view, footer, and notifications render through existing coding-agent UI surfaces.

The library remains the test seam for Provider resolution, process safety, Run and Session state, subscriptions, cancellation, resume, and persistence.
