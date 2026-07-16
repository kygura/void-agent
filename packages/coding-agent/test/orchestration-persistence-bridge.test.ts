import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@void/ai";
import {
	createMockProvider,
	createSessionStore,
	type Event,
	Orchestrator,
	Persister,
	type SessionStore,
} from "@void/orchestrator";
import { afterEach, describe, expect, it } from "vitest";
import { type CreateAgentSessionRuntimeFactory, createAgentSessionRuntime } from "../src/core/agent-session-runtime.js";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-services.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import type { ExtensionAPI } from "../src/core/extensions/index.js";
import {
	createOrchestrationExtension,
	ProcessLifetimeOrchestrationHost,
	VOID_SPAWN_CUSTOM_TYPE,
	VOID_SPAWN_STATE_CUSTOM_TYPE,
	type VoidSpawnState,
} from "../src/core/orchestration/index.js";
import type { OrchestratorResolutionSuccess } from "../src/core/orchestrator-config.js";
import { SessionManager } from "../src/core/session-manager.js";
import { createHarness } from "./suite/harness.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
});

function tempDirectory(prefix: string): string {
	const directory = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(directory, { recursive: true });
	cleanups.push(() => {
		if (existsSync(directory)) rmSync(directory, { recursive: true, force: true });
	});
	return directory;
}

