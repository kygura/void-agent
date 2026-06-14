# Wiki Schema — how this wiki is written

> This file governs the wiki. The wiki-update agent reads it before every
> update. The human refines it rarely. It is Layer 3 (the rules), per Karpathy's
> three-layer model: pages (the model) / log (the timeline) / schema (the rules).

## What the wiki is for

The wiki is the **comprehension surface**. The human reads the wiki, not the
diff. A page that only narrates what the code does is a FAILURE. Every page is
a readable model of the system that a human can hold in their head, and every
page that touches a decision must force a ruling (see "The tension rule").

## Layout

- `pages/` — one `.md` per architectural concept, module, or flow. LLM-maintained.
  - `architecture.md` — the top-level model: what the system is, its parts, how they relate.
  - `<module>.md` / `<flow>.md` — one per real boundary in the code.
- `log.md` — append-only decision timeline (newest at the BOTTOM). Immutable per entry.
- `tensions.md` — open questions the human must rule on. The real inbox.
- `index.md` — catalog + per-page freshness (last sha, stale flag). Machine block included.
- `schema.md` — this file.

## Style rules

1. Write for a human re-deriving their mental model after weeks away. Lead with
   the "why" and the shape; details second.
2. Prefer one concept per page. Link between pages with `[[page-slug]]`.
3. Every page states, near the top, the code it describes (paths) so freshness
   can be checked against reality.
4. Keep prose tight. No filler, no restating the obvious, no marketing tone.
5. Never invent certainty. If the code is ambiguous, say so — that ambiguity is
   a tension, not something to smooth over.

## The tension rule (the single most important rule — axiom #2)

Every page or log entry that touches a design decision MUST end with an explicit
unresolved question or a forced ruling when one exists. Describing what the code
does is necessary but NOT sufficient.

When a change introduces a tradeoff, contradicts a prior decision, leaves an
ambiguity, or picks one path where others were viable, you MUST state it as a
question the human has to answer and add it to `tensions.md`.

Prefer the form:

> "X now does Y. This contradicts/competes-with Z from session N. Which wins, and why?"

A page with no tensions is acceptable ONLY when the change is genuinely
mechanical. Do not manufacture false comfort. Do not smooth over conflicts to
make the wiki read cleanly. A smooth, complete wiki that the human absorbs
without thinking is the exact failure this system exists to prevent.

## Tension format (machine-readable, do not change the markers)

Open tensions in `tensions.md` are wrapped so the dashboard can track them:

```
<!-- tension:<id> open -->
**Tension:** <the forced ruling, in the "which wins, and why?" form>
<!-- /tension -->
```

When the human rules, the ruling is appended to `log.md` and the tension's
marker flips to `resolved`. Never delete a tension; resolution is provenance.
