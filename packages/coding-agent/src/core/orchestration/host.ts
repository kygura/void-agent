import { homedir } from "node:os";
import { join } from "node:path";
import {
	type AuthAdapter,
	type AuthInfo,
	type AuthLoginResult,
	createChildAuthAdapter,
	createSessionStore,
	discoverModels,
	type Event,
	type ExplicitEffort,
	Orchestrator,
	type OrchestratorConfig,
	type OrchestratorEvent,
	type OrchestratorState,
	Persister,
	ProviderModelMRU,
	type RunConfig,
	type RunSnapshot,
	type SessionStore,
	type Subscription,
	type SubscriptionListener,
} from "@void/orchestrator";
import { getAgentDir } from "../../config.js";
import {
	type OrchestratorConfigDiagnostic,
	type OrchestratorResolution,
	type OrchestratorResolutionSuccess,
	type OrchestratorSettingsSource,
	resolveOrchestratorSettings,
} from "../orchestrator-config.js";
import { type ClaudeAgentPreset, discoverClaudeAgentPresets } from "./claude-agent-presets.js";
import { type VoidSpawnState, type VoidSubagentResult, voidSpawnStateKey } from "./messages.js";

export interface ProcessLifetimeOrchestrationHostOptions {
	resolution?: OrchestratorResolution;
	homeDir?: string;
	persistenceDirectory?: string;
	authAdapters?: Readonly<Record<string, AuthAdapter>>;
	discoverProviderModels?: (config: OrchestratorConfig["providers"][string]) => Promise<readonly string[]>;
}

export interface ParentPersistenceBridge {
	readonly childSessionIds: readonly string[];
	readonly states: readonly VoidSpawnState[];
	sendSpawn(childSessionId: string): void;
	appendState(state: VoidSpawnState): void;
}

interface AttachedParentBridge {
	readonly sentSpawnMessages: Set<string>;
	readonly persistedStates: Set<string>;
	readonly sendSpawn: (childSessionId: string) => void;
	readonly appendState: (state: VoidSpawnState) => void;
}

interface ParentSelection {
	provider: string;
	model?: { provider: string; value: string };
	effort?: ExplicitEffort;
}

export interface SpawnRequest {
	parentSessionId: string;
	provider: string;
	prompt: string;
	workdir: string;
	count: number;
	preset?: ClaudeAgentPreset;
}

export interface LoginOutcome {
	provider: string;
	status: AuthInfo;
	login?: AuthLoginResult;
}

/** Owns the single Orchestrator whose lifetime matches the coding-agent application. */
export class ProcessLifetimeOrchestrationHost {
	private resolution?: OrchestratorResolution;
	private readonly selections = new Map<string, ParentSelection>();
	private readonly homeDir: string;
	private readonly configuredAuthAdapters: Readonly<Record<string, AuthAdapter>>;
	private readonly authAdapters = new Map<string, AuthAdapter>();
	private readonly modelMru = new ProviderModelMRU();
	private readonly discoveredModels = new Map<string, readonly string[]>();
	private readonly persistenceDirectory: string;
	private readonly parentBridges = new Map<string, AttachedParentBridge>();
	private readonly spawnStates = new Map<string, VoidSpawnState>();
	private eventSubscription?: Subscription;
	private restorePromise: Promise<readonly string[]> = Promise.resolve([]);
	private readonly discoverProviderModels: (
		config: OrchestratorConfig["providers"][string],
	) => Promise<readonly string[]>;

	public constructor(options: ProcessLifetimeOrchestrationHostOptions = {}) {
		this.resolution = options.resolution;
		this.homeDir = options.homeDir ?? homedir();
		this.persistenceDirectory = options.persistenceDirectory ?? join(getAgentDir(), "orchestrator", "sessions");
		this.configuredAuthAdapters = options.authAdapters ?? {};
		this.discoverProviderModels = options.discoverProviderModels ?? ((config) => discoverModels(config));
		this.startBridge();
	}

	public configure(settings: OrchestratorSettingsSource): readonly OrchestratorConfigDiagnostic[] {
		if (this.resolution === undefined) {
			const resolution = resolveOrchestratorSettings(settings);
			this.resolution = resolution.ok ? this.withPersistence(resolution) : resolution;
			this.startBridge();
		}
		return this.resolution.ok ? [] : this.resolution.diagnostics;
	}