async function createPersistentHost(
	events: readonly Event[],
	delayMs = 2,
): Promise<{
	host: ProcessLifetimeOrchestrationHost;
	store: SessionStore;
}> {
	const store = await createSessionStore(join(tempDirectory("void-orchestration-bridge"), "sessions"));
	const provider = createMockProvider({ delayMs, events, resumable: true });
	const providers = { mock: provider };
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
	return { host, store };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("timed out waiting for orchestration bridge state");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

describe("orchestration persistence bridge", () => {
	it("installs orchestrator persistence when the process host is configured", async () => {
		const persistenceDirectory = join(tempDirectory("void-orchestration-configured"), "sessions");
		const host = new ProcessLifetimeOrchestrationHost({ persistenceDirectory });
		cleanups.push(() => host.close());
		expect(
			host.configure({
				orchestrator: {
					defaultProvider: "mock",
					providers: { mock: { type: "mock" } },
				},
			}),
		).toEqual([]);
		const harness = await createHarness({ extensionFactories: [createOrchestrationExtension(host)] });
		cleanups.push(harness.cleanup);
		await harness.session.bindExtensions({});
		const parentSessionId = harness.sessionManager.getSessionId();

		await harness.session.prompt("/spawn mock configured persistence");
		await waitUntil(() => host.snapshot().runs[0]?.state === "done");
		await host.flushPersistence();

		const store = await createSessionStore(persistenceDirectory);
		const parent = await store.load(parentSessionId);
		expect(parent.records.filter((record) => record.event.kind === "subagentResult")).toHaveLength(1);
		expect(harness.faux.state.callCount).toBe(0);
	});

	it("persists one spawn message and one complete successful parent result", async () => {
		const { host, store } = await createPersistentHost([
			{ kind: "started", providerSessionId: "provider-child" },
			{ kind: "text", text: "working" },
			{ kind: "result", text: "finished", isError: false },
			{ kind: "exit", exitCode: 0 },
		]);
		const harness = await createHarness({ extensionFactories: [createOrchestrationExtension(host)] });
		cleanups.push(harness.cleanup);
		await harness.session.bindExtensions({});
		const parentSessionId = harness.sessionManager.getSessionId();

		await harness.session.prompt("/spawn mock inspect auth");
		const child = host.snapshot().sessions.find((session) => session.parentSessionId === parentSessionId);
		expect(child).toBeDefined();
		await waitUntil(() => host.snapshot().runs[0]?.state === "done");
		await host.flushPersistence();

		const entries = harness.sessionManager.getEntries();
		const messages = entries.filter(
			(entry) => entry.type === "custom_message" && entry.customType === VOID_SPAWN_CUSTOM_TYPE,
		);
		const states = entries.flatMap((entry) =>
			entry.type === "custom" && entry.customType === VOID_SPAWN_STATE_CUSTOM_TYPE
				? [entry.data as VoidSpawnState]
				: [],
		);
		expect(messages).toHaveLength(1);
		expect(messages[0]).toMatchObject({
			content: child!.id,
			details: { childSessionId: child!.id },
			display: true,
		});
		expect(states.map((state) => state.state)).toEqual(["pending", "running", "done"]);
		expect(states.at(-1)).toMatchObject({
			parentSessionId,
			childSessionId: child!.id,
			state: "done",
			result: {
				kind: "subagentResult",
				childSessionId: child!.id,
				childName: "mock",
				state: "done",
				text: "finished",
			},
		});
		expect(harness.faux.state.callCount).toBe(0);

		const parent = await store.load(parentSessionId);
		const results = parent.records.filter((record) => record.event.kind === "subagentResult");
		expect(results).toHaveLength(1);
		expect(results[0].event).toMatchObject({
			kind: "subagentResult",
			childSessionId: child!.id,
			childName: "mock",
			state: "done",
			text: "finished",
			elapsed: expect.any(Number),
		});
	});

	it("converges failure notifications into one complete failed result", async () => {
		const { host, store } = await createPersistentHost([
			{ kind: "started", providerSessionId: "provider-failed" },
			{ kind: "result", text: "review failed", isError: true },
			{ kind: "result", text: "duplicate result", isError: true },
			{ kind: "exit", exitCode: 1 },
		]);
		const harness = await createHarness({ extensionFactories: [createOrchestrationExtension(host)] });
		cleanups.push(harness.cleanup);
		await harness.session.bindExtensions({});
		const parentSessionId = harness.sessionManager.getSessionId();

		await harness.session.prompt("/spawn mock fail review");
		const child = host.snapshot().sessions.find((session) => session.parentSessionId === parentSessionId);
		expect(child).toBeDefined();
		await waitUntil(() => host.snapshot().runs[0]?.state === "failed");
		await host.flushPersistence();

		const entries = harness.sessionManager.getEntries();
		const messages = entries.filter(
			(entry) => entry.type === "custom_message" && entry.customType === VOID_SPAWN_CUSTOM_TYPE,
		);
		const states = entries.flatMap((entry) =>
			entry.type === "custom" && entry.customType === VOID_SPAWN_STATE_CUSTOM_TYPE
				? [entry.data as VoidSpawnState]
				: [],
		);
		expect(messages).toHaveLength(1);
		expect(states.map((state) => state.state)).toEqual(["pending", "running", "failed"]);
		expect(states.at(-1)?.result).toEqual({
			kind: "subagentResult",
			childSessionId: child!.id,
			childName: "mock",
			state: "failed",
			text: "review failed",
			elapsed: expect.any(Number),
		});
		expect(harness.faux.state.callCount).toBe(0);
		const parent = await store.load(parentSessionId);
		const results = parent.records.filter((record) => record.event.kind === "subagentResult");
		expect(results).toHaveLength(1);
		expect(results[0].event).toMatchObject({
			kind: "subagentResult",
			childSessionId: child!.id,
			childName: "mock",
			state: "failed",
			text: "review failed",
			elapsed: expect.any(Number),
		});
	});

	it("persists one complete cancelled result", async () => {
		const { host, store } = await createPersistentHost([
			{ kind: "started", providerSessionId: "provider-cancelled" },
			{ kind: "text", text: "should not finish" },
			{ kind: "result", text: "too late" },
			{ kind: "exit", exitCode: 0 },
		]);
		const harness = await createHarness({ extensionFactories: [createOrchestrationExtension(host)] });
		cleanups.push(harness.cleanup);
		await harness.session.bindExtensions({});
		const parentSessionId = harness.sessionManager.getSessionId();

		await harness.session.prompt("/spawn mock cancel review");
		const child = host.snapshot().sessions.find((session) => session.parentSessionId === parentSessionId);
		expect(child).toBeDefined();
		await waitUntil(() => host.snapshot().runs[0]?.state === "running");
		expect(host.cancel(child!.id)).toBe(true);
		await waitUntil(() => host.snapshot().runs[0]?.state === "cancelled");
		await host.flushPersistence();

		const entries = harness.sessionManager.getEntries();
		const messages = entries.filter(
			(entry) => entry.type === "custom_message" && entry.customType === VOID_SPAWN_CUSTOM_TYPE,
		);
		const states = entries.flatMap((entry) =>
			entry.type === "custom" && entry.customType === VOID_SPAWN_STATE_CUSTOM_TYPE
				? [entry.data as VoidSpawnState]
				: [],
		);
		expect(messages).toHaveLength(1);
		expect(states.map((state) => state.state)).toEqual(["pending", "running", "cancelled"]);
		expect(states.at(-1)?.result).toEqual({
			kind: "subagentResult",
			childSessionId: child!.id,
			childName: "mock",
			state: "cancelled",
			text: "Run cancelled",
			elapsed: expect.any(Number),
		});
		expect(harness.faux.state.callCount).toBe(0);
		const parent = await store.load(parentSessionId);
		const results = parent.records.filter((record) => record.event.kind === "subagentResult");
		expect(results).toHaveLength(1);
		expect(results[0].event).toMatchObject({
			kind: "subagentResult",
			childSessionId: child!.id,
			childName: "mock",
			state: "cancelled",
			text: "Run cancelled",
			elapsed: expect.any(Number),
		});
	});

	it("routes delayed completion to the original parent after a session switch", async () => {
		const { host, store } = await createPersistentHost(
			[
				{ kind: "started", providerSessionId: "provider-switched" },
				{ kind: "result", text: "finished after switch" },
				{ kind: "exit", exitCode: 0 },
			],
			20,
		);
		const directory = tempDirectory("void-orchestration-switch");
		const parentHarness = await createHarness();
		cleanups.push(parentHarness.cleanup);
		const parentModel = parentHarness.getModel();
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(parentModel.provider, "faux-key");
		const registerParentProvider = (pi: ExtensionAPI): void => {
			pi.registerProvider(parentModel.provider, {
				baseUrl: parentModel.baseUrl,
				apiKey: "faux-key",
				api: parentHarness.faux.api,
				models: parentHarness.models,
			});
		};
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir: directory,
				authStorage,
				orchestrationHost: host,
				resourceLoaderOptions: {
					extensionFactories: [registerParentProvider],
					noExtensions: true,
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
				},
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: parentModel,
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: directory,
			agentDir: directory,
			sessionManager: SessionManager.create(directory, join(directory, "coding-sessions")),
			applicationShutdown: () => host.close(),
		});
		cleanups.push(() => runtime.dispose());
		await runtime.session.bindExtensions({});
		const originalParentId = runtime.session.sessionManager.getSessionId();
		parentHarness.setResponses([fauxAssistantMessage("parent ready")]);
		await runtime.session.prompt("initialize parent");
		expect(parentHarness.faux.state.callCount).toBe(1);

		await runtime.session.prompt("/spawn mock delayed completion");
		const originalSessionFile = runtime.session.sessionFile;
		expect(originalSessionFile).toBeDefined();
		const child = host.snapshot().sessions.find((session) => session.parentSessionId === originalParentId);
		expect(child).toBeDefined();
		await runtime.newSession();
		await runtime.session.bindExtensions({});
		await waitUntil(() => host.spawnState(child!.id)?.state === "done");
		await host.flushPersistence();

		const originalEntries = SessionManager.open(originalSessionFile!).getEntries();
		expect(
			originalEntries.filter(
				(entry) => entry.type === "custom_message" && entry.customType === VOID_SPAWN_CUSTOM_TYPE,
			),
		).toHaveLength(1);
		expect(
			originalEntries.filter(
				(entry) =>
					entry.type === "custom" &&
					entry.customType === VOID_SPAWN_STATE_CUSTOM_TYPE &&
					isTerminalState(entry.data),
			),
		).toHaveLength(1);
		expect(
			runtime.session.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom_message" && entry.customType === VOID_SPAWN_CUSTOM_TYPE),
		).toHaveLength(0);
		expect(
			(await store.load(originalParentId)).records.filter((record) => record.event.kind === "subagentResult"),
		).toHaveLength(1);
		expect(parentHarness.faux.state.callCount).toBe(1);
	});

	it("reattaches from persisted entries without duplicating the spawn or result", async () => {
		const { host, store } = await createPersistentHost(
			[
				{ kind: "started", providerSessionId: "provider-reload" },
				{ kind: "result", text: "reload complete" },
				{ kind: "exit", exitCode: 0 },
			],
			15,
		);
		const harness = await createHarness({ extensionFactories: [createOrchestrationExtension(host)] });
		cleanups.push(harness.cleanup);
		await harness.session.bindExtensions({});
		const parentSessionId = harness.sessionManager.getSessionId();

		await harness.session.prompt("/spawn mock reload bridge");
		await waitUntil(() => host.snapshot().runs[0]?.state === "running");
		await harness.session.reload();
		await waitUntil(() => host.snapshot().runs[0]?.state === "done");
		await host.flushPersistence();
		const before = harness.sessionManager.getEntries();
		const beforeMessageCount = before.filter(
			(entry) => entry.type === "custom_message" && entry.customType === VOID_SPAWN_CUSTOM_TYPE,
		).length;
		const beforeStateCount = before.filter(
			(entry) => entry.type === "custom" && entry.customType === VOID_SPAWN_STATE_CUSTOM_TYPE,
		).length;

		await harness.session.reload();
		await host.flushPersistence();

		const after = harness.sessionManager.getEntries();
		expect(
			after.filter((entry) => entry.type === "custom_message" && entry.customType === VOID_SPAWN_CUSTOM_TYPE),
		).toHaveLength(beforeMessageCount);
		expect(
			after.filter((entry) => entry.type === "custom" && entry.customType === VOID_SPAWN_STATE_CUSTOM_TYPE),
		).toHaveLength(beforeStateCount);
		expect(
			(await store.load(parentSessionId)).records.filter((record) => record.event.kind === "subagentResult"),
		).toHaveLength(1);
		expect(harness.faux.state.callCount).toBe(0);
	});
});

function isTerminalState(value: unknown): boolean {
	return (
		typeof value === "object" &&
		value !== null &&
		"state" in value &&
		(value.state === "done" || value.state === "failed" || value.state === "cancelled")
	);
}
