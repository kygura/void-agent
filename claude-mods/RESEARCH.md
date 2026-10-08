# Claude Code mods: research notes

Written against Claude Code 2.1.292. Mods shipped in 2.1.287 (October 2026). The API is early access and changes between releases; the declaration file the engine writes (`.claude-plugin/types/claude-code/index.d.ts`) is the source of truth, not these notes.

Docs: [interface](https://code.claude.com/docs/en/plugins/mods/interface), [reference](https://code.claude.com/docs/en/plugins/mods/reference).

## The model

A mod is a plugin with a hooks module: `hooks/hooks.json` names one TypeScript file exporting `register(on, options)`. Every hook is `($, e, next)`:

- `e` is the event input, frozen.
- `next(e)` runs the plugins beneath and then the engine. Return without calling it and the hook answers for itself; call `next({ ...e, x })` and the rest of the chain sees the rewrite.
- `$` is the only way out of the sandbox (no DOM, no Node): `$.ui`, `$.session`, `$.agent`, `$.tool`, `$.command`, `$.state`, `$.store`, `$.clock`, `$.fs`, `$.process`, `$.http`, `$.model`.

Drawing goes through `ui.render`. The hook gets a component instance (`Pane`, `AbovePrompt`, `ToolUse`, `Spinner`, `PromptHint`, ...) and returns a tree built from `$.ui.resolve(e)`, the surface's element table. State a drawing reads lives in `$.state` (declared in the mod's `types/index.d.ts`): a `read` while drawing subscribes, a later write redraws exactly those readers. Module variables reset on every hot reload; `$.state` survives it, `$.store` survives sessions.

## Surfaces

| | terminal | desktop | vscode | mobile |
| --- | --- | --- | --- | --- |
| Box, Text, Button, Link, Code, Markdown | yes | yes | yes | yes |
| Input, Select | yes | yes | yes | no |
| Raster, Image (kitty protocol) | yes | no | no | no |
| Svg | no | yes | yes | yes |
| Client (own surface module) | yes | yes | no | no |
| AbovePrompt band | yes | yes | no | no |

A mod that sticks to the shared elements draws everywhere. `color-picker` branches on `e.surface` for its gradient strip: `Raster` of half blocks in the terminal, `Svg` elsewhere.

Placement: a pane opened by the person (a command, a press) seats at any width. Opened unasked (from `session.start`, a spawn, a timer) it docks only from 144 columns and waits below that. `agent-deck` opens itself on the first subagent spawn and accepts waiting.

## Where the data comes from

| Need | Source |
| --- | --- |
| Main window fill, cost, rate limits | `session.measure` event (fires when a unit changes), `$.session.usage()` |
| /context category breakdown | `$.session.usage({ breakdown: 'summary' })` (`'full'` calls the token-count API) |
| Model and effort per request | `turn.step` input: `model`, `effort`, `agentId` |
| Tokens per request, per agent | `turn.step` result `usage` (input, cache read, cache write, output, model) |
| Subagent identity | `agent.spawn`: `name`, `description`, `subagentType`, `parentAgentId`; result `agentId`, resolved `model` |
| Subagent status | `$.agent.list()` (`pending`, `running`, `waiting`, `idle`, `completed`, `failed`, `killed`), `turn.complete` with `agentId` |
| Current tool per agent | `tool.call` (carries `agentId`), before and after `next` |
| Task progression | `tool.call` on `TodoWrite`, `TaskCreate` (result has the id), `TaskUpdate` |
| Which agent's transcript is on screen | `e.props.view.agentId` on `Pane` and `AbovePrompt` |

`turn.step` is a streaming event, so its hook is an async generator: `const result = yield* next(e)` forwards every chunk and hands back the finished response.

A subagent's context window is not reported. `context-bar` reads it off the model id (1M for `[1m]` variants, 200k otherwise); the main window is exact.

## Rules the validator enforces

- `$` may only be passed to functions declared at the top of the file. Closures inside `register` that take `$` are refused at load.
- `$.state` keys are literals declared in the contract; `claude plugin validate` lists reads and writes.
- Render hooks never write state. Write from `onPress` or another event, with `update($, atom, fn)` so two quick presses both land.
- Hooks that can refuse something (`tool.call`, `command.run`, `agent.spawn`) are listed as gates. An observer should carry `.catch(($, e, next) => next(e))` so a bug never blocks a tool or a spawn; a guard should refuse in its `.catch` (`git-guard` does).
- No `import()`. Plugin files import each other with static imports.
- A slash command named like a built-in (`/color` is one) is refused at registration, and the throw skips the rest of that `session.start` hook. Watch the validator: a mod's own command should read "answers its own command"; if it reads as a gating hook, the name is taken. Register tools before commands so a refused name can't take the tool down with it.

## Live check

Loaded with hot reload in a cloud session: all five mods loaded. `mcp__ascii-canvas__draw` worked when the model called it. The first load of `color-picker` lost its `show_palette` tool to the `/color` collision described above; it is now `/swatch`.

The engine-generated `tsconfig.json` also pulls in `claude-code-mcp`, the types for every connected MCP tool. In a session with hundreds of connector tools that makes `tsc -p` very slow, and it reports TS2589 (type instantiation too deep) on `$.tool.call` in tests. To type-check a mod there, point a tsconfig at `claude-code/index.d.ts` alone.

## Testing

`claude plugin test <dir>` runs `*.test.ts(x)` with the engine's own `$`. Hooks a test registers sit beneath the plugin and stand in for the engine: answer `turn.step` with a generator that returns a usage block, `agent.spawn` with an id, `tool.call` with a result, then mount the component with `$.ui.mount({ plugin, surface, component, props })` and act on it by key. `mock.clock(on)` is needed for anything that calls `$.clock`. Each test here loops over `['terminal', 'desktop']`.

## Relation to void's own TUI

`DESIGN.md` specifies the same surfaces for void's pi-based TUI: a persistent sidebar of runs, an `/agents` overlay, status glyphs `○ ⠋ ✓ ✗ ⊘`. `agent-deck` uses that glyph set and the void palette (`#8abeb7` accent, `#9575cd` labels) so the two tools read alike. The data model carries over too: pi's `SubagentRegistry.onChange` plays the role of `agent.spawn` + `turn.complete`, and the per-agent usage the context bar shows maps onto `HarnessRunManager` runs.

## Backlog

Mods worth building next, roughly in order of payoff:

1. **check-runner**: after a turn that edited `packages/**/*.ts`, run `npm run check` with `$.process.spawn` in the background and show pass/fail in the status line. AGENTS.md requires it after every code change.
2. **changelog-nudge**: on `git commit` touching `packages/<pkg>/src`, check `packages/<pkg>/CHANGELOG.md` has an `[Unreleased]` entry; warn through `$.ui.notice` on the permission dialog.
3. **spawn-router**: an `agent.spawn` hook that sets `model: 'haiku'` for `Explore`-type spawns and leaves the rest alone. Cuts spend on fan-out searches.
4. **tasks-md**: read `TASKS.md` / `TASKS-autobuild.md` checkboxes with `$.fs` and feed them into `agent-deck`'s task section through a `dependencies` contract.
5. **turn-ledger**: `turn.complete` usage per turn into `$.store`, a pane with a sparkline (`Raster`) of tokens and cost per turn across sessions.
6. **diff-peek**: hook `ToolUse` for `Edit` and draw a compact `Code format="diff"` instead of the default row.

Connectors in this environment that pair with the mods: Context7 (current library docs), Excalidraw, tldraw and Mermaid Chart (diagrams past what ASCII can carry), Figma (design tokens into `color-picker` palettes).
