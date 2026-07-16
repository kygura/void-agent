import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockProvider, createSessionStore, Orchestrator, Persister } from "@void/orchestrator";
import { afterEach, describe, expect, it } from "vitest";
import {
	createOrchestrationExtension,
	ProcessLifetimeOrchestrationHost,
	VOID_SPAWN_CUSTOM_TYPE,
	VOID_SPAWN_STATE_CUSTOM_TYPE,
	type VoidSpawnState,
} from "../../src/core/orchestration/index.js";
import type { OrchestratorResolutionSuccess } from "../../src/core/orchestrator-config.js";
import { createHarness } from "./harness.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
});

function tempDirectory(): string {
	const directory = join(tmpdir(), `void-v016-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(directory, { recursive: true });
	cleanups.push(() => {
		if (existsSync(directory)) rmSync(directory, { recursive: true, force: true });
	});
	return directory;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 1_000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("timed out waiting for orchestrator spawn");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

describe("orchestrator spawn suite integration", () => {
	it("persists one displayable child result without consuming the parent Provider", async () => {
		const root = tempDirectory();
		const store = await createSessionStore(join(root, "orchestrator-sessions"));
		const mock = createMockProvider({
			events: [
				{ kind: "started", providerSessionId: "mock-child-session" },
				{ kind: "text", text: "working" },
				{ kind: "result", text: "hello result", isError: false },
				{ kind: "exit", exitCode: 0 },
			],
			delayMs: 1,
		});
		const providers = { mock };
		const orchestrator = new Orchestrator((name) => providers[name as keyof typeof providers], {
			defaultProvider: "mock",
			persister: new Persister(store),
		});
		const resolution: OrchestratorResolutionSuccess = {
			ok: true,
			config: { defaultProvider: "mock", providers: { mock: { type: "mock" } } },
			providers,
			orchestrator,
			diagnostics: [],
		};
		const host = new ProcessLifetimeOrchestrationHost({ resolution });
		cleanups.push(() => host.close());
		const harness = await createHarness({ extensionFactories: [createOrchestrationExtension(host)] });
		cleanups.push(harness.cleanup);
		await harness.session.bindExtensions({});
		const parentSessionId = harness.sessionManager.getSessionId();

		await harness.session.prompt("/spawn mock hello");
		const child = host.snapshot().sessions.find((session) => session.parentSessionId === parentSessionId);
		expect(child).toBeDefined();
		expect(harness.faux.state.callCount).toBe(0);
		expect(harness.getPendingResponseCount()).toBe(0);

		await waitUntil(() => host.snapshot().runs[0]?.state === "done");
		await host.flushPersistence();

		const entries = harness.sessionManager.getEntries();
		const spawnEntries = entries.filter(
			(entry) => entry.type === "custom_message" && entry.customType === VOID_SPAWN_CUSTOM_TYPE,
		);
		const states = entries.flatMap((entry) =>
			entry.type === "custom" && entry.customType === VOID_SPAWN_STATE_CUSTOM_TYPE
				? [entry.data as VoidSpawnState]
				: [],
		);
		expect(spawnEntries).toHaveLength(1);
		expect(spawnEntries[0]).toMatchObject({
			content: child!.id,
			details: { childSessionId: child!.id },
			display: true,
		});
		expect(states.at(-1)).toMatchObject({
			parentSessionId,
			childSessionId: child!.id,
			state: "done",
			result: {
				kind: "subagentResult",
				childSessionId: child!.id,
				childName: "mock",
				state: "done",
				text: "hello result",
			},
		});

		const persistedParent = await store.load(parentSessionId);
		const persistedResults = persistedParent.records.filter((record) => record.event.kind === "subagentResult");
		expect(persistedResults).toHaveLength(1);
		expect(persistedResults[0]?.event).toMatchObject({
			kind: "subagentResult",
			childSessionId: child!.id,
			childName: "mock",
			state: "done",
			text: "hello result",
		});
	});
});
