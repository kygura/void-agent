# Development

See [AGENTS.md](../../../AGENTS.md) for additional guidelines.

## Setup

From the repository root:

```bash
bun install --frozen-lockfile
bun run build
bun --cwd packages/orchestrator run build
```

Run the CLI from source with Bun:

```bash
bun packages/coding-agent/src/cli.ts
```

The compiled executable is created by the coding-agent package script:

```bash
bun --cwd packages/coding-agent run build:binary
./packages/coding-agent/dist/void --version
```

## Identity and paths

The application and executable are named `void`. Workspace packages use the `@void/*` scope. The global root is `~/.void`, project configuration is `.void`, and `VOID_CODING_AGENT_DIR` overrides the global root. New product-owned environment variables use the `VOID_` prefix.

The startup migration copies only `settings.json`, `extensions/`, `chains/`, and `APPEND_SYSTEM.md` from `~/.pi/agent` to `~/.void`. It never mutates the source; destination entries win. See the migration notes in the [coding-agent README](../README.md#migration-and-persistence).

## Commands

Run these from the repository root unless noted otherwise:

```bash
bun run check
bun run test
bun --cwd packages/orchestrator test
bun --cwd packages/coding-agent run test
```

The focused coding-agent suite is run from `packages/coding-agent`:

```bash
cd packages/coding-agent
bun ../../node_modules/vitest/dist/cli.js --run test/suite/orchestrator-spawn.test.ts
```

## Path Resolution

Three execution modes are supported: Bun from the workspace, the standalone binary, and Bun running the TypeScript source.

**Always use `src/config.ts`** for package assets:

```typescript
import { getPackageDir, getThemeDir } from "./config.js";
```

Never use `__dirname` directly for package assets.

## Debug Command

`/debug` (hidden) writes to `~/.void/void-debug.log`:
- Rendered TUI lines with ANSI codes
- Last messages sent to the LLM

## Testing

```bash
# From the repository root:
bun run test                         # Run all workspace tests
bun --cwd packages/orchestrator test # Run orchestrator tests

# From packages/coding-agent:
bun run test                         # Run coding-agent tests
bun ../../node_modules/vitest/dist/cli.js --run test/specific.test.ts
```

## Project Structure

```
packages/
  ai/           # LLM provider abstraction
  agent/        # Agent loop and message types  
  orchestrator/ # Headless child orchestration
  tui/          # Terminal UI components
  coding-agent/ # CLI and interactive mode
```
