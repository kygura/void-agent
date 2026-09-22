# SPEC: Jev-constrained harness

Status: phase 1 shipped (`@void/jev`, `permissions.judge`). Phases 2-4 are proposals.

## Why

Today every control decision in void's loop is made by the same model that writes the code. It decides which tool to call, whether it's done, whether a call is safe, and which model to use. It makes those decisions in free text, so the harness can't inspect or bound them.

Jev (TypeSafe's System One model) inverts that for the narrow decisions. It takes a state and typed questions (Noul yes/no, Choice pick-one, Score ordered levels) and returns calibrated probabilities. It answers in tens of milliseconds, never generates text, and always matches the schema. Our client validates every answer against the question asked.

We use one pattern throughout:

```
deterministic code -> Jev judgement (typed, calibrated) -> deterministic code (threshold, route, act)
```

The LLM plans and writes. Jev classifies. Code decides. We take every threshold decision in code, so it is testable and logged. All questions for one decision point go out in one request, which costs about the same as asking one.

## Invariants

1. **Jev never has the final say on a side effect.** It can move a call to a safer path, from a prompt to a block. It can skip a prompt only when every signal clears a high bar.
2. **Losing Jev degrades to today's behavior, never to a more permissive one.** A timeout, an HTTP error, or a schema mismatch counts as "no judgement".
3. **Every decision function is pure.** Answers and policy go in, the decision comes out, and it has unit tests with no network.
4. **Pin the model.** Thresholds are tuned against a versioned id. `jev-latest` is only for exploration.

## Phase 1: tool-call gate (shipped)

- `packages/jev`: a dependency-free client for `POST /v1/systemone`, typed question builders, response validation, `createToolCallJudge`, and the pure `decideToolCall`.
- `PermissionGate.setJudge()`: an automated pre-screen before the human approver. `allow` skips the prompt, `reject` blocks with a reason the model sees, and `ask` or an error goes to the prompt. With no approver, `ask` is denied.
- The state sent to Jev is the tool name, the clipped arguments, the cwd, the agent origin, and the latest user message. The user message lets Jev judge a call against what was actually asked. `rm -rf build` reads differently after "clean the build" than after "fix a typo".
- Headless runs (print and RPC) with `permissions.enabled` and a judge stay gated. Without a judge they keep auto-approving.
- Subagents share the parent's gate, so children get the same judge.

## Phase 2: loop control

Add these decision points to `AgentSession`, each one Jev request per turn:

| Decision | Questions | Deterministic action |
| --- | --- | --- |
| Turn end: done? | Noul `task_complete`, Noul `claims_unverified` (says tests pass without running them) | Unverified claim above threshold: queue a follow-up asking for evidence |
| Stuck loop | Noul `repeating` (state is the last N tool calls and results), Score `progress` | Repeating plus low progress: steer message, then stop after K occurrences |
| Tool result triage | Choice `outcome` {success, failure_actionable, failure_environmental} | Environmental failure: don't count it against the loop budget, surface it to the user |

Each one plugs into existing hooks: `afterToolCall`, `turn_end` events, and the steering and follow-up queues. No LLM call is added.

## Phase 3: routing

- **Model routing.** On each user prompt, a Choice over `scopedModels`, with each option's criteria written in settings (for example `fast`: "lookups, localized edits"). Route only above a confidence bar, and otherwise keep the current model. The route is recorded in the session so replays are deterministic.
- **Subagent dispatch.** Before `subagent` spawns, a Choice over the orchestrator Providers (claude, codex, void) and a Score for task size, to pick provider and effort. Today the parent LLM guesses these in free text.
- **Skill and context selection.** A Choice fan-out over skill descriptions (one Noul each, in the same request) picks which skills load. This replaces sending every skill description to the LLM each turn.

## Phase 4: typed plan execution

This is the step toward near-deterministic execution. The LLM writes a plan once, as a typed list of steps with tool, target, and success check. The harness executes the plan. Jev gates each transition:

- Before a step: Noul "does the current state still satisfy this step's precondition?"
- After a step: Choice {advance, retry, replan} on the tool result against the step's success check.

The LLM is called again only on `replan`, or to write the content of a step (edit bodies). Control flow lives in code, checked by Jev at each edge. The LLM handles the parts that need generation.

## Open questions

- **Calibration data.** Thresholds need labelled examples from our own sessions. Log (state, answers, decision, eventual human decision) from interactive runs where the prompt was shown anyway. That gives free labels for tuning `allowConfidence`.
- **State size.** Jev reads long states, but we clip tool arguments at 4k characters. Measure whether judging the file path and a diff summary beats judging the full body.
- **Cost.** One request per gated call is cheap, but phase 2 adds one per turn. We should batch every phase-2 question into the single `turn_end` request.
