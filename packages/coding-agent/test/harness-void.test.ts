import { describe, expect, test } from "vitest";
import type { AgentSession, AgentSessionEvent, AgentSessionEventListener } from "../src/core/agent-session.js";
import type { HarnessEvent } from "../src/core/harness/types.js";
import { VoidHarness } from "../src/core/harness/void.js";
import type { SpawnVoidChild } from "../src/core/tools/subagent.js";

/** Minimal AgentSession stand-in: only the surface VoidHarness actually calls. */
class FakeAgentSession {
	readonly sessionId: string;
	private listeners: AgentSessionEventListener[] = [];
	private lastText: string | undefined;
	promptCalls: string[] = [];
	aborted = false;
	disposeCalls = 0;
	private promptImpl: (text: string, self: FakeAgentSession) => Promise<void>;

	constructor(sessionId: string, promptImpl: (text: string, self: FakeAgentSession) => Promise<void>) {
		this.sessionId = sessionId;
		this.promptImpl = promptImpl;
	}

	subscribe(listener: AgentSessionEventListener): () => void {
		this.listeners.push(listener);
		return () => {
			this.listeners = this.listeners.filter((l) => l !== listener);
		};
	}

	emit(event: AgentSessionEvent): void {
		for (const listener of this.listeners) listener(event);
	}

	async prompt(text: string): Promise<void> {
		this.promptCalls.push(text);
		await this.promptImpl(text, this);
	}

	async abort(): Promise<void> {
		this.aborted = true;
	}

	dispose(): void {
		this.disposeCalls++;
	}

	setLastAssistantText(text: string): void {
		this.lastText = text;
	}

	getLastAssistantText(): string | undefined {
		return this.lastText;
	}

	getSessionStats() {
		return {
			tokens: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, total: 30 },
			cost: 0.005,
		} as ReturnType<AgentSession["getSessionStats"]>;
	}
}

function asAgentSession(fake: FakeAgentSession): AgentSession {
	return fake as unknown as AgentSession;
}

async function collect(iterable: AsyncIterable<HarnessEvent>): Promise<HarnessEvent[]> {
	const events: HarnessEvent[] = [];
	for await (const event of iterable) events.push(event);
	return events;
}

