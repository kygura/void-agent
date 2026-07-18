/**
 * subagent / subagent_output tools: spawn a child coding agent to run a
 * scoped task, either in-process (the "void" harness) or through an external
 * CLI harness (claude, codex, or a registered generic harness) - both flow
 * through HarnessRunManager.startRun, which is what gives every child a live
 * event stream, cancel, and background-notify. A run either blocks and
 * returns the child's final text, or is kicked off in the background and
 * later notifies the parent session on completion.
 */

import { randomUUID } from "node:crypto";
import { type Static, Type } from "@sinclair/typebox";
import type { AgentSession } from "../agent-session.js";
import { type AgentDefinition, discoverAgents } from "../agents.js";
import type { ToolDefinition } from "../extensions/types.js";
import type { HarnessRun, HarnessRunManager, VoidHarness } from "../harness/index.js";
import { nowIso } from "../harness/types.js";
import type { SettingsManager } from "../settings-manager.js";
import { cleanupWorktree, createWorktree, worktreePath } from "../worktree.js";
import { createAllTools, createCodingTools, createReadOnlyTools, type Tool, type ToolName } from "./index.js";
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
	/** Underlying HarnessRunManager run id. Set for every run - both "void" and external harnesses spawn through it. */
	harnessRunId?: string;
	/**
	 * HarnessRunManager session id backing this run. Every subagent spawn is session-backed, so this
	 * is set for all runs; it is what subagent_send targets to queue/resume a follow-up turn.
	 */
	sessionId?: string;
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

/**
 * Maps a `tools:` entry (case-insensitive) to a void registry key. Covers both void's own
 * lowercase names (read, bash, edit, write, grep, find, ls) and the Claude Code agent-file names
 * (Read, Grep, Glob, Bash, Edit, Write, LS) that `~/.claude/agents/*.md` files use.
 */
const TOOL_NAME_ALIASES: Record<string, ToolName> = {
	read: "read",
	bash: "bash",
	edit: "edit",
	write: "write",
	grep: "grep",
	find: "find",
	ls: "ls",
	glob: "find",
	web_search: "webSearch",
	websearch: "webSearch",
};

