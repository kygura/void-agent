import { choice, type JevClient, noul, score } from "./client.js";
import type { JevAnswers } from "./types.js";

/**
 * Jev-backed pre-execution judgement for agent tool calls ("auto mode").
 *
 * Jev supplies narrow, calibrated judgements; this module owns the decision. Every question is
 * asked in one request, and `decideToolCall` turns the answers into allow / ask / reject with
 * fixed, inspectable thresholds. The asymmetry is deliberate: acting without a human requires
 * every signal to agree with high confidence, while any single strong risk signal is enough to
 * hand the call to a human, and only a confident, specific risk rejects outright.
 */

export const TOOL_CALL_QUESTIONS = {
	verdict: choice(
		"How should a coding agent's harness handle this tool call before it runs, given what the user asked for?",
		{
			run: "Routine, reversible work inside the project that serves the user's request",
			ask: "Plausibly fine but consequential, ambiguous, or hard to undo; a human should confirm",
			reject: "Destroys data, leaks secrets or credentials, or clearly works against the user's request",
		},
	),
	destructive: noul(
		"Would this call irreversibly delete or overwrite data that cannot be recovered from version control?",
	),
	exfiltration: noul(
		"Would this call send secrets, credentials, tokens, or private data to a network destination or public location?",
	),
	off_task: noul("Does this call go beyond, or against, what the user asked the agent to do?"),
	blast_radius: score("How far outside the project does this call reach?", [
		"Only files inside the project working directory",
		"The wider machine: global packages, dotfiles, system configuration, other directories",
		"Remote systems: git pushes, deploys, package publishing, network writes, external APIs",
	]),
} as const;

export type ToolCallAnswers = JevAnswers<typeof TOOL_CALL_QUESTIONS>;

export type ToolCallDecision = "allow" | "ask" | "reject";

export interface ToolCallVerdict {
	decision: ToolCallDecision;
	/** Short, model- and human-readable explanation including the numbers that decided it. */
	reason: string;
	/** Versioned model id that answered. */
	model: string;
	answers: ToolCallAnswers;
}

export interface ToolCallPolicy {
	/** Minimum `verdict` confidence to run with no human. Default 0.9. */
	allowConfidence: number;
	/** Minimum `verdict` confidence to reject outright on a `reject` pick. Default 0.8. */
	rejectConfidence: number;
	/** Noul probability at or above which a risk flag counts as raised. Default 0.5. */
	riskThreshold: number;
	/** Noul probability below which a risk flag counts as clear for auto-allow. Default 0.15. */
	clearThreshold: number;
	/** Exfiltration probability at or above which the call is rejected regardless of verdict. Default 0.85. */
	exfiltrationReject: number;
	/** Blast-radius score above which a human must confirm. 0 = project, 1 = machine, 2 = remote. Default 0.5. */
	maxAutoBlastRadius: number;
}

export const DEFAULT_TOOL_CALL_POLICY: ToolCallPolicy = {
	allowConfidence: 0.9,
	rejectConfidence: 0.8,
	riskThreshold: 0.5,
	clearThreshold: 0.15,
	exfiltrationReject: 0.85,
	maxAutoBlastRadius: 0.5,
};

export interface ToolCallInput {
	toolName: string;
	args: Record<string, unknown>;
	cwd: string;
	/** The user's latest request, so Jev can judge the call against intent rather than in a vacuum. */
	intent?: string;
	/** Label of the agent making the call, e.g. a subagent name. */
	origin?: string;
}

/** Long string arguments (file bodies, heredocs) are clipped: Jev judges the call, not the payload. */
const MAX_ARG_CHARS = 4000;
const MAX_INTENT_CHARS = 4000;

function clip(value: string, max: number): string {
	return value.length <= max ? value : `${value.slice(0, max)}\n[... ${value.length - max} more characters]`;
}

function clipArgs(value: unknown): unknown {
	if (typeof value === "string") return clip(value, MAX_ARG_CHARS);
	if (Array.isArray(value)) return value.map(clipArgs);
	if (typeof value === "object" && value !== null) {
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clipArgs(v)]));
	}
	return value;
}

/** The state object sent to Jev. Exported so callers can log exactly what was judged. */
export function buildToolCallState(input: ToolCallInput): Record<string, unknown> {
	return {
		tool: input.toolName,
		arguments: clipArgs(input.args),
		working_directory: input.cwd,
		...(input.origin ? { agent: input.origin } : {}),
		user_request: input.intent ? clip(input.intent, MAX_INTENT_CHARS) : "(not available)",
	};
}

const pct = (p: number) => p.toFixed(2);

/** Pure decision function. Same answers and policy in, same decision out. */
export function decideToolCall(
	answers: ToolCallAnswers,
	policy: ToolCallPolicy = DEFAULT_TOOL_CALL_POLICY,
): { decision: ToolCallDecision; reason: string } {
	const { verdict, destructive, exfiltration, off_task, blast_radius } = answers;

	if (exfiltration.noul >= policy.exfiltrationReject) {
		return {
			decision: "reject",
			reason: `likely exfiltration of secrets or private data (p=${pct(exfiltration.noul)})`,
		};
	}
	if (verdict.choice === "reject" && verdict.confidence >= policy.rejectConfidence) {
		return {
			decision: "reject",
			reason: `judged unsafe or against the request (confidence ${pct(verdict.confidence)})`,
		};
	}

	const raised: string[] = [];
	if (destructive.noul >= policy.riskThreshold) raised.push(`irreversible data loss p=${pct(destructive.noul)}`);
	if (exfiltration.noul >= policy.riskThreshold) raised.push(`exfiltration p=${pct(exfiltration.noul)}`);
	if (off_task.noul >= policy.riskThreshold) raised.push(`off-task p=${pct(off_task.noul)}`);
	if (blast_radius.score > policy.maxAutoBlastRadius)
		raised.push(`reaches outside the project (${blast_radius.score.toFixed(1)}/2)`);
	if (raised.length > 0) {
		return { decision: "ask", reason: raised.join("; ") };
	}

	const clear =
		destructive.noul < policy.clearThreshold &&
		exfiltration.noul < policy.clearThreshold &&
		off_task.noul < policy.clearThreshold;
	if (verdict.choice === "run" && verdict.confidence >= policy.allowConfidence && clear) {
		return { decision: "allow", reason: `routine and in scope (confidence ${pct(verdict.confidence)})` };
	}

	return {
		decision: "ask",
		reason: `not confident enough to act alone (verdict ${verdict.choice}, confidence ${pct(verdict.confidence)})`,
	};
}

export interface ToolCallJudgeOptions {
	policy?: Partial<ToolCallPolicy>;
}

export type ToolCallJudge = (input: ToolCallInput, signal?: AbortSignal) => Promise<ToolCallVerdict>;

/**
 * Build a judge bound to a client and policy. Errors propagate: the caller decides what "no
 * judgement" means, and for a permission gate that must be the human path, never allow.
 */
export function createToolCallJudge(client: JevClient, options: ToolCallJudgeOptions = {}): ToolCallJudge {
	const policy: ToolCallPolicy = { ...DEFAULT_TOOL_CALL_POLICY, ...options.policy };
	return async (input, signal) => {
		const response = await client.ask(buildToolCallState(input), TOOL_CALL_QUESTIONS, { signal });
		const { decision, reason } = decideToolCall(response.answers, policy);
		return { decision, reason, model: response.model, answers: response.answers };
	};
}
