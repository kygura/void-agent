import { describe, expect, test } from "bun:test";
import { Orchestrator } from "../src/orchestrator.js";
import { MockProvider } from "../src/providers/mock.js";
import type { Event, OrchestratorEvent, Provider, RunState } from "../src/types.js";

function resolver(providers: Readonly<Record<string, Provider>>): (name: string) => Provider | undefined {
	return (name) => providers[name];
}

async function waitFor(condition: () => boolean, timeoutMs = 1_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (condition()) return;
		await Bun.sleep(1);
	}
	throw new Error("timed out waiting for condition");
}

async function waitForState(orchestrator: Orchestrator, runId: string, state: RunState): Promise<void> {
	await waitFor(() => orchestrator.run(runId)?.state === state);
}

function terminalScript(label: string): Event[] {
	return [
		{ kind: "text", text: `${label}1` },
		{ kind: "text", text: `${label}2` },
		{ kind: "result", text: `${label}-done` },
		{ kind: "exit" },
	];
}

function eventKinds(events: readonly OrchestratorEvent[], runId: string): string[] {
	return events.flatMap((entry) => (entry.runId === runId && entry.event !== undefined ? [entry.event.kind] : []));
}

describe("Orchestrator Run lifecycle", () => {
	test("fans interleaved Runs into one global order while preserving each Run order", async () => {
		const orchestrator = new Orchestrator(
			resolver({
				alpha: new MockProvider({ events: terminalScript("a"), delayMs: 3 }),
				beta: new MockProvider({ events: terminalScript("b"), delayMs: 3 }),
			}),
			{ defaultProvider: "alpha" },
		);
		const first: OrchestratorEvent[] = [];
		const second: OrchestratorEvent[] = [];
		orchestrator.subscribe((event) => first.push(event));
		orchestrator.subscribe((event) => second.push(event));

		const alphaId = orchestrator.startRun({ provider: "alpha", prompt: "alpha" });
		const betaId = orchestrator.startRun({ provider: "beta", prompt: "beta" });
		await waitForState(orchestrator, alphaId, "done");
		await waitForState(orchestrator, betaId, "done");
		await waitFor(() => second.some((entry) => entry.runId === betaId && entry.state === "done"));

		expect(eventKinds(first, alphaId)).toEqual(["text", "text", "result", "exit"]);
		expect(eventKinds(first, betaId)).toEqual(["text", "text", "result", "exit"]);
		expect(orchestrator.runEvents(alphaId).map((event) => event.text ?? event.kind)).toEqual([
			"a1",
			"a2",
			"a-done",
			"exit",
		]);
		expect(
			first.filter((entry) => entry.event?.kind === "text").map((entry) => `${entry.runId}:${entry.event?.text}`),
		).toEqual([`${alphaId}:a1`, `${betaId}:b1`, `${alphaId}:a2`, `${betaId}:b2`]);
		expect(second).toEqual(first);
		expect(orchestrator.snapshot().runs.map((run) => run.id)).toEqual([alphaId, betaId]);
		await orchestrator.close();
	});

	test("backpressures a full fan-in buffer without dropping terminal Events", async () => {
		const textEvents: Event[] = Array.from({ length: 20 }, (_, index) => ({ kind: "text", text: `${index}` }));
		const orchestrator = new Orchestrator(
			resolver({
				mock: new MockProvider({
					events: [...textEvents, { kind: "result", text: "complete" }, { kind: "exit", exitCode: 0 }],
				}),
			}),
			{ defaultProvider: "mock", eventBufferSize: 1 },
		);
		const observed: OrchestratorEvent[] = [];
		orchestrator.subscribe((event) => observed.push(event));

		const runIds = Array.from({ length: 32 }, (_, index) =>
			orchestrator.startRun({ provider: "mock", prompt: `pressure-${index}` }),
		);
		expect(new Set(runIds).size).toBe(32);
		await waitFor(() => runIds.every((runId) => orchestrator.run(runId)?.state === "done"));
		await waitFor(() =>
			runIds.every((runId) => observed.some((entry) => entry.runId === runId && entry.state === "done")),
		);

		for (const runId of runIds) {
			const events = observed.flatMap((entry) =>
				entry.runId === runId && entry.event !== undefined ? [entry.event] : [],
			);
			expect(events.length).toBe(22);
			expect(events.filter((event) => event.kind === "result").length).toBe(1);
			expect(events.filter((event) => event.kind === "exit").length).toBe(1);
			expect(orchestrator.runEvents(runId).length).toBe(22);
		}
		await orchestrator.close();
	});

	test("isolates launch and subscriber failures from another Run", async () => {
		const orchestrator = new Orchestrator(
			resolver({
				broken: new MockProvider({ startError: "mock launch failed" }),
				healthy: new MockProvider({ events: terminalScript("ok"), delayMs: 1 }),
			}),
			{ defaultProvider: "healthy" },
		);
		const observed: OrchestratorEvent[] = [];
		orchestrator.subscribe((event) => {
			if (event.event?.text === "ok1") throw new Error("broken subscriber");
		});
		orchestrator.subscribe((event) => observed.push(event));

		const brokenId = orchestrator.startRun({ provider: "broken", prompt: "fail" });
		const healthyId = orchestrator.startRun({ provider: "healthy", prompt: "continue" });
		await waitForState(orchestrator, brokenId, "failed");
		await waitForState(orchestrator, healthyId, "done");
		await waitFor(() => observed.some((entry) => entry.runId === healthyId && entry.state === "done"));

		expect(eventKinds(observed, brokenId)).toEqual(["result", "exit"]);
		expect(orchestrator.runEvents(brokenId).map((event) => event.kind)).toEqual(["result", "exit"]);
		expect(orchestrator.runEvents(brokenId)[0]?.isError).toBe(true);
		expect(eventKinds(observed, healthyId)).toEqual(["text", "text", "result", "exit"]);
		await orchestrator.close();
	});

	test("cancels one Run while another completes", async () => {
		const cancellableEvents: Event[] = [
			{ kind: "text", text: "cancel-me" },
			{ kind: "text", text: "too-late" },
		];
		const orchestrator = new Orchestrator(
			resolver({
				cancellable: new MockProvider({ events: cancellableEvents, delayMs: 20 }),
				other: new MockProvider({ events: terminalScript("other"), delayMs: 8 }),
			}),
			{ defaultProvider: "other" },
		);
		const observed: OrchestratorEvent[] = [];
		orchestrator.subscribe((event) => observed.push(event));

		const cancelledId = orchestrator.startRun({ provider: "cancellable", prompt: "cancel" });
		const otherId = orchestrator.startRun({ provider: "other", prompt: "finish" });
		await waitFor(() => orchestrator.runEvents(cancelledId).length > 0);
		expect(orchestrator.cancelRun(cancelledId)).toBe(true);
		await waitForState(orchestrator, cancelledId, "cancelled");
		await waitForState(orchestrator, otherId, "done");

		expect(orchestrator.runEvents(cancelledId).map((event) => event.kind)).toEqual(["text", "result", "exit"]);
		expect(eventKinds(observed, otherId)).toEqual(["text", "text", "result", "exit"]);
		expect(orchestrator.cancelRun(cancelledId)).toBe(false);
		await orchestrator.close();
	});

	test("keeps a naturally completed Run done when cancellation arrives before finishRun", async () => {
		const transcript = terminalScript("natural");
		const orchestrator = new Orchestrator(resolver({ natural: new MockProvider({ events: transcript }) }), {
			defaultProvider: "natural",
		});
		let lateCancelAccepted = false;
		const runId = orchestrator.startRun({ provider: "natural", prompt: "finish naturally" });
		orchestrator.subscribe((entry) => {
			if (entry.runId === runId && entry.event?.kind === "exit") {
				lateCancelAccepted = orchestrator.cancelRun(runId);
			}
		});

		await waitFor(() => {
			const state = orchestrator.run(runId)?.state;
			return state === "done" || state === "failed" || state === "cancelled";
		});

		expect(lateCancelAccepted).toBe(true);
		expect(orchestrator.run(runId)?.state).toBe("done");
		expect(orchestrator.runEvents(runId)).toEqual(transcript);
		await orchestrator.close();
	});

	test("creates an inspectable terminal failed Run for an unknown Provider", async () => {
		const orchestrator = new Orchestrator(resolver({}), { defaultProvider: "missing" });
		const observed: OrchestratorEvent[] = [];
		orchestrator.subscribe((event) => observed.push(event));

		const runId = orchestrator.startRun({ provider: "ghost", prompt: "hello" });
		await waitForState(orchestrator, runId, "failed");
		await waitFor(() => observed.some((entry) => entry.runId === runId && entry.state === "failed"));

		expect(orchestrator.run(runId)?.provider).toBe("ghost");
		expect(eventKinds(observed, runId)).toEqual(["result", "exit"]);
		expect(orchestrator.runEvents(runId)[0]?.text).toBe('Unknown Provider "ghost"');
		expect(orchestrator.runEvents(runId)[0]?.isError).toBe(true);
		await orchestrator.close();
	});

	test("close cancels all live Runs and completes within its bound", async () => {
		const orchestrator = new Orchestrator(
			resolver({
				first: new MockProvider({ events: [{ kind: "text", text: "late" }], delayMs: 10_000 }),
				second: new MockProvider({ events: [{ kind: "text", text: "later" }], delayMs: 10_000 }),
			}),
			{ defaultProvider: "first", closeTimeoutMs: 100 },
		);
		orchestrator.subscribe(() => {});
		const firstId = orchestrator.startRun({ provider: "first", prompt: "first" });
		const secondId = orchestrator.startRun({ provider: "second", prompt: "second" });

		const startedAt = Date.now();
		await orchestrator.close();
		const elapsed = Date.now() - startedAt;

		expect(elapsed < 500).toBe(true);
		expect(orchestrator.run(firstId)?.state).toBe("cancelled");
		expect(orchestrator.run(secondId)?.state).toBe("cancelled");
		expect(orchestrator.snapshot().closing).toBe(true);
	});
});
