/**
 * Compatibility facade for the committed harness API. Run lifecycle, fan-in,
 * queueing, cancellation, and Provider execution are owned by
 * @void/orchestrator; the local facade retains the timestamped event and store
 * shapes consumed by the existing subagent/sidebar customization.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
	type Event,
	Orchestrator,
	type OrchestratorEvent,
	type Provider,
	type RunConfig,
	type RunSnapshot,
	type SessionSnapshot,
} from "@void/orchestrator";
import { createEventBus } from "../event-bus.js";
import {
	fromOrchestratorEvent,
	fromOrchestratorRunConfig,
	type Harness,
	type HarnessEvent,
	type HarnessRunConfig,
	toOrchestratorEvent,
	toOrchestratorRunConfig,
} from "./types.js";

export type HarnessRunState = "pending" | "running" | "done" | "failed" | "cancelled";

/** A snapshot of one run's record. */
export interface HarnessRun {
	id: string;
	harnessId: string;
	/** Associates this run with a session ("" / undefined for a fire-and-forget run). */
	sessionId?: string;
	/** The harness's own conversation id, once known. */
	providerSessionId?: string;
	state: HarnessRunState;
	startTime: string;
	/** Absent until the run reaches a terminal state. */
	endTime?: string;
	prompt: string;
	config: HarnessRunConfig;
	events: HarnessEvent[];
}

/** An ordered chain of runs sharing the harness's native conversation, plus a FIFO prompt queue. */
export interface HarnessSession {
	id: string;
	harnessId: string;
	providerSessionId?: string;
	runIds: string[];
	/** Prompts submitted while a run was live, dequeued automatically when it finishes. */
	queued: string[];
}

/** What a subscriber receives: one harness event, tagged with its run and (if any) session. */
export interface HarnessRunEvent {
	runId: string;
	sessionId?: string;
	event: HarnessEvent;
}

export type HarnessEventListener = (e: HarnessRunEvent) => void;

/** Result of a call to submitPrompt: either a new run was launched, or the prompt was queued. */
export interface SubmitPromptResult {
	runId?: string;
	queued: boolean;
}

// =============================================================================
// Persistence
// =============================================================================

interface StoreMetaRecord {
	type: "meta";
	sessionId: string;
	harnessId: string;
	providerSessionId?: string;
	name?: string;
	createdAt: string;
}

interface StorePromptRecord {
	type: "prompt";
	runId: string;
	prompt: string;
}

interface StoreEventRecord {
	type: "event";
	runId: string;
	event: HarnessEvent;
}

type StoreRecord = StoreMetaRecord | StorePromptRecord | StoreEventRecord;

/** A fully loaded session: its latest metadata, every run's prompt, and every event in append order. */
export interface LoadedHarnessSession {
	meta: StoreMetaRecord;
	prompts: Map<string, string>;
	events: Array<{ runId: string; event: HarnessEvent }>;
}

/**
 * Persists harness sessions as one append-only JSONL file per session under
 * `dir`: a meta header, prompt lines, and event lines. Appending is the
 * whole persistence strategy (fs.appendFileSync reopens with O_APPEND
 * semantics per write, so there is no file handle to manage and a crash
 * mid-write only affects its own half-written trailing line). Metadata
 * changes (e.g. a newly learned providerSessionId) are recorded by
 * appending a fresh header line; on load, the last header wins.
 */
export class HarnessSessionStore {
	constructor(private readonly dir: string) {
		mkdirSync(dir, { recursive: true });
	}

	private path(sessionId: string): string {
		return join(this.dir, `${sessionId}.jsonl`);
	}

	private append(sessionId: string, record: StoreRecord): void {
		appendFileSync(this.path(sessionId), `${JSON.stringify(record)}\n`);
	}

	appendMeta(meta: Omit<StoreMetaRecord, "type">): void {
		this.append(meta.sessionId, { type: "meta", ...meta });
	}

	appendPrompt(sessionId: string, runId: string, prompt: string): void {
		this.append(sessionId, { type: "prompt", runId, prompt });
	}

