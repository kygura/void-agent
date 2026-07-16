import { describe, expect, test } from "bun:test";
import { createMockProvider, type Event, Orchestrator, type Provider, type RunState } from "../src/index.js";

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

function resolver(providers: Readonly<Record<string, Provider>>): (name: string) => Provider | undefined {
	return (name) => providers[name];
}

describe("@void/orchestrator public interface", () => {
	test("exercises root start/resume/cancel/subscribe/snapshot with MockProvider", async () => {
		const resumable = createMockProvider({
			resumable: true,
			events: [
				{ kind: "started", providerSessionId: "mock-session" },
				{ kind: "text", text: "hello" },
				{ kind: "result", text: "complete", usage: { inputTokens: 2, outputTokens: 3 } },
				{ kind: "exit", exitCode: 0 },
			],
		});
		const cancellable = createMockProvider({
			resumable: true,
			delayMs: 10_000,
			events: [{ kind: "text", text: "never completed" }],
		});
		const orchestrator = new Orchestrator(resolver({ mock: resumable, cancellable }), {
			defaultProvider: "mock",
		});
		const observed: Event[] = [];
		const subscription = orchestrator.subscribe((entry) => {
			if (entry.event !== undefined) observed.push(entry.event);
		});

		const sessionId = orchestrator.createSession({ id: "public-session", provider: "mock" });
		const first = orchestrator.submitPrompt(sessionId, "hello");
		expect(first.queued).toBe(false);
		expect(first.runId === undefined).toBe(false);
		const firstRunId = first.runId ?? "";
		await waitForState(orchestrator, firstRunId, "done");

		const firstSnapshot = orchestrator.snapshot();
		expect(firstSnapshot.defaultProvider).toBe("mock");
		expect(firstSnapshot.sessions).toMatchObject([
			{ id: sessionId, provider: "mock", providerSessionId: "mock-session", queue: { prompts: [] } },
		]);
		expect(firstSnapshot.runs).toMatchObject([
			{
				id: firstRunId,
				state: "done",
				finalText: "complete",
				usage: { inputTokens: 2, outputTokens: 3 },
			},
		]);
		const firstRun = orchestrator.run(firstRunId);
		expect(typeof firstRun?.startedAt === "string").toBe(true);
		expect(typeof firstRun?.endedAt === "string").toBe(true);
		expect(typeof firstRun?.lastActivityAt === "string").toBe(true);
		expect(observed.map((event) => event.kind)).toEqual(["started", "text", "result", "exit"]);

		const resumed = orchestrator.resumeSession(sessionId, "continue");
		expect(resumed).toMatchObject({ queued: false });
		const resumedRunId = resumed.runId ?? "";
		await waitForState(orchestrator, resumedRunId, "done");
		expect(resumable.getCalls()[1]?.providerSessionId).toBe("mock-session");

		const cancelRunId = orchestrator.startRun({ provider: "cancellable", prompt: "cancel me" });
		await waitFor(() => orchestrator.run(cancelRunId)?.state === "running");
		expect(orchestrator.cancelRun(cancelRunId)).toBe(true);
		await waitForState(orchestrator, cancelRunId, "cancelled");
		expect(orchestrator.runEvents(cancelRunId).map((event) => event.kind)).toEqual(["result", "exit"]);
		expect(orchestrator.snapshot().taskRuns.map((run) => run.id)).toEqual([cancelRunId]);

		subscription.unsubscribe();
		const eventCountAfterUnsubscribe = observed.length;
		const taskRunId = orchestrator.startRun({ provider: "mock", prompt: "after unsubscribe" });
		await waitForState(orchestrator, taskRunId, "done");
		expect(observed.length).toBe(eventCountAfterUnsubscribe);

		await orchestrator.close();
		expect(orchestrator.snapshot().closing).toBe(true);
	});
});
