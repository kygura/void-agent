# Claude Code mods

Mods for Claude Code (2.1.287+), written against the function-hooks plugin API. Each folder is one plugin; the repo root's `.claude-plugin/marketplace.json` lists them, so the repo installs as a marketplace.

| Mod | Where it draws | What it does |
| --- | --- | --- |
| [`agent-deck`](agent-deck) | Pane (`/deck`) | Main loop and every subagent as a tree: status, model, effort, step count, context size, elapsed time, current tool. Task list (TodoWrite or TaskCreate/TaskUpdate) with a progress bar. Opens by itself on the first subagent. |
| [`context-bar`](context-bar) | Band above the prompt, `/ctx` | Main window fill with threshold colours, token count, session cost, 5h/7d rate limits. One chip per subagent with its own context size; `[agents]` expands to a bar per agent with model, effort, in/cached/out tokens. `/ctx` prints the /context breakdown and a per-agent table. Toasts once past `warnAt` (default 80%). |
| [`ascii-canvas`](ascii-canvas) | Pane (`/canvas`, `/styles`) | `mcp__ascii-canvas__draw` lets the model put diagrams and mockups in a pane instead of the transcript. `/banner [--block\|--shade\|--hash\|--outline] text` draws block letters. `/flow A -> B \| C -> D; X -> Y` draws box-and-arrow chains. History, copy, "to prompt". `/styles` samples border styles, text styles and the theme's colour keys on the current surface. |
| [`color-picker`](color-picker) | Pane (`/swatch`) | Swatch, hex/rgb/hsl/oklch with copy, hue/saturation/lightness nudges, tint ramp, harmonies, WCAG contrast on white and black, colours found in the selection or the last 30 messages. `mcp__color-picker__show_palette` lets the model show a proposed palette with contrast figures. Hue strip is a `Raster` in the terminal and an `Svg` on desktop. |
| [`git-guard`](git-guard) | Bash gate | Refuses `reset --hard`, `checkout .`, `restore .`, `clean -f`, `stash`, `add -A`/`add .`, `--no-verify` and force pushes, the operations AGENTS.md forbids when agents share a worktree. `--force-with-lease` is allowed unless `allowForceWithLease` is turned off. |

All UI mods draw on the terminal and on the desktop app's Code tab; the tests mount every pane and band on both surfaces.

## Install

From a terminal session:

```
/plugin install agent-deck --marketplace kygura/void-agent
```

Answer `y` to add the marketplace, pick a scope, and repeat for the other mods. Installed at user scope they also load in the desktop app's local sessions.

To run one from the working copy without installing:

```bash
claude --plugin-dir claude-mods/agent-deck --plugin-dir claude-mods/context-bar
```

For desktop or SDK sessions, list the folders in `CLAUDE_CODE_PLUGIN_DIRS` (in the environment or the `env` block of `~/.claude/settings.json`).

## Developing

```bash
claude plugin validate claude-mods/<mod>   # what the engine will load, hook and refuse
claude plugin test claude-mods/<mod>       # runs tests/*.test.ts(x) against the engine
```

Once a session has loaded a mod from its folder, the engine writes `.claude-plugin/types/` and a `tsconfig.json` beside it, so `tsc -p claude-mods/<mod>` type-checks it. Both are git-ignored. These folders are outside the workspace's biome and tsgo scope, so `npm run check` does not read them.

See [RESEARCH.md](RESEARCH.md) for how the API works, what each mod reads, and the backlog.
