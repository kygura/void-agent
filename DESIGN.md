# void-ts — Orchestration TUI Design Brief

Design for the **new orchestration UI only**. pi's existing interactive TUI
(transcript, composer, footer, tool/thinking rendering, model/session/theme
selectors) stays exactly as-is. This brief covers the surfaces that make
void's orchestration — spawned child runs, background task runs, the agents
view, provider status — visible inside that existing TUI.

Terms per `../void/CONTEXT.md`: Provider, Run, Session, Event, Task run,
Focused session, Transcript, Orchestrator, Generic provider. Primary design
source: `../void/DESIGN.md` (the Go TUI's binding doc). This brief **adapts**
that doc to pi's TypeScript TUI and calls out every divergence with cause.

---

## 0. Ground truth — what already exists in the fork

Read before designing anything. The orchestration layer is **greenfield**, but
`interactive-mode.ts` has already been wired to the *intended* component shape.
Build to these hooks; do not invent parallel ones.

**Forward-referenced but not yet written (the files this brief specifies):**

| Symbol | Import path | Constructed as | Purpose |
|---|---|---|---|
| `Sidebar` | `./components/sidebar.js` | `new Sidebar(session, runtimeHost, footerDataProvider)` | persistent run/agent panel |
| `SidebarLayout` | `./components/sidebar.js` | `new SidebarLayout(chatColumn, sidebar, settingsManager)` | wraps chat column + sidebar, owns the width breakpoint |
| `AgentsOverlayComponent` | `./components/agents-overlay.js` | `new AgentsOverlayComponent(subagentRegistry, harnessRunManager, done, onRender)` | the `/agents` dashboard |
| `SubagentRegistry` | `core/tools/subagent.js` | exposes `.onChange(cb): () => void` | live registry of spawned children |
| `HarnessRunManager` | `core/harness/index.js` | exposes `.subscribe(cb): () => void` | live registry of background/harness runs |

`AgentSessionRuntime` (`core/agent-session-runtime.ts`) already exposes
`runtimeHost.subagentRegistry` and `runtimeHost.harnessRunManager` (both
optional). `interactive-mode.ts` already: constructs the sidebar (line ~300),
adds `SidebarLayout` to the UI (line ~535), re-subscribes both registries on
every session swap (`subscribeToAgentPanels`, ~2299), toggles the sidebar on
`app.sidebar.toggle` = **ctrl+x** and `/sidebar`, and opens the overlay on
`/agents` via `showAgentsOverlay` → `showSelector`.

**This is the single most important divergence from `../void/DESIGN.md`:** the
fork has committed to a **persistent sidebar** — the "Sketch B" the Go doc
explicitly rejected in favor of an ambient-only "Sketch A". We honor the
fork's decision (the wiring exists and is cheap to finish) but keep the sidebar
faithful to the Go doc's *principle* ("transcript is the product"): narrow,
toggleable, and collapsed under a width breakpoint. See §4.

---

## 1. Visual language — reuse pi's, do NOT port "Event Horizon"

The Go doc defines a bespoke "Event Horizon" palette (Cherenkov, Aurora, Flare,
Dust…). **void-ts must not introduce a new theme.** pi already has a complete,
user-overridable theme system (`modes/interactive/theme/theme.ts`, tokens in
`theme/dark.json`) accessed via `theme.fg(token, text)` and
`theme.bg(bgToken, text)`. Every orchestration surface uses those tokens so it
inherits the user's theme and the 256-color fallback for free.

**Go palette → pi token map** (use the right column everywhere):

| Go "Event Horizon" | Meaning | pi token (`theme.fg` / `theme.bg`) |
|---|---|---|
| Cherenkov | live activity, focus, accent | `accent` (`#8abeb7`) / border-focus: `borderAccent` |
| Aurora | success, done, exit 0 | `success` |
| Flare | error, failed, non-zero exit | `error` |
| Corona | in-progress attention, cancelling | `warning` |
| Comet | info, links, session names | `border` (blue) — or `accent` if it must glow |
| Pulsar | thinking, provider names, titles | `customMessageLabel` (`#9575cd`) or `accent` |
| Starlight | primary text | `text` (default fg) |
| Dust | secondary metadata, collapsed headers | `muted` |
| Faint | rules, placeholders, hints | `dim` |
| Umbra bg (raised) | user-msg / expanded bodies | `userMessageBg` |
| Penumbra bg | overlays | `customMessageBg` / `selectedBg` |

**pi's hierarchy convention is background tint + a bold bracketed label — NOT
left gutter bars or status glyphs.** Concretely, from the existing renderers:

- User messages (`user-message.ts`): `Spacer(1)` + `Markdown` on
  `theme.bg("userMessageBg")`, text `userMessageText`. **No `┃` left bar.**
- Custom/extension entries (`custom-message.ts`): a `Box(1,1, bg=customMessageBg)`
  whose first line is a **bold label** `theme.fg("customMessageLabel", "\x1b[1m[type]\x1b[22m")`,
  then `Markdown` content.
- Tool executions (`tool-execution.ts`): a `Box` whose background encodes status
  — `toolPendingBg` (running) → `toolSuccessBg` (ok) / `toolErrorBg` (error);
  title bold in `toolTitle`, body in `toolOutput`; an `expanded` flag toggles
  the body.

**Divergence from Go §4.1/§4.4:** we drop the `┃` user bar and the 2-col indent
in favor of pi's box-background idiom, because every existing pi entry uses it
and mixing the two conventions would read as two different apps. Status is
carried by **background tint + a bold `[label]` + one plain-Unicode status
glyph**, never by a colored gutter bar.

**Status glyphs** (keep the Go doc's set — all plain Unicode, pi ships no
nerd-font glyphs either): pending `○` (`muted`), running spinner
`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` (`accent`), done `✓` (`success`), failed `✗` (`error`),
cancelled `⊘` (`muted`). The spinner only animates while ≥1 run is live (reuse
pi's existing loader tick; do not add a second timer).

**Components/utilities to build with** (all from `@mariozechner/pi-tui`,
already used throughout): `Container`, `Box(padX, padY, bgFn)`,
`Text(text, padX, padY, bgFn?)`, `Markdown`, `Spacer(n)`, `SelectList` +
`getSelectListTheme()`, `truncateToWidth`, `visibleWidth`.

---

## 2. Spawn fan-out — child runs in the parent transcript

When the focused session spawns children (the subagent tool fires, or `/spawn`
fans out several), each child appears as **one custom transcript entry** that
lives at the point in the conversation where it was spawned and updates in
place as the child streams.

**Mechanism (extension API):** `pi.registerMessageRenderer("void:spawn",
renderer)` plus one `appendEntry("void:spawn", data)` per spawned child at spawn
time. The renderer is `(message, { expanded }, theme) => Component`. Live
updates: the orchestrator mutates the entry's backing data and the registry's
`onChange`/`subscribe` fires `ui.requestRender()` (already wired in
`subscribeToAgentPanels`), which re-invokes the renderer — the same
invalidate/rebuild path `CustomMessageComponent` already uses. No new
re-render machinery.

> If the spawn layer is built first-class instead of as a bundled extension,
> the same `registerMessageRenderer` seam is used internally — the renderer
> contract is identical either way.

**Entry layout — collapsed (default):** a single `Box` whose background is the
status tint (running → `toolPendingBg`, done → `toolSuccessBg`, failed →
`toolErrorBg`, cancelled → `customMessageBg`). One line:

```
[spawn] ⠹ fix-lint  codex  running 1m32s  · go vet ./...
[spawn] ✓ docs-gen  claude  done 41s  · $0.02  3 files
[spawn] ✗ e2e-suite claude  failed 3m10s  · exit 1
```

- `[spawn]` label bold in `customMessageLabel`.
- glyph + `accent`/`success`/`error`/`muted` per §1.
- name (bold `text`), provider (`muted`), state + elapsed (`muted`), then a
  `·`-separated **last-activity** tail (running: latest tool/text summary,
  truncated with `truncateToWidth`; finished: cost/exit/file-count if known).
- Elapsed ticks at 1s **only while running** (claude-code cadence). Reuse the
  live-run tick; finished rows are static.

**Expanded (pi's existing `expanded` toggle, no new key):** the box grows to
show the child's last ~6–10 events rendered with pi's normal entry renderers
(tool one-liners, assistant text, the run's result line), capped with a
`dim` `… N more lines`. This reuses the transcript renderer rather than a
bespoke tail widget.

**How much shows inline:** collapsed one-liner is the default and the resting
state — a fan-out of 5 children is 5 quiet lines, not 5 scrolling transcripts.
Full child output is one expand away (per child), and the full interactive
child is one `enter` away — a focused spawn entry opens the child-session view
(§3A) via `app.child.enter`.
**Divergence from Go §9.1:** the Go doc keeps task runs *out* of the transcript
entirely (fire-and-forget, surfaced only in the run strip). We put the spawn
entry inline because `/spawn` is initiated *from* this conversation and reads as
part of it; background task runs started elsewhere stay out of the transcript
and live only in the sidebar/overlay (§4). The rule: **spawned-from-here →
inline entry + sidebar; started-elsewhere → sidebar/overlay only.**

**Status progression** drives only the box background and the glyph; the entry
never changes position or height class (collapsed stays one line) as it
transitions, so the transcript never reflows under the user (codex no-jump
rule).

---

## 3. `/agents` view — the runs dashboard overlay

Canonical registry view of every live + recent run/session. Opened by `/agents`
(already wired) — add `ctrl+g`… no: keep `/agents` as the trigger and, if a
key is wanted, bind a new `app.agents.toggle` action (do not overload the
sidebar's ctrl+x). Built as **`AgentsOverlayComponent`** with the already-wired
constructor `(subagentRegistry, harnessRunManager, done, onRender)`.

**Presentation:** reuse pi's `SelectList` (+ `getSelectListTheme()`) inside a
focus-swap component via the existing `showSelector` path (what
`showAgentsOverlay` already calls). This matches every other pi picker
(sessions, models, settings) and gives arrow-nav, filter-as-you-type, and the
`accent` selected-row marker for free. **Divergence from Go §3.2:** the Go doc
specifies a bespoke Canvas/Layer floating overlay with a live-tail inspector
pane. We use pi's `SelectList` picker instead — it is the house idiom and the
inspector pane is replaced by "enter the run" (§3A). A true floating
overlay is available (`ctx.ui.custom(factory, { overlay: true })`) if a later
version wants the split; v1 stays with the cheaper focus-swap list.

**Grouping & sort:** one list, grouped by state with dim section headers,
newest-first within a group: **running** → **pending** → **finished**
(done/failed/cancelled interleaved by end time). Subagent children and harness
task runs are merged into one list (they are both "runs" to the user); a
one-glyph origin hint distinguishes them only if needed.

**Row content:** `glyph  name  provider  state  elapsed  · last-activity/cost/exit`
— identical column vocabulary to the spawn entry (§2) so the two never disagree.
Filter matches `name + provider + state` (pi's filterable-picker convention).

**Navigation / keys** (SelectList defaults + these):

- `↑↓` select · type to filter · `esc` close (per pi).
- `enter` — **enter the run**: open the child-session view (§3A) for that row —
  live and interactive for child Sessions, read-only (composer disabled with a
  reason line) for TaskRuns and generic sessions. If the row is the focused
  parent session itself, just close the overlay.
- `ctrl+x` — cancel the selected run (confirm via `ctx.ui.confirm` only if it is
  running). Matches the Go doc's cancel key and avoids a printable letter that
  would type into the filter.
- new run: `/spawn` from the composer (below) rather than an in-overlay `n`,
  keeping the overlay read-mostly.

**Empty state:** `no runs yet — spawn one with /spawn` (dim).

---

## 3A. Child-session view — enter, prompt, resume

Pressing enter on a child anywhere — spawn entry (§2), sidebar (§4), `/agents`
row (§3) — opens the **child-session view**: a full-screen focus swap that
replaces the parent transcript + composer with the child's. It is **live and
interactive**, not a read-only attach. The interaction model is claude-code's
teammate view (`enterTeammateView`/`exitTeammateView`,
`TeammateViewHeader`): enter a running subagent, read its stream, type
follow-ups into the same composer, esc back to the parent; completed agents
stay viewable for review and are never auto-exited.

**Entry points** (all via configurable keybinding actions — no hardcoded key
matches anywhere in this section):

| From | How |
|---|---|
| inline spawn entry (§2) | entry focused → `app.child.enter` (default `enter`) |
| `/agents` overlay (§3) | selected row → `enter` (SelectList submit) |
| sidebar (§4) | `app.sidebar.focus` moves focus into the run list → `↑↓` → `app.child.enter` |

Every origin opens the same view. TaskRuns open it too, read-only (routing
table below).

**Layout (top to bottom):** header, child transcript, queue strip (only when
non-empty), composer, footer. The sidebar is never rendered inside the view —
the view owns the full width, so the §4 breakpoint is moot here.

**Header** — one status line plus one dim hint line, built from the same
`RunRow` vocabulary (§8.1) so the header and every row rendering of this child
can never disagree:

```
[agent] ⠹ fix-lint  codex · gpt-5.6 · high  running 1m32s   ↩ parent: auth-refactor
esc detach · ctrl+x cancel · queued 2
```

- `[agent]` bold in `customMessageLabel`; glyph + state color per §1; name bold
  `text`; provider, model, effort in `muted` (model/effort shown only when
  armed via `/agent-model`/`/agent-effort`); elapsed ticks at 1s only while
  running (§2 rule, same shared tick).
- Parent link in `dim`: the parent session's name. It is a label, not a
  button — `app.child.detach` is the way back.
- The hint line shows only actions that currently apply: no `cancel` on a
  finished run, `queued N` only when N > 0. (claude-code's header shows
  "Viewing @name · esc return" plus the original prompt; we keep that shape
  but swap in the RunRow columns.)

**Transcript area:** the child Session's persisted Transcript (from the append
store) plus live Events, rendered with pi's normal entry renderers — `text`/
`thinking` as assistant entries, `tool` Events as tool one-liners, each Run's
`result` as its result line, prompts as user messages. Restored sessions render
history first, then live Events append. No bespoke tail widget — §2's rule
applied to the full view. Scrollback follows pi's existing transcript behavior.

**Composer routing** — submit maps onto SPEC orchestrator semantics exactly;
the composer is a discrete-prompt box, never a keystroke pipe (PTY embedding is
out of scope for v1):

| Session state | Submit does | Composer state |
|---|---|---|
| live Run (pending/running) | **enqueue FIFO** — completion or cancellation atomically starts the oldest queued prompt | active, placeholder `queue a follow-up…` |
| idle + resumable (claude/codex/mock, `providerSessionId` known) | **start a resume Run** — identical to `/agent-resume <session-id> <prompt>` | active, placeholder `resume codex session…` |
| idle, no `providerSessionId` recorded | — | disabled: `no provider session id recorded — this child cannot be resumed` |
| generic Provider session (any state) | — | disabled: `generic providers are not resumable — read-only` |
| TaskRun (any state) | — | disabled: `task run — fire-and-forget, not attached to a session` |

- A disabled composer renders as a single `dim` reason line where the composer
  would sit — the reason is always visible, never a silently missing input.
- **Generic while live:** disabled even during the first Run. SPEC lets any
  Session enqueue, but a generic session's queued prompt would drain into a
  resume attempt and die as a terminal failed Run — offering the queue would be
  a trap. `/agent-resume` typed at the parent still exercises the SPEC path
  (inspectable failed Run) for anyone who insists; the view then renders that
  failed Run like any other (§7).
- **Queue strip:** queued prompts render above the composer, oldest first, each
  a dim truncated line `2· fix the flaky test…`; the count mirrors into the
  header hint. `app.child.queueDrop` (default `alt+backspace`) removes the
  **newest** queued prompt (SPEC remove-newest) and confirms with a one-line
  status `dropped queued prompt`.

**Detach:** `app.child.detach` (default `esc`) returns to the parent transcript
exactly as the user left it. The child keeps running, queued prompts stay
queued, nothing is cancelled. If the composer holds text, esc first follows
pi's normal composer-clear behavior; the next esc detaches. Detaching from a
finished child changes nothing about its registry/store lifecycle.

**Cancel from the view:** `app.child.cancel` (default `ctrl+x`, view-scoped —
the sidebar is not visible here, so no collision with `app.sidebar.toggle`, and
it matches the overlay's cancel key, §3). Confirm via `ctx.ui.confirm` while
the Run is live; when the queue is non-empty the confirm copy says what happens
next: `cancel run? 2 queued prompts — the oldest starts next` (SPEC:
cancellation atomically starts the oldest queued prompt).

**State transitions in place** — the view never closes on a state change:

- pending → running: glyph/status flip only.
- running → done/failed/cancelled: header flips per §1/§7, the Run's `result`
  line lands in the transcript, and the composer re-evaluates its row in the
  routing table (queue mode → resume mode, or a disabled reason). If prompts
  are queued, the oldest starts and the view simply keeps streaming.
- **No auto-detach on completion** — claude-code's rule: the user stays to
  review the transcript. Auto-detach happens only when the session itself
  vanishes (edge states, below).

**Notifications while attached (§5 amendment):** the viewed child counts as the
focused session — its completion gets **no** toast (the result lands in view).
The parent session and every other run count as non-focused while the view is
open and toast normally per §5.

**Edge and error states:**

- **Unsupported resume forced anyway** (`/agent-resume` on a generic session):
  rendered exactly as SPEC defines — a terminal failed Run appended to the
  transcript; the header flips to `✗ failed`, the reason is the result line.
  No special chrome.
- **Provider exits while focused:** never a dead screen — the terminal Events
  (`result`, `exit`) render, the header flips, the composer re-routes. Spawn
  failures (missing binary) render per §7 with the `void:` prefix.
- **Session evicted/unknown while viewing** (registry loses it, store entry
  gone): auto-detach to the parent plus `notify(info, "child session ended —
  detached")`. Mirrors claude-code's auto-exit, which fires on eviction/kill
  only — finished children never auto-detach.
- **Narrow terminals:** the header status line truncates right-to-left — parent
  link drops first, then model/effort, then elapsed; glyph + name survive to
  the last column (`truncateToWidth`). Queue lines and the hint line truncate
  independently. No §4-style breakpoint collapse — the view already owns the
  full width.

**Keybindings** — all through the configurable keybinding map (`keybindings.ts`
actions, same mechanism as `app.sidebar.toggle`); defaults below are defaults,
never hardcoded matches:

| Action | Default | Scope |
|---|---|---|
| `app.child.enter` | `enter` | focused spawn entry / focused sidebar row (overlay rows use SelectList submit) |
| `app.child.detach` | `esc` | child-session view |
| `app.child.cancel` | `ctrl+x` | child-session view |
| `app.child.queueDrop` | `alt+backspace` | child-session view |
| `app.sidebar.focus` | `alt+x` | main view, sidebar visible |

---

## 4. Sidebar — the ambient run surface (already committed)

The fork's `Sidebar` + `SidebarLayout` is void's answer to the Go doc's "run
strip". It is the always-available glance at background activity, so the user
does not need `/agents` for a quick count.

**Content (top to bottom):** a dim `agents` header with the live count
(`2▶ 1✓`), then up to ~6 run rows (running first, then recently-finished for
~30s), each a one-line `glyph name provider elapsed` using the §1 tokens. Below
a hairline, the recent-sessions list. Overflow → `…and N more`.

**Layout contract (owned by `SidebarLayout`):** narrow fixed width (~28–32
cols) to the right of `chatColumn`; **collapses entirely below a width
breakpoint** (implement the breakpoint in `SidebarLayout`, per the code comment
at line ~244) so 80-col terminals keep the full transcript. Toggle: `ctrl+x`
(`app.sidebar.toggle`) and `/sidebar`, both already wired; persisted via
`settingsManager.getSidebar()`. Default off is a reasonable v1 choice given the
Go doc's "transcript is the product" stance — the overlay (`/agents`) is the
complete view; the sidebar is the optional ambient one.

**Divergence from Go §3.1:** the Go run strip sits *above the composer* and is
transient; void's sidebar sits *beside* the transcript and is toggleable. Both
serve the same "ambient background-run visibility" goal; the fork's structural
choice wins because it is already built into the layout tree. If a later version
wants the Go-style transient strip too, it is an extension `setWidget(key, …,
{ placement: "aboveEditor" })` and needs no core change.

**Entering a run from the sidebar:** `app.sidebar.focus` (default `alt+x`,
configurable) moves focus into the run list; `↑↓` selects, `app.child.enter`
opens the child-session view (§3A), `esc` returns focus to the composer. Focus
is transient, never sticky — the sidebar stays a glance surface.

**Data:** `Sidebar` reads `runtimeHost.subagentRegistry` +
`harnessRunManager` and re-renders on their change events (subscription already
wired). It must tolerate both being `undefined` (orchestration disabled) by
rendering nothing.

---

## 5. Background-run notifications (toasts)

**Mechanism:** `ctx.ui.notify(message, type)`. pi already routes it
(`showExtensionNotify`, ~1914): `info` → `showStatus`, `warning` →
`showWarning`, `error` → `showError`. **Do not build a bespoke 4s toast with
severity chips** (Go §6.2) — reuse `notify`. Divergence noted: pi's notify is a
transient status message, not a persistent colored chip; the durable count
lives in the sidebar/footer instead (§4, §6).

**When they fire:**

- A **non-focused** run finishes → `notify`. done → `info`:
  `✓ docs-gen finished · 41s`. failed → `error`:
  `✗ e2e-suite failed · exit 1 · /agents to view`.
- **Spawn failure** (bad command / missing binary) → `error` immediately, in
  addition to the failed sidebar/overlay row (§7).
- **Focused-session** completions get **no** toast — the result line lands in
  view (Go §9.4). While a child-session view is open (§3A), the viewed child is
  the focused session for this rule; the parent counts as non-focused. No
  terminal bell in v1.

Message text: short, glyph-prefixed, `<glyph> <name> <verb> · <detail>`. Keep it
to one line; `notify` owns truncation.

---

## 6. Provider selection & status

pi is model-centric (it shows model + provider in the footer); void adds the
**provider** as a first-class, switchable axis.

**Status surface (footer segment):** use `ctx.ui.setStatus("void:provider",
text)`. The footer already renders extension statuses on their own dim line
(`footer.ts` → `getExtensionStatuses()`, alphabetical, space-joined,
width-truncated). Content: the effective provider name; when a provider is
*armed but not committed* (see below) append a dim `⟳`:
`provider: codex ⟳`. This reuses the footer's existing extension-status channel
— no footer surgery. **Divergence from Go §6.1:** the Go status line is a
bespoke multi-segment assembler with a drop-order; pi's footer already owns
segment layout and truncation, so provider is just one more `setStatus` entry
and we inherit pi's drop behavior.

**Selection:**

- `/provider [name]` command (`pi.registerCommand`): with an arg, arm/switch;
  bare, open a picker. The picker is `ctx.ui.select("provider", names)` — pi's
  simple selector, no custom UI.
- Optional ergonomic key mirroring the Go doc's shift+tab cycle: bind a new
  `app.provider.cycle` action. **Adopt the Go doc's arm-then-commit rule (§14.0)
  verbatim in spirit:** cycling/selecting *arms* `pendingProvider`; the switch
  (and its resume-chain reset) commits at the next submit, so merely *looking*
  never resets a live session's conversation. Show the armed state with the `⟳`
  in the footer segment; clear it on commit or on session switch.

Sessions are provider-bound (CONTEXT.md): switching the focused session's
provider applies to its **next** run and resets that provider's resume chain —
surface this once, at commit, via `notify(info, "provider → codex · next run
starts fresh")`.

---

## 7. Error presentation for failed child runs

A failed run is the same spawn entry (§2) / overlay row (§3) flipped to the
failed state — background `toolErrorBg`, glyph `✗` in `error`. The failure
*reason* is the last-activity tail and the expanded body. Three failure classes,
each with concrete copy:

- **Bad exit** (child ran, non-zero exit / result `isError`): collapsed
  `[spawn] ✗ e2e-suite claude failed 3m10s · exit 1`. Expanded body: the last
  ~5 lines of the child's stderr/stream, `muted`, capped.
- **Missing binary / spawn failed** (provider command not found): the run never
  reaches running — it appears already-failed. Collapsed
  `[spawn] ✗ fix-lint codex failed · command not found: codex`, prefixed
  `void:` in the expanded body to mark it as an orchestrator error, not the
  child's output. Also fires an `error` toast immediately (§5).
- **Unparseable stream** (generic provider emits non-JSON / adapter can't
  normalize): per the Go doc this is **never fatal** — the raw text is shown as
  plain output and the run continues; only a true process failure flips the row
  to `✗`. If the stream is unparseable *and* the process exits non-zero, it is
  a bad-exit failure with the raw tail as the body. No special "parse error"
  chrome — a garbled tail is self-evident.

**Divergence from Go §4.6:** the Go doc uses a dedicated `Flare` block with a
`✗ run failed` header line. We fold this into the standard failed-entry
background+glyph so failed runs render identically inline and in the overlay,
and the "void:" prefix (only for orchestrator-level errors) is the sole extra
signal.

---

## 8. Component boundaries & names for the implementer

Two integration paths. **Persistent/structural** orchestration UI is
first-class in `interactive-mode.ts` (already forward-wired). **Per-entry and
transient** surfaces go through the **extension API** (the task's preference,
and cleaner for the spawn/notify/status pieces).

### 8.1 First-class components to create

| Component | File | Responsibility | Reads / uses |
|---|---|---|---|
| `Sidebar` | `modes/interactive/components/sidebar.ts` | ambient run + session panel (§4) | `runtimeHost.subagentRegistry.onChange`, `harnessRunManager.subscribe`, `footerDataProvider`; pi-tui `Container`/`Box`/`Text`; `theme.fg/bg` tokens |
| `SidebarLayout` | same file | side-by-side layout of `chatColumn` + `Sidebar`; **width breakpoint** (collapse under threshold); honors `settingsManager.getSidebar()` | pi-tui layout, `settingsManager` |
| `AgentsOverlayComponent` | `modes/interactive/components/agents-overlay.ts` | `/agents` dashboard (§3) | both registries, `SelectList` + `getSelectListTheme()`; `done`/`onRender` callbacks; `ctx.ui.confirm` for cancel |
| `ChildSessionView` | `modes/interactive/components/child-session-view.ts` | full-screen child view (§3A): header, child transcript, queue strip, routing composer / disabled-reason line | orchestrator session/TaskRun snapshot + Event subscription, store-loaded Transcript, pi's existing entry renderers, keybinding map, `ctx.ui.confirm` |
| `RunRow` (helper) | shared (e.g. in sidebar.ts or a small `run-row.ts`) | the one-line `glyph name provider state elapsed · tail` renderer used by sidebar, overlay, and the spawn entry | `theme` tokens, status glyph set, `truncateToWidth` |

`RunRow` is the single source of the row vocabulary — sidebar, overlay, and the
spawn transcript entry all call it so they can never drift (Go doc's "one
renderer" principle, §4).

### 8.2 Extension API surfaces used

| Deliverable | Extension API surface |
|---|---|
| Spawn entry in transcript (§2) | `registerMessageRenderer("void:spawn", …)` + `appendEntry`; live update via registry `onChange` → `ui.requestRender` |
| Failed-run styling (§7) | same renderer, `toolErrorBg` + `✗`; missing-binary also `ctx.ui.notify(msg, "error")` |
| Background-run toasts (§5) | `ctx.ui.notify(message, "info" \| "warning" \| "error")` |
| Provider status segment (§6) | `ctx.ui.setStatus("void:provider", text)` |
| Provider picker (§6) | `pi.registerCommand("provider", …)` + `ctx.ui.select(...)` |
| `/agents`, `/spawn`, `/sidebar` commands | `pi.registerCommand(...)` (or the already-wired inline handlers) |
| Child-session view (§3A) | focus swap via the same mechanism as `showSelector`/session-swap; composer submit → orchestrator enqueue (live Run) or resume (idle resumable), one call site |
| View keys (`app.child.enter/detach/cancel/queueDrop`, `app.sidebar.focus`) | keybindings.ts entries — configurable map, no hardcoded matches |
| Optional keys (`app.provider.cycle`, `app.agents.toggle`) | `pi.registerShortcut(keyId, …)` / keybindings.ts entries |
| Cancel-run confirm | `ctx.ui.confirm(title, message)` |
| New-run form, if richer than `/spawn [name]` | `ctx.ui.custom(factory, { overlay: true })` or sequential `ctx.ui.input`/`ctx.ui.select` |

### 8.3 Core data the UI depends on (must be exposed by the orchestration layer)

`RunRow` needs, per run: `name`, `provider`, `state`
(`pending|running|done|failed|cancelled`), `startedAt`/`endedAt` (for elapsed),
a short `lastActivity` string, and on finish `cost?`/`exitCode?`/`error?`. The
`SubagentRegistry` and `HarnessRunManager` must expose a snapshot list of these
plus `onChange`/`subscribe`.

`ChildSessionView` (§3A) additionally needs, per child Session:
`parentSessionId?`, `providerSessionId?`, `resumable` (claude/codex/mock true,
generic false), armed `model?`/`effort?`, and `queue: string[]` (queued
prompts, oldest first — SPEC exposes queue state in snapshots). Operations it
calls: submit (enqueue-or-resume), remove-newest-queued, cancel. This brief
does not design those core types — it only fixes the fields and operations the
UI reads.

### 8.4 Anti-scope (do not build)

- No "Event Horizon" theme, no new palette — reuse `theme.*` tokens (§1).
- No bespoke toast/chip system — reuse `notify` (§5).
- No Canvas/Layer overlay framework — reuse `SelectList`/`showSelector`; escalate
  to `ctx.ui.custom({overlay:true})` only if a split-pane inspector is later
  demanded (§3).
- No left-gutter-bar entry style — reuse box-background + bold `[label]` (§1).
- No second animation timer — reuse pi's live-run tick for the spinner/elapsed.
- No PTY embedding — the child composer routes discrete prompts (FIFO enqueue
  or resume Run), never raw keystrokes (SPEC out-of-scope).
- No hardcoded key matches — every §3A interaction goes through the
  configurable keybinding map.

---

## 9. Summary of divergences from `../void/DESIGN.md`

1. **Sidebar (Sketch B), not ambient-only (Sketch A)** — the fork already wired
   a persistent sidebar; we keep it narrow, toggleable (ctrl+x), width-collapsing.
2. **pi theme tokens, not Event Horizon** — every color maps to
   `theme.fg/bg`; the user's theme and 256-color fallback come free.
3. **Box-background + bold `[label]` hierarchy, not `┃` gutter bars** — matches
   every existing pi entry renderer.
4. **`notify()` transient messages, not bespoke 4s severity-chip toasts.**
5. **`SelectList` picker for `/agents`, not a Canvas/Layer overlay with a
   live-tail inspector** — house idiom; attach-on-enter replaces the inspector.
6. **Spawned-from-here runs render inline as transcript entries**, while
   started-elsewhere task runs stay in the sidebar/overlay only (Go keeps all
   task runs out of the transcript).
7. **Failed runs reuse the standard failed-entry style** (`toolErrorBg` + `✗`),
   not a separate Flare error block; only orchestrator-level errors get the
   `void:` prefix.
8. **Enter opens a live, interactive child-session view** (§3A) — claude-code's
   teammate-view model: full-screen child transcript, a composer that routes to
   the child (FIFO enqueue while a Run is live, resume Run when idle), esc
   detaches with the child still running. The Go doc has no interactive attach;
   TaskRuns and generic sessions get the same view with the composer disabled
   and an explicit reason line.
