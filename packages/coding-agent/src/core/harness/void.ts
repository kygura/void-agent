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
	// ponytail: live-children-only resume - a providerSessionId only resolves while this
	// process (and this Map) is alive. Upgrade path when cross-process/cross-restart resume is
	// needed: respawn from the child's persisted session file (SpawnVoidChild would need a
	// "resume existing session file" variant) instead of failing the resume as data below.
	// Disposal (in run()'s finally) is safe today because no current caller ever passes
	// providerSessionId back into startRun(), so nothing is ever actually resumed - the day a
	// real resume caller shows up (threading sessionId through so a later call carries a
	// matching providerSessionId), disposing here on every run would break it. That's the
	// trigger to revisit: keep-alive would need to move to only fire for a session a live
	// resume caller is tracking.
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
			this.children.delete(session.sessionId);
			session.dispose();
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
			this.children.delete(session.sessionId);
			session.dispose();
		}
	}

	/** Resolves the child for this run: a fresh spawn, or the live session for a resume. */
	private async resolveSession(
		cfg: HarnessRunConfig,
		stream: EventStream<HarnessEvent, void>,
	): Promise<AgentSession | undefined> {
		if (cfg.providerSessionId !== undefined) {
			const session = this.children.get(cfg.providerSessionId);
			if (session === undefined) {
				stream.push({
					kind: "result",
					timestamp: nowIso(),
					isError: true,
					text: `void: unknown or dead child session "${cfg.providerSessionId}"`,
				});
				stream.push({ kind: "exit", timestamp: nowIso(), exitCode: 1 });
				return undefined;
			}
			return session;
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
		this.children.set(session.sessionId, session);
		stream.push({ kind: "started", timestamp: nowIso(), providerSessionId: session.sessionId });
		return session;
	}
}

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
