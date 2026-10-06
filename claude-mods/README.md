# Claude Code mods

Mods for Claude Code (terminal TUI and the desktop app's Code tab), built for how this repo is worked on: several agents and subagents in parallel, long sessions, strict git rules from `AGENTS.md`.

| Mod | What it is | Where it shows |
| --- | --- | --- |
| `agent-deck` | Agent panel. Every agent loop (main, subagents, teammates) as a tree, each with model, effort, status, live tool, context tokens, output tokens, step and tool counts, elapsed time. Below it, task progress from `TodoWrite` / `TaskCreate` / `TaskUpdate` with a progress bar and the active task. `c` toggles compact, `x` clears finished agents. `/agent-deck` opens it. | Pane: docked beside the transcript in fullscreen (opens by itself from 144 columns), inline above the prompt otherwise; a pane on desktop |
| `context-bar` | Context bar above the prompt. Main context fill (colored by threshold), tokens / window, total output, session cost, 5h rate limit. When subagents exist: a stacked "mix" bar of live tokens by loop, and one bar per subagent against the window. Toast once when main passes 80%. `d` toggles the per-agent rows, `/context-bar` hides it. | `AbovePrompt` band, terminal and desktop |
| `repo-guard` | Enforces `AGENTS.md`. Refuses `git add -A`/`.`, `reset --hard`, `checkout .`, `clean -f`, `stash`, `commit --no-verify`, force push, `npm run dev`/`build`, `npm test`. After a code edit, refuses `git commit` until `npm run check` passes; the status line shows `check pending · N files`. Active only where the cwd has an `AGENTS.md`. Quoted strings and heredocs are ignored when matching, so commit messages can't trip it. | Tool-call guard + status line |

## Install

From a terminal session:

```
/plugin install agent-deck --marketplace kygura/void-agent
/plugin install context-bar --marketplace kygura/void-agent
/plugin install repo-guard --marketplace kygura/void-agent
```

Answer `y` to add the marketplace, then pick a scope. Installed at user scope they also load in the desktop app's local Code-tab sessions.

To run one from this checkout without installing:

```
claude --plugin-dir claude-mods/agent-deck --plugin-dir claude-mods/context-bar
```

For desktop or SDK hosts where no flag can be passed, set `CLAUDE_CODE_PLUGIN_DIRS` to the absolute paths (in the environment or the `env` block of `~/.claude/settings.json`).

## Develop

Each mod is `.claude-plugin/plugin.json`, `hooks/hooks.json`, `hooks/register.tsx`, a `types/index.d.ts` contract for its `$.state` values, and `tests/*.test.ts`.

```
claude plugin validate claude-mods/<mod>
claude plugin test claude-mods/<mod>
```

Tests mount every UI on both `terminal` and `desktop`. The engine writes `.claude-plugin/types/` and `tsconfig.json` into a mod folder on load; both are gitignored.

## How the data is sourced

- Per-loop tokens come from `turn.step`: each request's `usage` (input + cache read + cache write = that loop's current context), keyed by `agentId` (absent = main).
- Model and effort come from `turn.step`'s `model` / `effort`, so a mid-session `/model` or a subagent on Haiku shows correctly.
- Agent tree and labels come from `agent.spawn` (`description`, `subagentType`, `parentAgentId`), resynced against `$.agent.list()` every 4s to catch idle teammates and kills.
- Main context %, window, cost and rate limits come from `$.session.usage()`, the same figures as the status line.
- Subagent bars are drawn against the main session's window; a subagent on a model with a smaller window reads low.

## Ideas for next mods

- **Diff ledger pane**: files touched this session per agent, with `+/-` counts from `Edit`/`Write` results, and a button to quote a file's diff into the prompt.
- **Compaction advisor**: on `turn.complete` past 85%, `$.model.fork` a one-line summary of what can be dropped and offer `/compact` with it as instructions.
- **Changelog nudge**: when a commit touches `packages/<pkg>/src` without `packages/<pkg>/CHANGELOG.md`, append a reminder via `prompt.compose`.
- **Subagent budget**: an `agent.spawn` hook that downgrades `model` to Haiku for `Explore` and caps parallel spawns, shown in `agent-deck`.
