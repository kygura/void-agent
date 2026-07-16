import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockProvider, Orchestrator, type OrchestratorConfig } from "@void/orchestrator";
import { afterEach, describe, expect, it } from "vitest";
import { type CreateAgentSessionRuntimeFactory, createAgentSessionRuntime } from "../src/core/agent-session-runtime.js";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-services.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import type { ExtensionAPI } from "../src/core/extensions/index.js";
import {
	createOrchestrationExtension,
	discoverClaudeAgentPresets,
	ProcessLifetimeOrchestrationHost,
	VOID_SPAWN_CUSTOM_TYPE,
} from "../src/core/orchestration/index.js";
import type { OrchestratorResolutionSuccess } from "../src/core/orchestrator-config.js";
import { SessionManager } from "../src/core/session-manager.js";
import { createHarness } from "./suite/harness.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
	process.chdir(tmpdir());
});

function tempDirectory(prefix: string): string {
	const directory = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(directory, { recursive: true });
	cleanups.push(() => {
		if (existsSync(directory)) rmSync(directory, { recursive: true, force: true });
	});
	return directory;
}

function createHost(options: { delayMs?: number; homeDir?: string; providerNames?: readonly string[] } = {}) {
	const providerNames = options.providerNames ?? ["mock"];
	const config: OrchestratorConfig = {
		defaultProvider: providerNames[0],
		providers: Object.fromEntries(
			providerNames.map((name) => [name, { type: name === "mock" ? "mock" : "claude", models: ["small", "large"] }]),
		),
	};
	const mock = createMockProvider({
		delayMs: options.delayMs,
		resumable: true,
		events: [
			{ kind: "started", providerSessionId: "provider-session" },
			{ kind: "result", text: "complete", isError: false },
			{ kind: "exit", exitCode: 0 },
		],
	});
	const providers = Object.fromEntries(providerNames.map((name) => [name, mock]));
	const orchestrator = new Orchestrator((name) => providers[name], { defaultProvider: config.defaultProvider });
	const resolution: OrchestratorResolutionSuccess = {
		ok: true,
		config,
		providers,
		orchestrator,
		diagnostics: [],
	};
	const host = new ProcessLifetimeOrchestrationHost({ resolution, homeDir: options.homeDir });
	cleanups.push(() => host.close());
	return { host, mock };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("timed out waiting for orchestration state");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

describe("built-in orchestration extension", () => {
	it("discovers Claude presets with project precedence and fans out without a parent response", async () => {
		const homeDir = tempDirectory("void-orchestration-home");
		const { host, mock } = createHost({ homeDir, providerNames: ["claude"] });
		const harness = await createHarness({ extensionFactories: [createOrchestrationExtension(host)] });
		cleanups.push(harness.cleanup);

		const userAgents = join(homeDir, ".claude", "agents");
		const projectAgents = join(harness.tempDir, ".claude", "agents");
		mkdirSync(userAgents, { recursive: true });
		mkdirSync(projectAgents, { recursive: true });
		writeFileSync(join(userAgents, "review.md"), "---\nname: review\nmodel: small\n---\nUser prompt");
		writeFileSync(join(userAgents, "_shared.md"), "shared");
		writeFileSync(join(userAgents, "hidden.md"), "---\nuser-invocable: false\n---\nhidden");
		writeFileSync(
			join(projectAgents, "review.md"),
			"---\nname: review\ndescription: Project reviewer\nmodel: large\n---\nProject system prompt",
		);

		expect(discoverClaudeAgentPresets(homeDir, harness.tempDir)).toEqual([
			{
				name: "review",
				description: "Project reviewer",
				model: "large",
				systemPrompt: "Project system prompt",
			},
		]);

		await harness.session.prompt("/spawn --preset review --count 2 claude inspect auth");

		expect(harness.faux.state.callCount).toBe(0);
		expect(mock.getCalls()).toEqual([
			expect.objectContaining({
				provider: "claude",
				model: "large",
				prompt: "Project system prompt\n\ninspect auth",
			}),
			expect.objectContaining({
				provider: "claude",
				model: "large",
				prompt: "Project system prompt\n\ninspect auth",
			}),
		]);
		const children = host.snapshot().sessions.filter((session) => session.parentSessionId !== undefined);
		expect(children.map((session) => session.name)).toEqual(["review-1", "review-2"]);
		expect(new Set(children.map((session) => session.parentSessionId))).toEqual(
			new Set([harness.sessionManager.getSessionId()]),
		);
		const resume = harness.session.extensionRunner?.getCommand("agent-resume");
		expect(await resume?.getArgumentCompletions?.(children[0].id)).toEqual([
			expect.objectContaining({ value: children[0].id }),
		]);
	});

	it("registers validated commands and completions, and invalid input starts nothing", async () => {
		const { host } = createHost();
		const harness = await createHarness({ extensionFactories: [createOrchestrationExtension(host)] });
		cleanups.push(harness.cleanup);

		const commands = harness.session.extensionRunner?.getRegisteredCommands() ?? [];
		expect(commands.map((command) => command.name)).toEqual([
			"spawn",
			"run",
			"agent-resume",
			"provider",
			"agents",
			"cancel",
			"login",
			"agent-model",
			"agent-effort",
		]);
		expect(harness.session.extensionRunner?.getMessageRenderer(VOID_SPAWN_CUSTOM_TYPE)).toBeDefined();
		const spawn = commands.find((command) => command.name === "spawn");
		expect(await spawn?.getArgumentCompletions?.("mo")).toEqual([expect.objectContaining({ value: "mock" })]);
		const effort = commands.find((command) => command.name === "agent-effort");
		expect(await effort?.getArgumentCompletions?.("m")).toEqual([expect.objectContaining({ value: "medium" })]);

		for (const command of [
			"/spawn mock",
			"/spawn --count 0 mock task",
			"/spawn --count 9 mock task",
			'/spawn mock "unterminated',
			"/spawn unknown task",
			"/run mock",
			"/agent-resume missing continue",
			"/provider unknown",
			"/cancel missing",
			"/login mock extra",
			"/agent-model unknown model",
			"/agent-effort extreme",
		]) {
			await harness.session.prompt(command);
		}

		expect(harness.faux.state.callCount).toBe(0);
		expect(host.snapshot().runs).toHaveLength(0);
	});

	it("keeps delayed Runs alive across two parent switches and reaps them on application shutdown", async () => {
		const directory = tempDirectory("void-orchestration-runtime");
		const { host } = createHost({ delayMs: 30 });
		const authStorage = AuthStorage.inMemory();
		const harness = await createHarness();
		cleanups.push(harness.cleanup);
		const parentModel = harness.getModel();
		authStorage.setRuntimeApiKey(parentModel.provider, "faux-key");

		const registerParentProvider = (pi: ExtensionAPI): void => {
			pi.registerProvider(parentModel.provider, {
				baseUrl: parentModel.baseUrl,
				apiKey: "faux-key",
				api: harness.faux.api,
				models: harness.models,
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
			sessionManager: SessionManager.create(directory, join(directory, "sessions")),
			applicationShutdown: () => host.close(),
		});
		await runtime.session.bindExtensions({});
		const originalParentId = runtime.session.sessionManager.getSessionId();
		await runtime.session.prompt("/spawn mock delayed");
		const delayedRunId = host.snapshot().runs[0]?.id;
		expect(delayedRunId).toBeDefined();

		await runtime.newSession();
		await runtime.session.bindExtensions({});
		await runtime.newSession();
		await runtime.session.bindExtensions({});

		expect(host.snapshot().sessions.some((session) => session.id === originalParentId)).toBe(true);
		await waitUntil(() => host.snapshot().runs.find((run) => run.id === delayedRunId)?.state === "done");

		await runtime.session.prompt("/spawn mock reap-on-shutdown");
		const liveRunId = host.snapshot().runs.at(-1)?.id;
		await runtime.dispose();
		expect(host.snapshot().closing).toBe(true);
		expect(host.snapshot().runs.find((run) => run.id === liveRunId)?.state).toBe("cancelled");
		expect(harness.faux.state.callCount).toBe(0);
	});

	it("loads the built-in factory with noExtensions while suppressing user extensions", async () => {
		const directory = tempDirectory("void-orchestration-no-extensions");
		const extensionsDirectory = join(directory, "extensions");
		mkdirSync(extensionsDirectory, { recursive: true });
		writeFileSync(
			join(extensionsDirectory, "user.ts"),
			'export default function (pi) { pi.registerCommand("user-command", { handler: async () => {} }); }',
		);
		const { host } = createHost();
		const services = await createAgentSessionServices({
			cwd: directory,
			agentDir: directory,
			orchestrationHost: host,
			resourceLoaderOptions: { noExtensions: true },
		});
		const commandNames = services.resourceLoader
			.getExtensions()
			.extensions.flatMap((extension) => [...extension.commands.keys()]);
		expect(commandNames).toContain("spawn");
		expect(commandNames).not.toContain("user-command");
	});
});
