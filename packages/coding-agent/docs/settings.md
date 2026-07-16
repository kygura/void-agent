# Settings

void uses JSON settings files, layered low to high precedence:

| Location | Scope |
|----------|-------|
| `~/.void/settings.json` | Global (all projects) |
| `~/.void/profiles/<name>.json` | Profile, only when `--profile <name>` is passed |
| `.void/settings.json` | Project (current directory) |
| `--config key.path=value` | CLI override (highest precedence, in-memory only) |

Nested objects merge recursively at each layer; arrays and scalars in a higher layer replace the lower layer's value.

Edit settings files directly or use `/settings` for common options. Settings changed via `/settings` or other commands are always written to the global or project file, never to a profile or `--config` override.

## Profiles

`--profile <name>` loads `~/.void/profiles/<name>.json` and layers it between global and project settings. Useful for switching between named configurations (e.g. a "work" profile with a different default model). Exits with an error listing available profiles if the named profile file doesn't exist.

```bash
void --profile work
```

## CLI Overrides

`--config key.path=value` (repeatable) sets a settings value by dotted path, applied on top of every other layer. The value is parsed as JSON, falling back to a raw string if it isn't valid JSON.

```bash
void --config theme=dark --config 'statusLine=["model","git-branch"]'
```

## All Settings

### Model & Thinking

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `defaultProvider` | string | - | Default provider (e.g., `"anthropic"`, `"openai"`) |
| `defaultModel` | string | - | Default model ID |
| `defaultThinkingLevel` | string | - | `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"` |
| `hideThinkingBlock` | boolean | `false` | Hide thinking blocks in output |
| `thinkingBudgets` | object | - | Custom token budgets per thinking level |

#### thinkingBudgets

```json
{
  "thinkingBudgets": {
    "minimal": 1024,
    "low": 4096,
    "medium": 10240,
    "high": 32768
  }
}
```

### UI & Display

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `theme` | string | `"dark"` | Theme name (`"dark"`, `"light"`, or custom) |
| `quietStartup` | boolean | `false` | Hide startup header |
| `collapseChangelog` | boolean | `false` | Show condensed changelog after updates |
| `doubleEscapeAction` | string | `"tree"` | Action for double-escape: `"tree"`, `"fork"`, or `"none"` |
| `treeFilterMode` | string | `"default"` | Default filter for `/tree`: `"default"`, `"no-tools"`, `"user-only"`, `"labeled-only"`, `"all"` |
| `editorPaddingX` | number | `0` | Horizontal padding for input editor (0-3) |
| `autocompleteMaxVisible` | number | `5` | Max visible items in autocomplete dropdown (3-20) |
| `showHardwareCursor` | boolean | `false` | Show terminal cursor |
| `statusLine` | string[] | - | Ordered list of footer item ids. Unset shows the default footer (see below) |
| `statusLineSeparator` | string | `" · "` | Separator between statusline items |
| `sidebar` | boolean | `true` | Show the session sidebar pane (session/model/context/git + active agent runs) when terminal width is at least 120 columns. Toggle with `/sidebar` or `Ctrl+X` |

#### statusLine

When set, replaces the default footer with a single line built from the given item ids, in order. Unknown ids render as literal text, so they can be used as labels or custom separators.

| Item id | Shows |
|---------|-------|
| `model` | Current model id |
| `thinking-level` | Current thinking level, if the model supports it |
| `current-dir` | Basename of the working directory (`~` if home) |
| `project-root` | Basename of the git repo root, if in a repo |
| `git-branch` | Git branch, with a `*` suffix if the working tree is dirty |
| `context-remaining` | Percentage of context window left, e.g. `"62% left"` |
| `used-tokens` | Total tokens used this session, compact form (e.g. `12.3k`) |
| `cost` | Session cost in USD, if computable |
| `session-name` | Session name, if set |
| `version` | void version |
| `status` | Extension statuses set via `ctx.ui.setStatus()` |

Items that have no value are dropped (no double separators).

```json
{
  "statusLine": ["current-dir", "git-branch", "model", "context-remaining"],
  "statusLineSeparator": " | "
}
```

