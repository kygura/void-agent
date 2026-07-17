/** Shared run view model used by inline spawn entries, the sidebar, and /agents. */
import type {
	Event,
	ExplicitEffort,
	OrchestratorState,
	ProviderType,
	RunSnapshot,
	SessionSnapshot,
} from "@void/orchestrator";
import { truncateToWidth } from "@void/tui";
import type { HarnessEvent, HarnessRun, HarnessRunManager } from "../../../core/harness/index.js";
import type { SubagentRegistry, SubagentRunRecord } from "../../../core/tools/subagent.js";
import { theme } from "../theme/theme.js";

export type AgentRunState = "pending" | "running" | "done" | "failed" | "cancelled";
export type AgentRunOrigin = "subagent" | "harness" | "session" | "task";

export interface AgentRunSummary {
	id: string;
	runId: string;
	name: string;
	provider: string;
	harnessId: string;
	origin: AgentRunOrigin;
	state: AgentRunState;
	startTime: string;
	endTime?: string;
	description?: string;
	lastActivity?: string;
	parentSessionId?: string;
	providerSessionId?: string;
	model?: string;
	effort?: ExplicitEffort;
	queue?: readonly string[];
	providerType?: ProviderType;
}

export interface AgentRunGroup {
	label: "running" | "pending" | "finished";
	runs: AgentRunSummary[];
}

export type AgentRunCancelResult = { cancelled: true } | { cancelled: false; reason: string };

