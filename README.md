<!-- OSS_WEEKEND_START -->
# 🏖️ OSS Weekend

**Issue tracker reopens Monday, April 13, 2026.**

OSS weekend runs Thursday, April 2, 2026 through Monday, April 13, 2026. New issues and PRs from unapproved contributors are auto-closed during this time. Approved contributors can still open issues and PRs if something is genuinely urgent, but please keep that to pressing matters only. For support, join [Discord](https://discord.com/invite/3cU7Bz4UPx).

> _Current focus: at the moment i'm deep in refactoring internals, and need to focus._
<!-- OSS_WEEKEND_END -->

---

<p align="center">
  <a href="https://shittycodingagent.ai">
    <img src="https://shittycodingagent.ai/logo.svg" alt="void logo" width="128">
  </a>
</p>
<p align="center">
  <a href="https://discord.com/invite/3cU7Bz4UPx"><img alt="Discord" src="https://img.shields.io/badge/discord-community-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
  <a href="https://github.com/badlogic/pi-mono/actions/workflows/ci.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/badlogic/pi-mono/ci.yml?style=flat-square&branch=main" /></a>
</p>
<p align="center">
  <a href="https://pi.dev">pi.dev</a> domain graciously donated by
  <br /><br />
  <a href="https://exe.dev"><img src="packages/coding-agent/docs/images/exy.png" alt="Exy mascot" width="48" /><br />exe.dev</a>
</p>

# void Monorepo

> **Looking for the void coding agent?** See **[packages/coding-agent](packages/coding-agent)** for installation and usage.

void preserves the pi-mono stack and its authorship history while using void product and package identities.

Tools for building AI agents and managing LLM deployments.

## Identity and configuration

The application and compiled executable are named `void`. Workspace packages use the `@void/*` scope, the global configuration root is `~/.void`, and project-local configuration uses `.void`. Set `VOID_CODING_AGENT_DIR` to use a different global root. Product-owned environment variables use the `VOID_` prefix.

## Packages

| Package | Description |
|---------|-------------|
| **[@void/ai](packages/ai)** | Unified multi-provider LLM API (OpenAI, Anthropic, Google, etc.) |
| **[@void/agent](packages/agent)** | Agent runtime with tool calling and state management |
| **[@void/coding-agent](packages/coding-agent)** | Interactive coding agent CLI |
| **[@void/orchestrator](packages/orchestrator)** | Headless, provider-agnostic child orchestration |
| **[@void/mom](packages/mom)** | Slack bot that delegates messages to the void coding agent |
| **[@void/tui](packages/tui)** | Terminal UI library with differential rendering |
| **[@void/web-ui](packages/web-ui)** | Web components for AI chat interfaces |
| **[@void/pods](packages/pods)** | CLI for managing vLLM deployments on GPU pods |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and [AGENTS.md](AGENTS.md) for project-specific rules (for both humans and agents).

## Development

```bash
bun install --frozen-lockfile
bun run build
bun --cwd packages/orchestrator run build
bun run check
bun run test
bun --cwd packages/orchestrator test
bun --cwd packages/coding-agent run build:binary
./packages/coding-agent/dist/void --version
```

`bun run build` follows the root script and builds the existing application packages; the explicit orchestrator build covers the standalone library package. `bun run check` requires the package builds first because the web-ui package checks against compiled dependency declarations.

## License

MIT
