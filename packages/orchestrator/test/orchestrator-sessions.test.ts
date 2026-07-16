import { describe, expect, test } from "bun:test";
import { Orchestrator } from "../src/index.js";
import type { Event, Provider, RunConfig, RunState } from "../src/types.js";

function resolver(providers: Readonly<Record<string, Provider>>): (name: string) => Provider | undefined {
	return (name) => providers[name];
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (condition()) return;
		await Bun.sleep(1);
	}
	throw new Error("timed out waiting for condition");
}

function abortAwareWait(milliseconds: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, milliseconds);
		if (signal === undefined) return;
		const abort = (): void => {
			clearTimeout(timer);
			resolve();
		};
		if (signal.aborted) abort();
		else signal.addEventListener("abort", abort, { once: true });
	});
}

async function waitForState(orchestrator: Orchestrator, runId: string, state: RunState): Promise<void> {
	await waitFor(() => orchestrator.run(runId)?.state === state);
}

function cloneConfig(config: RunConfig): RunConfig {
	return {
		...config,
		...(config.extraArgs === undefined ? {} : { extraArgs: [...config.extraArgs] }),
		...(config.env === undefined ? {} : { env: [...config.env] }),
	};
}

class RecordingProvider implements Provider {
	public readonly calls: RunConfig[] = [];

	public constructor(
		public readonly name: string,
		public readonly resumable: boolean,
		private readonly learnedSessionId = `${name}-learned`,
	) {}

	public start(config: RunConfig, signal?: AbortSignal): AsyncIterable<Event> {
		this.calls.push(cloneConfig(config));
		return this.events(signal);
	}

	private async *events(signal?: AbortSignal): AsyncIterable<Event> {
		yield { kind: "started", providerSessionId: this.learnedSessionId };
		if (signal?.aborted) return;
		yield { kind: "result", text: "done" };
		yield { kind: "exit", exitCode: 0 };
	}
}

class DelayedProvider implements Provider {
	public readonly name = "delayed";
	public readonly resumable = true;
	public readonly calls: RunConfig[] = [];
	public live = 0;
	public maxLive = 0;

	public constructor(private readonly delayMs: number) {}

	public start(config: RunConfig, signal?: AbortSignal): AsyncIterable<Event> {
		this.calls.push(cloneConfig(config));
		return this.events(config, signal);
	}

	private async *events(config: RunConfig, signal?: AbortSignal): AsyncIterable<Event> {
		this.live += 1;
		this.maxLive = Math.max(this.maxLive, this.live);
		try {
			yield { kind: "started", providerSessionId: `provider-${config.prompt}` };
			await abortAwareWait(this.delayMs, signal);
			if (signal?.aborted) return;
			yield { kind: "result", text: config.prompt };
			yield { kind: "exit", exitCode: 0 };
		} finally {
			this.live -= 1;
		}
	}
}

