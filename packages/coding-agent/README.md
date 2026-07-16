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
  <a href="https://www.npmjs.com/package/@void/coding-agent"><img alt="npm" src="https://img.shields.io/npm/v/@void/coding-agent?style=flat-square" /></a>
  <a href="https://github.com/badlogic/pi-mono/actions/workflows/ci.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/badlogic/pi-mono/ci.yml?style=flat-square&branch=main" /></a>
</p>
<p align="center">
  <a href="https://pi.dev">pi.dev</a> domain graciously donated by
  <br /><br />
  <a href="https://exe.dev"><img src="docs/images/exy.png" alt="Exy mascot" width="48" /><br />exe.dev</a>
</p>

void is a minimal terminal coding harness. Adapt void to your workflows, not the other way around, without having to fork and modify void internals. Extend it with TypeScript [Extensions](#extensions), [Skills](#skills), [Prompt Templates](#prompt-templates), and [Themes](#themes). Put your extensions, skills, prompt templates, and themes in [void Packages](#void-packages) and share them with others via npm or git.

void includes a built-in process-lifetime orchestration extension for running headless child coding agents alongside the parent session. It also supports the existing interactive, print or JSON, RPC, and SDK modes.

See [openclaw/openclaw](https://github.com/openclaw/openclaw) for a real-world SDK integration.

## Table of Contents

- [Quick Start](#quick-start)
- [Providers & Models](#providers--models)
- [Interactive Mode](#interactive-mode)
  - [Editor](#editor)
  - [Commands](#commands)
  - [Keyboard Shortcuts](#keyboard-shortcuts)
  - [Message Queue](#message-queue)
- [Child Orchestration](#child-orchestration)
- [Sessions](#sessions)
  - [Branching](#branching)
  - [Compaction](#compaction)
- [Settings](#settings)
- [Context Files](#context-files)
- [Customization](#customization)
  - [Prompt Templates](#prompt-templates)
  - [Skills](#skills)
  - [Extensions](#extensions)
  - [Themes](#themes)
  - [void Packages](#void-packages)
- [Programmatic Usage](#programmatic-usage)
- [Philosophy](#philosophy)
- [CLI Reference](#cli-reference)

---

## Quick Start

```bash
bun install -g @void/coding-agent
```

Authenticate with an API key:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
void
```

Or use your existing subscription:

```bash
void
/login  # Then select provider
```

Then just talk to void. By default, void gives the model four tools: `read`, `write`, `edit`, and `bash`. The model uses these to fulfill your requests. Add capabilities via [skills](#skills), [prompt templates](#prompt-templates), [extensions](#extensions), or [void packages](#void-packages).

**Platform notes:** [Windows](docs/windows.md) | [Termux (Android)](docs/termux.md) | [tmux](docs/tmux.md) | [Terminal setup](docs/terminal-setup.md) | [Shell aliases](docs/shell-aliases.md)

---

## Providers & Models

For each built-in provider, void maintains a list of tool-capable models, updated with every release. Authenticate via subscription (`/login`) or API key, then select any model from that provider via `/model` (or Ctrl+L).

**Subscriptions:**
- Anthropic Claude Pro/Max
- OpenAI ChatGPT Plus/Pro (Codex)
- GitHub Copilot
- Google Gemini CLI
- Google Antigravity

**API keys:**
- Anthropic
- OpenAI
- Azure OpenAI
- Google Gemini
- Google Vertex
- Amazon Bedrock
- Mistral
- Groq
- Cerebras
- xAI
- OpenRouter
- Vercel AI Gateway
- ZAI
- OpenCode Zen
- OpenCode Go
- Hugging Face
- Kimi For Coding
- MiniMax

See [docs/providers.md](docs/providers.md) for detailed setup instructions.

**Custom providers & models:** Add providers via `~/.void/models.json` if they speak a supported API (OpenAI, Anthropic, Google). For custom APIs or OAuth, use extensions. See [docs/models.md](docs/models.md) and [docs/custom-provider.md](docs/custom-provider.md).

---

## Interactive Mode

<p align="center"><img src="docs/images/interactive-mode.png" alt="Interactive Mode" width="600"></p>

The interface from top to bottom:

- **Startup header** - Shows shortcuts (`/hotkeys` for all), loaded AGENTS.md files, prompt templates, skills, and extensions
- **Messages** - Your messages, assistant responses, tool calls and results, notifications, errors, and extension UI
- **Editor** - Where you type; border color indicates thinking level
- **Footer** - Working directory, session name, total token/cache usage, cost, context usage, current model

The editor can be temporarily replaced by other UI, like built-in `/settings` or custom UI from extensions (e.g., a Q&A tool that lets the user answer model questions in a structured format). [Extensions](#extensions) can also replace the editor, add widgets above/below it, a status line, custom footer, or overlays.

### Editor

| Feature | How |
|---------|-----|
| File reference | Type `@` to fuzzy-search project files |
| Path completion | Tab to complete paths |
| Multi-line | Shift+Enter (or Ctrl+Enter on Windows Terminal) |
| Images | Ctrl+V to paste (Alt+V on Windows), or drag onto terminal |
| Bash commands | `!command` runs and sends output to LLM, `!!command` runs without sending |

Standard editing keybindings for delete word, undo, etc. See [docs/keybindings.md](docs/keybindings.md).

### Commands

Type `/` in the editor to trigger commands. [Extensions](#extensions) can register custom commands, [skills](#skills) are available as `/skill:name`, and [prompt templates](#prompt-templates) expand via `/templatename`.

| Command | Description |
|---------|-------------|
| `/login`, `/logout` | OAuth authentication |
| `/model` | Switch models |
| `/scoped-models` | Enable/disable models for Ctrl+P cycling |
| `/settings` | Thinking level, theme, message delivery, transport |
| `/resume` | Pick from previous sessions |
| `/new`, `/clear` | Start a new session |
| `/name <name>` | Set session display name |
| `/session` | Show session info (path, tokens, cost) |
| `/tree` | Jump to any point in the session and continue from there |
| `/fork` | Create a new session from the current branch |
| `/compact [prompt]` | Manually compact context, optional custom instructions |
| `/copy` | Copy last assistant message to clipboard |
| `/export [file]` | Export session to HTML file |
| `/share` | Upload as private GitHub gist with shareable HTML link |
| `/reload` | Reload keybindings, extensions, skills, prompts, and context files (themes hot-reload automatically) |
| `/hotkeys` | Show all keyboard shortcuts |
| `/changelog` | Display version history |
| `/quit` | Quit void |

### Keyboard Shortcuts

See `/hotkeys` for the full list. Customize via `~/.void/keybindings.json`. See [docs/keybindings.md](docs/keybindings.md).

**Commonly used:**

| Key | Action |
|-----|--------|
| Ctrl+C | Clear editor |
| Ctrl+C twice | Quit |
| Escape | Cancel/abort |
| Escape twice | Open `/tree` |
| Ctrl+L | Open model selector |
| Ctrl+P / Shift+Ctrl+P | Cycle scoped models forward/backward |
| Shift+Tab | Cycle thinking level |
| Ctrl+O | Collapse/expand tool output |
| Ctrl+T | Collapse/expand thinking blocks |

### Message Queue

Submit messages while the agent is working:

- **Enter** queues a *steering* message, delivered after the current assistant turn finishes executing its tool calls
- **Alt+Enter** queues a *follow-up* message, delivered only after the agent finishes all work
- **Escape** aborts and restores queued messages to editor
- **Alt+Up** retrieves queued messages back to editor

On Windows Terminal, `Alt+Enter` is fullscreen by default. Remap it in [docs/terminal-setup.md](docs/terminal-setup.md) so void can receive the follow-up shortcut.

Configure delivery in [settings](docs/settings.md): `steeringMode` and `followUpMode` can be `"one-at-a-time"` (default, waits for response) or `"all"` (delivers all queued at once). `transport` selects provider transport preference (`"sse"`, `"websocket"`, or `"auto"`) for providers that support multiple transports.

---

## Child orchestration

The built-in orchestration extension runs configured headless coding-agent CLIs as child processes. Child Sessions are independent from the parent model loop, can run concurrently, and can be resumed when their Provider supplies a native session ID.

### Commands

| Command | Description |
|---------|-------------|
| `/spawn <provider> <prompt>` | Start a persisted child Session. Repeat for concurrent fan-out. |
| `/run <provider> <prompt>` | Start a process-lifetime background TaskRun. TaskRuns are not persisted or resumable. |
| `/agent-resume <session-id> <prompt>` | Resume a persisted child Session. |
| `/provider [name]` | Show or select the child-run Provider. |
| `/cancel <run-id-or-session-id>` | Cancel a live child Run. |
| `/agents` | Open the grouped Runs and Sessions view. |
| `/login [provider]` | Check or start authentication for a supported child CLI. |
| `/agent-model [provider] [model]` | Show or arm a model for the next child Run. |
| `/agent-effort [level]` | Show or arm `default`, `low`, `medium`, or `high` effort for the next child Run. |

`/spawn` also accepts `--preset <name>` and `--count 1-8` for discovered Claude agent presets. Project `.claude/agents/*.md` definitions override user definitions with the same name; names beginning with `_` and presets marked `user-invocable: false` are excluded.

### Provider prerequisites

| Provider | Prerequisite | Resume |
|----------|--------------|--------|
| `claude` | The `claude` CLI must be installed and authenticated. Use `/login claude` when supported by the local CLI. | Native Provider session resume |
| `codex` | The `codex` CLI must be installed and authenticated. Use `/login codex` when supported by the local CLI. | Native Provider session resume |
| `generic` | Configure an executable and argv template. The executable must be available on `PATH` or supplied as a path. | Not supported in v1 |
| `mock` | No executable or credentials. The scripted Provider is intended for deterministic tests and demonstrations. | Controlled by the mock script |

Child authentication is separate from direct-model credentials. Authentication failures appear as diagnostics or terminal Run events; tokens are not logged.

### Manual examples

The mock Provider needs no credentials:

```text
/spawn mock inspect the current working tree
/spawn mock list the likely causes of the failing test
/agents
/cancel <run-id-or-session-id>
```

With authenticated CLIs, use the same command surface:

```text
/login claude
/spawn claude review the authentication changes
/agents
/agent-resume <child-session-id> continue with the failing tests

/login codex
/spawn codex inspect dependency drift
```

The child Session ID is shown by `/agents`. Generic Providers report an inspectable failed Run if resume is requested.

### Migration and persistence

On first startup, void performs a one-time, idempotent copy from the legacy `~/.pi/agent` root into `~/.void`. Only `settings.json`, `extensions/`, `chains/`, and `APPEND_SYSTEM.md` are considered. Existing destination entries win; directories merge only missing descendants; symlinks remain symlinks. The source is never renamed, deleted, truncated, permission-changed, or otherwise mutated. The destination root is owner-only, and copied settings retain owner-only file permissions. Credentials, auth files, model registries, sessions, binaries, and other project-local legacy data are excluded. A marker is written only after all requested copies succeed, so a partial failure is retried on the next launch.

Child Session transcripts are stored in `~/.void/orchestrator/sessions/<session-id>.json`. Each file is append-only JSONL despite the `.json` suffix:

```json
{"meta":{"id":"...","provider":"claude","providerSessionId":"...","name":"...","parentSessionId":"...","created":"..."}}
{"runId":"...","prompt":"review the changes"}
{"runId":"...","event":{"kind":"text","text":"..."}}
```

The latest metadata record wins, event order is append order, and a corrupt or truncated tail is skipped with a warning while valid preceding records remain usable. Store directories are owner-only.

### Extension architecture

`@void/orchestrator` is a TUI-free library. It owns Provider resolution, argv-only process execution, normalized Events, Run and Session state, cancellation, resume, fan-in, and append-only persistence. It does not import the coding agent or UI packages.

The coding-agent adapter creates one process-lifetime orchestration host and injects the built-in extension through `DefaultResourceLoader`'s `extensionFactories` path, including when user extensions are disabled. The host owns the Orchestrator across parent session switches; each extension instance only attaches or detaches its UI subscription. A spawn appends one non-triggering `void:spawn` custom message and `void:spawn-state` ownership entries. The registered renderer resolves the same child Session ID from live or restored state, while the sidebar, `/agents` overlay, child-session view, footer status, and notifications use existing extension UI surfaces.

See [docs/settings.md](docs/settings.md) for the `orchestrator` settings schema and [@void/orchestrator](../orchestrator) for the library contract.

---

## Sessions

Sessions are stored as JSONL files with a tree structure. Each entry has an `id` and `parentId`, enabling in-place branching without creating new files. See [docs/session.md](docs/session.md) for file format.

### Management

Sessions auto-save to `~/.void/sessions/` organized by working directory.

```bash
void -c                  # Continue most recent session
void -r                  # Browse and select from past sessions
void --no-session        # Ephemeral mode (don't save)
void --session <path>    # Use specific session file or ID
void --fork <path>       # Fork specific session file or ID into a new session
```

### Branching

**`/tree`** - Navigate the session tree in-place. Select any previous point, continue from there, and switch between branches. All history preserved in a single file.

<p align="center"><img src="docs/images/tree-view.png" alt="Tree View" width="600"></p>

- Search by typing, fold/unfold and jump between branches with Ctrl+←/Ctrl+→ or Alt+←/Alt+→, page with ←/→
- Filter modes (Ctrl+O): default → no-tools → user-only → labeled-only → all
- Press Shift+L to label entries as bookmarks and Shift+T to toggle label timestamps

**`/fork`** - Create a new session file from the current branch. Opens a selector, copies history up to the selected point, and places that message in the editor for modification.

**`--fork <path|id>`** - Fork an existing session file or partial session UUID directly from the CLI. This copies the full source session into a new session file in the current project.

### Compaction

Long sessions can exhaust context windows. Compaction summarizes older messages while keeping recent ones.

**Manual:** `/compact` or `/compact <custom instructions>`

**Automatic:** Enabled by default. Triggers on context overflow (recovers and retries) or when approaching the limit (proactive). Configure via `/settings` or `settings.json`.

Compaction is lossy. The full history remains in the JSONL file; use `/tree` to revisit. Customize compaction behavior via [extensions](#extensions). See [docs/compaction.md](docs/compaction.md) for internals.

---

## Settings

Use `/settings` to modify common options, or edit JSON files directly:

| Location | Scope |
|----------|-------|
| `~/.void/settings.json` | Global (all projects) |
| `.void/settings.json` | Project (overrides global) |

See [docs/settings.md](docs/settings.md) for all options.

---

## Context Files

void loads `AGENTS.md` (or `CLAUDE.md`) at startup from:
- `~/.void/AGENTS.md` (global)
- Parent directories (walking up from cwd)
- Current directory

Use for project instructions, conventions, common commands. All matching files are concatenated.

### System Prompt

Replace the default system prompt with `.void/SYSTEM.md` (project) or `~/.void/SYSTEM.md` (global). Append without replacing via `APPEND_SYSTEM.md`.

---

## Customization

### Prompt Templates

Reusable prompts as Markdown files. Type `/name` to expand.

```markdown
<!-- ~/.void/prompts/review.md -->
Review this code for bugs, security issues, and performance problems.
Focus on: {{focus}}
```

Place in `~/.void/prompts/`, `.void/prompts/`, or a [void package](#void-packages) to share with others. See [docs/prompt-templates.md](docs/prompt-templates.md).

### Skills

On-demand capability packages following the [Agent Skills standard](https://agentskills.io). Invoke via `/skill:name` or let the agent load them automatically.

```markdown
<!-- ~/.void/skills/my-skill/SKILL.md -->
# My Skill
Use this skill when the user asks about X.

## Steps
1. Do this
2. Then that
```

Place in `~/.void/skills/`, `~/.agents/skills/`, `.void/skills/`, or `.agents/skills/` (from `cwd` up through parent directories) or a [void package](#void-packages) to share with others. See [docs/skills.md](docs/skills.md).

### Extensions

<p align="center"><img src="docs/images/doom-extension.png" alt="Doom Extension" width="600"></p>

TypeScript modules that extend void with custom tools, commands, keyboard shortcuts, event handlers, and UI components.

```typescript
export default function (voidApi: ExtensionAPI) {
  voidApi.registerTool({ name: "deploy", ... });
  voidApi.registerCommand("stats", { ... });
  voidApi.on("tool_call", async (event, ctx) => { ... });
}
```

**What's possible:**
- Custom tools (or replace built-in tools entirely)
- Sub-agents and plan mode
- Custom compaction and summarization
- Permission gates and path protection
- Custom editors and UI components
- Status lines, headers, footers
- Git checkpointing and auto-commit
- SSH and sandbox execution
- MCP server integration
- Make void look like Claude Code
- Games while waiting (yes, Doom runs)
- ...anything you can dream up

Place in `~/.void/extensions/`, `.void/extensions/`, or a [void package](#void-packages) to share with others. See [docs/extensions.md](docs/extensions.md) and [examples/extensions/](examples/extensions/).

### Themes

Built-in: `dark`, `light`. Themes hot-reload: modify the active theme file and void immediately applies changes.

Place in `~/.void/themes/`, `.void/themes/`, or a [void package](#void-packages) to share with others. See [docs/themes.md](docs/themes.md).

### void Packages

Bundle and share extensions, skills, prompts, and themes via npm or git. Find packages on [npmjs.com](https://www.npmjs.com/search?q=keywords%3Api-package) or [Discord](https://discord.com/channels/1456806362351669492/1457744485428629628).

> **Security:** void packages run with full system access. Extensions execute arbitrary code, and skills can instruct the model to perform any action including running executables. Review source code before installing third-party packages.

```bash
void install npm:@foo/void-tools
void install npm:@foo/void-tools@1.2.3      # pinned version
void install git:github.com/user/repo
void install git:github.com/user/repo@v1  # tag or commit
void install git:git@github.com:user/repo
void install git:git@github.com:user/repo@v1  # tag or commit
void install https://github.com/user/repo
void install https://github.com/user/repo@v1      # tag or commit
void install ssh://git@github.com/user/repo
void install ssh://git@github.com/user/repo@v1    # tag or commit
void remove npm:@foo/void-tools
void uninstall npm:@foo/void-tools          # alias for remove
void list
void update                               # skips pinned packages
void config                               # enable/disable extensions, skills, prompts, themes
```

Packages install to `~/.void/git/` (git) or global npm. Use `-l` for project-local installs (`.void/git/`, `.void/npm/`). If you use a Node version manager and want package installs to reuse a stable npm context, set `npmCommand` in `settings.json`, for example `["mise", "exec", "node@20", "--", "npm"]`.

Create a package by adding a `void` key to `package.json`:

```json
{
  "name": "my-void-package",
  "keywords": ["void-package"],
  "void": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"]
  }
}
```

Without a `void` manifest, void auto-discovers from conventional directories (`extensions/`, `skills/`, `prompts/`, `themes/`).

See [docs/packages.md](docs/packages.md).

---

## Programmatic Usage

### SDK

```typescript
import { AuthStorage, createAgentSession, ModelRegistry, SessionManager } from "@void/coding-agent";

const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);
const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  authStorage,
  modelRegistry,
});

await session.prompt("What files are in the current directory?");
```

For advanced multi-session runtime replacement, use `createAgentSessionRuntime()` and `AgentSessionRuntime`.

See [docs/sdk.md](docs/sdk.md) and [examples/sdk/](examples/sdk/).

### RPC Mode

For non-Node.js integrations, use RPC mode over stdin/stdout:

```bash
void --mode rpc
```

RPC mode uses strict LF-delimited JSONL framing. Clients must split records on `\n` only. Do not use generic line readers like Node `readline`, which also split on Unicode separators inside JSON payloads.

See [docs/rpc.md](docs/rpc.md) for the protocol.

---

## Philosophy

void is aggressively extensible so it doesn't have to dictate your workflow. Features that other tools bake in can be built with [extensions](#extensions), [skills](#skills), or installed from third-party [void packages](#void-packages). This keeps the core minimal while letting you shape void to fit how you work.

**No MCP.** Build CLI tools with READMEs (see [Skills](#skills)), or build an extension that adds MCP support. [Why?](https://mariozechner.at/posts/2025-11-02-what-if-you-dont-need-mcp/)

**Child orchestration is explicit.** Use the built-in orchestration commands for supported headless Providers, or build a separate extension when a workflow needs a different process contract.

**No permission popups.** Run in a container, or build your own confirmation flow with [extensions](#extensions) inline with your environment and security requirements.

**No plan mode.** Write plans to files, or build it with [extensions](#extensions), or install a package.

**No built-in to-dos.** They confuse models. Use a TODO.md file, or build your own with [extensions](#extensions).

**No background bash.** Use tmux. Full observability, direct interaction.

Read the [blog post](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/) for the full rationale.

---

## CLI Reference

```bash
void [options] [@files...] [messages...]
```

### Package Commands

```bash
void install <source> [-l]     # Install package, -l for project-local
void remove <source> [-l]      # Remove package
void uninstall <source> [-l]   # Alias for remove
void update [source]           # Update packages (skips pinned)
void list                      # List installed packages
void config                    # Enable/disable package resources
```

### Modes

| Flag | Description |
|------|-------------|
| (default) | Interactive mode |
| `-p`, `--print` | Print response and exit |
| `--mode json` | Output all events as JSON lines (see [docs/json.md](docs/json.md)) |
| `--mode rpc` | RPC mode for process integration (see [docs/rpc.md](docs/rpc.md)) |
| `--export <in> [out]` | Export session to HTML |

In print mode, void also reads piped stdin and merges it into the initial prompt:

```bash
cat README.md | void -p "Summarize this text"
```

### Model Options

| Option | Description |
|--------|-------------|
| `--provider <name>` | Provider (anthropic, openai, google, etc.) |
| `--model <pattern>` | Model pattern or ID (supports `provider/id` and optional `:<thinking>`) |
| `--api-key <key>` | API key (overrides env vars) |
| `--thinking <level>` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh` |
| `--models <patterns>` | Comma-separated patterns for Ctrl+P cycling |
| `--list-models [search]` | List available models |

### Session Options

| Option | Description |
|--------|-------------|
| `-c`, `--continue` | Continue most recent session |
| `-r`, `--resume` | Browse and select session |
| `--session <path>` | Use specific session file or partial UUID |
| `--fork <path>` | Fork specific session file or partial UUID into a new session |
| `--session-dir <dir>` | Custom session storage directory |
| `--no-session` | Ephemeral mode (don't save) |

### Tool Options

| Option | Description |
|--------|-------------|
| `--tools <list>` | Enable specific built-in tools (default: `read,bash,edit,write`) |
| `--no-tools` | Disable all built-in tools (extension tools still work) |

Available built-in tools: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`

### Resource Options

| Option | Description |
|--------|-------------|
| `-e`, `--extension <source>` | Load extension from path, npm, or git (repeatable) |
| `--no-extensions` | Disable extension discovery |
| `--skill <path>` | Load skill (repeatable) |
| `--no-skills` | Disable skill discovery |
| `--prompt-template <path>` | Load prompt template (repeatable) |
| `--no-prompt-templates` | Disable prompt template discovery |
| `--theme <path>` | Load theme (repeatable) |
| `--no-themes` | Disable theme discovery |

Combine `--no-*` with explicit flags to load exactly what you need, ignoring settings.json (e.g., `--no-extensions -e ./my-ext.ts`).

### Other Options

| Option | Description |
|--------|-------------|
| `--system-prompt <text>` | Replace default prompt (context files and skills still appended) |
| `--append-system-prompt <text>` | Append to system prompt |
| `--verbose` | Force verbose startup |
| `-h`, `--help` | Show help |
| `-v`, `--version` | Show version |

### File Arguments

Prefix files with `@` to include in the message:

```bash
void @prompt.md "Answer this"
void -p @screenshot.png "What's in this image?"
void @code.ts @test.ts "Review these files"
```

### Examples

```bash
# Interactive with initial prompt
void "List all .ts files in src/"

# Non-interactive
void -p "Summarize this codebase"

# Non-interactive with piped stdin
cat README.md | void -p "Summarize this text"

# Different model
void --provider openai --model gpt-4o "Help me refactor"

# Model with provider prefix (no --provider needed)
void --model openai/gpt-4o "Help me refactor"

# Model with thinking level shorthand
void --model sonnet:high "Solve this complex problem"

# Limit model cycling
void --models "claude-*,gpt-4o"

# Read-only mode
void --tools read,grep,find,ls -p "Review the code"

# High thinking level
void --thinking high "Solve this complex problem"
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `VOID_CODING_AGENT_DIR` | Override config directory (default: `~/.void`) |
| `VOID_PACKAGE_DIR` | Override package directory (useful for Nix/Guix where store paths tokenize poorly) |
| `VOID_SKIP_VERSION_CHECK` | Skip version check at startup |
| `VOID_CACHE_RETENTION` | Set to `long` for extended prompt cache (Anthropic: 1h, OpenAI: 24h) |
| `VISUAL`, `EDITOR` | External editor for Ctrl+G |

---

## Contributing & Development

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for guidelines and [docs/development.md](docs/development.md) for setup, forking, and debugging.

---

## License

MIT

## See Also

- [@void/ai](https://www.npmjs.com/package/@void/ai): Core LLM toolkit
- [@void/agent](https://www.npmjs.com/package/@void/agent): Agent framework
- [@void/tui](https://www.npmjs.com/package/@void/tui): Terminal UI components
