# void

void is a TypeScript monorepo for building and running AI agents. It includes a terminal coding agent, a provider-neutral agent runtime, a multi-provider LLM API, terminal and web UI libraries, and supporting tools.

## Quick start

Requirements:

- [Bun](https://bun.sh/) 1.3 or newer
- Node.js 20 or newer

Install dependencies, build the coding agent, and run it:

```bash
bun install --frozen-lockfile
bun run start:build
```

To run the built executable directly:

```bash
./packages/coding-agent/dist/void
```

To make the executable available as `void` on your PATH:

```bash
bun run install:global
```

## Packages

| Package | Purpose |
| --- | --- |
| [`@void/ai`](packages/ai) | Unified API for working with multiple LLM providers |
| [`@void/agent`](packages/agent) | Agent runtime, tool calling, and state management |
| [`@void/coding-agent`](packages/coding-agent) | Interactive coding agent and CLI |
| [`@void/orchestrator`](packages/orchestrator) | Headless orchestration of provider-neutral child agents |
| [`@void/tui`](packages/tui) | Terminal UI components and differential rendering |
| [`@void/web-ui`](packages/web-ui) | Web components for AI interfaces |
| [`@void/mom`](packages/mom) | Slack bot integration for the coding agent |
| [`@void/pods`](packages/pods) | CLI for managing vLLM deployments on GPU pods |

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