	public async attachParent(parentSessionId: string, bridge: ParentPersistenceBridge): Promise<void> {
		await this.restorePromise;
		const attached: AttachedParentBridge = {
			sentSpawnMessages: new Set(bridge.childSessionIds),
			persistedStates: new Set(bridge.states.map(voidSpawnStateKey)),
			sendSpawn: bridge.sendSpawn,
			appendState: bridge.appendState,
		};
		this.parentBridges.set(parentSessionId, attached);
		const restoredStates = new Map<string, VoidSpawnState>();
		for (const state of bridge.states) restoredStates.set(state.childSessionId, state);
		for (const [childSessionId, state] of restoredStates) {
			if (!this.spawnStates.has(childSessionId)) this.spawnStates.set(childSessionId, cloneSpawnState(state));
		}
		for (const state of this.spawnStates.values()) {
			if (state.parentSessionId === parentSessionId) this.persistBridgeState(state);
		}
	}

	public providerNames(): readonly string[] {
		return Object.keys(this.ready().config.providers).sort();
	}

	public providerConfig(provider: string): OrchestratorConfig["providers"][string] | undefined {
		return this.ready().config.providers[provider];
	}

	public defaultProvider(parentSessionId: string): string {
		return this.selection(parentSessionId).provider;
	}

	public selectProvider(parentSessionId: string, provider: string, workdir: string): void {
		this.requireProvider(provider);
		const selection = this.selection(parentSessionId);
		if (selection.provider === provider) return;
		selection.provider = provider;
		selection.model = undefined;
		selection.effort = undefined;
		this.ensureParentSession(parentSessionId, provider, workdir);
		this.ready().orchestrator.setSessionProvider(parentSessionId, provider);
	}

	public armModel(parentSessionId: string, provider: string, model: string): void {
		this.requireProvider(provider);
		if (model.trim() === "") throw new Error("model is required");
		const knownModels = this.configuredModels(provider);
		if (knownModels.length > 0 && !knownModels.includes(model)) {
			throw new Error(`unknown model ${JSON.stringify(model)} for Provider ${JSON.stringify(provider)}`);
		}
		this.selection(parentSessionId).model = { provider, value: model };
		this.modelMru.remember(provider, model);
	}

	public armedModel(parentSessionId: string, provider: string): string | undefined {
		const armed = this.selection(parentSessionId).model;
		return armed?.provider === provider ? armed.value : undefined;
	}

	public armEffort(parentSessionId: string, effort: ExplicitEffort | undefined): void {
		this.selection(parentSessionId).effort = effort;
	}

	public armedEffort(parentSessionId: string): ExplicitEffort | undefined {
		return this.selection(parentSessionId).effort;
	}

	public configuredModels(provider: string): readonly string[] {
		const configured = this.requireProvider(provider).models ?? [];
		return unique([...this.modelMru.list(provider), ...configured, ...(this.discoveredModels.get(provider) ?? [])]);
	}

	public async availableModels(provider: string): Promise<readonly string[]> {
		const config = this.requireProvider(provider);
		const discovered = await this.discoverProviderModels(config);
		this.discoveredModels.set(provider, discovered);
		return this.configuredModels(provider);
	}

	public presets(workdir: string): readonly ClaudeAgentPreset[] {
		return discoverClaudeAgentPresets(this.homeDir, workdir);
	}

	public spawn(request: SpawnRequest): readonly { sessionId: string; runId: string }[] {
		const config = this.requireProvider(request.provider);
		if (!Number.isInteger(request.count) || request.count < 1 || request.count > 8) {
			throw new Error("count must be an integer from 1 through 8");
		}
		if (request.prompt.trim() === "") throw new Error("prompt is required");
		if (request.preset !== undefined && config.type !== "claude") {
			throw new Error("Claude agent presets require a Claude Provider");
		}
		this.ensureParentSession(request.parentSessionId, this.defaultProvider(request.parentSessionId), request.workdir);
		const selection = this.consumeSelection(request.parentSessionId, request.provider);
		const model = request.preset?.model ?? selection.model;
		const prompt = request.preset?.systemPrompt
			? `${request.preset.systemPrompt}\n\n${request.prompt}`
			: request.prompt;
		const baseName = request.preset?.name ?? request.provider;
		const results: Array<{ sessionId: string; runId: string }> = [];
		for (let index = 1; index <= request.count; index++) {
			const result = this.ready().orchestrator.spawnChildSession(request.parentSessionId, {
				provider: request.provider,
				prompt,
				workdir: request.workdir,
				name: request.count === 1 ? baseName : `${baseName}-${index}`,
				...(model === undefined ? {} : { model }),
				...(selection.effort === undefined ? {} : { effort: selection.effort }),
			});
			results.push(result);
			this.registerChildRun(result.sessionId, result.runId, "pending");
		}
		return results;
	}

