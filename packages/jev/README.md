# @void/jev

Typed client for [TypeSafe](https://typesafe.ai)'s Jev, a System One model. Jev doesn't generate text. You send it a state and typed questions, and it answers all of them in one parallel pass with calibrated probabilities.

In void, Jev makes the small, frequent decisions in the agent loop that shouldn't cost a full LLM call. The LLM still plans and writes code; your code owns control flow and side effects.

## Install and configure

```bash
export TYPESAFE_API_KEY=...
# optional
export TYPESAFE_BASE_URL=https://api.typesafe.ai
```

## Ask questions

```ts
import { choice, JevClient, noul, score } from "@void/jev";

const jev = new JevClient({ model: "jev-1.13.0" });

const res = await jev.ask(ticketText, {
	department: choice("Which team should handle this", {
		billing: "Payment or subscription issues",
		technical: "Bugs or integration problems",
	}),
	frustration: score("How frustrated the customer appears", ["Calm", "Frustrated but civil", "Very angry"]),
	is_urgent: noul("The message conveys urgency or time-sensitivity"),
});

res.answers.department.choice; // "billing" | "technical"
res.answers.department.confidence; // 0..1
res.answers.is_urgent.noul; // P(yes)
```

| Question | Answer fields |
| --- | --- |
| `noul(instructions)` | `noul`: probability the answer is yes |
| `choice(instructions, { option: description })` | `choice`, `confidence`, `probabilities` per option |
| `score(instructions, levels)` | `score` (expected level index), `confidence`, `probabilities` per level |

`confidenceOf(answer)` gives one certainty reading for all three types. Noul answers have no `confidence` field, so it uses `|p - 0.5| * 2`.

### Guarantees

Each response is checked against the questions you asked. If an answer is missing, has the wrong type, picks a choice outside your options, or has a probability outside [0, 1], the client throws `JevResponseError`. You never get a mistyped value back. Other failures throw their own errors: `JevAPIError` for a non-2xx status, `JevTimeoutError` when the request exceeds the timeout (default 5s), and `JevRequestError` for a malformed request. When a Jev answer gates a side effect, treat any of these errors as "no judgement" and take the conservative path.

`jev-latest` is an alias and moves with each release, which can shift the calibrated numbers. Once your thresholds are tuned, pin a versioned id.

## Tool-call judge

`createToolCallJudge(client)` screens an agent's tool call before it runs. It asks five questions in one request:

- `verdict`: `run`, `ask`, or `reject`, judged against what the user asked for
- `destructive`: irreversible data loss outside version control
- `exfiltration`: secrets or private data leaving the machine
- `off_task`: the call goes beyond or against the request
- `blast_radius`: project only, the wider machine, or remote systems

`decideToolCall(answers, policy)` is a pure function that turns those answers into `allow`, `ask`, or `reject`:

- **Allow** only when the verdict is `run` with confidence ≥ 0.9, every risk probability is below 0.15, and the blast radius stays inside the project.
- **Ask** when any single risk reaches 0.5.
- **Reject** only on a confident `reject` verdict (≥ 0.8) or likely exfiltration (≥ 0.85).
- Anything else is **ask**.

Allowing needs every signal to agree, while one clear risk is enough to escalate. All thresholds are overridable through `policy`.

`@void/coding-agent` uses this through `permissions.judge`. See its settings docs.
