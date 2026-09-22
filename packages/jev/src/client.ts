import type {
	ChoiceAnswer,
	ChoiceQuestion,
	JevAnswer,
	JevAnswers,
	JevQuestion,
	JevQuestions,
	JevResponse,
	JevState,
	NoulAnswer,
	NoulQuestion,
	ScoreAnswer,
	ScoreQuestion,
} from "./types.js";

export const DEFAULT_JEV_BASE_URL = "https://api.typesafe.ai";
export const DEFAULT_JEV_MODEL = "jev-latest";
/** Jev answers in tens of milliseconds; anything past this is a stalled request, not a slow model. */
export const DEFAULT_JEV_TIMEOUT_MS = 5000;

export const JEV_API_KEY_ENV = "TYPESAFE_API_KEY";
export const JEV_BASE_URL_ENV = "TYPESAFE_BASE_URL";

const MAX_CHOICE_OPTIONS = 255;
const MIN_SCORE_LEVELS = 2;
const MAX_SCORE_LEVELS = 10;

export function noul(instructions: string): NoulQuestion {
	return { type: "noul", instructions };
}

export function choice<const K extends string>(instructions: string, criteria: Record<K, string>): ChoiceQuestion<K> {
	const count = Object.keys(criteria).length;
	if (count < 2 || count > MAX_CHOICE_OPTIONS) {
		throw new JevRequestError(`A choice needs 2-${MAX_CHOICE_OPTIONS} options, got ${count}`);
	}
	return { type: "choice", instructions, criteria };
}

export function score(instructions: string, levels: readonly string[]): ScoreQuestion {
	if (levels.length < MIN_SCORE_LEVELS || levels.length > MAX_SCORE_LEVELS) {
		throw new JevRequestError(`A score needs ${MIN_SCORE_LEVELS}-${MAX_SCORE_LEVELS} levels, got ${levels.length}`);
	}
	return { type: "score", instructions, criteria: levels };
}

/**
 * One certainty reading across all three answer types, in [0, 1].
 *
 * Choice and Score carry Jev's own `confidence`. A Noul carries none, so this uses the margin
 * from the coin flip, doubled: 0.99 and 0.01 both read 0.98, 0.55 reads 0.10.
 */
export function confidenceOf(answer: JevAnswer): number {
	return answer.type === "noul" ? Math.abs(answer.noul - 0.5) * 2 : answer.confidence;
}

export class JevError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "JevError";
	}
}

/** The request was malformed before it left the process. */
export class JevRequestError extends JevError {
	constructor(message: string) {
		super(message);
		this.name = "JevRequestError";
	}
}

/** The API returned a non-2xx status. */
export class JevAPIError extends JevError {
	readonly status: number;
	constructor(status: number, message: string) {
		super(`Jev API ${status}: ${message}`);
		this.name = "JevAPIError";
		this.status = status;
	}
}

/** The API returned 2xx but the body does not match the questions that were asked. */
export class JevResponseError extends JevError {
	constructor(message: string) {
		super(message);
		this.name = "JevResponseError";
	}
}

export class JevTimeoutError extends JevError {
	constructor(timeoutMs: number) {
		super(`Jev request timed out after ${timeoutMs}ms`);
		this.name = "JevTimeoutError";
	}
}

export interface JevClientOptions {
	/** Defaults to `TYPESAFE_API_KEY`. */
	apiKey?: string;
	/** Defaults to `TYPESAFE_BASE_URL`, then the public API. */
	baseUrl?: string;
	/**
	 * Model id or alias. Aliases move on release and can shift calibrated numbers, so pin a
	 * versioned id (`jev-1.13.0`) once thresholds have been tuned against it.
	 */
	model?: string;
	timeoutMs?: number;
	/** Injected for tests and custom transports. */
	fetch?: typeof fetch;
}

export interface JevAskOptions {
	signal?: AbortSignal;
	/** Per-request model override. */
	model?: string;
}

/**
 * Thin, dependency-free client for `POST /v1/systemone`.
 *
 * Every response is validated against the questions that were asked: a missing answer, an
 * answer of the wrong type, or a choice outside the declared options is a `JevResponseError`,
 * never a silently mistyped value. Callers gating side effects on Jev should treat any thrown
 * error as "no judgement" and fall back to their conservative path.
 */
export class JevClient {
	readonly model: string;
	private readonly apiKey: string;
	private readonly baseUrl: string;
	private readonly timeoutMs: number;
	private readonly fetchImpl: typeof fetch;

