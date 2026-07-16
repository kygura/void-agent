import type { SessionMeta, SessionStore, StoredSession } from "./store.js";
import type { Event, RunSnapshot, SessionSnapshot } from "./types.js";

const PERSISTENCE_FAILURE_PREFIX = "session persistence is failing";
const DEFAULT_RESTORE_TIMEOUT_MS = 4_000;

export interface PersisterOptions {
	readonly restoreTimeoutMs?: number;
}

export interface PersistenceRestoreResult {
	readonly sessions: readonly StoredSession[];
	readonly warnings: readonly string[];
}

/**
 * The single append owner between Orchestrator lifecycle state and SessionStore.
 * Its own per-session queues preserve multi-step invariants while the store
 * serializes every physical load and append touching a session file.
 */
export class Persister {
	readonly #sessionTails = new Map<string, Promise<void>>();
	readonly #pending = new Set<Promise<void>>();
	readonly #metaWritten = new Map<string, string>();
	readonly #promptWritten = new Set<string>();
	readonly #terminalResults = new Set<string>();
	readonly #restoreTimeoutMs: number;
	#warned = false;

	public constructor(
		private readonly store: SessionStore,
		options: PersisterOptions = {},
	) {
		this.#restoreTimeoutMs = positiveTimeout(options.restoreTimeoutMs, DEFAULT_RESTORE_TIMEOUT_MS);
	}

