import { randomUUID } from "node:crypto";
import type { Persister } from "./persister.js";
import type {
	Event,
	ExplicitEffort,
	OrchestratorEvent,
	OrchestratorState,
	Provider,
	RunConfig,
	RunSnapshot,
	RunState,
	SessionSnapshot,
	Subscription,
	SubscriptionListener,
	TaskRunSnapshot,
	Timestamp,
} from "./types.js";

const DEFAULT_EVENT_BUFFER_SIZE = 256;
const DEFAULT_CLOSE_TIMEOUT_MS = 4_000;

export type ProviderResolver = (name: string) => Provider | undefined;

export interface OrchestratorOptions {
	defaultProvider?: string;
	eventBufferSize?: number;
	closeTimeoutMs?: number;
	persister?: Persister;
}

export interface SessionConfig {
	id?: string;
	provider: string;
	providerSessionId?: string;
	model?: string;
	effort?: ExplicitEffort;
	workdir?: string;
	name?: string;
	parentSessionId?: string;
	created?: Timestamp;
}

export interface RestoredSessionConfig extends SessionConfig {
	id: string;
}

export interface ChildSessionConfig {
	provider: string;
	prompt: string;
	model?: string;
	effort?: ExplicitEffort;
	workdir?: string;
	name?: string;
}

export interface SpawnChildResult {
	sessionId: string;
	runId: string;
}

export interface SubmitPromptResult {
	runId?: string;
	queued: boolean;
}

interface LiveRun {
	readonly snapshot: RunSnapshot;
	readonly transcript: Event[];
	readonly controller: AbortController;
	readonly text: string[];
	cancelRequested: boolean;
	hadError: boolean;
	sawResult: boolean;
	sawExit: boolean;
}

interface QueuedPrompt {
	readonly prompt: string;
	readonly resumeRequired: boolean;
}

interface LiveSession {
	readonly id: string;
	provider: string;
	providerSessionId?: string;
	model?: string;
	effort?: ExplicitEffort;
	workdir?: string;
	name?: string;
	readonly parentSessionId?: string;
	readonly created: Timestamp;
	readonly runIds: string[];
	readonly queued: QueuedPrompt[];
	activeRunId?: string;
}

interface RunMetadata {
	readonly name?: string;
	readonly sessionId?: string;
}

interface ReservedRun {
	readonly id: string;
	readonly config: RunConfig;
	readonly preflightFailure?: string;
}

interface PendingFanInEvent {
	readonly value: OrchestratorEvent;
	readonly resolve: () => void;
}

/**
 * One bounded, ordered surface shared by every Run and every subscriber.
 * Producers wait once the buffer is full; Events are never discarded.
 */
class OrderedFanIn {
	private readonly listeners = new Set<SubscriptionListener>();
	private readonly queue: OrchestratorEvent[] = [];
	private readonly pending: PendingFanInEvent[] = [];
	private readonly drainWaiters: Array<() => void> = [];
	private dispatchScheduled = false;
	private dispatching = false;

	public constructor(private readonly capacity: number) {}

	public subscribe(listener: SubscriptionListener): Subscription {
		this.listeners.add(listener);
		let subscribed = true;
		return {
			unsubscribe: () => {
				if (!subscribed) return;
				subscribed = false;
				this.listeners.delete(listener);
			},
		};
	}

	/** Returns a Promise only when the producer must wait for buffer space. */
	public enqueue(value: OrchestratorEvent): Promise<void> | undefined {
		if (this.queue.length < this.capacity) {
			this.queue.push(value);
			this.scheduleDispatch();
			return undefined;
		}
		const accepted = new Promise<void>((resolve) => this.pending.push({ value, resolve }));
		this.scheduleDispatch();
		return accepted;
	}

	public drain(): Promise<void> {
		if (!this.dispatching && !this.dispatchScheduled && this.queue.length === 0 && this.pending.length === 0) {
			return Promise.resolve();
		}
		return new Promise<void>((resolve) => this.drainWaiters.push(resolve));
	}

	private scheduleDispatch(): void {
		if (this.dispatchScheduled || this.dispatching) return;
		this.dispatchScheduled = true;
		queueMicrotask(() => this.dispatch());
	}

