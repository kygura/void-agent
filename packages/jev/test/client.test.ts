import { describe, expect, it } from "vitest";
import {
	choice,
	confidenceOf,
	JevAPIError,
	JevClient,
	JevRequestError,
	JevResponseError,
	JevTimeoutError,
	noul,
	score,
} from "../src/index.js";

interface Captured {
	url?: string;
	init?: RequestInit;
}

function fakeFetch(body: unknown, status = 200, captured: Captured = {}): typeof fetch {
	return (async (url: string | URL | Request, init?: RequestInit) => {
		captured.url = String(url);
		captured.init = init;
		return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
	}) as typeof fetch;
}

const questions = {
	department: choice("Which team should handle this", {
		billing: "Payment issues",
		technical: "Bugs or integrations",
	}),
	frustration: score("How frustrated the customer appears", ["Calm", "Frustrated", "Angry"]),
	is_urgent: noul("The message conveys urgency"),
};

const validBody = {
	model: "jev-1.13.0",
	answers: {
		department: {
			type: "choice",
			choice: "technical",
			confidence: 0.78,
			probabilities: { technical: 0.85, billing: 0.15 },
		},
		frustration: {
			type: "score",
			score: 1.0,
			confidence: 1.0,
			legend: { "0": "Calm", "1": "Frustrated", "2": "Angry" },
			probabilities: { "0": 0, "1": 1, "2": 0 },
		},
		is_urgent: { type: "noul", noul: 0.999 },
	},
	usage: { input_tokens: 392, output_tokens: 65 },
};

describe("JevClient", () => {
	it("posts state and questions and returns typed answers", async () => {
		const captured: Captured = {};
		const client = new JevClient({ apiKey: "k", model: "jev-1.13.0", fetch: fakeFetch(validBody, 200, captured) });
		const res = await client.ask("stripe integration failing, losing sales", questions);

		expect(captured.url).toBe("https://api.typesafe.ai/v1/systemone");
		expect((captured.init?.headers as Record<string, string>).Authorization).toBe("Bearer k");
		const sent = JSON.parse(String(captured.init?.body));
		expect(sent.model).toBe("jev-1.13.0");
		expect(sent.questions.department.criteria.billing).toBe("Payment issues");

		const department: "billing" | "technical" = res.answers.department.choice;
		expect(department).toBe("technical");
		expect(res.answers.frustration.score).toBe(1);
		expect(res.answers.is_urgent.noul).toBe(0.999);
		expect(res.model).toBe("jev-1.13.0");
		expect(res.usage).toEqual({ input_tokens: 392, output_tokens: 65 });
	});

	it("rejects a choice outside the declared options", async () => {
		const body = structuredClone(validBody);
		body.answers.department.choice = "sales";
		const client = new JevClient({ apiKey: "k", fetch: fakeFetch(body) });
		await expect(client.ask("x", questions)).rejects.toBeInstanceOf(JevResponseError);
	});

	it("rejects a missing or mistyped answer", async () => {
		const missing = structuredClone(validBody) as { answers: Record<string, unknown> };
		delete missing.answers.is_urgent;
		await expect(
			new JevClient({ apiKey: "k", fetch: fakeFetch(missing) }).ask("x", questions),
		).rejects.toBeInstanceOf(JevResponseError);

		const mistyped = structuredClone(validBody) as { answers: Record<string, unknown> };
		mistyped.answers.is_urgent = { type: "choice", choice: "yes", confidence: 1, probabilities: {} };
		await expect(
			new JevClient({ apiKey: "k", fetch: fakeFetch(mistyped) }).ask("x", questions),
		).rejects.toBeInstanceOf(JevResponseError);
	});

	it("rejects out-of-range probabilities and scores", async () => {
		const badNoul = structuredClone(validBody);
		badNoul.answers.is_urgent.noul = 1.5;
		await expect(
			new JevClient({ apiKey: "k", fetch: fakeFetch(badNoul) }).ask("x", questions),
		).rejects.toBeInstanceOf(JevResponseError);

		const badScore = structuredClone(validBody);
		badScore.answers.frustration.score = 3;
		await expect(
			new JevClient({ apiKey: "k", fetch: fakeFetch(badScore) }).ask("x", questions),
		).rejects.toBeInstanceOf(JevResponseError);
	});

	it("surfaces HTTP errors with status", async () => {
		const client = new JevClient({ apiKey: "k", fetch: fakeFetch({ error: "nope" }, 429) });
		const error = await client.ask("x", questions).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(JevAPIError);
		expect((error as JevAPIError).status).toBe(429);
	});

	it("times out stalled requests", async () => {
		const stalled = ((_url: string, init?: RequestInit) =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
			})) as unknown as typeof fetch;
		const client = new JevClient({ apiKey: "k", timeoutMs: 20, fetch: stalled });
		await expect(client.ask("x", questions)).rejects.toBeInstanceOf(JevTimeoutError);
	});

	it("requires an API key and valid question shapes", () => {
		const saved = process.env.TYPESAFE_API_KEY;
		delete process.env.TYPESAFE_API_KEY;
		try {
			expect(() => new JevClient()).toThrow(JevRequestError);
		} finally {
			if (saved !== undefined) process.env.TYPESAFE_API_KEY = saved;
		}
		expect(() => choice("one option", { only: "x" })).toThrow(JevRequestError);
		expect(() => score("one level", ["x"])).toThrow(JevRequestError);
	});
});

describe("confidenceOf", () => {
	it("reads noul as doubled margin from 0.5", () => {
		expect(confidenceOf({ type: "noul", noul: 0.99 })).toBeCloseTo(0.98);
		expect(confidenceOf({ type: "noul", noul: 0.01 })).toBeCloseTo(0.98);
		expect(confidenceOf({ type: "noul", noul: 0.55 })).toBeCloseTo(0.1);
	});

	it("passes through choice and score confidence", () => {
		expect(confidenceOf({ type: "choice", choice: "a", confidence: 0.7, probabilities: { a: 0.8 } })).toBe(0.7);
	});
});
