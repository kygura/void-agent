/**
 * subagent / subagent_output tools: spawn a child coding agent to run a
 * scoped task, either in-process (the "void" harness, via a fresh
 * AgentSession) or through an external CLI harness (claude, codex, or a
 * registered generic harness) via HarnessRunManager. A run either blocks and
 * returns the child's final text, or is kicked off in the background and
 * later notifies the parent session on completion.
 */

import { randomUUID } from "node:crypto";
import { type Static, Type } from "@sinclair/typebox";
import type { AgentSession } from "../agent-session.js";
import { discoverAgents } from "../agents.js";
import type { ToolDefinition } from "../extensions/types.js";
import type { HarnessRun, HarnessRunManager } from "../harness/index.js";
import { nowIso } from "../harness/types.js";
import { createAllTools, createCodingTools, type Tool, type ToolName } from "./index.js";
import { truncateHead } from "./truncate.js";

/** Cap applied to the final text embedded in a background-completion notification. */
const NOTIFICATION_MAX_BYTES = 4000;

export type SubagentRunState = "running" | "done" | "failed" | "cancelled";

/** One child run's bookkeeping, shared between the subagent and subagent_output tools. */
export interface SubagentRunRecord {
	id: string;
	agent: string;
	description?: string;
	harness: string;
	background: boolean;
	state: SubagentRunState;
	startTime: string;
	endTime?: string;
	finalText?: string;
	error?: string;
	/** Session file for the child, when spawned via the "void" harness. */
	childSessionFilePath?: string;
	/** Underlying HarnessRunManager run id, when spawned via an external harness. */
	harnessRunId?: string;
}

/** In-memory registry of child runs. One instance is shared by both tools for a session. */
export class SubagentRegistry {
	private readonly runs = new Map<string, SubagentRunRecord>();
	private readonly changeCallbacks = new Set<() => void>();

	start(init: Omit<SubagentRunRecord, "state" | "startTime">): SubagentRunRecord {
		const record: SubagentRunRecord = { ...init, state: "running", startTime: nowIso() };
		this.runs.set(record.id, record);
		this.notifyChange();
		return record;
	}

	get(id: string): SubagentRunRecord | undefined {
		return this.runs.get(id);
	}

	/** Snapshots of all runs in creation order. */
	list(): SubagentRunRecord[] {
		return Array.from(this.runs.values());
	}

	finish(id: string, patch: Partial<Omit<SubagentRunRecord, "id">>): void {
		const record = this.runs.get(id);
		if (!record) return;
		Object.assign(record, patch, { endTime: patch.endTime ?? nowIso() });
		this.notifyChange();
	}

	/** Subscribe to any run being started or finished. Returns an unsubscribe function. */
	onChange(callback: () => void): () => void {
		this.changeCallbacks.add(callback);
		return () => this.changeCallbacks.delete(callback);
	}

	private notifyChange(): void {
		for (const cb of this.changeCallbacks) cb();
	}
}

/** Resolves an agent definition's `tools` list to concrete cwd-bound Tool instances. Undefined/empty = all coding tools. */
export function resolveAgentTools(cwd: string, toolNames: string[] | undefined): Tool[] {
	if (!toolNames || toolNames.length === 0) return createCodingTools(cwd);
	const all = createAllTools(cwd);
	return toolNames.map((name) => all[name as ToolName]).filter((t): t is Tool => t !== undefined);
}

function formatAgentList(cwd: string): string {
	const defs = discoverAgents(cwd);
	if (defs.length === 0) {
		return "No custom agents discovered. Omit `agent` to spawn a default general-purpose agent with all coding tools.";
	}
	return defs.map((d) => `- ${d.name} — ${d.description}`).join("\n");
}