	public startTask(parentSessionId: string, provider: string, prompt: string, workdir: string): string {
		this.requireProvider(provider);
		if (prompt.trim() === "") throw new Error("prompt is required");
		const selection = this.consumeSelection(parentSessionId, provider);
		const config: RunConfig = {
			provider,
			prompt,
			workdir,
			...(selection.model === undefined ? {} : { model: selection.model }),
			...(selection.effort === undefined ? {} : { effort: selection.effort }),
		};
		return this.ready().orchestrator.startTaskRun(config, prompt);
	}

	public resume(parentSessionId: string, sessionId: string, prompt: string): string | undefined {
		if (prompt.trim() === "") throw new Error("prompt is required");
		const session = this.ready().orchestrator.session(sessionId);
		if (session === undefined || session.parentSessionId === undefined) {
			throw new Error(`unknown child Session ${JSON.stringify(sessionId)}`);
		}
		const selection = this.consumeSelection(parentSessionId, session.provider);
		if (selection.model !== undefined) this.ready().orchestrator.setSessionModel(sessionId, selection.model);
		if (selection.effort !== undefined) this.ready().orchestrator.setSessionEffort(sessionId, selection.effort);
		const runId = this.ready().orchestrator.resumeSession(sessionId, prompt).runId;
		if (runId !== undefined) this.registerChildRun(sessionId, runId, "pending");
		return runId;
	}

	public cancel(id: string): boolean {
		const orchestrator = this.ready().orchestrator;
		return orchestrator.cancelSession(id) || orchestrator.cancelRun(id);
	}

	public childSessionIds(): readonly string[] {
		return this.ready()
			.orchestrator.sessions()
			.filter((session) => session.parentSessionId !== undefined)
			.map((session) => session.id);
	}

	public cancellableIds(): readonly string[] {
		const state = this.snapshot();
		const live = new Set(["pending", "running"]);
		return unique([
			...state.runs.filter((run) => live.has(run.state)).map((run) => run.id),
			...state.sessions.filter((session) => session.queue.activeRunId !== undefined).map((session) => session.id),
		]);
	}

	public async login(provider: string): Promise<LoginOutcome> {
		this.requireProvider(provider);
		const adapter = this.authAdapter(provider);
		if (adapter === undefined) throw new Error(`Provider ${JSON.stringify(provider)} does not support login`);
		const status = await adapter.status();
		if (status.loggedIn) return { provider, status };
		return { provider, status, login: await adapter.login() };
	}

	public subscribe(listener: SubscriptionListener): Subscription {
		return this.ready().orchestrator.subscribe(listener);
	}

	public snapshot(): OrchestratorState {
		return this.ready().orchestrator.snapshot();
	}

	public runEvents(runId: string): readonly Event[] {
		return this.ready().orchestrator.runEvents(runId);
	}

	public removeQueuedPrompt(sessionId: string): string | undefined {
		return this.ready().orchestrator.removeQueuedPrompt(sessionId);
	}

	public spawnState(childSessionId: string): VoidSpawnState | undefined {
		const state = this.spawnStates.get(childSessionId);
		return state === undefined ? undefined : cloneSpawnState(state);
	}

	public flushPersistence(): Promise<void> {
		return this.ready().orchestrator.flushPersistence();
	}

	public async close(): Promise<void> {
		this.eventSubscription?.unsubscribe();
		this.eventSubscription = undefined;
		await this.restorePromise;
		if (this.resolution?.ok === true) await this.resolution.orchestrator.close();
	}

	private withPersistence(resolution: OrchestratorResolutionSuccess): OrchestratorResolutionSuccess {
		const store = lazySessionStore(createSessionStore(this.persistenceDirectory));
		return {
			...resolution,
			orchestrator: new Orchestrator((name) => resolution.providers[name], {
				defaultProvider: resolution.config.defaultProvider,
				persister: new Persister(store),
			}),
		};
	}

	private startBridge(): void {
		if (this.resolution?.ok !== true || this.eventSubscription !== undefined) return;
		this.eventSubscription = this.resolution.orchestrator.subscribe((event) => this.handleEvent(event));
		this.restorePromise = this.resolution.orchestrator.restorePersistedSessions();
	}

	private registerChildRun(childSessionId: string, runId: string, state: VoidSpawnState["state"]): void {
		const child = this.ready().orchestrator.session(childSessionId);
		const run = this.ready().orchestrator.run(runId);
		if (child?.parentSessionId === undefined || run === undefined) return;
		const spawnState = toSpawnState(child.parentSessionId, childSessionId, run, child.name, state);
		this.spawnStates.set(childSessionId, spawnState);
		this.persistBridgeState(spawnState);
	}

	private handleEvent(event: OrchestratorEvent): void {
		const run = this.ready().orchestrator.run(event.runId);
		if (run?.sessionId === undefined) return;
		const child = this.ready().orchestrator.session(run.sessionId);
		if (child?.parentSessionId === undefined) return;
		const state = toSpawnState(child.parentSessionId, child.id, run, child.name, event.state);
		this.spawnStates.set(child.id, state);
		if (event.lifecycle === true) this.persistBridgeState(state);
	}