	private dispatch(): void {
		this.dispatchScheduled = false;
		if (this.dispatching) return;
		this.dispatching = true;
		try {
			while (this.queue.length > 0) {
				const value = this.queue.shift();
				this.acceptPending();
				if (value === undefined) continue;
				for (const listener of [...this.listeners]) {
					try {
						listener(cloneOrchestratorEvent(value));
					} catch {
						// One failed consumer must not interrupt fan-in or another Run.
					}
				}
			}
		} finally {
			this.dispatching = false;
			if (this.queue.length > 0) this.scheduleDispatch();
			else if (this.pending.length === 0) this.resolveDrainWaiters();
		}
	}

	private acceptPending(): void {
		while (this.queue.length < this.capacity) {
			const next = this.pending.shift();
			if (next === undefined) return;
			this.queue.push(next.value);
			next.resolve();
		}
	}

	private resolveDrainWaiters(): void {
		for (const resolve of this.drainWaiters.splice(0)) resolve();
	}
}

/** Concurrent Run registry and ordered Provider Event fan-in. */
export class Orchestrator {
	private readonly runsById = new Map<string, LiveRun>();
	private readonly runOrder: string[] = [];
	private readonly sessionsById = new Map<string, LiveSession>();
	private readonly sessionOrder: string[] = [];
	private readonly tasks = new Map<string, Promise<void>>();
	private readonly persistenceTasks = new Set<Promise<void>>();
	private readonly persistenceWarningMessages: string[] = [];
	private readonly fanIn: OrderedFanIn;
	private readonly closeTimeoutMs: number;
	private readonly defaultProvider: string;
	private readonly persister: Persister | undefined;
	private closing = false;
	private closePromise: Promise<void> | undefined;

	public constructor(
		private readonly resolveProvider: ProviderResolver = () => undefined,
		options: OrchestratorOptions = {},
	) {
		this.defaultProvider = options.defaultProvider ?? "";
		this.fanIn = new OrderedFanIn(positiveInteger(options.eventBufferSize, DEFAULT_EVENT_BUFFER_SIZE));
		this.closeTimeoutMs = positiveInteger(options.closeTimeoutMs, DEFAULT_CLOSE_TIMEOUT_MS);
		this.persister = options.persister;
	}

	public subscribe(listener: SubscriptionListener): Subscription {
		return this.fanIn.subscribe(listener);
	}

	/** Atomically reserves a Run ID and starts its Provider outside registry mutation. */
	public startRun(config: RunConfig): string {
		return this.startTaskRun(config);
	}

	/** Starts process-lifetime work that is deliberately not attached to a Session. */
	public startTaskRun(config: RunConfig, name?: string): string {
		if (this.closing) throw new Error("Orchestrator is closing");
		if (hasProviderSessionId(config)) throw new Error("TaskRuns cannot resume a Provider Session");
		const id = this.reserveRun(config, name === undefined ? {} : { name });
		this.startReservedRun({ id, config });
		return id;
	}

	/** Creates a persisted-shaped Session. A caller may supply a stable top-level ID. */
	public createSession(config: SessionConfig): string {
		if (this.closing) throw new Error("Orchestrator is closing");
		const id = config.id ?? this.newSessionId();
		if (id.trim() === "") throw new Error("Session ID must not be empty");
		if (config.provider.trim() === "") throw new Error("Session Provider must not be empty");
		if (this.sessionsById.has(id)) throw new Error(`Session ${JSON.stringify(id)} already exists`);
		if (config.parentSessionId !== undefined && !this.sessionsById.has(config.parentSessionId)) {
			throw new Error(`Unknown parent Session ${JSON.stringify(config.parentSessionId)}`);
		}
		this.registerSession(config, id);
		const session = this.session(id);
		if (session !== undefined && this.persister !== undefined) {
			void this.trackPersistence(id, "pending", () => this.persister?.persistSession(session));
		}
		return id;
	}

	/** Registers persisted Session metadata without replaying historical Runs. */
	public restoreSession(config: RestoredSessionConfig): boolean {
		if (config.id.trim() === "") throw new Error("Session ID must not be empty");
		if (config.provider.trim() === "") throw new Error("Session Provider must not be empty");
		if (this.sessionsById.has(config.id)) return false;
		this.registerSession(config, config.id);
		return true;
	}