	appendEvent(sessionId: string, runId: string, event: HarnessEvent): void {
		this.append(sessionId, { type: "event", runId, event });
	}

	/** Returns the ids of every persisted session. */
	list(): string[] {
		if (!existsSync(this.dir)) return [];
		return readdirSync(this.dir)
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => f.slice(0, -".jsonl".length));
	}

	/**
	 * Loads one session. The last meta line wins; events are returned in
	 * append order. A corrupt or truncated trailing line (e.g. from a crash
	 * mid-write) is silently skipped. Returns undefined if the session has no
	 * meta record (missing file, or empty/fully-corrupt file).
	 */
	load(sessionId: string): LoadedHarnessSession | undefined {
		const filePath = this.path(sessionId);
		if (!existsSync(filePath)) return undefined;

		let meta: StoreMetaRecord | undefined;
		const prompts = new Map<string, string>();
		const events: Array<{ runId: string; event: HarnessEvent }> = [];

		for (const rawLine of readFileSync(filePath, "utf8").split("\n")) {
			const trimmed = rawLine.trim();
			if (!trimmed) continue;
			let record: StoreRecord;
			try {
				record = JSON.parse(trimmed);
			} catch {
				continue; // corrupt/truncated trailing line: tolerated, skipped
			}
			switch (record.type) {
				case "meta":
					meta = record;
					break;
				case "prompt":
					prompts.set(record.runId, record.prompt);
					break;
				case "event":
					events.push({ runId: record.runId, event: record.event });
					break;
			}
		}

		if (!meta) return undefined;
		return { meta, prompts, events };
	}

	/** Hard-deletes a session's file. Idempotent: deleting an already-missing session is not an error. */
	delete(sessionId: string): void {
		const filePath = this.path(sessionId);
		if (existsSync(filePath)) rmSync(filePath);
	}
}

// =============================================================================
// Run manager
// =============================================================================

const HARNESS_EVENT_CHANNEL = "harness-event";

/**
 * Preserves the local harness manager API while delegating all concurrency and
 * execution semantics to one Orchestrator instance.
 */
export class HarnessRunManager {
	private readonly harnesses = new Map<string, Harness>();
	private readonly providers = new Map<string, Provider>();
	private readonly orchestrator: Orchestrator;
	private readonly runConfigs = new Map<string, HarnessRunConfig>();
	private readonly eventsByRun = new Map<string, HarnessEvent[]>();
	private readonly persistedPrompts = new Set<string>();
	private readonly bus = createEventBus();
	private readonly store: HarnessSessionStore;
	private closing = false;

	constructor(storeDir: string) {
		this.store = new HarnessSessionStore(storeDir);
		this.orchestrator = new Orchestrator((name) => this.providers.get(name));
		this.orchestrator.subscribe((event) => this.onOrchestratorEvent(event));
	}

	registerHarness(harness: Harness): void {
		this.harnesses.set(harness.id, harness);
		this.providers.set(harness.id, providerFromHarness(harness));
	}

	/** Returns a previously registered harness by id (e.g. "void", for its in-process prepareSpawn seam), or undefined. */
	getHarness(id: string): Harness | undefined {
		return this.harnesses.get(id);
	}

	/** Subscribes to every event across every run. Returns an unsubscribe function. */
	subscribe(listener: HarnessEventListener): () => void {
		return this.bus.on(HARNESS_EVENT_CHANNEL, (data) => listener(data as HarnessRunEvent));
	}

	/**
	 * Creates an empty session bound to harnessId and returns its id. `workdir`
	 * is carried onto the session so every run it launches inherits the right
	 * cwd (submitPrompt rebuilds run config from session fields, so a cwd not
	 * stored here is lost). `providerSessionId`, when supplied, pre-binds the
	 * session to an already-existing provider conversation so its very first run
	 * resumes that conversation instead of starting a fresh one - used by the
	 * subagent tool to point a session at a void child it spawned eagerly.
	 */
	newSession(harnessId: string, opts?: { workdir?: string; providerSessionId?: string }): string {
		if (!this.harnesses.has(harnessId)) {
			throw new Error(`harness: unknown harness "${harnessId}"`);
		}
		const id = this.orchestrator.createSession({
			provider: harnessId,
			...(opts?.workdir === undefined ? {} : { workdir: opts.workdir }),
			...(opts?.providerSessionId === undefined ? {} : { providerSessionId: opts.providerSessionId }),
		});
		const session = this.orchestrator.session(id);
		this.store.appendMeta({
			sessionId: id,
			harnessId,
			...(opts?.providerSessionId === undefined ? {} : { providerSessionId: opts.providerSessionId }),
			createdAt: session?.created ?? new Date().toISOString(),
		});
		return id;
	}

