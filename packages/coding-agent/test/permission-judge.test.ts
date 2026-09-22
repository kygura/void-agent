/**
 * Tests for the automated judge pre-screen on the permission gate, and the Jev adapter.
 *
 * The gate must never turn a judge failure into an allow: errors and "ask" fall through to the
 * human approver, and with no approver they deny.
 */

import { describe, expect, it, vi } from "vitest";
import { createJevPermissionJudge } from "../src/core/jev-judge.js";
import {
	PermissionGate,
	type PermissionJudge,
	type PermissionJudgement,
	type PermissionRequest,
} from "../src/core/permissions.js";

const request: PermissionRequest = {
	toolName: "bash",
	args: { command: "bun test" },
	cwd: "/repo",
	intent: "run tests",
};

function gateWith(judge: PermissionJudge, approver?: () => Promise<"allow" | "deny">) {
	const gate = new PermissionGate({ enabled: true });
	gate.setJudge(judge);
	const approve = approver ? vi.fn(approver) : undefined;
	if (approve) gate.setApprover(approve);
	return { gate, approve };
}

const judged =
	(decision: PermissionJudgement["decision"]): PermissionJudge =>
	async () => ({
		decision,
		reason: `judge said ${decision}`,
	});

describe("PermissionGate judge", () => {
	it("allows without prompting when the judge allows", async () => {
		const { gate, approve } = gateWith(judged("allow"), async () => "deny");
		expect(await gate.check(request)).toEqual({ allowed: true });
		expect(approve).not.toHaveBeenCalled();
	});

	it("blocks without prompting when the judge rejects", async () => {
		const { gate, approve } = gateWith(judged("reject"), async () => "allow");
		const result = await gate.check(request);
		expect(result.allowed).toBe(false);
		expect(result.reason).toContain("judge said reject");
		expect(approve).not.toHaveBeenCalled();
	});

	it("falls through to the approver when the judge asks", async () => {
		const { gate, approve } = gateWith(judged("ask"), async () => "allow");
		expect((await gate.check(request)).allowed).toBe(true);
		expect(approve).toHaveBeenCalledOnce();
	});

	it("treats a throwing judge as ask, never allow", async () => {
		const failing: PermissionJudge = async () => {
			throw new Error("network down");
		};
		const { gate, approve } = gateWith(failing, async () => "deny");
		expect((await gate.check(request)).allowed).toBe(false);
		expect(approve).toHaveBeenCalledOnce();
	});

	it("denies ask with no approver, citing the judge", async () => {
		const { gate } = gateWith(judged("ask"));
		const result = await gate.check(request);
		expect(result.allowed).toBe(false);
		expect(result.reason).toContain("judge said ask");
	});

	it("still auto-allows with no approver, for headless runs", async () => {
		const { gate } = gateWith(judged("allow"));
		expect((await gate.check(request)).allowed).toBe(true);
	});

	it("skips the judge for non-mutating and always-allowed tools", async () => {
		const judge = vi.fn(judged("reject"));
		const gate = new PermissionGate({ enabled: true, alwaysAllow: ["edit"] });
		gate.setJudge(judge);
		expect((await gate.check({ ...request, toolName: "read" })).allowed).toBe(true);
		expect((await gate.check({ ...request, toolName: "edit" })).allowed).toBe(true);
		expect(judge).not.toHaveBeenCalled();
	});

	it("reports every judgement to the listener", async () => {
		const { gate } = gateWith(judged("allow"));
		const seen: string[] = [];
		gate.onJudgement((req, judgement) => seen.push(`${req.toolName}:${judgement.decision}`));
		await gate.check(request);
		expect(seen).toEqual(["bash:allow"]);
	});
});

describe("createJevPermissionJudge", () => {
	it("explains a missing API key instead of throwing", () => {
		const saved = process.env.TYPESAFE_API_KEY;
		delete process.env.TYPESAFE_API_KEY;
		try {
			const setup = createJevPermissionJudge({ enabled: true });
			expect("error" in setup && setup.error).toContain("TYPESAFE_API_KEY");
		} finally {
			if (saved !== undefined) process.env.TYPESAFE_API_KEY = saved;
		}
	});

	it("maps a Jev verdict onto a gate judgement", async () => {
		let sentModel: string | undefined;
		const fetchImpl = (async (_url: string, init?: RequestInit) => {
			sentModel = JSON.parse(String(init?.body)).model;
			return new Response(
				JSON.stringify({
					model: "jev-1.13.0",
					answers: {
						verdict: {
							type: "choice",
							choice: "reject",
							confidence: 0.95,
							probabilities: { run: 0.01, ask: 0.03, reject: 0.96 },
						},
						destructive: { type: "noul", noul: 0.97 },
						exfiltration: { type: "noul", noul: 0.02 },
						off_task: { type: "noul", noul: 0.9 },
						blast_radius: {
							type: "score",
							score: 1.1,
							confidence: 0.8,
							legend: {},
							probabilities: { "0": 0.1, "1": 0.7, "2": 0.2 },
						},
					},
				}),
				{ status: 200 },
			);
		}) as unknown as typeof fetch;

		const setup = createJevPermissionJudge({ enabled: true, model: "jev-1.13.0" }, { apiKey: "k", fetch: fetchImpl });
		if (!("judge" in setup)) throw new Error(setup.error);
		const judgement = await setup.judge({ ...request, args: { command: "rm -rf ~" }, intent: "fix a typo" });

		expect(sentModel).toBe("jev-1.13.0");
		expect(judgement.decision).toBe("reject");
		expect(judgement.source).toBe("jev-1.13.0");
	});
});