	/** Loads append logs without registering them into an Orchestrator. */
	public restore(): Promise<PersistenceRestoreResult> {
		return boundedRestore(this.restoreFromStore(), this.#restoreTimeoutMs);
	}

	private async restoreFromStore(): Promise<PersistenceRestoreResult> {
		let sessionIds: readonly string[];
		try {
			sessionIds = await this.store.list();
		} catch (error) {
			return { sessions: [], warnings: [this.failureWarning(error)] };
		}

		const sessions: StoredSession[] = [];
		const warnings: string[] = [];
		for (const sessionId of sessionIds) {
			try {
				const session = await this.store.load(sessionId);
				sessions.push(session);
				this.#metaWritten.set(sessionId, session.meta.providerSessionId ?? "");
				if (session.warning !== undefined) warnings.push(session.warning);
			} catch (error) {
				warnings.push(this.failureWarning(error));
			}
		}
		return { sessions, warnings };
	}

	/** Establishes the metadata-first invariant for a newly registered Session. */
	public persistSession(session: SessionSnapshot): Promise<string | undefined> {
		return this.serialize(session.id, async () => {
			await this.ensureMeta(session);
			return undefined;
		});
	}

	/** Persists a Run prompt before its Provider is allowed to stream Events. */
	public persistRunStart(session: SessionSnapshot, run: RunSnapshot): Promise<string | undefined> {
		return this.serialize(session.id, async () => {
			await this.ensureMeta(session);
			await this.ensurePrompt(session.id, run);
			return undefined;
		});
	}

	/** Appends one Event and mirrors a newly learned Provider session ID. */
	public persistEvent(session: SessionSnapshot, run: RunSnapshot, event: Event): Promise<string | undefined> {
		return this.serialize(session.id, async () => {
			await this.ensureMeta(session);
			await this.ensurePrompt(session.id, run);
			await this.store.appendEvent(session.id, run.id, event);
			if (
				event.kind === "started" &&
				event.providerSessionId !== undefined &&
				event.providerSessionId !== "" &&
				this.#metaWritten.get(session.id) !== event.providerSessionId
			) {
				await this.store.appendMeta(toMeta(session));
				this.#metaWritten.set(session.id, event.providerSessionId);
			}
			return undefined;
		});
	}

	/**
	 * Appends a fresh last-wins metadata line from the live Session snapshot.
	 * The load and append remain inside this Persister queue; both physical
	 * operations also share the SessionStore's per-session serialization.
	 */
	public persistSessionUpdate(session: SessionSnapshot): Promise<string | undefined> {
		return this.serialize(session.id, async () => {
			await this.ensureMeta(session);
			const previous = await this.store.load(session.id);
			const created = previous.meta.created === "" ? session.created : previous.meta.created;
			await this.store.appendMeta(toMeta({ ...session, created }));
			this.#metaWritten.set(session.id, session.providerSessionId ?? "");
			return previous.warning === undefined ? undefined : this.warningOnce(previous.warning);
		});
	}

	/**
	 * Records one child Run's terminal result in its parent Session. The child
	 * Run ID is the idempotency key while the child Session ID groups the record
	 * in the parent's transcript.
	 */
	public persistSubagentResult(
		parent: SessionSnapshot,
		childRunId: string,
		event: Event,
	): Promise<string | undefined> {
		return this.serialize(parent.id, async () => {
			if (this.#terminalResults.has(childRunId)) return undefined;
			await this.ensureMeta(parent);
			await this.store.appendEvent(parent.id, event.childSessionId ?? "", event);
			this.#terminalResults.add(childRunId);
			return undefined;
		});
	}

	/** Waits for every scheduled append, including work enqueued while waiting. */
	public async flush(): Promise<void> {
		while (this.#pending.size > 0) await Promise.allSettled([...this.#pending]);
	}

	private async ensureMeta(session: SessionSnapshot): Promise<void> {
		if (this.#metaWritten.has(session.id)) return;
		await this.store.appendMeta(toMeta(session));
		this.#metaWritten.set(session.id, session.providerSessionId ?? "");
	}

	private async ensurePrompt(sessionId: string, run: RunSnapshot): Promise<void> {
		if (this.#promptWritten.has(run.id)) return;
		await this.store.appendPrompt(sessionId, run.id, run.prompt);
		this.#promptWritten.add(run.id);
	}

	private serialize(sessionId: string, operation: () => Promise<string | undefined>): Promise<string | undefined> {
		const previous = this.#sessionTails.get(sessionId) ?? Promise.resolve();
		const result = previous
			.catch(() => undefined)
			.then(async () => {
				try {
					return await operation();
				} catch (error) {
					return this.warningOnce(this.failureWarning(error));
				}
			});
		const tail = result.then(() => undefined);
		this.#sessionTails.set(sessionId, tail);
		this.#pending.add(tail);
		void tail.then(() => {
			this.#pending.delete(tail);
			if (this.#sessionTails.get(sessionId) === tail) this.#sessionTails.delete(sessionId);
		});
		return result;
	}

	private warningOnce(warning: string): string | undefined {
		if (this.#warned) return undefined;
		this.#warned = true;
		return warning;
	}

	private failureWarning(error: unknown): string {
		const message = error instanceof Error ? error.message : String(error);
		return `${PERSISTENCE_FAILURE_PREFIX} (${message}) — this session may not survive a restart`;
	}
}

function boundedRestore(
	operation: Promise<PersistenceRestoreResult>,
	timeoutMs: number,
): Promise<PersistenceRestoreResult> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (result: PersistenceRestoreResult): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};
		const timer = setTimeout(
			() =>
				finish({
					sessions: [],
					warnings: [`persisted sessions unavailable (restore timed out after ${timeoutMs}ms)`],
				}),
			timeoutMs,
		);
		void operation.then(finish, (error: unknown) => {
			const message = error instanceof Error ? error.message : String(error);
			finish({ sessions: [], warnings: [`persisted sessions unavailable (${message})`] });
		});
	});
}

function positiveTimeout(value: number | undefined, fallback: number): number {
	return value === undefined || !Number.isFinite(value) || value <= 0 ? fallback : value;
}

function toMeta(session: SessionSnapshot): SessionMeta {
	return {
		id: session.id,
		provider: session.provider,
		...(session.providerSessionId === undefined ? {} : { providerSessionId: session.providerSessionId }),
		...(session.name === undefined ? {} : { name: session.name }),
		...(session.parentSessionId === undefined ? {} : { parentSessionId: session.parentSessionId }),
		created: session.created,
	};
}
