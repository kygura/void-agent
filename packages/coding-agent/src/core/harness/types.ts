/**
 * The harness seam: the small, stable surface every harness adapter (claude,
 * codex, generic) implements and that HarnessRunManager consumes. Adapters
 * translate a CLI's raw output into the normalized HarnessEvent stream
 * declared here; nothing above this seam knows which CLI produced an event.
 */

import type { Event, ExplicitEffort, RunConfig } from "@void/orchestrator";

/** Discriminant for HarnessEvent. The kind determines which fields are meaningful. */
export type HarnessEventKind = "started" | "text" | "thinking" | "tool" | "result" | "exit";

/** Token/cost figures for a run, populated when the harness reports them. */
export interface HarnessUsage {
	inputTokens: number;
	outputTokens: number;
	costUsd?: number;
}

/**
 * One flat, JSON-serializable, harness-normalized item in a run's stream.
 * This single shape is both the in-memory stream type and the persistence
 * record — Kind selects which fields apply; fields not relevant to a Kind
 * are simply omitted.
 */
export interface HarnessEvent {
	kind: HarnessEventKind;
	/** ISO-8601 timestamp of when the event was produced. */
	timestamp: string;

	/** "started": the provider's own conversation id, once known. */
	providerSessionId?: string;

	/** "text" / "thinking" / "result" (final message). */
	text?: string;

	/** "tool": tool name, a human-readable input summary, and completion flag. */
	tool?: string;
	toolInput?: string;
	toolDone?: boolean;

	/** "result": logical failure flag and usage, when known. */
	isError?: boolean;
	usage?: HarnessUsage;

	/** "exit": the child process exit code. */
	exitCode?: number;
}

/**
 * Fully describes one run. The prompt is passed to the child as a discrete
 * argv element or stdin by the adapter — never interpolated into a shell
 * line (trust boundary, see proc.ts).
 */
export interface HarnessRunConfig {
	prompt: string;
	model?: string;
	effort?: string;
	cwd?: string;
	env?: Record<string, string>;
	/**
	 * When set, asks a resume-capable harness to continue the prior provider
	 * conversation with that id. Harnesses that are not resumable ignore it.
	 */
	providerSessionId?: string;
	extraArgs?: string[];
}

/**
 * A harness adapter. One start() call is one run: it returns an async
 * iterable of events that ends once the underlying process exits — the last
 * event is always an "exit" event.
 */
export interface Harness {
	id: string;
	resumable: boolean;
	start(cfg: HarnessRunConfig, signal: AbortSignal): AsyncIterable<HarnessEvent>;
}

/** Current time as an ISO-8601 string, used to timestamp every HarnessEvent. */
export function nowIso(): string {
	return new Date().toISOString();
}

/** Converts the committed harness event shape to the canonical orchestrator event contract. */
export function toOrchestratorEvent(event: HarnessEvent): Event {
	return {
		kind: event.kind,
		...(event.providerSessionId === undefined ? {} : { providerSessionId: event.providerSessionId }),
		...(event.text === undefined ? {} : { text: event.text }),
		...(event.tool === undefined ? {} : { tool: event.tool }),
		...(event.toolInput === undefined ? {} : { detail: event.toolInput }),
		...(event.toolDone === undefined ? {} : { done: event.toolDone }),
		...(event.isError === undefined ? {} : { isError: event.isError }),
		...(event.usage === undefined ? {} : { usage: { ...event.usage } }),
		...(event.exitCode === undefined ? {} : { exitCode: event.exitCode }),
	};
}

/** Converts a canonical orchestrator event to the timestamped committed harness shape. */
export function fromOrchestratorEvent(event: Event, timestamp = nowIso()): HarnessEvent | undefined {
	if (event.kind === "subagentResult") return undefined;
	return {
		kind: event.kind,
		timestamp,
		...(event.providerSessionId === undefined ? {} : { providerSessionId: event.providerSessionId }),
		...(event.text === undefined ? {} : { text: event.text }),
		...(event.tool === undefined ? {} : { tool: event.tool }),
		...(event.detail === undefined ? {} : { toolInput: event.detail }),
		...(event.done === undefined ? {} : { toolDone: event.done }),
		...(event.isError === undefined ? {} : { isError: event.isError }),
		...(event.usage === undefined
			? {}
			: {
					usage: {
						inputTokens: event.usage.inputTokens ?? 0,
						outputTokens: event.usage.outputTokens ?? 0,
						...(event.usage.costUsd === undefined ? {} : { costUsd: event.usage.costUsd }),
					},
				}),
		...(event.exitCode === undefined ? {} : { exitCode: event.exitCode }),
	};
}

export function toOrchestratorRunConfig(provider: string, config: HarnessRunConfig): RunConfig {
	const effort = normalizeEffort(config.effort);
	return {
		provider,
		prompt: config.prompt,
		...(config.cwd === undefined ? {} : { workdir: config.cwd }),
		...(config.model === undefined ? {} : { model: config.model }),
		...(effort === undefined ? {} : { effort }),
		...(config.extraArgs === undefined ? {} : { extraArgs: [...config.extraArgs] }),
		...(config.env === undefined ? {} : { env: Object.entries(config.env).map(([key, value]) => `${key}=${value}`) }),
		...(config.providerSessionId === undefined ? {} : { providerSessionId: config.providerSessionId }),
	};
}

export function fromOrchestratorRunConfig(config: RunConfig): HarnessRunConfig {
	return {
		prompt: config.prompt,
		...(config.workdir === undefined ? {} : { cwd: config.workdir }),
		...(config.model === undefined ? {} : { model: config.model }),
		...(config.effort === undefined || config.effort === "" ? {} : { effort: config.effort }),
		...(config.extraArgs === undefined ? {} : { extraArgs: [...config.extraArgs] }),
		...(config.env === undefined ? {} : { env: environmentRecord(config.env) }),
		...(config.providerSessionId === undefined ? {} : { providerSessionId: config.providerSessionId }),
	};
}

export async function* fromOrchestratorEvents(events: AsyncIterable<Event>): AsyncGenerator<HarnessEvent> {
	for await (const event of events) {
		const converted = fromOrchestratorEvent(event);
		if (converted !== undefined) yield converted;
	}
}

function normalizeEffort(value: string | undefined): ExplicitEffort | "" | undefined {
	if (value === "low" || value === "medium" || value === "high") return value;
	return value === undefined ? undefined : "";
}

function environmentRecord(entries: readonly string[]): Record<string, string> {
	const result: Record<string, string> = {};
	for (const entry of entries) {
		const separator = entry.indexOf("=");
		if (separator <= 0) continue;
		result[entry.slice(0, separator)] = entry.slice(separator + 1);
	}
	return result;
}