	constructor(options: JevClientOptions = {}) {
		const apiKey = options.apiKey ?? process.env[JEV_API_KEY_ENV];
		if (!apiKey) {
			throw new JevRequestError(`No Jev API key. Set ${JEV_API_KEY_ENV} or pass apiKey.`);
		}
		this.apiKey = apiKey;
		this.baseUrl = (options.baseUrl ?? process.env[JEV_BASE_URL_ENV] ?? DEFAULT_JEV_BASE_URL).replace(/\/+$/, "");
		this.model = options.model ?? DEFAULT_JEV_MODEL;
		this.timeoutMs = options.timeoutMs ?? DEFAULT_JEV_TIMEOUT_MS;
		this.fetchImpl = options.fetch ?? fetch;
	}

	/** Ask every question about `state` in one request. */
	async ask<const Qs extends JevQuestions>(
		state: JevState,
		questions: Qs,
		options: JevAskOptions = {},
	): Promise<JevResponse<Qs>> {
		if (Object.keys(questions).length === 0) {
			throw new JevRequestError("At least one question is required");
		}

		const timeout = AbortSignal.timeout(this.timeoutMs);
		const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

		let response: Response;
		try {
			response = await this.fetchImpl(`${this.baseUrl}/v1/systemone`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${this.apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ model: options.model ?? this.model, state, questions }),
				signal,
			});
		} catch (error) {
			if (timeout.aborted && !options.signal?.aborted) {
				throw new JevTimeoutError(this.timeoutMs);
			}
			throw error;
		}

		if (!response.ok) {
			const text = await response.text().catch(() => "");
			throw new JevAPIError(response.status, text.slice(0, 500) || response.statusText);
		}

		const body: unknown = await response.json();
		return parseResponse(body, questions);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnit(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function parseProbabilities(name: string, value: unknown, keys: readonly string[]): Record<string, number> {
	if (!isRecord(value)) {
		throw new JevResponseError(`Answer "${name}" is missing probabilities`);
	}
	const out: Record<string, number> = {};
	for (const key of keys) {
		const p = value[key];
		if (!isUnit(p)) {
			throw new JevResponseError(`Answer "${name}" has no valid probability for "${key}"`);
		}
		out[key] = p;
	}
	return out;
}

function parseAnswer(name: string, question: JevQuestion, raw: unknown): JevAnswer {
	if (!isRecord(raw)) {
		throw new JevResponseError(`Missing answer for "${name}"`);
	}
	if (raw.type !== question.type) {
		throw new JevResponseError(`Answer "${name}" is ${String(raw.type)}, expected ${question.type}`);
	}

	switch (question.type) {
		case "noul": {
			if (!isUnit(raw.noul)) {
				throw new JevResponseError(`Answer "${name}" has no valid noul probability`);
			}
			return { type: "noul", noul: raw.noul } satisfies NoulAnswer;
		}
		case "choice": {
			const options = Object.keys(question.criteria);
			if (typeof raw.choice !== "string" || !options.includes(raw.choice)) {
				throw new JevResponseError(`Answer "${name}" chose "${String(raw.choice)}", not one of the options`);
			}
			if (!isUnit(raw.confidence)) {
				throw new JevResponseError(`Answer "${name}" has no valid confidence`);
			}
			return {
				type: "choice",
				choice: raw.choice,
				confidence: raw.confidence,
				probabilities: parseProbabilities(name, raw.probabilities, options),
			} satisfies ChoiceAnswer;
		}
		case "score": {
			const top = question.criteria.length - 1;
			if (typeof raw.score !== "number" || !Number.isFinite(raw.score) || raw.score < 0 || raw.score > top) {
				throw new JevResponseError(`Answer "${name}" has a score outside 0-${top}`);
			}
			if (!isUnit(raw.confidence)) {
				throw new JevResponseError(`Answer "${name}" has no valid confidence`);
			}
			const levels = question.criteria.map((_, i) => String(i));
			const legend: Record<string, string> = {};
			question.criteria.forEach((level, i) => {
				legend[String(i)] = level;
			});
			return {
				type: "score",
				score: raw.score,
				confidence: raw.confidence,
				legend,
				probabilities: parseProbabilities(name, raw.probabilities, levels),
			} satisfies ScoreAnswer;
		}
	}
}

/** Validate a raw API body against the questions asked. Exported for callers with their own transport. */
export function parseResponse<const Qs extends JevQuestions>(body: unknown, questions: Qs): JevResponse<Qs> {
	if (!isRecord(body) || !isRecord(body.answers)) {
		throw new JevResponseError("Response has no answers object");
	}
	const answers: Record<string, JevAnswer> = {};
	for (const [name, question] of Object.entries(questions)) {
		answers[name] = parseAnswer(name, question, body.answers[name]);
	}

	const usage =
		isRecord(body.usage) &&
		typeof body.usage.input_tokens === "number" &&
		typeof body.usage.output_tokens === "number"
			? { input_tokens: body.usage.input_tokens, output_tokens: body.usage.output_tokens }
			: undefined;

	return {
		model: typeof body.model === "string" ? body.model : "unknown",
		answers: answers as JevAnswers<Qs>,
		...(usage ? { usage } : {}),
	};
}