	/** Loads every valid persisted Session through the V008 registration path. */
	public async restorePersistedSessions(): Promise<readonly string[]> {
		if (this.persister === undefined) return [];
		const restored = await this.persister.restore();
		const warnings = [...restored.warnings];
		for (const stored of restored.sessions) {
			if (stored.meta.provider === "") {
				warnings.push(`persister: session ${stored.meta.id}: missing Provider metadata`);
				continue;
			}
			this.restoreSession({
				id: stored.meta.id,
				provider: stored.meta.provider,
				...(stored.meta.providerSessionId === undefined
					? {}
					: { providerSessionId: stored.meta.providerSessionId }),
				...(stored.meta.name === undefined ? {} : { name: stored.meta.name }),
				...(stored.meta.parentSessionId === undefined ? {} : { parentSessionId: stored.meta.parentSessionId }),
				created: stored.meta.created,
			});
		}
		this.persistenceWarningMessages.push(...warnings);
		return warnings;
	}

	/** Creates a full child Session and reserves its first Run before returning. */
	public spawnChildSession(parentSessionId: string, config: ChildSessionConfig): SpawnChildResult {
		if (this.closing) throw new Error("Orchestrator is closing");
		if (!this.sessionsById.has(parentSessionId)) {
			throw new Error(`Unknown parent Session ${JSON.stringify(parentSessionId)}`);
		}
		const sessionId = this.createSession({
			provider: config.provider,
			...(config.model === undefined ? {} : { model: config.model }),
			...(config.effort === undefined ? {} : { effort: config.effort }),
			...(config.workdir === undefined ? {} : { workdir: config.workdir }),
			...(config.name === undefined ? {} : { name: config.name }),
			parentSessionId,
		});
		const session = this.sessionsById.get(sessionId);
		if (session === undefined) throw new Error(`Unknown Session ${JSON.stringify(sessionId)}`);
		const reserved = this.reserveSessionRun(session, config.prompt, false);
		this.startReservedRun(reserved);
		return { sessionId, runId: reserved.id };
	}

	/** Starts now, or appends to the Session's FIFO while its one Run is live. */
	public submitPrompt(sessionId: string, prompt: string): SubmitPromptResult {
		return this.submitSessionPrompt(sessionId, prompt, false);
	}

	/** Explicitly continues a Provider conversation and fails as data when it cannot be resumed. */
	public resumeSession(sessionId: string, prompt: string): SubmitPromptResult {
		return this.submitSessionPrompt(sessionId, prompt, true);
	}

	/** Removes the newest queued prompt, matching the composer backspace behavior. */
	public removeQueuedPrompt(sessionId: string): string | undefined {
		const session = this.sessionsById.get(sessionId);
		const removed = session?.queued.pop();
		return removed?.prompt;
	}

	public setSessionProvider(sessionId: string, provider: string): void {
		if (provider.trim() === "") throw new Error("Session Provider must not be empty");
		const session = this.requireSession(sessionId);
		if (session.provider === provider) return;
		session.provider = provider;
		session.providerSessionId = undefined;
		session.model = undefined;
		session.effort = undefined;
		this.persistSessionUpdate(sessionId);
	}

	public setSessionModel(sessionId: string, model: string | undefined): void {
		this.requireSession(sessionId).model = model === "" ? undefined : model;
	}

	public setSessionEffort(sessionId: string, effort: ExplicitEffort | undefined): void {
		this.requireSession(sessionId).effort = effort;
	}

	public setSessionName(sessionId: string, name: string | undefined): void {
		this.requireSession(sessionId).name = name === "" ? undefined : name;
		this.persistSessionUpdate(sessionId);
	}

	public cancelSession(sessionId: string): boolean {
		const activeRunId = this.sessionsById.get(sessionId)?.activeRunId;
		return activeRunId === undefined ? false : this.cancelRun(activeRunId);
	}

	/** Requests cancellation of one live Run without touching any other Run. */
	public cancelRun(runId: string): boolean {
		const run = this.runsById.get(runId);
		if (run === undefined || isTerminal(run.snapshot.state)) return false;
		run.cancelRequested = true;
		run.controller.abort();
		return true;
	}