export function cancelAgentRun(
	run: AgentRunSummary,
	harnessRunManager: HarnessRunManager | undefined,
	orchestrationHost: { cancel(id: string): boolean } | undefined,
): AgentRunCancelResult {
	if (run.state !== "pending" && run.state !== "running") {
		return { cancelled: false, reason: `cannot cancel ${run.name}: run is no longer live` };
	}
	try {
		if (run.origin === "subagent") {
			if (harnessRunManager === undefined) {
				return { cancelled: false, reason: `cannot cancel ${run.name}: harness manager is unavailable` };
			}
			harnessRunManager.cancel(run.runId);
			return { cancelled: true };
		}
		if (run.origin === "harness") {
			if (harnessRunManager === undefined) {
				return { cancelled: false, reason: `cannot cancel ${run.name}: harness manager is unavailable` };
			}
			harnessRunManager.cancel(run.runId);
			return { cancelled: true };
		}
		if (orchestrationHost === undefined) {
			return { cancelled: false, reason: `cannot cancel ${run.name}: orchestration host is unavailable` };
		}
		const cancelled = orchestrationHost.cancel(run.origin === "session" ? run.id : run.runId);
		return cancelled
			? { cancelled: true }
			: { cancelled: false, reason: `cannot cancel ${run.name}: no matching live run` };
	} catch (error) {
		return {
			cancelled: false,
			reason: `cannot cancel ${run.name}: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

export const STATE_GLYPHS: Record<AgentRunState, string> = {
	pending: "○",
	running: "⠋",
	done: "✓",
	failed: "✗",
	cancelled: "⊘",
};

export function formatElapsed(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	if (totalSeconds < 1) return `${Math.max(0, Math.round(ms))}ms`;
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes < 60) return seconds === 0 ? `${minutes}m` : `${minutes}m${seconds}s`;
	const hours = Math.floor(minutes / 60);
	const remainingMinutes = minutes % 60;
	return remainingMinutes === 0 ? `${hours}h` : `${hours}h${remainingMinutes}m`;
}

export function elapsedMs(run: Pick<AgentRunSummary, "startTime" | "endTime">, now: number = Date.now()): number {
	const started = Date.parse(run.startTime);
	const ended = run.endTime === undefined ? now : Date.parse(run.endTime);
	return Number.isFinite(started) && Number.isFinite(ended) ? Math.max(0, ended - started) : 0;
}

/** Merge the owner's direct agents/harness runs with orchestrated child Sessions and TaskRuns. */
export function collectAgentRuns(
	subagentRuns: readonly SubagentRunRecord[],
	harnessRuns: readonly HarnessRun[],
	orchestration?: OrchestratorState,
): AgentRunSummary[] {
	const linkedHarnessRunIds = new Set(
		subagentRuns.map((item) => item.harnessRunId).filter((id): id is string => id !== undefined),
	);
	const summaries: AgentRunSummary[] = subagentRuns.map((item) => ({
		id: item.id,
		runId: item.harnessRunId ?? item.id,
		name: item.agent,
		provider: item.harness,
		harnessId: item.harness,
		origin: "subagent",
		state: item.state,
		startTime: item.startTime,
		...(item.endTime === undefined ? {} : { endTime: item.endTime }),
		...(item.description === undefined ? {} : { description: item.description }),
		...(item.finalText === undefined
			? item.error === undefined
				? {}
				: { lastActivity: item.error }
			: { lastActivity: singleLine(item.finalText) }),
	}));

	for (const item of harnessRuns) {
		if (linkedHarnessRunIds.has(item.id)) continue;
		summaries.push({
			id: item.id,
			runId: item.id,
			name: item.harnessId,
			provider: item.harnessId,
			harnessId: item.harnessId,
			origin: "harness",
			state: item.state,
			startTime: item.startTime,
			...(item.endTime === undefined ? {} : { endTime: item.endTime }),
			description: item.prompt,
			...(lastHarnessActivity(item.events) === undefined ? {} : { lastActivity: lastHarnessActivity(item.events) }),
		});
	}

	if (orchestration !== undefined) {
		const runsById = new Map(orchestration.runs.map((item) => [item.id, item]));
		for (const child of orchestration.sessions) {
			if (child.parentSessionId === undefined) continue;
			const latestRunId = child.runIds.at(-1);
			const latestRun = latestRunId === undefined ? undefined : runsById.get(latestRunId);
			if (latestRun === undefined) continue;
			summaries.push(fromSession(child, latestRun));
		}
		for (const task of orchestration.taskRuns) summaries.push(fromRun(task, "task"));
	}

	return summaries;
}

export function groupAgentRuns(runs: readonly AgentRunSummary[]): AgentRunGroup[] {
	const running = runs.filter((item) => item.state === "running").sort(newestFirst);
	const pending = runs.filter((item) => item.state === "pending").sort(newestFirst);
	const finished = runs
		.filter((item) => item.state !== "running" && item.state !== "pending")
		.sort((a, b) => Date.parse(b.endTime ?? b.startTime) - Date.parse(a.endTime ?? a.startTime));
	return [
		...(running.length === 0 ? [] : [{ label: "running" as const, runs: running }]),
		...(pending.length === 0 ? [] : [{ label: "pending" as const, runs: pending }]),
		...(finished.length === 0 ? [] : [{ label: "finished" as const, runs: finished }]),
	];
}

export function renderRunRow(run: AgentRunSummary, width: number, now: number = Date.now()): string {
	const glyphColor =
		run.state === "done"
			? "success"
			: run.state === "failed"
				? "error"
				: run.state === "running"
					? "accent"
					: "muted";
	const glyph = theme.fg(glyphColor, STATE_GLYPHS[run.state]);
	const essential = `${glyph} ${theme.bold(run.name)}`;
	if (width <= 24) return truncateToWidth(essential, Math.max(1, width));
	const elapsed = formatElapsed(elapsedMs(run, now));
	const metadata = theme.fg(
		"muted",
		[run.provider, run.model, run.effort, `${run.state} ${elapsed}`]
			.filter((value) => value !== undefined)
			.join(" · "),
	);
	const tail = run.lastActivity ?? run.description;
	const line = `${essential}  ${metadata}${tail === undefined || tail === "" ? "" : `  ${theme.fg("dim", `· ${tail}`)}`}`;
	return truncateToWidth(line, Math.max(1, width));
}

export function getRunOutputText(
	summary: AgentRunSummary,
	subagentRegistry: SubagentRegistry | undefined,
	harnessRunManager: HarnessRunManager | undefined,
): string {
	const record = subagentRegistry?.get(summary.id);
	if (record) {
		if (record.finalText) return record.finalText;
		if (record.error) return `Error: ${record.error}`;
		if (record.harnessRunId && harnessRunManager) {
			const output = formatHarnessEvents(harnessRunManager.runEvents(record.harnessRunId));
			if (output !== "") return output;
		}
		return record.state === "running" ? "(running, no output yet)" : "(no output)";
	}
	if (harnessRunManager) {
		const output = formatHarnessEvents(harnessRunManager.runEvents(summary.runId));
		if (output !== "") return output;
		return summary.state === "pending" || summary.state === "running" ? "(running, no output yet)" : "(no output)";
	}
	return "(no output)";
}

function fromSession(session: SessionSnapshot, run: RunSnapshot): AgentRunSummary {
	return {
		...fromRun(run, "session"),
		id: session.id,
		name: session.name ?? run.name ?? run.provider,
		parentSessionId: session.parentSessionId,
		...(session.providerSessionId === undefined ? {} : { providerSessionId: session.providerSessionId }),
		...(session.model === undefined ? {} : { model: session.model }),
		...(session.effort === undefined ? {} : { effort: session.effort }),
		queue: session.queue.prompts,
	};
}

function fromRun(run: RunSnapshot, origin: "session" | "task"): AgentRunSummary {
	return {
		id: run.sessionId ?? run.id,
		runId: run.id,
		name: run.name ?? run.provider,
		provider: run.provider,
		harnessId: run.provider,
		origin,
		state: run.state,
		startTime: run.startedAt,
		...(run.endedAt === undefined ? {} : { endTime: run.endedAt }),
		description: run.prompt,
		...(run.finalText === undefined ? {} : { lastActivity: singleLine(run.finalText) }),
		...(run.providerSessionId === undefined ? {} : { providerSessionId: run.providerSessionId }),
		...(run.model === undefined ? {} : { model: run.model }),
		...(run.effort === undefined ? {} : { effort: run.effort }),
	};
}

function newestFirst(a: AgentRunSummary, b: AgentRunSummary): number {
	return Date.parse(b.startTime) - Date.parse(a.startTime);
}

function singleLine(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function lastHarnessActivity(events: readonly HarnessEvent[]): string | undefined {
	const event = events.at(-1);
	if (event === undefined) return undefined;
	if (event.kind === "text" || event.kind === "thinking" || event.kind === "result")
		return singleLine(event.text ?? "");
	if (event.kind === "tool") return `${event.tool}${event.toolInput ? ` ${singleLine(event.toolInput)}` : ""}`;
	return undefined;
}

function formatHarnessEvents(events: readonly HarnessEvent[]): string {
	return events
		.flatMap((event) => {
			if (event.kind === "text" || event.kind === "thinking" || event.kind === "result") {
				return event.text === undefined ? [] : [event.text];
			}
			if (event.kind === "tool") {
				return [`[tool: ${event.tool ?? "tool"}${event.toolInput ? ` ${event.toolInput}` : ""}]`];
			}
			return [];
		})
		.join("\n");
}

export function lastOrchestratorActivity(events: readonly Event[]): string | undefined {
	const event = [...events].reverse().find((item) => item.kind !== "started" && item.kind !== "exit");
	if (event === undefined) return undefined;
	if (event.kind === "text" || event.kind === "thinking" || event.kind === "result")
		return singleLine(event.text ?? "");
	if (event.kind === "tool") return `${event.tool ?? "tool"}${event.detail ? ` ${singleLine(event.detail)}` : ""}`;
	if (event.kind === "subagentResult") return singleLine(event.text ?? "");
	return undefined;
}