describe("Orchestrator Sessions", () => {
	test("passes learned Provider session IDs to Claude and Codex resumes", async () => {
		const claude = new RecordingProvider("claude", true, "claude-session");
		const codex = new RecordingProvider("codex", true, "codex-session");
		const orchestrator = new Orchestrator(resolver({ claude, codex }));

		for (const [providerName, providerSessionId, provider] of [
			["claude", "claude-session", claude],
			["codex", "codex-session", codex],
		] as const) {
			const sessionId = orchestrator.createSession({ provider: providerName });
			const first = orchestrator.submitPrompt(sessionId, "first");
			expect(first.queued).toBe(false);
			await waitForState(orchestrator, first.runId ?? "", "done");
			expect(orchestrator.session(sessionId)?.providerSessionId).toBe(providerSessionId);

			const resumed = orchestrator.resumeSession(sessionId, "continue");
			expect(resumed.queued).toBe(false);
			await waitForState(orchestrator, resumed.runId ?? "", "done");
			expect(provider.calls[1]?.providerSessionId).toBe(providerSessionId);
		}

		await orchestrator.close();
	});

	test("turns unsupported generic resume into an inspectable failed Run", async () => {
		const generic = new RecordingProvider("generic", false, "unused");
		const orchestrator = new Orchestrator(resolver({ generic }));
		orchestrator.restoreSession({
			id: "restored-generic",
			provider: "generic",
			providerSessionId: "generic-session",
			created: "2026-01-02T03:04:05.000Z",
		});

		const resumed = orchestrator.resumeSession("restored-generic", "continue");
		await waitForState(orchestrator, resumed.runId ?? "", "failed");

		expect(generic.calls).toEqual([]);
		expect(orchestrator.run(resumed.runId ?? "")?.sessionId).toBe("restored-generic");
		expect(orchestrator.runEvents(resumed.runId ?? "").map((event) => event.kind)).toEqual(["result", "exit"]);
		expect(orchestrator.runEvents(resumed.runId ?? "")[0]?.isError).toBe(true);
		await orchestrator.close();
	});

	test("fans two full child Sessions out concurrently under a caller-supplied parent ID", async () => {
		const delayed = new DelayedProvider(20);
		const orchestrator = new Orchestrator(resolver({ delayed }));
		const parentId = orchestrator.createSession({ id: "coding-agent-session", provider: "delayed" });

		const first = orchestrator.spawnChildSession(parentId, {
			provider: "delayed",
			prompt: "first-child",
			name: "first",
			model: "first-model",
			effort: "high",
		});
		const second = orchestrator.spawnChildSession(parentId, {
			provider: "delayed",
			prompt: "second-child",
			name: "second",
			model: "second-model",
			effort: "low",
		});
		await waitFor(() => delayed.live === 2);

		expect(parentId).toBe("coding-agent-session");
		expect(orchestrator.session(first.sessionId)?.parentSessionId).toBe(parentId);
		expect(orchestrator.session(second.sessionId)?.parentSessionId).toBe(parentId);
		expect(orchestrator.session(first.sessionId)?.runIds).toEqual([first.runId]);
		expect(orchestrator.session(second.sessionId)?.runIds).toEqual([second.runId]);
		expect(delayed.maxLive).toBe(2);
		expect(delayed.calls.find((config) => config.prompt === "first-child")?.model).toBe("first-model");
		expect(delayed.calls.find((config) => config.prompt === "first-child")?.effort).toBe("high");
		expect(delayed.calls.find((config) => config.prompt === "second-child")?.model).toBe("second-model");
		expect(delayed.calls.find((config) => config.prompt === "second-child")?.effort).toBe("low");
		await waitForState(orchestrator, first.runId, "done");
		await waitForState(orchestrator, second.runId, "done");
		await orchestrator.close();
	});

	test("serializes FIFO, remove-newest, completion, cancellation, and dequeue races", async () => {
		const delayed = new DelayedProvider(2);
		const orchestrator = new Orchestrator(resolver({ delayed }));
		let observedTwoLiveRuns = false;
		orchestrator.subscribe(() => {
			for (const session of orchestrator.sessions()) {
				const live = session.runIds.filter((runId) => {
					const state = orchestrator.run(runId)?.state;
					return state === "pending" || state === "running";
				});
				if (live.length > 1) observedTwoLiveRuns = true;
			}
		});

		for (let iteration = 0; iteration < 40; iteration += 1) {
			const sessionId = orchestrator.createSession({ id: `race-${iteration}`, provider: "delayed" });
			const firstPrompt = `${iteration}-first`;
			const secondPrompt = `${iteration}-second`;
			const thirdPrompt = `${iteration}-third`;
			const first = orchestrator.submitPrompt(sessionId, firstPrompt);
			expect(orchestrator.submitPrompt(sessionId, secondPrompt)).toEqual({ queued: true });
			expect(orchestrator.submitPrompt(sessionId, thirdPrompt)).toEqual({ queued: true });

			const removal = (async (): Promise<string | undefined> => {
				await Bun.sleep(iteration % 4);
				return orchestrator.removeQueuedPrompt(sessionId);
			})();
			if (iteration % 2 === 1) {
				await Bun.sleep(iteration % 3);
				orchestrator.cancelRun(first.runId ?? "");
			}
			const removed = await removal;
			await waitFor(() => {
				const session = orchestrator.session(sessionId);
				return (
					session !== undefined && session.queue.activeRunId === undefined && session.queue.prompts.length === 0
				);
			});

			const prompts = delayed.calls
				.map((config) => config.prompt)
				.filter((prompt) => prompt.startsWith(`${iteration}-`));
			const expected =
				removed === thirdPrompt ? [firstPrompt, secondPrompt] : [firstPrompt, secondPrompt, thirdPrompt];
			expect(prompts).toEqual(expected);
			expect(new Set(prompts).size).toBe(prompts.length);
		}

		expect(observedTwoLiveRuns).toBe(false);
		await orchestrator.close();
	});

	test("cancellation interrupts the DelayedProvider wait immediately", async () => {
		const delayed = new DelayedProvider(300);
		const orchestrator = new Orchestrator(resolver({ delayed }));
		const runId = orchestrator.startRun({ provider: "delayed", prompt: "cancel promptly" });
		await waitFor(() => orchestrator.runEvents(runId).some((event) => event.kind === "started"));

		const startedAt = Date.now();
		expect(orchestrator.cancelRun(runId)).toBe(true);
		await waitFor(() => orchestrator.run(runId)?.state === "cancelled", 50);

		expect(Date.now() - startedAt < 100).toBe(true);
		await orchestrator.close();
	});

	test("resumes restored Sessions and keeps TaskRuns sessionless", async () => {
		const resumable = new RecordingProvider("resumable", true, "restored-next");
		const orchestrator = new Orchestrator(resolver({ resumable }));
		expect(
			orchestrator.restoreSession({
				id: "restored-child",
				provider: "resumable",
				providerSessionId: "restored-provider-session",
				parentSessionId: "coding-parent",
				created: "2026-01-02T03:04:05.000Z",
			}),
		).toBe(true);

		const resumed = orchestrator.resumeSession("restored-child", "resume restored");
		await waitForState(orchestrator, resumed.runId ?? "", "done");
		const taskRunId = orchestrator.startTaskRun({ provider: "resumable", prompt: "background" }, "audit");
		await waitForState(orchestrator, taskRunId, "done");

		expect(resumable.calls[0]?.providerSessionId).toBe("restored-provider-session");
		expect(orchestrator.run(taskRunId)?.sessionId).toBeUndefined();
		expect(orchestrator.run(taskRunId)?.name).toBe("audit");
		expect(orchestrator.snapshot().taskRuns.map((run) => run.id)).toEqual([taskRunId]);
		expect(orchestrator.sessions().map((session) => session.id)).toEqual(["restored-child"]);
		let taskResumeError = "";
		try {
			orchestrator.startTaskRun({
				provider: "resumable",
				prompt: "invalid task resume",
				providerSessionId: "not-allowed",
			});
		} catch (error) {
			taskResumeError = error instanceof Error ? error.message : String(error);
		}
		expect(taskResumeError).toBe("TaskRuns cannot resume a Provider Session");
		await orchestrator.close();
	});

	test("switching a child Provider clears only that Session's resume, model, and effort", async () => {
		const orchestrator = new Orchestrator(resolver({}));
		orchestrator.createSession({
			id: "parent",
			provider: "claude",
			model: "parent-model",
			effort: "high",
		});
		orchestrator.restoreSession({
			id: "child",
			provider: "claude",
			providerSessionId: "claude-session",
			model: "child-model",
			effort: "medium",
			parentSessionId: "parent",
			created: "2026-01-02T03:04:05.000Z",
		});

		orchestrator.setSessionProvider("child", "codex");

		expect(orchestrator.session("child")).toMatchObject({ id: "child", provider: "codex" });
		expect(orchestrator.session("child")?.providerSessionId).toBeUndefined();
		expect(orchestrator.session("child")?.model).toBeUndefined();
		expect(orchestrator.session("child")?.effort).toBeUndefined();
		expect(orchestrator.session("parent")?.model).toBe("parent-model");
		expect(orchestrator.session("parent")?.effort).toBe("high");
		await orchestrator.close();
	});
});