	public run(runId: string): RunSnapshot | undefined {
		const run = this.runsById.get(runId);
		return run === undefined ? undefined : cloneRun(run.snapshot);
	}

	public runs(): readonly RunSnapshot[] {
		return this.runOrder.flatMap((id) => {
			const run = this.runsById.get(id);
			return run === undefined ? [] : [cloneRun(run.snapshot)];
		});
	}

	public session(sessionId: string): SessionSnapshot | undefined {
		const session = this.sessionsById.get(sessionId);
		return session === undefined ? undefined : cloneSession(session);
	}

	public sessions(): readonly SessionSnapshot[] {
		return this.sessionOrder.flatMap((id) => {
			const session = this.sessionsById.get(id);
			return session === undefined ? [] : [cloneSession(session)];
		});
	}

	public runEvents(runId: string): readonly Event[] {
		return this.runsById.get(runId)?.transcript.map(cloneEvent) ?? [];
	}

	public snapshot(): OrchestratorState {
		const runs = this.runs();
		const taskRuns: TaskRunSnapshot[] = runs.flatMap((run) =>
			run.sessionId === undefined ? [cloneRun(run) as TaskRunSnapshot] : [],
		);
		return {
			runs,
			sessions: this.sessions(),
			taskRuns,
			defaultProvider: this.defaultProvider,
			closing: this.closing,
		};
	}

	public persistenceWarnings(): readonly string[] {
		return [...this.persistenceWarningMessages];
	}

	/** Waits until all lifecycle-triggered writes and warnings are observable. */
	public async flushPersistence(): Promise<void> {
		if (this.persister !== undefined) await this.persister.flush();
		while (this.persistenceTasks.size > 0) await Promise.allSettled([...this.persistenceTasks]);
		await this.fanIn.drain();
	}

	/** Cancels every live Run and waits for teardown, bounded by closeTimeoutMs. */
	public close(): Promise<void> {
		if (this.closePromise !== undefined) return this.closePromise;
		this.closing = true;
		for (const run of this.runsById.values()) {
			if (isTerminal(run.snapshot.state)) continue;
			run.cancelRequested = true;
			run.controller.abort();
		}
		const tasks = [...this.tasks.values()];
		this.closePromise = this.finishClose(tasks);
		return this.closePromise;
	}

	private registerSession(config: SessionConfig, id: string): void {
		this.sessionsById.set(id, {
			id,
			provider: config.provider,
			...(config.providerSessionId === undefined || config.providerSessionId === ""
				? {}
				: { providerSessionId: config.providerSessionId }),
			...(config.model === undefined || config.model === "" ? {} : { model: config.model }),
			...(config.effort === undefined ? {} : { effort: config.effort }),
			...(config.workdir === undefined || config.workdir === "" ? {} : { workdir: config.workdir }),
			...(config.name === undefined || config.name === "" ? {} : { name: config.name }),
			...(config.parentSessionId === undefined || config.parentSessionId === ""
				? {}
				: { parentSessionId: config.parentSessionId }),
			created: config.created ?? timestamp(),
			runIds: [],
			queued: [],
		});
		this.sessionOrder.push(id);
	}

	private submitSessionPrompt(sessionId: string, prompt: string, resumeRequired: boolean): SubmitPromptResult {
		if (this.closing) throw new Error("Orchestrator is closing");
		const session = this.requireSession(sessionId);
		if (session.activeRunId !== undefined) {
			session.queued.push({ prompt, resumeRequired });
			return { queued: true };
		}
		const reserved = this.reserveSessionRun(session, prompt, resumeRequired);
		this.startReservedRun(reserved);
		return { runId: reserved.id, queued: false };
	}

	private reserveSessionRun(session: LiveSession, prompt: string, resumeRequired: boolean): ReservedRun {
		const providerSessionId = session.providerSessionId;
		const config: RunConfig = {
			provider: session.provider,
			prompt,
			...(session.workdir === undefined ? {} : { workdir: session.workdir }),
			...(session.model === undefined ? {} : { model: session.model }),
			...(session.effort === undefined ? {} : { effort: session.effort }),
			...(providerSessionId === undefined ? {} : { providerSessionId }),
		};
		const id = this.reserveRun(config, { sessionId: session.id });
		session.activeRunId = id;
		return {
			id,
			config,
			...(resumeRequired && providerSessionId === undefined
				? { preflightFailure: `Session ${JSON.stringify(session.id)} has no Provider session ID to resume` }
				: {}),
		};
	}

