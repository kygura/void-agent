import { describe, expect, it } from "vitest";
import {
	buildToolCallState,
	createToolCallJudge,
	decideToolCall,
	JevClient,
	type ToolCallAnswers,
} from "../src/index.js";

function answers(overrides: {
	verdict?: "run" | "ask" | "reject";
	confidence?: number;
	destructive?: number;
	exfiltration?: number;
	off_task?: number;
	blast?: number;
}): ToolCallAnswers {
	const pick = overrides.verdict ?? "run";
	return {
		verdict: {
			type: "choice",
			choice: pick,
			confidence: overrides.confidence ?? 0.97,
			probabilities: {
				run: pick === "run" ? 0.98 : 0.01,
				ask: pick === "ask" ? 0.98 : 0.01,
				reject: pick === "reject" ? 0.98 : 0.01,
			},
		},
		destructive: { type: "noul", noul: overrides.destructive ?? 0.02 },
		exfiltration: { type: "noul", noul: overrides.exfiltration ?? 0.01 },
		off_task: { type: "noul", noul: overrides.off_task ?? 0.03 },
		blast_radius: {
			type: "score",
			score: overrides.blast ?? 0.05,
			confidence: 0.95,
			legend: { "0": "project", "1": "machine", "2": "remote" },
			probabilities: { "0": 0.95, "1": 0.05, "2": 0 },
		},
	};
}

describe("decideToolCall", () => {
	it("allows only when the verdict is confident and every risk is clear", () => {
		expect(decideToolCall(answers({})).decision).toBe("allow");
	});

	it("asks when the verdict is not confident enough", () => {
		expect(decideToolCall(answers({ confidence: 0.7 })).decision).toBe("ask");
	});

	it("asks when a risk is ambiguous even if the verdict says run", () => {
		expect(decideToolCall(answers({ destructive: 0.3 })).decision).toBe("ask");
	});

	it("asks when any risk flag is raised", () => {
		expect(decideToolCall(answers({ destructive: 0.8 })).reason).toContain("irreversible");
		expect(decideToolCall(answers({ off_task: 0.6 })).decision).toBe("ask");
		expect(decideToolCall(answers({ blast: 1.8 })).decision).toBe("ask");
	});

	it("rejects confident reject verdicts and likely exfiltration", () => {
		expect(decideToolCall(answers({ verdict: "reject", confidence: 0.9 })).decision).toBe("reject");
		expect(decideToolCall(answers({ exfiltration: 0.95 })).decision).toBe("reject");
	});

	it("does not reject on a low-confidence reject verdict", () => {
		expect(decideToolCall(answers({ verdict: "reject", confidence: 0.4 })).decision).toBe("ask");
	});

	it("honors policy overrides", () => {
		expect(decideToolCall(answers({ confidence: 0.85 }), { ...defaults(), allowConfidence: 0.8 }).decision).toBe(
			"allow",
		);
	});
});

function defaults() {
	return {
		allowConfidence: 0.9,
		rejectConfidence: 0.8,
		riskThreshold: 0.5,
		clearThreshold: 0.15,
		exfiltrationReject: 0.85,
		maxAutoBlastRadius: 0.5,
	};
}

describe("buildToolCallState", () => {
	it("clips long arguments and carries intent", () => {
		const state = buildToolCallState({
			toolName: "write",
			args: { path: "a.ts", content: "x".repeat(10_000) },
			cwd: "/repo",
			intent: "add a helper",
		});
		const content = (state.arguments as { content: string }).content;
		expect(content.length).toBeLessThan(4100);
		expect(content).toContain("more characters");
		expect(state.user_request).toBe("add a helper");
	});
});

describe("createToolCallJudge", () => {
	it("sends the judged state and returns the decision", async () => {
		let sent: { state: Record<string, unknown>; questions: Record<string, unknown> } | undefined;
		const body = { model: "jev-1.13.0", answers: answers({}) };
		const fetchImpl = (async (_url: string, init?: RequestInit) => {
			sent = JSON.parse(String(init?.body));
			return new Response(JSON.stringify(body), { status: 200 });
		}) as unknown as typeof fetch;

		const judge = createToolCallJudge(new JevClient({ apiKey: "k", fetch: fetchImpl }));
		const verdict = await judge({
			toolName: "bash",
			args: { command: "bun test" },
			cwd: "/repo",
			intent: "run tests",
		});

		expect(verdict.decision).toBe("allow");
		expect(verdict.model).toBe("jev-1.13.0");
		expect(sent?.state.tool).toBe("bash");
		expect(Object.keys(sent?.questions ?? {})).toEqual([
			"verdict",
			"destructive",
			"exfiltration",
			"off_task",
			"blast_radius",
		]);
	});
});