describe("VoidHarness", () => {
	test("fresh run: spawns a child, translates its event stream, and closes with result + exit", async () => {
		const fake = new FakeAgentSession("child-1", async (_text, self) => {
			self.emit({
				type: "message_update",
				message: {} as never,
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hel", partial: {} as never },
			});
			self.emit({
				type: "message_update",
				message: {} as never,
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "lo", partial: {} as never },
			});
			self.emit({
				type: "message_update",
				message: {} as never,
				assistantMessageEvent: {
					type: "thinking_delta",
					contentIndex: 0,
					delta: "pondering",
					partial: {} as never,
				},
			});
			self.emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: { path: "a.ts" } });
			self.emit({ type: "tool_execution_end", toolCallId: "t1", toolName: "read", result: "ok", isError: false });
			self.setLastAssistantText("hello");
		});
		const spawnVoidChild: SpawnVoidChild = async () => asAgentSession(fake);
		const harness = new VoidHarness(spawnVoidChild);

		const events = await collect(harness.start({ prompt: "hi" }, new AbortController().signal));

		expect(events.map((e) => e.kind)).toEqual([
			"started",
			"text",
			"text",
			"thinking",
			"tool",
			"tool",
			"result",
			"exit",
		]);
		expect(events[0]).toMatchObject({ kind: "started", providerSessionId: "child-1" });
		expect(events[1]).toMatchObject({ kind: "text", text: "hel" });
		expect(events[3]).toMatchObject({ kind: "thinking", text: "pondering" });
		expect(events[4]).toMatchObject({ kind: "tool", tool: "read", toolDone: false });
		expect(events[5]).toMatchObject({ kind: "tool", tool: "read", toolDone: true });
		expect(events[6]).toMatchObject({
			kind: "result",
			text: "hello",
			usage: { inputTokens: 10, outputTokens: 20, costUsd: 0.005 },
		});
		expect(events[7]).toMatchObject({ kind: "exit", exitCode: 0 });
		expect(fake.promptCalls).toEqual(["hi"]);
	});

	test("resume: a known providerSessionId reuses the live child instead of respawning, while it's still alive", async () => {
		// Disposal now happens in run()'s finally (fix 1), so a session only remains resumable
		// while its owning run is still in flight - this gates the first prompt open so the
		// second (resuming) call lands before the first run's finally disposes it.
		let spawnCount = 0;
		let releaseFirst = () => {};
		const releaseGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const fake = new FakeAgentSession("child-2", async (text, self) => {
			if (text === "first") await releaseGate;
			self.setLastAssistantText("turn done");
		});
		const spawnVoidChild: SpawnVoidChild = async () => {
			spawnCount++;
			return asAgentSession(fake);
		};
		const harness = new VoidHarness(spawnVoidChild);

		const firstRun = collect(harness.start({ prompt: "first" }, new AbortController().signal));
		await new Promise((resolve) => setTimeout(resolve, 0)); // let resolveSession register the session first

		const resumeEvents = await collect(
			harness.start({ prompt: "second", providerSessionId: "child-2" }, new AbortController().signal),
		);
		expect(spawnCount).toBe(1); // no respawn
		expect(resumeEvents.map((e) => e.kind)).toEqual(["result", "exit"]); // no "started" on resume

		releaseFirst();
		await firstRun;
		expect(fake.promptCalls).toEqual(["first", "second"]);
	});

	test("resume: an unknown providerSessionId fails as data, not a thrown exception", async () => {
		const spawnVoidChild: SpawnVoidChild = async () => {
			throw new Error("should not spawn on a resume attempt");
		};
		const harness = new VoidHarness(spawnVoidChild);

		const events = await collect(
			harness.start({ prompt: "resume please", providerSessionId: "no-such-session" }, new AbortController().signal),
		);

		expect(events).toHaveLength(2);
		expect(events[0]).toMatchObject({ kind: "result", isError: true });
		expect((events[0] as { text?: string }).text).toContain("no-such-session");
		expect(events[1]).toMatchObject({ kind: "exit", exitCode: 1 });
	});

	test("abort during prompt: reports the run as cancelled (isError:true, exit 130), not done", async () => {
		const fake = new FakeAgentSession("child-3", async () => {
			// Simulates a long-running turn that only ends once abort() lands.
			while (!fake.aborted) await new Promise((resolve) => setTimeout(resolve, 1));
			fake.setLastAssistantText("aborted mid-turn");
		});
		const spawnVoidChild: SpawnVoidChild = async () => asAgentSession(fake);
		const harness = new VoidHarness(spawnVoidChild);

		const controller = new AbortController();
		const eventsPromise = collect(harness.start({ prompt: "long task" }, controller.signal));
		// Let resolveSession settle and prompt() start polling before aborting, so this exercises
		// the "abort while prompt() is in flight" path (fix 2), not the abort-during-spawn race
		// (that one's covered separately below).
		await new Promise((resolve) => setTimeout(resolve, 0));
		controller.abort();
		const events = await eventsPromise;

		expect(fake.promptCalls).toEqual(["long task"]);
		expect(fake.aborted).toBe(true);
		expect(events).toEqual([
			expect.objectContaining({ kind: "started", providerSessionId: "child-3" }),
			expect.objectContaining({ kind: "result", isError: true, text: "Run cancelled" }),
			expect.objectContaining({ kind: "exit", exitCode: 130 }),
		]);
	});

	test("abort during spawn: an already-aborted signal disposes the session and never calls prompt()", async () => {
		const fake = new FakeAgentSession("child-abort-spawn", async () => {
			throw new Error("prompt() should never be called when the signal was aborted before resolveSession settled");
		});
		const spawnVoidChild: SpawnVoidChild = async () => asAgentSession(fake);
		const harness = new VoidHarness(spawnVoidChild);

		const controller = new AbortController();
		// Aborting synchronously, right after start(), fires before resolveSession's spawn promise
		// has settled (spawnVoidChild is async, so it resolves on a later microtask) - this is the
		// abort-during-spawn race from fix 3, not the abort-during-prompt path above.
		const eventsPromise = collect(harness.start({ prompt: "long task" }, controller.signal));
		controller.abort();
		const events = await eventsPromise;

		expect(fake.promptCalls).toEqual([]);
		expect(fake.aborted).toBe(false); // never reached the abort() listener - disposed before prompting
		expect(fake.disposeCalls).toBe(1);
		expect(events).toEqual([
			expect.objectContaining({ kind: "started", providerSessionId: "child-abort-spawn" }),
			expect.objectContaining({ kind: "result", isError: true, text: "Run cancelled" }),
			expect.objectContaining({ kind: "exit", exitCode: 130 }),
		]);
	});

	test("normal completion: disposes the session and removes it from the resume map", async () => {
		const fake = new FakeAgentSession("child-dispose", async (_text, self) => {
			self.setLastAssistantText("done");
		});
		const spawnVoidChild: SpawnVoidChild = async () => asAgentSession(fake);
		const harness = new VoidHarness(spawnVoidChild);

		await collect(harness.start({ prompt: "hi" }, new AbortController().signal));

		expect(fake.disposeCalls).toBe(1);

		// Session was removed from `children` on disposal, so a resume attempt against the same
		// providerSessionId now fails as an unknown session instead of reusing the disposed child.
		const resumeEvents = await collect(
			harness.start({ prompt: "resume?", providerSessionId: "child-dispose" }, new AbortController().signal),
		);
		expect(resumeEvents[0]).toMatchObject({ kind: "result", isError: true });
		expect((resumeEvents[0] as { text?: string }).text).toContain("child-dispose");
	});

	test("spawn failure: yields an error result + exit instead of an unhandled rejection", async () => {
		const spawnVoidChild: SpawnVoidChild = async () => {
			throw new Error("no capacity for a new child");
		};
		const harness = new VoidHarness(spawnVoidChild);

		const events = await collect(harness.start({ prompt: "hi" }, new AbortController().signal));

		expect(events).toEqual([
			expect.objectContaining({ kind: "result", isError: true, text: "no capacity for a new child" }),
			expect.objectContaining({ kind: "exit", exitCode: 1 }),
		]);
	});

	test("prepareSpawn: the token is looked up once (extraArgs[0]) and handed to spawnVoidChild", async () => {
		const seenConfigs: Array<{ systemPrompt?: string; toolNames?: string[]; modelId?: string }> = [];
		const fake = new FakeAgentSession("child-4", async () => {});
		const spawnVoidChild: SpawnVoidChild = async (cfg) => {
			seenConfigs.push(cfg);
			return asAgentSession(fake);
		};
		const harness = new VoidHarness(spawnVoidChild);
		harness.prepareSpawn("tok-1", { systemPrompt: "be nice", toolNames: ["read"], modelId: "sonnet" });

		await collect(harness.start({ prompt: "hi", extraArgs: ["tok-1"] }, new AbortController().signal));

		expect(seenConfigs).toEqual([{ systemPrompt: "be nice", toolNames: ["read"], modelId: "sonnet" }]);

		// One-shot: a second run with the same (now-consumed) token gets an empty spawn config.
		const fake2 = new FakeAgentSession("child-5", async () => {});
		const spawnVoidChild2: SpawnVoidChild = async (cfg) => {
			seenConfigs.push(cfg);
			return asAgentSession(fake2);
		};
		const harness2 = new VoidHarness(spawnVoidChild2);
		await collect(harness2.start({ prompt: "hi", extraArgs: ["never-registered"] }, new AbortController().signal));
		expect(seenConfigs[1]).toEqual({ systemPrompt: undefined, toolNames: undefined, modelId: undefined });
	});

	test("cancelSpawn: cleans up a token left dangling by a startRun() throw before start() ever ran", async () => {
		// Mirrors subagent.ts's void branch: prepareSpawn() registers a token, then startRun()
		// (not exercised here - it's HarnessRunManager, out of scope for this unit) can throw
		// synchronously before VoidHarness.start()/resolveSession() ever runs, so the token would
		// never be consumed and would leak in pendingSpawns forever without cancelSpawn().
		const seenConfigs: Array<{ systemPrompt?: string; toolNames?: string[]; modelId?: string }> = [];
		const fake = new FakeAgentSession("child-6", async () => {});
		const spawnVoidChild: SpawnVoidChild = async (cfg) => {
			seenConfigs.push(cfg);
			return asAgentSession(fake);
		};
		const harness = new VoidHarness(spawnVoidChild);
		harness.prepareSpawn("tok-leak", { systemPrompt: "leaked?", toolNames: ["read"], modelId: "sonnet" });

		// Simulate the startRun() throw path: clean up instead of ever calling start() with this token.
		harness.cancelSpawn("tok-leak");

		// A later run reusing the same token (e.g. a UUID collision, or - more realistically - proof
		// the entry is gone) now gets an empty spawn config instead of the stale registered one.
		await collect(harness.start({ prompt: "hi", extraArgs: ["tok-leak"] }, new AbortController().signal));
		expect(seenConfigs).toEqual([{ systemPrompt: undefined, toolNames: undefined, modelId: undefined }]);
	});
});