	/**
	 * Launches harnessId with cfg and begins consuming its stream. Returns
	 * the new run id immediately (fire-and-forget); the orchestrator publishes
	 * the pending -> running transition through the compatibility event bridge,
	 * followed by done/failed/cancelled once the stream ends.
	 *
	 * sessionId, when set, associates the run with a session: its prompt is
	 * persisted, and a providerSessionId already known for the session is
	 * carried into cfg so a resumable harness continues the conversation.
	 */
	startRun(harnessId: string, cfg: HarnessRunConfig, sessionId?: string): string {
		if (this.closing) throw new Error("harness: run manager is shutting down");
		if (!this.harnesses.has(harnessId)) throw new Error(`harness: unknown harness "${harnessId}"`);

		const runConfig = toOrchestratorRunConfig(harnessId, cfg);
		let runId: string;
		if (sessionId === undefined) {
			runId = this.orchestrator.startTaskRun(runConfig);
		} else {
			const session = this.orchestrator.session(sessionId);
			if (session === undefined) throw new Error(`harness: unknown session "${sessionId}"`);
			if (session.provider !== harnessId) {
				throw new Error(`harness: session "${sessionId}" uses harness "${session.provider}"`);
			}
			if (runConfig.model !== undefined && runConfig.model !== "") {
				this.orchestrator.setSessionModel(sessionId, runConfig.model);
			}
			if (runConfig.effort !== undefined && runConfig.effort !== "") {
				this.orchestrator.setSessionEffort(sessionId, runConfig.effort);
			}
			const result = this.orchestrator.submitPrompt(sessionId, cfg.prompt);
			if (result.runId === undefined) throw new Error(`harness: session "${sessionId}" already has a live run`);
			runId = result.runId;
			this.persistPrompt(sessionId, runId, cfg.prompt);
		}
		this.runConfigs.set(runId, cfg);
		return runId;
	}

	/** Cancels a live run via its AbortController. A no-op if the run is already terminal. */
	cancel(runId: string): void {
		if (this.orchestrator.run(runId) === undefined) throw new Error(`harness: unknown run "${runId}"`);
		this.orchestrator.cancelRun(runId);
	}

	/**
	 * Advances a session by one turn. If the session already has a live run,
	 * prompt is appended to its FIFO queue (queued: true) and dequeues
	 * automatically when the live run finishes. Otherwise a run starts now,
	 * resuming the harness conversation when a providerSessionId is known.
	 */
	submitPrompt(sessionId: string, prompt: string): SubmitPromptResult {
		if (this.closing) throw new Error("harness: run manager is shutting down");
		if (this.orchestrator.session(sessionId) === undefined) {
			throw new Error(`harness: unknown session "${sessionId}"`);
		}
		const result = this.orchestrator.submitPrompt(sessionId, prompt);
		if (result.runId !== undefined) {
			this.runConfigs.set(result.runId, { prompt });
			this.persistPrompt(sessionId, result.runId, prompt);
		}
		return { ...(result.runId === undefined ? {} : { runId: result.runId }), queued: result.queued };
	}

	/** Snapshots of all runs in creation order. */
	runs(): HarnessRun[] {
		return this.orchestrator.runs().map((run) => this.toHarnessRun(run));
	}

	run(id: string): HarnessRun | undefined {
		const run = this.orchestrator.run(id);
		return run === undefined ? undefined : this.toHarnessRun(run);
	}

	runEvents(id: string): HarnessEvent[] {
		return [...(this.eventsByRun.get(id) ?? [])];
	}