	private reserveRun(config: RunConfig, metadata: RunMetadata = {}): string {
		let id = randomUUID();
		while (this.runsById.has(id)) id = randomUUID();
		const startedAt = timestamp();
		this.runsById.set(id, {
			snapshot: {
				id,
				...(metadata.name === undefined ? {} : { name: metadata.name }),
				provider: config.provider,
				...(metadata.sessionId === undefined ? {} : { sessionId: metadata.sessionId }),
				...(config.providerSessionId === undefined || config.providerSessionId === ""
					? {}
					: { providerSessionId: config.providerSessionId }),
				state: "pending",
				startedAt,
				lastActivityAt: startedAt,
				prompt: config.prompt,
				...(config.model === undefined ? {} : { model: config.model }),
				...(config.effort === undefined || config.effort === "" ? {} : { effort: config.effort }),
			},
			transcript: [],
			controller: new AbortController(),
			text: [],
			cancelRequested: false,
			hadError: false,
			sawResult: false,
			sawExit: false,
		});
		this.runOrder.push(id);
		if (metadata.sessionId !== undefined) this.sessionsById.get(metadata.sessionId)?.runIds.push(id);
		return id;
	}

	private startReservedRun(reserved: ReservedRun): void {
		const task = this.consumeRun(reserved.id, reserved.config, reserved.preflightFailure);
		this.tasks.set(reserved.id, task);
		void task.then(
			() => this.tasks.delete(reserved.id),
			() => this.tasks.delete(reserved.id),
		);
	}

	private async consumeRun(runId: string, config: RunConfig, preflightFailure?: string): Promise<void> {
		const run = this.runsById.get(runId);
		if (run === undefined) return;
		let launchFailure = false;
		let failure = preflightFailure;
		let terminalState: RunState | undefined;
		const sessionId = run.snapshot.sessionId;
		const session = sessionId === undefined ? undefined : this.session(sessionId);
		if (session !== undefined && this.persister !== undefined) {
			await this.trackPersistence(runId, "pending", () =>
				this.persister?.persistRunStart(session, cloneRun(run.snapshot)),
			);
		}

		try {
			const provider = failure === undefined ? this.resolveProvider(config.provider) : undefined;
			if (run.cancelRequested) {
				launchFailure = true;
			} else if (failure !== undefined) {
				launchFailure = true;
			} else if (provider === undefined) {
				launchFailure = true;
				failure = `Unknown Provider ${JSON.stringify(config.provider)}`;
			} else if (hasProviderSessionId(config) && provider.resumable !== true) {
				launchFailure = true;
				failure = `Provider ${JSON.stringify(config.provider)} does not support resume`;
			} else {
				let events: AsyncIterable<Event> | undefined;
				try {
					events = provider.start(config, run.controller.signal);
				} catch (error) {
					launchFailure = true;
					failure = errorMessage(error);
				}
				if (events !== undefined) {
					run.snapshot.state = "running";
					run.snapshot.lastActivityAt = timestamp();
					await this.publish({ runId, state: "running", lifecycle: true });
					try {
						for await (const event of events) {
							if (!this.acceptProviderEvent(run, event)) continue;
							if (event.kind === "exit") {
								terminalState = run.cancelRequested
									? "cancelled"
									: run.hadError || (event.exitCode ?? 0) !== 0
										? "failed"
										: "done";
							}
							await this.recordAndPublish(runId, run, event, "running");
							if (event.kind === "exit") break;
						}
					} catch (error) {
						failure = errorMessage(error);
					}
				}
			}
		} catch (error) {
			launchFailure = run.snapshot.state === "pending";
			failure = errorMessage(error);
		}

		if (failure !== undefined) run.hadError = true;
		terminalState ??= run.cancelRequested ? "cancelled" : run.hadError ? "failed" : "done";
		const eventState = launchFailure ? terminalState : run.snapshot.state;
		await this.ensureTerminalEvents(runId, run, eventState, failure);
		const next = this.finishRun(runId, run, terminalState);
		await this.persistSubagentResult(runId, run, terminalState);
		const terminalPublish = this.publish({ runId, state: terminalState, lifecycle: true });
		if (next !== undefined) this.startReservedRun(next);
		await terminalPublish;
	}

