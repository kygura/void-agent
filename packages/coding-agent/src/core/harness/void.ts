/**
 * In-process harness adapter for void's own subagent children. Unlike
 * claude/codex (child CLI processes whose stdout is parsed line by line), a
 * "void" run drives a live in-process AgentSession spawned via the
 * SpawnVoidChild callback (sdk.ts) and translates its own event stream into
 * HarnessEvents directly - no process, no JSON.
 *
 * Live children are kept in a Map keyed by their own session id (which
 * doubles as providerSessionId) so a resume reuses the same session instead
 * of respawning.
 */

import { EventStream } from "@void/ai";
import type { AgentSession, AgentSessionEvent } from "../agent-session.js";
import type { SpawnVoidChild } from "../tools/subagent.js";
import { type Harness, type HarnessEvent, type HarnessRunConfig, nowIso } from "./types.js";

/** Spawn config pre-registered by prepareSpawn(), looked up via the token in cfg.extraArgs[0]. */
export interface VoidSpawnConfig {
	systemPrompt?: string;
	toolNames?: string[];
	modelId?: string;
	/** Overrides the child's tool-bound cwd (e.g. a worktree isolation path). Default: parent's cwd. */
	cwd?: string;
}

/**
 * Adapts void's own in-process subagent children to the Harness seam so they
 * flow through the same HarnessRunManager/orchestrator machinery as
 * claude/codex CLI children (live transcript, resume, cancel in the UI).
 *
 * Token handoff: HarnessRunConfig has no systemPrompt/toolNames field (every
 * other harness would have to ignore it), so the agent definition's spawn
 * config travels out of band. The caller generates a token, calls
 * prepareSpawn(token, {...}) immediately before startRun(), and passes
 * cfg.extraArgs = [token] into that same startRun() call. start() looks the
 * token up (one-shot - deleted once read) and spawns with an empty config if
 * no token is present.
 */
export class VoidHarness implements Harness {
	readonly id = "void";
	readonly resumable = true;

	private readonly pendingSpawns = new Map<string, VoidSpawnConfig>();
	// ponytail: resume is no longer bounded by this process's lifetime - a providerSessionId
	// missing from this Map (evicted, or this process restarted) falls through to
	// spawnVoidChild({ resumeSessionId }), which respawns from the child's persisted session
	// file (sdk.ts). The remaining ceiling is CHILD_CAP (~32) for in-memory reuse only: past
	// that cap the oldest live child is evicted from this Map (still disposed eagerly), but a
	// later resume against it just respawns from disk again instead of failing - the only true
	// failure-as-data case left is an id whose session file never existed (or was removed).
	// Bounded via a plain LRU cap (CHILD_CAP, ~32) instead of disposing on every completion or
	// keeping children alive forever: a Map's insertion order doubles as recency order, so
	// "touch" (moveToMru, called on fresh spawn and on resume lookup) is delete+reinsert, and
	// eviction is just deleting the oldest key once size exceeds the cap. Upgrade path if 32 is
	// ever wrong: make the cap configurable, not needed today.
	private readonly children = new Map<string, AgentSession>();

	constructor(private readonly spawnVoidChild: SpawnVoidChild) {}

	/** Registers spawn config for the next fresh run keyed by token. Call immediately before startRun(). */
	prepareSpawn(token: string, cfg: VoidSpawnConfig): void {
		this.pendingSpawns.set(token, cfg);
	}

	/** Cleans up a token registered by prepareSpawn() when startRun() throws before start() ever runs. */
	cancelSpawn(token: string): void {
		this.pendingSpawns.delete(token);
	}

	/**
	 * Eagerly spawns a child now and returns its session id (= providerSessionId).
	 * Used by the session-backed subagent path: the caller creates a HarnessRunManager
	 * session pre-bound to this id, so the child's runs flow through the orchestrator's
	 * session machinery (FIFO queue, resume) from birth. This sidesteps the prepareSpawn
	 * token handoff, whose out-of-band spawn config cannot survive the session run path
	 * (submitPrompt rebuilds run config from stored session fields, dropping extraArgs).
	 */
	async spawnChild(cfg: VoidSpawnConfig): Promise<string> {
		const session = await this.spawnVoidChild({
			systemPrompt: cfg.systemPrompt,
			toolNames: cfg.toolNames,
			modelId: cfg.modelId,
			cwd: cfg.cwd,
		});
		this.registerChild(session);
		return session.sessionId;
	}

	start(cfg: HarnessRunConfig, signal: AbortSignal): AsyncIterable<HarnessEvent> {
		const stream = new EventStream<HarnessEvent, void>(
			(event) => event.kind === "exit",
			() => undefined,
		);
		void this.run(cfg, signal, stream);
		return stream;
	}

	private async run(
		cfg: HarnessRunConfig,
		signal: AbortSignal,
		stream: EventStream<HarnessEvent, void>,
	): Promise<void> {
		const session = await this.resolveSession(cfg, stream);
		if (session === undefined) return; // resolveSession already emitted a failed result + exit

		if (signal.aborted) {
			// Only dispose+evict a session this call freshly spawned. A resume's session is a
			// live, resumable child owned by this.children long before this call - an incidental
			// abort race here should just cancel this turn, not nuke the child for future resumes.
			if (cfg.providerSessionId === undefined) {
				this.children.delete(session.sessionId);
				session.dispose();
			}
			pushCancelled(stream);
			return;
		}

		const unsubscribe = session.subscribe((event) => {
			const translated = translateAgentEvent(event);
			if (translated !== undefined) stream.push(translated);
		});
		const onAbort = () => void session.abort();
		signal.addEventListener("abort", onAbort, { once: true });

		try {
			await session.prompt(cfg.prompt);
			if (signal.aborted) {
				pushCancelled(stream);
			} else {
				stream.push({
					kind: "result",
					timestamp: nowIso(),
					text: session.getLastAssistantText() ?? "",
					usage: toUsage(session),
				});
				stream.push({ kind: "exit", timestamp: nowIso(), exitCode: 0 });
			}
		} catch (error) {
			stream.push({
				kind: "result",
				timestamp: nowIso(),
				isError: true,
				text: error instanceof Error ? error.message : String(error),
			});
			stream.push({ kind: "exit", timestamp: nowIso(), exitCode: 1 });
		} finally {
			unsubscribe();
			signal.removeEventListener("abort", onAbort);
			// Completed children stay in this.children, alive and resumable - only abort,
			// LRU eviction, and manager close dispose a child now (see the ponytail comment
			// on the children field).
		}
	}