	/** Snapshots of all sessions in creation order. */
	sessions(): HarnessSession[] {
		return this.orchestrator.sessions().map(toHarnessSession);
	}

	session(id: string): HarnessSession | undefined {
		const session = this.orchestrator.session(id);
		return session === undefined ? undefined : toHarnessSession(session);
	}

	/** Underlying JSONL store, exposed for callers that want to list/load/delete persisted sessions directly. */
	get sessionStore(): HarnessSessionStore {
		return this.store;
	}

	/**
	 * Marks the manager as shutting down: no new run/prompt is accepted after
	 * this call. Live runs are cancelled through the orchestrator's bounded
	 * shutdown path.
	 */
	close(): void {
		this.closing = true;
		void this.orchestrator.close();
	}

	private onOrchestratorEvent(update: OrchestratorEvent): void {
		if (update.event === undefined) return;
		const event = fromOrchestratorEvent(update.event);
		if (event === undefined) return;
		const run = this.orchestrator.run(update.runId);
		if (run === undefined) return;
		const events = this.eventsByRun.get(update.runId) ?? [];
		events.push(event);
		this.eventsByRun.set(update.runId, events);
		if (run.sessionId !== undefined) {
			this.persistPrompt(run.sessionId, run.id, run.prompt);
			this.store.appendEvent(run.sessionId, run.id, event);
			if (event.kind === "started" && event.providerSessionId !== undefined) {
				const session = this.orchestrator.session(run.sessionId);
				if (session !== undefined) {
					this.store.appendMeta({
						sessionId: session.id,
						harnessId: session.provider,
						providerSessionId: event.providerSessionId,
						createdAt: session.created,
					});
				}
			}
		}
		this.bus.emit(HARNESS_EVENT_CHANNEL, {
			runId: update.runId,
			...(run.sessionId === undefined ? {} : { sessionId: run.sessionId }),
			event,
		} satisfies HarnessRunEvent);
	}

	private persistPrompt(sessionId: string, runId: string, prompt: string): void {
		if (this.persistedPrompts.has(runId)) return;
		this.persistedPrompts.add(runId);
		this.store.appendPrompt(sessionId, runId, prompt);
	}

	private toHarnessRun(run: RunSnapshot): HarnessRun {
		const config = this.runConfigs.get(run.id) ?? fromSnapshot(run);
		return {
			id: run.id,
			harnessId: run.provider,
			...(run.sessionId === undefined ? {} : { sessionId: run.sessionId }),
			...(run.providerSessionId === undefined ? {} : { providerSessionId: run.providerSessionId }),
			state: run.state,
			startTime: run.startedAt,
			...(run.endedAt === undefined ? {} : { endTime: run.endedAt }),
			prompt: run.prompt,
			config: { ...config },
			events: this.runEvents(run.id),
		};
	}
}

function providerFromHarness(harness: Harness): Provider {
	return {
		name: harness.id,
		resumable: harness.resumable,
		start: (config, signal) => harnessProviderEvents(harness, config, signal),
	};
}

async function* harnessProviderEvents(
	harness: Harness,
	config: RunConfig,
	signal?: AbortSignal,
): AsyncGenerator<Event> {
	const effectiveSignal = signal ?? new AbortController().signal;
	for await (const event of harness.start(fromOrchestratorRunConfig(config), effectiveSignal)) {
		yield toOrchestratorEvent(event);
	}
}

function toHarnessSession(session: SessionSnapshot): HarnessSession {
	return {
		id: session.id,
		harnessId: session.provider,
		...(session.providerSessionId === undefined ? {} : { providerSessionId: session.providerSessionId }),
		runIds: [...session.runIds],
		queued: [...session.queue.prompts],
	};
}

function fromSnapshot(run: RunSnapshot): HarnessRunConfig {
	return {
		prompt: run.prompt,
		...(run.model === undefined ? {} : { model: run.model }),
		...(run.effort === undefined ? {} : { effort: run.effort }),
		...(run.providerSessionId === undefined ? {} : { providerSessionId: run.providerSessionId }),
	};
}