/** Resolves an agent definition's `tools` list to concrete cwd-bound Tool instances. Undefined/empty = all coding tools. */
export function resolveAgentTools(cwd: string, toolNames: string[] | undefined): Tool[] {
	if (!toolNames || toolNames.length === 0) return createCodingTools(cwd);
	const all = createAllTools(cwd);
	const resolved: Tool[] = [];
	for (const name of toolNames) {
		const key = TOOL_NAME_ALIASES[name.toLowerCase()];
		const tool = key ? all[key] : undefined;
		if (tool) resolved.push(tool);
		else console.error(`resolveAgentTools: unknown tool name "${name}", dropping it`);
	}
	return resolved.length > 0 ? resolved : createReadOnlyTools(cwd);
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

/** Spawns a fresh in-process child AgentSession. Implemented by createAgentSession's caller (sdk.ts) to avoid a module cycle. */
export type SpawnVoidChild = (config: {
	systemPrompt?: string;
	toolNames?: string[];
	modelId?: string;
	/** Resume a specific persisted session file by id instead of spawning fresh. */
	resumeSessionId?: string;
	/** Overrides the child's tool-bound cwd (e.g. a worktree isolation path). Default: parent's cwd. */
	cwd?: string;
}) => Promise<AgentSession>;

export interface SubagentToolOptions {
	cwd: string;
	/** Global config dir, used to root opt-in worktree isolation scratch paths (see worktree.ts). */
	agentDir: string;
	harnessRunManager: HarnessRunManager;
	registry: SubagentRegistry;
	/** Updated by the caller once the owning AgentSession exists (forward reference, mirrors extensionRunnerRef). */
	parentSessionRef: { current?: AgentSession };
	/** Source of the concurrency cap on background subagent-tool runs (see createSubagentToolDefinition). */
	settingsManager: SettingsManager;
}

interface ChildRunResult {
	text: string;
	elapsedMs: number;
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

/** A worktree created for one spawn's opt-in isolation (SPEC Part 4). */
interface SpawnWorktree {
	readonly repoDir: string;
	readonly path: string;
}

/**
 * Cleans up an opted-in worktree once its run is done: removes it if clean, or leaves it in place
 * and appends its path to `text` if dirty - never silently discards a child's uncommitted work.
 */
async function finalizeWorktree(worktree: SpawnWorktree, text: string): Promise<string> {
	const result = await cleanupWorktree(worktree.repoDir, worktree.path);
	if (result.removed) return text;
	return `${text}\n\n[worktree isolation] left uncommitted changes in place, not deleted: ${result.dirtyPath}`;
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

/**
 * Watches a session and notifies the parent exactly once per run that completes on it
 * (its "exit" event): the initial background run plus any follow-up run started by
 * subagent_send - whether it resumed immediately or was queued behind a live run and
 * auto-launched later. `skipRunId`, when set, is a foreground run whose result is returned
 * inline by execute(), so it is not also reported as a background completion.
 *
 * Exit fires once per run id, so this preserves the "exactly one parent notification per
 * child run" bridge guarantee across a multi-turn FIFO session - not once per queued
 * message, not zero times for an auto-dequeued follow-up.
 *
 * ponytail: the subscription is never explicitly torn down; it lives for the HarnessRunManager's
 * (i.e. the parent session's) lifetime, which is exactly as long as follow-ups can still arrive.
 */
function installSessionNotifier(
	opts: SubagentToolOptions,
	id: string,
	agent: string,
	sessionId: string,
	skipRunId?: string,
	// Worktree cleanup is scoped to the one run it was created for (worktreeRunId) - a later
	// subagent_send follow-up run on the same session is a different run id and is reported here
	// too, but doesn't re-trigger cleanup (the worktree, if clean, is already gone by then; see the
	// ponytail note in createSubagentToolDefinition for why isolation doesn't extend to follow-ups).
	worktree?: { runId: string; worktree: SpawnWorktree },
): void {
	const manager = opts.harnessRunManager;
	const notified = new Set<string>();
	manager.subscribe((e) => {
		if (e.sessionId !== sessionId || e.event.kind !== "exit") return;
		if (e.runId === skipRunId || notified.has(e.runId)) return;
		notified.add(e.runId);
		void (async () => {
			const run = manager.run(e.runId);
			if (run === undefined) return;
			let { state, text } = harnessOutcome(run);
			if (worktree && e.runId === worktree.runId) {
				try {
					text = await finalizeWorktree(worktree.worktree, text);
				} catch (error) {
					console.error(`subagent: worktree cleanup failed for run "${id}":`, error);
				}
			}
			opts.registry.finish(id, { state, finalText: text });
			void notifyParent(opts, id, agent, state, text);
		})();
	});
}

function backgroundResult(id: string, agent: string, queued: boolean) {
	const queuedNote = queued
		? " It may be queued behind the concurrency cap on background subagent runs and not started yet."
		: "";
	const text = `Started background subagent run "${id}" (agent: ${agent}).${queuedNote} A notification with the final result will arrive in this session when it completes. Use subagent_output with id "${id}" to poll status/output in the meantime.`;
	return { content: [{ type: "text" as const, text }], details: undefined };
}

function foregroundResult(id: string, agent: string, result: ChildRunResult) {
	const stats = `[subagent ${id} | agent=${agent} | elapsed=${formatElapsed(result.elapsedMs)}]`;
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
	isolation: Type.Optional(
		Type.Literal("worktree", {
			description:
				"Run the child in its own git worktree instead of the parent's cwd (see SPEC-void-orchestration-gaps.md Part 4). Default: off.",
		}),
	),
});
export type SubagentToolInput = Static<typeof subagentSchema>;

/** Builds the subagent tool. The tool description lists agents discovered at build time (session start). */
export function createSubagentToolDefinition(opts: SubagentToolOptions): ToolDefinition<typeof subagentSchema> {
	const agentList = formatAgentList(opts.cwd);
	const manager = opts.harnessRunManager;

	// Concurrency cap on background subagent-tool fan-out (SPEC Part 2). Scoped to this tool
	// definition instance (one per session, like `registry`), counting only run_in_background:
	// true calls - foreground calls already block the parent turn before it can issue another
	// tool call, so they aren't the unbounded-fan-out problem this gate exists for, and don't
	// touch this counter. `runningBackground` is claimed/released like a semaphore; `backgroundQueue`
	// holds FIFO resolvers for calls made while at the cap, drained one at a time as a running
	// background run reaches its terminal state.
	let runningBackground = 0;
	const backgroundQueue: Array<() => void> = [];

	function releaseBackgroundSlot(): void {
		runningBackground--;
		const next = backgroundQueue.shift();
		next?.();
	}

	// Every spawn is session-backed: a HarnessRunManager session is created and the run is
	// attached to it, so the child can later receive a follow-up turn via subagent_send
	// (queued while live, or resumed when idle). Only how the session/run is built differs
	// per harness. External CLI harnesses (claude, codex, a registered generic harness)
	// prepend the system prompt onto the first prompt and learn their providerSessionId from
	// the first run's "started" event. "void" has no CLI to hand a system prompt to and its
	// out-of-band spawn config cannot survive submitPrompt's config rebuild, so the child is
	// spawned eagerly and the session is pre-bound to it (resume-from-birth).
	async function spawnHarnessRun(
		harnessId: string,
		def: AgentDefinition | undefined,
		prompt: string,
		cwd: string,
	): Promise<{ runId: string; sessionId: string }> {
		try {
			if (harnessId === "void") {
				const voidHarness = manager.getHarness("void") as VoidHarness | undefined;
				if (!voidHarness) throw new Error('"void" harness is not registered on this session');
				const providerSessionId = await voidHarness.spawnChild({
					systemPrompt: def?.systemPrompt,
					toolNames: def?.tools,
					modelId: def?.model,
					cwd,
				});
				const sessionId = manager.newSession("void", { workdir: cwd, providerSessionId });
				const runId = manager.startRun("void", { prompt, model: def?.model, cwd }, sessionId);
				return { runId, sessionId };
			}
			const fullPrompt = def?.systemPrompt ? `${def.systemPrompt}\n\n${prompt}` : prompt;
			const sessionId = manager.newSession(harnessId, { workdir: cwd });
			const runId = manager.startRun(harnessId, { prompt: fullPrompt, model: def?.model, cwd }, sessionId);
			return { runId, sessionId };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`subagent: could not start harness "${harnessId}": ${message}`);
		}
	}

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

			// Opt-in worktree isolation (SPEC Part 4): tool param wins over the agent def's frontmatter.
			// The worktree path needs this run's own id, which is why `id` above is generated up front -
			// before spawnHarnessRun (and thus before any HarnessRunManager run id exists).
			const isolation = params.isolation ?? def?.isolation;
			let childCwd = opts.cwd;
			let worktree: SpawnWorktree | undefined;
			if (isolation === "worktree") {
				const path = worktreePath(opts.agentDir, id);
				try {
					const created = await createWorktree(opts.cwd, path);
					childCwd = created.path;
					worktree = { repoDir: opts.cwd, path: created.path };
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					throw new Error(`subagent: could not create isolation worktree: ${message}`);
				}
			}

			if (background) {
				// ponytail: cap is re-read from settings on every acquire attempt, so a newly *lowered*
				// cap applies to the next call immediately; a *raised* cap only helps calls that arrive
				// after the raise, not ones already parked in the queue - upgrade if that gap matters.
				const cap = opts.settingsManager.getMaxConcurrentSubagents();
				const queued = runningBackground >= cap;

				// Register the run immediately (even if queued) so subagent_output can poll it right away.
				opts.registry.start({
					id,
					agent: agentLabel,
					description: params.description,
					harness: harnessId,
					background: true,
				});

				if (!queued) {
					runningBackground++;
					try {
						const { runId, sessionId } = await spawnHarnessRun(harnessId, def, params.prompt, childCwd);
						const record = opts.registry.get(id);
						if (record) {
							record.harnessRunId = runId;
							record.sessionId = sessionId;
						}
						installSessionNotifier(
							opts,
							id,
							agentLabel,
							sessionId,
							undefined,
							worktree ? { runId, worktree } : undefined,
						);
						void waitForHarnessRun(manager, runId)
							.catch(() => undefined)
							.finally(releaseBackgroundSlot);
					} catch (error) {
						releaseBackgroundSlot();
						// The run never started, so no completion path (installSessionNotifier) will ever
						// clean this worktree up - do it here instead of leaking it.
						if (worktree) void cleanupWorktree(worktree.repoDir, worktree.path).catch(() => undefined);
						throw error;
					}
					return backgroundResult(id, agentLabel, false);
				}

				// At the cap: hold the actual spawn until a running slot frees, reusing waitForHarnessRun's
				// exit-event signal (via releaseBackgroundSlot below) as the drain trigger - no second
				// "is a slot free" detector.
				const slotReady = new Promise<void>((resolve) => {
					backgroundQueue.push(resolve);
				});
				void (async () => {
					await slotReady;
					runningBackground++;
					try {
						const { runId, sessionId } = await spawnHarnessRun(harnessId, def, params.prompt, childCwd);
						const record = opts.registry.get(id);
						if (record) {
							record.harnessRunId = runId;
							record.sessionId = sessionId;
						}
						installSessionNotifier(
							opts,
							id,
							agentLabel,
							sessionId,
							undefined,
							worktree ? { runId, worktree } : undefined,
						);
						await waitForHarnessRun(manager, runId).catch(() => undefined);
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						opts.registry.finish(id, { state: "failed", error: message });
						if (worktree) void cleanupWorktree(worktree.repoDir, worktree.path).catch(() => undefined);
					} finally {
						releaseBackgroundSlot();
					}
				})();
				return backgroundResult(id, agentLabel, true);
			}

			const { runId, sessionId } = await spawnHarnessRun(harnessId, def, params.prompt, childCwd);
			opts.registry.start({
				id,
				agent: agentLabel,
				description: params.description,
				harness: harnessId,
				background: false,
				harnessRunId: runId,
				sessionId,
			});

			// Foreground: this run's result is returned inline (skipRunId), but still watch the
			// session so a later subagent_send on this now-idle child notifies the parent.
			installSessionNotifier(opts, id, agentLabel, sessionId, runId);
			if (signal) {
				const onAbort = () => opts.harnessRunManager.cancel(runId);
				if (signal.aborted) onAbort();
				else signal.addEventListener("abort", onAbort, { once: true });
			}
			const run = await waitForHarnessRun(opts.harnessRunManager, runId);
			const outcome = harnessOutcome(run);
			const state = outcome.state;
			let text = outcome.text;
			if (worktree) {
				try {
					text = await finalizeWorktree(worktree, outcome.text);
				} catch (error) {
					console.error(`subagent: worktree cleanup failed for run "${id}":`, error);
				}
			}
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

const subagentSendSchema = Type.Object({
	id: Type.String({ description: "Run id returned by the subagent tool." }),
	message: Type.String({ description: "Follow-up message to send into the child agent's conversation." }),
});
export type SubagentSendToolInput = Static<typeof subagentSendSchema>;

/**
 * Builds the subagent_send tool: sends a follow-up message into a child spawned by the subagent
 * tool, continuing its conversation. Queues the message (FIFO) if the child is still running, or
 * resumes it (continuing its own provider conversation) if it is idle. The child's completion of
 * that turn notifies the parent the same way a background run does.
 */
export function createSubagentSendToolDefinition(opts: SubagentToolOptions): ToolDefinition<typeof subagentSendSchema> {
	return {
		name: "subagent_send",
		label: "subagent send",
		description:
			"Send a follow-up message into a running or finished subagent run, continuing its conversation with context intact. Queues if the child is still working, or resumes it if idle. Its reply arrives as a background-completion notification (poll with subagent_output).",
		promptSnippet: "Send a follow-up message to a subagent run",
		parameters: subagentSendSchema,
		async execute(_toolCallId, { id, message }) {
			const record = opts.registry.get(id);
			if (!record) {
				throw new Error(`subagent_send: unknown run "${id}"`);
			}
			if (record.sessionId === undefined) {
				throw new Error(
					`subagent_send: run "${id}" cannot receive follow-up messages (it was not spawned with a session)`,
				);
			}
			// Mirror getChildComposerRoute's "generic providers are not resumable" gate: a non-resumable
			// harness cannot continue a conversation, so reject as data rather than starting a doomed run.
			const harness = opts.harnessRunManager.getHarness(record.harness);
			if (harness?.resumable !== true) {
				throw new Error(
					`subagent_send: harness "${record.harness}" is not resumable — run "${id}" cannot receive follow-up messages`,
				);
			}

			let result: { runId?: string; queued: boolean };
			try {
				result = opts.harnessRunManager.submitPrompt(record.sessionId, message);
			} catch (error) {
				const errMessage = error instanceof Error ? error.message : String(error);
				throw new Error(`subagent_send: could not deliver message to run "${id}": ${errMessage}`);
			}
			// A new turn is under way; reflect it so subagent_output no longer reports the prior turn as done.
			record.state = "running";

			const text = result.queued
				? `Queued follow-up for subagent run "${id}"; it will be delivered when the child's current turn finishes. The reply will arrive as a background-completion notification. Poll with subagent_output id "${id}".`
				: `Resumed subagent run "${id}" with your follow-up. The reply will arrive as a background-completion notification. Poll with subagent_output id "${id}".`;
			return { content: [{ type: "text" as const, text }], details: undefined };
		},
	};
}