### Compaction

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `compaction.enabled` | boolean | `true` | Enable auto-compaction |
| `compaction.reserveTokens` | number | `16384` | Tokens reserved for LLM response |
| `compaction.keepRecentTokens` | number | `20000` | Recent tokens to keep (not summarized) |

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  }
}
```

### Branch Summary

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `branchSummary.reserveTokens` | number | `16384` | Tokens reserved for branch summarization |
| `branchSummary.skipPrompt` | boolean | `false` | Skip "Summarize branch?" prompt on `/tree` navigation (defaults to no summary) |

### Retry

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `retry.enabled` | boolean | `true` | Enable automatic retry on transient errors |
| `retry.maxRetries` | number | `3` | Maximum retry attempts |
| `retry.baseDelayMs` | number | `2000` | Base delay for exponential backoff (2s, 4s, 8s) |
| `retry.maxDelayMs` | number | `60000` | Max server-requested delay before failing (60s) |

When a provider requests a retry delay longer than `maxDelayMs` (e.g., Google's "quota will reset after 5h"), the request fails immediately with an informative error instead of waiting silently. Set to `0` to disable the cap.

```json
{
  "retry": {
    "enabled": true,
    "maxRetries": 3,
    "baseDelayMs": 2000,
    "maxDelayMs": 60000
  }
}
```

### Message Delivery

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `steeringMode` | string | `"one-at-a-time"` | How steering messages are sent: `"all"` or `"one-at-a-time"` |
| `followUpMode` | string | `"one-at-a-time"` | How follow-up messages are sent: `"all"` or `"one-at-a-time"` |
| `transport` | string | `"sse"` | Preferred transport for providers that support multiple transports: `"sse"`, `"websocket"`, or `"auto"` |

### Terminal & Images

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `terminal.showImages` | boolean | `true` | Show images in terminal (if supported) |
| `terminal.clearOnShrink` | boolean | `false` | Clear empty rows when content shrinks (can cause flicker) |
| `images.autoResize` | boolean | `true` | Resize images to 2000x2000 max |
| `images.blockImages` | boolean | `false` | Block all images from being sent to LLM |

### Shell

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `shellPath` | string | - | Custom shell path (e.g., for Cygwin on Windows) |
| `shellCommandPrefix` | string | - | Prefix for every bash command (e.g., `"shopt -s expand_aliases"`) |
| `npmCommand` | string[] | - | Command argv used for npm package lookup/install operations (e.g., `["mise", "exec", "node@20", "--", "npm"]`) |

```json
{
  "npmCommand": ["mise", "exec", "node@20", "--", "npm"]
}
```

`npmCommand` is used for all npm package-manager operations, including `npm root -g`, installs, uninstalls, and `npm install` inside git packages. Use argv-style entries exactly as the process should be launched.

### Sessions

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `sessionDir` | string | - | Directory where session files are stored. Accepts absolute or relative paths. |

```json
{ "sessionDir": ".void/sessions" }
```

When multiple sources specify a session directory, `--session-dir` CLI flag takes precedence over `sessionDir` in settings.json.

### Model Cycling

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `enabledModels` | string[] | - | Model patterns for Ctrl+P cycling (same format as `--models` CLI flag) |

```json
{
  "enabledModels": ["claude-*", "gpt-4o", "gemini-2*"]
}
```

### Markdown

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `markdown.codeBlockIndent` | string | `"  "` | Indentation for code blocks |

### Resources

These settings define where to load extensions, skills, prompts, and themes from.

Paths in `~/.void/settings.json` resolve relative to `~/.void`. Paths in `.void/settings.json` resolve relative to `.void`. Absolute paths and `~` are supported.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `packages` | array | `[]` | npm/git packages to load resources from |
| `extensions` | string[] | `[]` | Local extension file paths or directories |
| `skills` | string[] | `[]` | Local skill file paths or directories |
| `prompts` | string[] | `[]` | Local prompt template paths or directories |
| `themes` | string[] | `[]` | Local theme file paths or directories |
| `enableSkillCommands` | boolean | `true` | Register skills as `/skill:name` commands |

Arrays support glob patterns and exclusions. Use `!pattern` to exclude. Use `+path` to force-include an exact path and `-path` to force-exclude an exact path.

#### packages

String form loads all resources from a package:

```json
{
  "packages": ["void-skills", "@org/my-extension"]
}
```

Object form filters which resources to load:

```json
{
  "packages": [
    {
      "source": "void-skills",
      "skills": ["brave-search", "transcribe"],
      "extensions": []
    }
  ]
}
```

See [packages.md](packages.md) for package management details.

### Child orchestration

Child Provider configuration is an optional `orchestrator` object in `settings.json`. The same schema is accepted in global and project settings; project values override global values through the normal nested settings merge.

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
      "reviewer": {
        "type": "generic",
        "command": "reviewer-cli",
        "args": ["run", "{{prompt}}"],
        "modelFlag": "--model",
        "effortFlag": "--effort",
        "models": ["reviewer-default"],
        "extraArgs": [],
        "env": ["REVIEWER_API_KEY=..."],
        "auth": "auto"
      },
      "mock": { "type": "mock" }
    }
  }
}
```

`defaultProvider` must name an entry in `providers`. Provider types are `claude`, `codex`, `generic`, and `mock`. A generic provider requires a `command` and exactly one argv element equal to `{{prompt}}`; substring interpolation and shell templates are not supported. `modelFlag` and `effortFlag` add discrete argv values, `models` supplies configured model choices, `extraArgs` appends argv entries, and `env` entries use `KEY=VALUE` to overlay the parent environment. Environment values are never logged. The optional `auth` mode is `auto`, `subscription`, or `api`.

If `orchestrator` is absent, the runtime supplies its built-in Provider defaults with `claude` as the default. Invalid orchestration settings produce startup diagnostics and do not rewrite the settings file.

## Example

```json
{
  "defaultProvider": "anthropic",
  "defaultModel": "claude-sonnet-4-20250514",
  "defaultThinkingLevel": "medium",
  "theme": "dark",
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  },
  "retry": {
    "enabled": true,
    "maxRetries": 3
  },
  "enabledModels": ["claude-*", "gpt-4o"],
  "packages": ["void-skills"]
}
```

## Project Overrides

Project settings (`.void/settings.json`) override global settings. Nested objects are merged:

```json
// ~/.void/settings.json (global)
{
  "theme": "dark",
  "compaction": { "enabled": true, "reserveTokens": 16384 }
}

// .void/settings.json (project)
{
  "compaction": { "reserveTokens": 8192 }
}

// Result
{
  "theme": "dark",
  "compaction": { "enabled": true, "reserveTokens": 8192 }
}
```