function formatElapsed(ms: number): string {
	return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function truncateForNotification(text: string): string {
	const result = truncateHead(text, { maxBytes: NOTIFICATION_MAX_BYTES });
	if (!result.truncated) return result.content;
	return `${result.content}\n\n[truncated: showing first ${result.outputBytes} of ${result.totalBytes} bytes]`;
}

async function withAbort<T>(work: Promise<T>, signal: AbortSignal | undefined, onAbort: () => void): Promise<T> {
	if (!signal) return work;
	const listener = () => onAbort();
	if (signal.aborted) {
		onAbort();
	} else {
		signal.addEventListener("abort", listener, { once: true });
	}
	try {
		return await work;
	} finally {
		signal.removeEventListener("abort", listener);
	}
}

/** Spawns a fresh in-process child AgentSession. Implemented by createAgentSession's caller (sdk.ts) to avoid a module cycle. */
export type SpawnVoidChild = (config: {
	systemPrompt?: string;
	toolNames?: string[];
	modelId?: string;
}) => Promise<AgentSession>;

export interface SubagentToolOptions {
	cwd: string;
	harnessRunManager: HarnessRunManager;
	registry: SubagentRegistry;
	/** Updated by the caller once the owning AgentSession exists (forward reference, mirrors extensionRunnerRef). */
	parentSessionRef: { current?: AgentSession };
	spawnVoidChild: SpawnVoidChild;
}

interface ChildRunResult {
	text: string;
	elapsedMs: number;
	tokens?: number;
	sessionFilePath?: string;
}

async function runVoidChild(
	opts: SubagentToolOptions,
	def: ReturnType<typeof discoverAgents>[number] | undefined,
	prompt: string,
	signal: AbortSignal | undefined,
): Promise<ChildRunResult> {
	const startedAt = Date.now();
	const session = await opts.spawnVoidChild({
		systemPrompt: def?.systemPrompt,
		toolNames: def?.tools,
		modelId: def?.model,
	});
	try {
		await withAbort(session.prompt(prompt), signal, () => {
			void session.abort();
		});
		const stats = session.getSessionStats();
		return {
			text: session.getLastAssistantText() ?? "",
			elapsedMs: Date.now() - startedAt,
			tokens: stats.tokens.total,
			sessionFilePath: session.sessionFile,
		};
	} finally {
		session.dispose();
	}
}

/**
 * Resolves once runId's stream ends (its "exit" event). Resolves with the run's own event list,
 * not HarnessRunManager's run.state: that summary field is only assigned by the manager *after*
 * its for-await loop observes the stream close, one tick after the "exit" event itself is
 * broadcast to subscribers - reading run.state synchronously inside the "exit" handler below
 * would race that assignment and see a stale "running". The event list is not subject to this:
 * every event, including "exit" itself, is appended before it is broadcast.
 */
function waitForHarnessRun(manager: HarnessRunManager, runId: string): Promise<HarnessRun> {
	return new Promise((resolve, reject) => {
		const existing = manager.run(runId);
		if (existing?.events.some((e) => e.kind === "exit")) {
			resolve(existing);
			return;
		}
		const unsubscribe = manager.subscribe((e) => {
			if (e.runId !== runId || e.event.kind !== "exit") return;
			unsubscribe();
			const run = manager.run(runId);
			if (run) resolve(run);
			else reject(new Error(`subagent: run "${runId}" vanished`));
		});
	});
}

/** Derives the run's outcome from its own event list (see waitForHarnessRun for why not run.state). */
function harnessOutcome(run: HarnessRun): { state: SubagentRunState; text: string } {
	const resultEvent = run.events.find((e) => e.kind === "result");
	const exitEvent = run.events.find((e) => e.kind === "exit");
	const isError = !!resultEvent?.isError || (exitEvent?.exitCode !== undefined && exitEvent.exitCode !== 0);
	return { state: isError ? "failed" : "done", text: resultEvent?.text ?? "" };
}

async function notifyParent(
	opts: SubagentToolOptions,
	id: string,
	agent: string,
	state: SubagentRunState,
	text: string,
): Promise<void> {
	const session = opts.parentSessionRef.current;
	if (!session) return;
	const record = opts.registry.get(id);
	const elapsedMs = record?.endTime ? Date.parse(record.endTime) - Date.parse(record.startTime) : undefined;
	const lines = [
		"[subagent background run complete]",
		`id: ${id}`,
		`agent: ${agent}`,
		`state: ${state}`,
		elapsedMs !== undefined ? `elapsed: ${formatElapsed(elapsedMs)}` : undefined,
		"",
		truncateForNotification(text || "(no output)"),
	].filter((line): line is string => line !== undefined);
	try {
		await session.sendUserMessage(lines.join("\n"), { deliverAs: "followUp" });
	} catch (error) {
		console.error(`subagent: failed to notify parent session of run "${id}" completion:`, error);
	}
}

function backgroundResult(id: string, agent: string) {
	const text = `Started background subagent run "${id}" (agent: ${agent}). A notification with the final result will arrive in this session when it completes. Use subagent_output with id "${id}" to poll status/output in the meantime.`;
	return { content: [{ type: "text" as const, text }], details: undefined };
}

function foregroundResult(id: string, agent: string, result: ChildRunResult) {
	const stats = `[subagent ${id} | agent=${agent} | elapsed=${formatElapsed(result.elapsedMs)}${result.tokens !== undefined ? ` | tokens=${result.tokens}` : ""}]`;
	const text = `${result.text || "(no output)"}\n\n${stats}`;
	return { content: [{ type: "text" as const, text }], details: undefined };
}

const subagentSchema = Type.Object({
	agent: Type.Optional(
		Type.String({ description: "Agent name from discovery. Omit for a default general-purpose agent." }),
	),
	prompt: Type.String({ description: "Task briefing for the child agent." }),
	description: Type.Optional(Type.String({ description: "Short label for display." })),
	run_in_background: Type.Optional(
		Type.Boolean({ description: "Run in the background and return immediately (default: false)." }),
	),
});
export type SubagentToolInput = Static<typeof subagentSchema>;

/** Builds the subagent tool. The tool description lists agents discovered at build time (session start). */
export function createSubagentToolDefinition(opts: SubagentToolOptions): ToolDefinition<typeof subagentSchema> {
	const agentList = formatAgentList(opts.cwd);
	return {
		name: "subagent",
		label: "subagent",
		description: `Spawn a child coding agent to run a scoped task, in-process by default or via an external CLI harness (claude, codex). Use run_in_background for long-running tasks; poll with subagent_output.\n\nAvailable agents:\n${agentList}`,
		promptSnippet: "Spawn a child coding agent for a scoped task",
		parameters: subagentSchema,
		async execute(_toolCallId, params, signal) {
			const def = params.agent ? discoverAgents(opts.cwd).find((d) => d.name === params.agent) : undefined;
			if (params.agent && !def) {
				throw new Error(`subagent: unknown agent "${params.agent}". Available agents:\n${agentList}`);
			}

			const harnessId = def?.harness ?? "void";
			const background = params.run_in_background ?? false;
			const id = randomUUID();
			const agentLabel = def?.name ?? "general";

			if (harnessId === "void") {
				if (background) {
					opts.registry.start({
						id,
						agent: agentLabel,
						description: params.description,
						harness: harnessId,
						background: true,
					});
					void runVoidChild(opts, def, params.prompt, undefined)
						.then((result) => {
							opts.registry.finish(id, {
								state: "done",
								finalText: result.text,
								childSessionFilePath: result.sessionFilePath,
							});
							return notifyParent(opts, id, agentLabel, "done", result.text);
						})
						.catch((error) => {
							const message = error instanceof Error ? error.message : String(error);
							opts.registry.finish(id, { state: "failed", error: message });
							return notifyParent(opts, id, agentLabel, "failed", message);
						});
					return backgroundResult(id, agentLabel);
				}

				opts.registry.start({
					id,
					agent: agentLabel,
					description: params.description,
					harness: harnessId,
					background: false,
				});
				try {
					const result = await runVoidChild(opts, def, params.prompt, signal);
					opts.registry.finish(id, {
						state: "done",
						finalText: result.text,
						childSessionFilePath: result.sessionFilePath,
					});
					return foregroundResult(id, agentLabel, result);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					opts.registry.finish(id, { state: "failed", error: message });
					throw new Error(`subagent: run failed: ${message}`);
				}
			}

			// External harness (claude, codex, or a registered generic harness).
			const fullPrompt = def?.systemPrompt ? `${def.systemPrompt}\n\n${params.prompt}` : params.prompt;
			let runId: string;
			try {
				runId = opts.harnessRunManager.startRun(harnessId, {
					prompt: fullPrompt,
					model: def?.model,
					cwd: opts.cwd,
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(`subagent: could not start harness "${harnessId}": ${message}`);
			}

			if (background) {
				opts.registry.start({
					id,
					agent: agentLabel,
					description: params.description,
					harness: harnessId,
					background: true,
					harnessRunId: runId,
				});
				void waitForHarnessRun(opts.harnessRunManager, runId)
					.then((run) => {
						const { state, text } = harnessOutcome(run);
						opts.registry.finish(id, { state, finalText: text });
						return notifyParent(opts, id, agentLabel, state, text);
					})
					.catch((error) => {
						const message = error instanceof Error ? error.message : String(error);
						opts.registry.finish(id, { state: "failed", error: message });
						return notifyParent(opts, id, agentLabel, "failed", message);
					});
				return backgroundResult(id, agentLabel);
			}

			opts.registry.start({
				id,
				agent: agentLabel,
				description: params.description,
				harness: harnessId,
				background: false,
				harnessRunId: runId,
			});
			if (signal) {
				const onAbort = () => opts.harnessRunManager.cancel(runId);
				if (signal.aborted) onAbort();
				else signal.addEventListener("abort", onAbort, { once: true });
			}
			const run = await waitForHarnessRun(opts.harnessRunManager, runId);
			const { state, text } = harnessOutcome(run);
			opts.registry.finish(id, { state, finalText: text });
			if (state === "failed") {
				throw new Error(`subagent: run failed: ${text || "unknown error"}`);
			}
			const exitTimestamp = run.events.find((e) => e.kind === "exit")?.timestamp;
			const elapsedMs = exitTimestamp ? Date.parse(exitTimestamp) - Date.parse(run.startTime) : 0;
			return foregroundResult(id, agentLabel, { text, elapsedMs });
		},
	};
}

const subagentOutputSchema = Type.Object({
	id: Type.String({ description: "Run id returned by the subagent tool." }),
});
export type SubagentOutputToolInput = Static<typeof subagentOutputSchema>;

/** Builds the subagent_output tool: polls state/output for a run started by the subagent tool. */
export function createSubagentOutputToolDefinition(
	registry: SubagentRegistry,
): ToolDefinition<typeof subagentOutputSchema> {
	return {
		name: "subagent_output",
		label: "subagent output",
		description:
			"Get the state and output of a subagent run (in particular, one started with run_in_background: true).",
		promptSnippet: "Poll a subagent run's state and output",
		parameters: subagentOutputSchema,
		async execute(_toolCallId, { id }) {
			const record = registry.get(id);
			if (!record) {
				throw new Error(`subagent_output: unknown run "${id}"`);
			}
			const lines = [
				`id: ${record.id}`,
				`agent: ${record.agent}`,
				`state: ${record.state}`,
				`started: ${record.startTime}`,
				record.endTime ? `ended: ${record.endTime}` : "still running",
				record.error ? `error: ${record.error}` : undefined,
				"",
				record.finalText || "(no output yet)",
			].filter((line): line is string => line !== undefined);
			return { content: [{ type: "text" as const, text: lines.join("\n") }], details: undefined };
		},
	};
}