	/** Resolves the child for this run: a live resume, a session-file respawn, or a fresh spawn. */
	private async resolveSession(
		cfg: HarnessRunConfig,
		stream: EventStream<HarnessEvent, void>,
	): Promise<AgentSession | undefined> {
		if (cfg.providerSessionId !== undefined) {
			const live = this.children.get(cfg.providerSessionId);
			if (live !== undefined) {
				this.touch(cfg.providerSessionId, live);
				return live;
			}

			// Not live (evicted, or this process restarted since it spawned) - attempt a
			// session-file respawn before giving up. spawnVoidChild throws when the id's session
			// file truly doesn't exist (see sdk.ts), which is the same "unknown or dead" outcome
			// a never-spawned id already hits below.
			let respawned: AgentSession;
			try {
				respawned = await this.spawnVoidChild({ resumeSessionId: cfg.providerSessionId, modelId: cfg.model });
			} catch {
				stream.push({
					kind: "result",
					timestamp: nowIso(),
					isError: true,
					text: `void: unknown or dead child session "${cfg.providerSessionId}"`,
				});
				stream.push({ kind: "exit", timestamp: nowIso(), exitCode: 1 });
				return undefined;
			}
			this.registerChild(respawned);
			stream.push({ kind: "started", timestamp: nowIso(), providerSessionId: respawned.sessionId });
			return respawned;
		}

		const token = cfg.extraArgs?.[0];
		const spawnCfg = token === undefined ? undefined : this.pendingSpawns.get(token);
		if (token !== undefined) this.pendingSpawns.delete(token);

		let session: AgentSession;
		try {
			session = await this.spawnVoidChild({
				systemPrompt: spawnCfg?.systemPrompt,
				toolNames: spawnCfg?.toolNames,
				modelId: spawnCfg?.modelId ?? cfg.model,
			});
		} catch (error) {
			stream.push({
				kind: "result",
				timestamp: nowIso(),
				isError: true,
				text: error instanceof Error ? error.message : String(error),
			});
			stream.push({ kind: "exit", timestamp: nowIso(), exitCode: 1 });
			return undefined;
		}
		this.registerChild(session);
		stream.push({ kind: "started", timestamp: nowIso(), providerSessionId: session.sessionId });
		return session;
	}

	/** Moves a child to MRU position (Map insertion order = recency order): delete + reinsert. */
	private touch(id: string, session: AgentSession): void {
		this.children.delete(id);
		this.children.set(id, session);
	}

	/**
	 * Inserts a (freshly spawned or respawned) child, evicting the oldest past CHILD_CAP -
	 * skipping any child with a run currently in flight (session.isStreaming), so a busy LRU
	 * cap never tears down a live run's transcript/event forwarding out from under it. If every
	 * child is active, eviction is skipped for this call: a temporary excess over CHILD_CAP is
	 * far better than silently corrupting a live run.
	 */
	private registerChild(session: AgentSession): void {
		this.children.set(session.sessionId, session);
		if (this.children.size > CHILD_CAP) {
			let evictId: string | undefined;
			for (const [id, child] of this.children) {
				if (!child.isStreaming) {
					evictId = id;
					break;
				}
			}
			if (evictId !== undefined) {
				this.children.get(evictId)?.dispose();
				this.children.delete(evictId);
			}
		}
	}
}

/** Max live (resumable) children kept around at once; oldest is evicted past this. */
const CHILD_CAP = 32;

/** Cancelled-run convention shared with the orchestrator's ensureTerminalEvents and generic.ts's finalizeGeneric. */
function pushCancelled(stream: EventStream<HarnessEvent, void>): void {
	stream.push({ kind: "result", timestamp: nowIso(), isError: true, text: "Run cancelled" });
	stream.push({ kind: "exit", timestamp: nowIso(), exitCode: 130 });
}

function toUsage(session: AgentSession): { inputTokens: number; outputTokens: number; costUsd: number } {
	const stats = session.getSessionStats();
	return { inputTokens: stats.tokens.input, outputTokens: stats.tokens.output, costUsd: stats.cost };
}

function translateAgentEvent(event: AgentSessionEvent): HarnessEvent | undefined {
	if (event.type === "message_update") {
		if (event.assistantMessageEvent.type === "text_delta") {
			return { kind: "text", timestamp: nowIso(), text: event.assistantMessageEvent.delta };
		}
		if (event.assistantMessageEvent.type === "thinking_delta") {
			return { kind: "thinking", timestamp: nowIso(), text: event.assistantMessageEvent.delta };
		}
		return undefined;
	}
	if (event.type === "tool_execution_start") {
		return {
			kind: "tool",
			timestamp: nowIso(),
			tool: event.toolName,
			toolInput: safeStringify(event.args),
			toolDone: false,
		};
	}
	if (event.type === "tool_execution_end") {
		return { kind: "tool", timestamp: nowIso(), tool: event.toolName, toolDone: true };
	}
	return undefined;
}

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "";
	} catch {
		return String(value);
	}
}
