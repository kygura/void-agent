/**
 * Wire types for TypeSafe's System One API (`POST /v1/systemone`).
 *
 * A request carries a `state` (the material to judge) and a map of named `questions`. Jev
 * answers every question in one parallel pass and returns typed answers with probabilities.
 * It never generates text, so every answer is one of the shapes below or the request failed.
 */

/** Material Jev judges. Text, a JSON object, or an array of text. */
export type JevState = string | Record<string, unknown> | readonly string[];

/** Yes/no question. The answer is the probability that the answer is yes. */
export interface NoulQuestion {
	type: "noul";
	instructions: string;
}

/** Pick one of a fixed set of options. `criteria` maps option name to its description. */
export interface ChoiceQuestion<K extends string = string> {
	type: "choice";
	instructions: string;
	criteria: Record<K, string>;
}

/** Rate against 2-10 ordered levels. Index 0 is the lowest level. */
export interface ScoreQuestion {
	type: "score";
	instructions: string;
	criteria: readonly string[];
}

export type JevQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export type JevQuestions = Record<string, JevQuestion>;

export interface NoulAnswer {
	type: "noul";
	/** Probability in [0, 1] that the answer is yes. */
	noul: number;
}

export interface ChoiceAnswer<K extends string = string> {
	type: "choice";
	choice: K;
	/** Spread-derived certainty in [0, 1]. Not the probability that `choice` is correct. */
	confidence: number;
	probabilities: Record<K, number>;
}

export interface ScoreAnswer {
	type: "score";
	/** Expected level: sum of level index times its probability. */
	score: number;
	confidence: number;
	/** Level index (as a string) to level description. */
	legend: Record<string, string>;
	/** Level index (as a string) to probability. */
	probabilities: Record<string, number>;
}

export type JevAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

/** The answer type a given question produces. */
export type AnswerFor<Q extends JevQuestion> = Q extends ChoiceQuestion<infer K>
	? ChoiceAnswer<K>
	: Q extends ScoreQuestion
		? ScoreAnswer
		: NoulAnswer;

export type JevAnswers<Qs extends JevQuestions> = { [N in keyof Qs]: AnswerFor<Qs[N]> };

export interface JevUsage {
	input_tokens: number;
	output_tokens: number;
}

export interface JevResponse<Qs extends JevQuestions = JevQuestions> {
	/** Versioned id that answered, even when the request named an alias like `jev-latest`. */
	model: string;
	answers: JevAnswers<Qs>;
	usage?: JevUsage;
}
