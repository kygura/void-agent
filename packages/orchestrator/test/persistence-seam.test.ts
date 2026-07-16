import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionStore, StoredSession } from "../src/index.js";
import { createSessionStore, Orchestrator, Persister } from "../src/index.js";
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

async function waitForState(orchestrator: Orchestrator, runId: string, state: RunState): Promise<void> {
	await waitFor(() => orchestrator.run(runId)?.state === state);
}

async function waitForStoredSession(store: SessionStore, sessionId: string): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (Date.now() < deadline) {
		try {
			await store.load(sessionId);
			return;
		} catch {
			await Bun.sleep(1);
		}
	}
	throw new Error(`timed out waiting for persisted Session ${sessionId}`);
}

async function withStore(run: (store: SessionStore, directory: string) => Promise<void>): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "void-orchestrator-persistence-"));
	const directory = join(root, "sessions");
	try {
		await run(await createSessionStore(directory), directory);
	} finally {
		await rm(root, { force: true, recursive: true });
	}
}

class StreamingProvider implements Provider {
	public readonly name = "streaming";
	public readonly resumable = true;

	public constructor(private readonly eventCount: number) {}

	public start(config: RunConfig): AsyncIterable<Event> {
		return this.events(config);
	}

	private async *events(config: RunConfig): AsyncIterable<Event> {
		yield { kind: "started", providerSessionId: `provider-${config.prompt}` };
		for (let index = 0; index < this.eventCount; index += 1) {
			await Bun.sleep(0);
			yield { kind: "text", text: eventText(index) };
		}
		yield { kind: "result", text: `finished ${config.prompt}` };
		// Duplicate terminal notifications pin convergence at the lifecycle seam.
		yield { kind: "result", text: "duplicate result" };
		yield { kind: "exit", exitCode: 0 };
		yield { kind: "exit", exitCode: 0 };
	}
}

function eventText(index: number): string {
	return `event-${index.toString().padStart(4, "0")}-payload-abcdefghijklmnopqrstuvwxyz`;
}

function eventRecords(session: StoredSession, kind: Event["kind"]): readonly Event[] {
	return session.records.flatMap((record) => (record.event.kind === kind ? [record.event] : []));
}

