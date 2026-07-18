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

	test("resume: a known providerSessionId reuses the live child instead of respawning, while the first run is still in flight", async () => {
		// Gates the first prompt open so the second (resuming) call lands while the first run
		// is still active, exercising resume-of-an-in-flight-child specifically (resume of a
		// completed child is covered separately below).
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

	test("resume: a truly unknown providerSessionId (never spawned, no session file) fails as data, not a thrown exception", async () => {
		// Missing from this.children now triggers a respawn attempt (spawnVoidChild({ resumeSessionId })
		// - see sdk.ts), which throws when no session file exists for the id. VoidHarness must catch
		// that and fall back to the same "unknown or dead child session" failure-as-data result it
		// always has, not let the error escape or change the message.
		const spawnVoidChild: SpawnVoidChild = async (cfg) => {
			throw new Error(`no session file for "${cfg.resumeSessionId}"`);
		};
		const harness = new VoidHarness(spawnVoidChild);

		const events = await collect(
			harness.start({ prompt: "resume please", providerSessionId: "no-such-session" }, new AbortController().signal),
		);

		expect(events).toHaveLength(2);
		expect(events[0]).toMatchObject({ kind: "result", isError: true });
		expect((events[0] as { text?: string }).text).toBe('void: unknown or dead child session "no-such-session"');
		expect(events[1]).toMatchObject({ kind: "exit", exitCode: 1 });
	});

	test("resume: an id missing from this.children (evicted, or this process restarted) respawns via spawnVoidChild({ resumeSessionId }) instead of failing immediately", async () => {
		const resumeCalls: Array<{ resumeSessionId?: string; modelId?: string }> = [];
		const fake = new FakeAgentSession("restored-1", async (_text, self) => {
			self.setLastAssistantText("continued");
		});
		const spawnVoidChild: SpawnVoidChild = async (cfg) => {
			resumeCalls.push({ resumeSessionId: cfg.resumeSessionId, modelId: cfg.modelId });
			return asAgentSession(fake);
		};
		const harness = new VoidHarness(spawnVoidChild);

		const events = await collect(
			harness.start({ prompt: "resume please", providerSessionId: "restored-1" }, new AbortController().signal),
		);

		expect(resumeCalls).toEqual([{ resumeSessionId: "restored-1", modelId: undefined }]);
		expect(events.map((e) => e.kind)).toEqual(["started", "result", "exit"]);
		expect(events[0]).toMatchObject({ kind: "started", providerSessionId: "restored-1" });
		expect(fake.promptCalls).toEqual(["resume please"]);

		// Respawned child re-entered this.children: a second resume against the same id reuses it
		// directly, no second respawn.
		const followUp = await collect(
			harness.start({ prompt: "again", providerSessionId: "restored-1" }, new AbortController().signal),
		);
		expect(followUp.map((e) => e.kind)).toEqual(["result", "exit"]); // no "started" - reused, not respawned
		expect(resumeCalls).toHaveLength(1); // still just the one respawn
		expect(fake.promptCalls).toEqual(["resume please", "again"]);
	});

	test("resume: a live child in this.children never attempts a session-file respawn", async () => {
		let resumeAttempts = 0;
		const fake = new FakeAgentSession("live-1", async (_text, self) => {
			self.setLastAssistantText("done");
		});
		const spawnVoidChild: SpawnVoidChild = async (cfg) => {
			if (cfg.resumeSessionId !== undefined) resumeAttempts++;
			return asAgentSession(fake);
		};
		const harness = new VoidHarness(spawnVoidChild);

		await collect(harness.start({ prompt: "first" }, new AbortController().signal)); // fresh spawn
		const resumeEvents = await collect(
			harness.start({ prompt: "second", providerSessionId: "live-1" }, new AbortController().signal),
		);

		expect(resumeAttempts).toBe(0); // live path short-circuits before ever calling spawnVoidChild again
		expect(resumeEvents.map((e) => e.kind)).toEqual(["result", "exit"]);
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

	test("abort during an already-in-flight resume attempt: does NOT dispose/evict the live child, just cancels this turn", async () => {
		const fake = new FakeAgentSession("child-resume-abort", async (text, self) => {
			self.setLastAssistantText(`done: ${text}`);
		});
		const spawnVoidChild: SpawnVoidChild = async () => asAgentSession(fake);
		const harness = new VoidHarness(spawnVoidChild);

		// Fresh spawn first, so this.children holds a live, resumable child before the race below.
		await collect(harness.start({ prompt: "first" }, new AbortController().signal));
		expect(fake.promptCalls).toEqual(["first"]);

		const controller = new AbortController();
		// Same synchronous-abort-right-after-start() race as the fresh-spawn case above, but this
		// time providerSessionId is set, so resolveSession takes the resume branch (an existing
		// child from this.children, not a fresh spawn) - the early-abort branch in run() must not
		// dispose/evict that child just because this turn's signal was already aborted.
		const eventsPromise = collect(
			harness.start({ prompt: "second", providerSessionId: "child-resume-abort" }, controller.signal),
		);
		controller.abort();
		const events = await eventsPromise;

		expect(fake.promptCalls).toEqual(["first"]); // "second" never prompted - cancelled before prompt()
		expect(fake.disposeCalls).toBe(0); // resume's live child must survive this abort race
		expect(events).toEqual([
			expect.objectContaining({ kind: "result", isError: true, text: "Run cancelled" }),
			expect.objectContaining({ kind: "exit", exitCode: 130 }),
		]);

		// Prove the child is still live in this.children: it resumes again instead of failing as
		// unknown or triggering a fresh respawn.
		const followUp = await collect(
			harness.start({ prompt: "third", providerSessionId: "child-resume-abort" }, new AbortController().signal),
		);
		expect(followUp.map((e) => e.kind)).toEqual(["result", "exit"]); // no "started" - reused, not respawned
		expect(fake.promptCalls).toEqual(["first", "third"]);
	});

	test("normal completion: keeps the session alive and resumable instead of disposing it", async () => {
		let spawnCount = 0;
		const fake = new FakeAgentSession("child-dispose", async (_text, self) => {
			self.setLastAssistantText("done");
		});
		const spawnVoidChild: SpawnVoidChild = async () => {
			spawnCount++;
			return asAgentSession(fake);
		};
		const harness = new VoidHarness(spawnVoidChild);

		await collect(harness.start({ prompt: "hi" }, new AbortController().signal));

		expect(fake.disposeCalls).toBe(0);

		// Session stays in `children` after normal completion, so a resume attempt against the same
		// providerSessionId reuses the same live child instead of respawning or failing as unknown.
		const resumeEvents = await collect(
			harness.start({ prompt: "resume?", providerSessionId: "child-dispose" }, new AbortController().signal),
		);
		expect(resumeEvents.map((e) => e.kind)).toEqual(["result", "exit"]); // no "started" - reused, not spawned
		expect(spawnCount).toBe(1); // no respawn
		expect(fake.promptCalls).toEqual(["hi", "resume?"]);
	});

	test("LRU eviction: past CHILD_CAP (32), the oldest evicted child now respawns via spawnVoidChild instead of failing, while a recent one is served straight from the live map", async () => {
		const fakes: FakeAgentSession[] = [];
		const bySessionId = new Map<string, FakeAgentSession>();
		let respawnCount = 0;
		const spawnVoidChild: SpawnVoidChild = async (cfg) => {
			if (cfg.resumeSessionId !== undefined) {
				// Simulates sdk.ts finding the id's session file on disk and reopening the same
				// session (same underlying object here, since this fake has no real file backing).
				const existing = bySessionId.get(cfg.resumeSessionId);
				if (existing === undefined) throw new Error(`no session file for "${cfg.resumeSessionId}"`);
				respawnCount++;
				return asAgentSession(existing);
			}
			const fake = new FakeAgentSession(`child-${fakes.length}`, async (_text, self) => {
				self.setLastAssistantText("done");
			});
			fakes.push(fake);
			bySessionId.set(fake.sessionId, fake);
			return asAgentSession(fake);
		};
		const harness = new VoidHarness(spawnVoidChild);

		for (let i = 0; i < 33; i++) {
			await collect(harness.start({ prompt: "hi" }, new AbortController().signal));
		}

		expect(fakes).toHaveLength(33);
		expect(fakes[0].disposeCalls).toBe(1); // oldest evicted past the cap
		expect(fakes[32].disposeCalls).toBe(0); // most recent still alive

		// Evicted from the live map, but its "session file" (bySessionId, standing in for disk) still
		// exists, so the resume respawns instead of failing.
		const evictedResume = await collect(
			harness.start({ prompt: "resume?", providerSessionId: fakes[0].sessionId }, new AbortController().signal),
		);
		expect(evictedResume.map((e) => e.kind)).toEqual(["started", "result", "exit"]); // respawned
		expect(respawnCount).toBe(1);
		expect(fakes[0].promptCalls).toEqual(["hi", "resume?"]);

		const recentResume = await collect(
			harness.start({ prompt: "resume?", providerSessionId: fakes[32].sessionId }, new AbortController().signal),
		);
		expect(recentResume.map((e) => e.kind)).toEqual(["result", "exit"]); // served from live map, no respawn
		expect(respawnCount).toBe(1); // still just the one respawn (from the evicted-child case above)
		expect(fakes[32].promptCalls).toEqual(["hi", "resume?"]);
	});

	test("LRU eviction respects touch(): resuming an early child bumps it to MRU, sparing it from eviction", async () => {
		const fakes: FakeAgentSession[] = [];
		const spawnVoidChild: SpawnVoidChild = async () => {
			const fake = new FakeAgentSession(`child-${fakes.length}`, async (_text, self) => {
				self.setLastAssistantText("done");
			});
			fakes.push(fake);
			return asAgentSession(fake);
		};
		const harness = new VoidHarness(spawnVoidChild);

		// Fill exactly to the cap: child-0..child-31, no eviction yet.
		for (let i = 0; i < 32; i++) {
			await collect(harness.start({ prompt: "hi" }, new AbortController().signal));
		}

		// Touch child-0 via resume, bumping it to MRU ahead of child-1 (the next-oldest untouched).
		await collect(
			harness.start({ prompt: "resume?", providerSessionId: fakes[0].sessionId }, new AbortController().signal),
		);

		// One more fresh spawn pushes size past the cap; the oldest untouched child (child-1) should
		// be evicted instead of the touched child-0.
		await collect(harness.start({ prompt: "hi" }, new AbortController().signal));

		expect(fakes[0].disposeCalls).toBe(0); // touched - survived
		expect(fakes[1].disposeCalls).toBe(1); // untouched and oldest - evicted
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
