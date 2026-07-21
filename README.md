# void

void is a TypeScript monorepo for building and running AI agents. It includes a terminal coding agent, a provider-neutral agent runtime, a multi-provider LLM API, terminal and web UI libraries, headless child-agent orchestration, and supporting tools for Slack automation and GPU-hosted LLM deployments.

void is a fork of [badlogic/pi-mono](https://github.com/badlogic/pi-mono), renamed and extended with headless child-agent orchestration (`@void/orchestrator`).

## Quick start

Requirements:

- [Bun](https://bun.sh/) 1.3 or newer
- Node.js 20 or newer

Install dependencies, build the coding agent, and run it:

```bash
bun install --frozen-lockfile
bun run build:start
```

To run the built executable directly:

```bash
./packages/coding-agent/dist/void
```

To build and make the executable available as `void` on your PATH:

```bash
bun run build:global
```

To build and link the executable into this project's local bin instead:

```bash
bun run build:local
```

For a one-shot response, use print mode:

```bash
void --print "Explain the files in this repository"
```

See the [`@void/coding-agent` README](packages/coding-agent/README.md) for provider setup, session management, extensions, skills, and the complete CLI reference.

## Packages

| Package | Purpose |
| --- | --- |
| [`@void/ai`](packages/ai) | Unified streaming/tool-calling API across 20+ LLM providers (OpenAI, Anthropic, Google, Bedrock, OpenRouter, local OpenAI-compatible servers, etc.), with OAuth login, cross-provider handoffs, and context serialization |
| [`@void/agent`](packages/agent) | Stateful agent runtime built on `@void/ai`: event-streaming loop, parallel/sequential tool execution, steering and follow-up message queues, custom message types |
| [`@void/coding-agent`](packages/coding-agent) | Terminal coding agent (`void` CLI). Interactive TUI, print/JSON/RPC modes, sessions with branching and compaction, and extensibility via extensions, skills, prompt templates, themes, and installable void packages |
| [`@void/orchestrator`](packages/orchestrator) | TUI-free library for running headless coding-agent CLIs (Claude, Codex, generic, mock) as child processes, with Run/Session tracking, cancellation, native resume, and JSONL transcript persistence |
| [`@void/tui`](packages/tui) | Terminal UI framework: differential rendering, synchronized output, overlays, and built-in components (Editor, Markdown, SelectList, Image, etc.) |
| [`@void/web-ui`](packages/web-ui) | Web components (mini-lit + Tailwind) for building AI chat interfaces: chat panel, artifacts, attachments, IndexedDB-backed storage |
| [`@void/mom`](packages/mom) | Self-managing Slack bot with bash/file tools, Docker sandboxing, persistent memory, custom skills, and scheduled events |
| [`@void/pods`](packages/pods) | CLI for deploying and managing vLLM models on GPU pods (DataCrunch, RunPod, etc.) with automatic tool-calling configuration |

## Configuration

The default global configuration directory is `~/.void`. Project-specific configuration lives in `.void`.

Set `VOID_CODING_AGENT_DIR` to use a different global configuration directory. Product-owned environment variables use the `VOID_` prefix.

Provider credentials and coding-agent configuration are documented in the [`@void/coding-agent` README](packages/coding-agent/README.md).

## Development

Build the workspace:

```bash
bun run build
```

Run type checking and repository checks:

```bash
bun run check
```

Build the standalone orchestrator package when working on it directly:

```bash
bun --cwd packages/orchestrator run build
```

Run a focused package command from that package's directory. For example:

```bash
bun --cwd packages/coding-agent test
```

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for contribution workflow and [`AGENTS.md`](AGENTS.md) for repository-specific development rules.

## License

MIT