describe("orchestrator persistence seam", () => {
	test("bounds persisted Session list and load restore operations", async () => {
		for (const blockedOperation of ["list", "load"] as const) {
			const never = new Promise<never>(() => {});
			const store: SessionStore = {
				list: () => (blockedOperation === "list" ? never : Promise.resolve(["stuck"])),
				load: () => never,
				appendMeta: async () => {},
				appendPrompt: async () => {},
				appendEvent: async () => {},
			};
			const startedAt = Date.now();
			const restored = await new Persister(store, { restoreTimeoutMs: 10 }).restore();

			expect(Date.now() - startedAt < 100).toBe(true);
			expect(restored.sessions).toEqual([]);
			expect(restored.warnings.length).toBe(1);
			expect(restored.warnings[0]?.includes("persisted sessions unavailable")).toBe(true);
		}
	});

	test("persists metadata first, streams incrementally, writes one parent result, and restores grouping", async () => {
		await withStore(async (store, directory) => {
			const provider = new StreamingProvider(4);
			const orchestrator = new Orchestrator(resolver({ streaming: provider }), {
				persister: new Persister(store),
			});
			const parentId = orchestrator.createSession({ id: "parent", provider: "streaming", name: "parent" });
			const child = orchestrator.spawnChildSession(parentId, {
				provider: "streaming",
				prompt: "child",
				name: "reviewer",
			});

			await waitForState(orchestrator, child.runId, "done");
			await orchestrator.flushPersistence();

			const childLines = (await readFile(join(directory, `${child.sessionId}.json`), "utf8"))
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as Record<string, unknown>);
			expect("meta" in (childLines[0] ?? {})).toBe(true);
			expect("prompt" in (childLines[1] ?? {})).toBe(true);

			const persistedChild = await store.load(child.sessionId);
			expect(persistedChild.meta.providerSessionId).toBe("provider-child");
			expect(persistedChild.records.map((record) => record.event.kind)).toEqual([
				"started",
				"text",
				"text",
				"text",
				"text",
				"result",
				"exit",
			]);

			const persistedParent = await store.load(parentId);
			const parentResults = eventRecords(persistedParent, "subagentResult");
			expect(parentResults.length).toBe(1);
			expect(parentResults[0]).toMatchObject({
				kind: "subagentResult",
				childSessionId: child.sessionId,
				childName: "reviewer",
				state: "done",
				text: "finished child",
			});

			await orchestrator.close();

			const restored = new Orchestrator(resolver({ streaming: provider }), {
				persister: new Persister(store),
			});
			expect(await restored.restorePersistedSessions()).toEqual([]);
			expect(restored.session(child.sessionId)?.parentSessionId).toBe(parentId);
			expect(restored.session(child.sessionId)?.providerSessionId).toBe("provider-child");
			expect(
				restored
					.sessions()
					.map((session) => session.id)
					.sort(),
			).toEqual([child.sessionId, parentId].sort());
			await restored.close();
		});
	});

	test("loses no record when event appends race rename, load, and parent-result writes", async () => {
		await withStore(async (store) => {
			const eventCount = 120;
			const orchestrator = new Orchestrator(resolver({ streaming: new StreamingProvider(eventCount) }), {
				persister: new Persister(store),
			});
			const parentId = orchestrator.createSession({ id: "race-parent", provider: "streaming" });
			const child = orchestrator.spawnChildSession(parentId, {
				provider: "streaming",
				prompt: "race-child",
				name: "before",
			});
			await waitForStoredSession(store, child.sessionId);

			const rename = async (): Promise<void> => {
				for (let index = 0; index < 120; index += 1) {
					orchestrator.setSessionName(child.sessionId, `renamed-${index}`);
					await Bun.sleep(0);
				}
			};
			const load = async (): Promise<void> => {
				for (let index = 0; index < 120; index += 1) {
					const loaded = await store.load(child.sessionId);
					expect(loaded.warning).toBeUndefined();
					for (const [recordIndex, record] of eventRecords(loaded, "text").entries()) {
						expect(record.text).toBe(eventText(recordIndex));
					}
				}
			};

			await Promise.all([rename(), load(), waitForState(orchestrator, child.runId, "done")]);
			await orchestrator.flushPersistence();

			const persistedChild = await store.load(child.sessionId);
			expect(persistedChild.warning).toBeUndefined();
			expect(persistedChild.meta.name).toBe("renamed-119");
			expect(eventRecords(persistedChild, "text").map((event) => event.text)).toEqual(
				Array.from({ length: eventCount }, (_, index) => eventText(index)),
			);
			const parentResults = eventRecords(await store.load(parentId), "subagentResult");
			expect(parentResults.length).toBe(1);
			expect(orchestrator.persistenceWarnings()).toEqual([]);
			await orchestrator.close();
		});
	});

	test("surfaces an injected disk failure without taking down another Run", async () => {
		await withStore(async (baseStore) => {
			const failingStore: SessionStore = {
				list: () => baseStore.list(),
				load: (sessionId) => baseStore.load(sessionId),
				appendMeta: async (meta) => {
					if (meta.id === "broken") throw new Error("injected disk failure");
					await baseStore.appendMeta(meta);
				},
				appendPrompt: async (sessionId, runId, prompt) => {
					if (sessionId === "broken") throw new Error("injected disk failure");
					await baseStore.appendPrompt(sessionId, runId, prompt);
				},
				appendEvent: async (sessionId, runId, event) => {
					if (sessionId === "broken") throw new Error("injected disk failure");
					await baseStore.appendEvent(sessionId, runId, event);
				},
			};
			const orchestrator = new Orchestrator(resolver({ streaming: new StreamingProvider(2) }), {
				persister: new Persister(failingStore),
			});
			const observedWarnings: string[] = [];
			orchestrator.subscribe((event) => {
				if (event.warning !== undefined) observedWarnings.push(event.warning);
			});
			const brokenId = orchestrator.createSession({ id: "broken", provider: "streaming" });
			const healthyId = orchestrator.createSession({ id: "healthy", provider: "streaming" });
			const broken = orchestrator.submitPrompt(brokenId, "broken");
			const healthy = orchestrator.submitPrompt(healthyId, "healthy");

			await waitForState(orchestrator, broken.runId ?? "", "done");
			await waitForState(orchestrator, healthy.runId ?? "", "done");
			await orchestrator.flushPersistence();

			expect(orchestrator.persistenceWarnings().length).toBe(1);
			expect(orchestrator.persistenceWarnings()[0]?.includes("injected disk failure")).toBe(true);
			expect(observedWarnings).toEqual(orchestrator.persistenceWarnings());
			expect(orchestrator.run(healthy.runId ?? "")?.finalText).toBe("finished healthy");
			expect((await baseStore.load(healthyId)).records.length).toBe(5);
			await orchestrator.close();
		});
	});
});