	private acceptProviderEvent(run: LiveRun, event: Event): boolean {
		if (event.kind === "result") {
			if (run.sawResult) return false;
			run.sawResult = true;
		}
		if (event.kind === "exit") {
			if (run.sawExit) return false;
			run.sawExit = true;
		}
		return true;
	}

	private finishRun(runId: string, run: LiveRun, terminalState: RunState): ReservedRun | undefined {
		run.snapshot.state = terminalState;
		run.snapshot.endedAt = timestamp();
		run.snapshot.lastActivityAt = run.snapshot.endedAt;
		const sessionId = run.snapshot.sessionId;
		if (sessionId === undefined) return undefined;
		const session = this.sessionsById.get(sessionId);
		if (session === undefined || session.activeRunId !== runId) return undefined;
		session.activeRunId = undefined;
		if (this.closing) return undefined;
		const next = session.queued.shift();
		return next === undefined ? undefined : this.reserveSessionRun(session, next.prompt, next.resumeRequired);
	}

	private async ensureTerminalEvents(
		runId: string,
		run: LiveRun,
		state: RunState,
		failure: string | undefined,
	): Promise<void> {
		const cancelled = run.cancelRequested;
		if (!run.sawResult) {
			run.sawResult = true;
			const isError = cancelled || failure !== undefined;
			const text = cancelled ? "Run cancelled" : (failure ?? run.text.join(""));
			const result: Event = { kind: "result", text, ...(isError ? { isError: true } : {}) };
			await this.recordAndPublish(runId, run, result, state);
		}
		if (!run.sawExit) {
			run.sawExit = true;
			const exitCode = cancelled ? 130 : failure === undefined ? 0 : 1;
			await this.recordAndPublish(runId, run, { kind: "exit", exitCode }, state);
		}
	}

	private async recordAndPublish(runId: string, run: LiveRun, event: Event, state: RunState): Promise<void> {
		const recorded = cloneEvent(event);
		run.transcript.push(recorded);
		run.snapshot.lastActivityAt = timestamp();
		if (
			recorded.kind === "started" &&
			recorded.providerSessionId !== undefined &&
			recorded.providerSessionId !== ""
		) {
			run.snapshot.providerSessionId = recorded.providerSessionId;
			const sessionId = run.snapshot.sessionId;
			const session = sessionId === undefined ? undefined : this.sessionsById.get(sessionId);
			if (session !== undefined && session.provider === run.snapshot.provider) {
				session.providerSessionId = recorded.providerSessionId;
			}
		}
		if (recorded.kind === "text" && recorded.text !== undefined) run.text.push(recorded.text);
		if (recorded.kind === "result") {
			run.snapshot.finalText = recorded.text ?? "";
			run.snapshot.usage = recorded.usage === undefined ? undefined : { ...recorded.usage };
			if (recorded.isError === true) run.hadError = true;
		}
		if (recorded.kind === "exit" && (recorded.exitCode ?? 0) !== 0) run.hadError = true;
		const sessionId = run.snapshot.sessionId;
		const session = sessionId === undefined ? undefined : this.session(sessionId);
		if (session !== undefined && this.persister !== undefined) {
			await this.trackPersistence(runId, state, () =>
				this.persister?.persistEvent(session, cloneRun(run.snapshot), recorded),
			);
		}
		await this.publish({ runId, event: recorded, state });
	}

	private async publish(event: OrchestratorEvent): Promise<void> {
		const backpressure = this.fanIn.enqueue(event);
		if (backpressure !== undefined) await backpressure;
	}

	private async finishClose(tasks: readonly Promise<void>[]): Promise<void> {
		const completed = Promise.allSettled(tasks).then(async () => {
			await this.flushPersistence();
		});
		await boundedWait(completed, this.closeTimeoutMs);
	}

	private persistSessionUpdate(sessionId: string): void {
		const session = this.session(sessionId);
		if (session === undefined || this.persister === undefined) return;
		const runId = session.queue.activeRunId ?? sessionId;
		const state = session.queue.activeRunId === undefined ? "pending" : (this.run(runId)?.state ?? "pending");
		void this.trackPersistence(runId, state, () => this.persister?.persistSessionUpdate(session));
	}