	private persistBridgeState(state: VoidSpawnState): void {
		const bridge = this.parentBridges.get(state.parentSessionId);
		if (bridge === undefined) return;
		if (!bridge.sentSpawnMessages.has(state.childSessionId)) {
			bridge.sendSpawn(state.childSessionId);
			bridge.sentSpawnMessages.add(state.childSessionId);
		}
		const key = voidSpawnStateKey(state);
		if (bridge.persistedStates.has(key)) return;
		bridge.appendState(cloneSpawnState(state));
		bridge.persistedStates.add(key);
	}

	private ready(): OrchestratorResolutionSuccess {
		if (this.resolution === undefined) throw new Error("orchestration host has not been configured");
		if (!this.resolution.ok) throw new Error(this.resolution.diagnostics.map((item) => item.message).join("; "));
		return this.resolution;
	}

	private selection(parentSessionId: string): ParentSelection {
		let selection = this.selections.get(parentSessionId);
		if (selection === undefined) {
			selection = { provider: this.ready().config.defaultProvider };
			this.selections.set(parentSessionId, selection);
		}
		return selection;
	}

	private ensureParentSession(parentSessionId: string, provider: string, workdir: string): void {
		const orchestrator = this.ready().orchestrator;
		if (orchestrator.session(parentSessionId) !== undefined) return;
		orchestrator.createSession({ id: parentSessionId, provider, workdir });
	}

	private requireProvider(provider: string): OrchestratorConfig["providers"][string] {
		const config = this.ready().config.providers[provider];
		if (config === undefined) throw new Error(`unknown Provider ${JSON.stringify(provider)}`);
		return config;
	}

	private consumeSelection(
		parentSessionId: string,
		provider: string,
	): {
		model?: string;
		effort?: ExplicitEffort;
	} {
		const selection = this.selection(parentSessionId);
		const model = selection.model?.provider === provider ? selection.model.value : undefined;
		const effort = selection.effort;
		selection.model = undefined;
		selection.effort = undefined;
		return { ...(model === undefined ? {} : { model }), ...(effort === undefined ? {} : { effort }) };
	}

	private authAdapter(provider: string): AuthAdapter | undefined {
		const configured = this.configuredAuthAdapters[provider];
		if (configured !== undefined) return configured;
		const cached = this.authAdapters.get(provider);
		if (cached !== undefined) return cached;
		const config = this.requireProvider(provider);
		if (config.type !== "claude" && config.type !== "codex") return undefined;
		const adapter = createChildAuthAdapter(
			config.type,
			config.command === undefined ? {} : { command: config.command },
		);
		this.authAdapters.set(provider, adapter);
		return adapter;
	}
}

function unique(values: readonly string[]): readonly string[] {
	return [...new Set(values)];
}

function toSpawnState(
	parentSessionId: string,
	childSessionId: string,
	run: RunSnapshot,
	childName: string | undefined,
	state: VoidSpawnState["state"],
): VoidSpawnState {
	const terminal = state === "done" || state === "failed" || state === "cancelled";
	return {
		version: 1,
		parentSessionId,
		childSessionId,
		runId: run.id,
		provider: run.provider,
		...(childName === undefined ? {} : { childName }),
		state,
		...(terminal ? { result: toSubagentResult(childSessionId, childName, run, state) } : {}),
	};
}

function toSubagentResult(
	childSessionId: string,
	childName: string | undefined,
	run: RunSnapshot,
	state: VoidSubagentResult["state"],
): VoidSubagentResult {
	const started = Date.parse(run.startedAt);
	const ended = Date.parse(run.endedAt ?? run.lastActivityAt ?? run.startedAt);
	return {
		kind: "subagentResult",
		childSessionId,
		...(childName === undefined ? {} : { childName }),
		state,
		text: run.finalText ?? "",
		elapsed: Math.max(0, Math.round((ended - started) * 1_000_000)),
	};
}

function cloneSpawnState(state: VoidSpawnState): VoidSpawnState {
	return { ...state, ...(state.result === undefined ? {} : { result: { ...state.result } }) };
}

function lazySessionStore(store: Promise<SessionStore>): SessionStore {
	return {
		list: async () => (await store).list(),
		load: async (sessionId) => (await store).load(sessionId),
		appendMeta: async (meta) => (await store).appendMeta(meta),
		appendPrompt: async (sessionId, runId, prompt) => (await store).appendPrompt(sessionId, runId, prompt),
		appendEvent: async (sessionId, runId, event) => (await store).appendEvent(sessionId, runId, event),
	};
}