	private async persistSubagentResult(runId: string, run: LiveRun, state: RunState): Promise<void> {
		if (this.persister === undefined) return;
		const childSessionId = run.snapshot.sessionId;
		if (childSessionId === undefined) return;
		const child = this.session(childSessionId);
		const parent = child?.parentSessionId === undefined ? undefined : this.session(child.parentSessionId);
		if (child === undefined || parent === undefined) return;
		const started = Date.parse(run.snapshot.startedAt);
		const ended = Date.parse(run.snapshot.endedAt ?? run.snapshot.lastActivityAt ?? run.snapshot.startedAt);
		const elapsed = Math.max(0, Math.round((ended - started) * 1_000_000));
		const event: Event = {
			kind: "subagentResult",
			childSessionId,
			...(child.name === undefined ? {} : { childName: child.name }),
			state,
			text: run.snapshot.finalText ?? run.text.join(""),
			...(elapsed === 0 ? {} : { elapsed }),
		};
		await this.trackPersistence(runId, state, () => this.persister?.persistSubagentResult(parent, runId, event));
	}

	private trackPersistence(
		runId: string,
		state: RunState,
		operation: () => Promise<string | undefined> | undefined,
	): Promise<void> {
		const task = (async (): Promise<void> => {
			let warning: string | undefined;
			try {
				warning = await operation();
			} catch (error) {
				warning = `session persistence is failing (${errorMessage(error)}) — this session may not survive a restart`;
			}
			if (warning === undefined) return;
			this.persistenceWarningMessages.push(warning);
			await this.publish({ runId, state, warning });
		})();
		this.persistenceTasks.add(task);
		void task.finally(() => this.persistenceTasks.delete(task));
		return task;
	}

	private requireSession(sessionId: string): LiveSession {
		const session = this.sessionsById.get(sessionId);
		if (session === undefined) throw new Error(`Unknown Session ${JSON.stringify(sessionId)}`);
		return session;
	}

	private newSessionId(): string {
		let id = randomUUID();
		while (this.sessionsById.has(id)) id = randomUUID();
		return id;
	}
}

function cloneRun(run: RunSnapshot): RunSnapshot {
	return {
		...run,
		...(run.usage === undefined ? {} : { usage: { ...run.usage } }),
	};
}

function cloneSession(session: LiveSession): SessionSnapshot {
	return {
		id: session.id,
		provider: session.provider,
		...(session.providerSessionId === undefined ? {} : { providerSessionId: session.providerSessionId }),
		...(session.model === undefined ? {} : { model: session.model }),
		...(session.effort === undefined ? {} : { effort: session.effort }),
		...(session.workdir === undefined ? {} : { workdir: session.workdir }),
		...(session.name === undefined ? {} : { name: session.name }),
		...(session.parentSessionId === undefined ? {} : { parentSessionId: session.parentSessionId }),
		created: session.created,
		runIds: [...session.runIds],
		queue: {
			prompts: session.queued.map((entry) => entry.prompt),
			...(session.activeRunId === undefined ? {} : { activeRunId: session.activeRunId }),
		},
	};
}

function cloneEvent(event: Event): Event {
	return {
		...event,
		...(event.usage === undefined ? {} : { usage: { ...event.usage } }),
	};
}

function cloneOrchestratorEvent(event: OrchestratorEvent): OrchestratorEvent {
	return {
		...event,
		...(event.event === undefined ? {} : { event: cloneEvent(event.event) }),
	};
}

function isTerminal(state: RunState): boolean {
	return state === "done" || state === "failed" || state === "cancelled";
}

function hasProviderSessionId(config: RunConfig): boolean {
	return config.providerSessionId !== undefined && config.providerSessionId !== "";
}

function positiveInteger(value: number | undefined, fallback: number): number {
	return value === undefined || !Number.isInteger(value) || value <= 0 ? fallback : value;
}

function timestamp(): string {
	return new Date().toISOString();
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function boundedWait(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, timeoutMs);
		void promise.then(
			() => {
				clearTimeout(timer);
				resolve();
			},
			() => {
				clearTimeout(timer);
				resolve();
			},
		);
	});
}
