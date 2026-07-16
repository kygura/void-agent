/**
 * Harness adapter for the `claude` CLI's stream-json output
 * (`claude -p --output-format stream-json --verbose --include-partial-messages`).
 */

import { buildClaudeArgv, ClaudeProvider, parseClaudeLine as parseOrchestratorClaudeLine } from "@void/orchestrator";
import {
	fromOrchestratorEvent,
	fromOrchestratorEvents,
	type Harness,
	type HarnessEvent,
	type HarnessRunConfig,
	toOrchestratorRunConfig,
} from "./types.js";

/**
 * Builds the argv for a claude run. Pure function so tests can assert the
 * exact array without spawning a process; the prompt is always a single,
 * discrete argv element (never shell-interpolated).
 */
export function claudeArgs(cfg: HarnessRunConfig): string[] {
	return [...buildClaudeArgv(toOrchestratorRunConfig("claude", cfg))].slice(1);
}

/**
 * Turns one line of claude's stream-json JSONL into zero or more events.
 * Pure function so tests can feed fixture lines directly.
 *
 * Text/thinking dedup rule: with --include-partial-messages, claude streams
 * assistant text and thinking incrementally as stream_event
 * content_block_delta events *before* it emits the full "assistant" message
 * containing the same content as complete blocks. To avoid emitting every
 * piece of text twice, only stream_event deltas produce "text"/"thinking"
 * events; the assistant message is used solely to surface tool_use blocks,
 * since tool input isn't emitted as readable deltas. The final message text
 * is carried by the "result" event instead.
 */
export function parseClaudeLine(line: string): HarnessEvent[] {
	return parseOrchestratorClaudeLine(line).flatMap((event) => {
		const converted = fromOrchestratorEvent(event);
		return converted === undefined ? [] : [converted];
	});
}

/** Adapts the `claude` CLI. No config needed: the binary is looked up on PATH. */
export class ClaudeHarness implements Harness {
	readonly id = "claude";
	readonly resumable = true;
	private readonly provider = new ClaudeProvider();

	start(cfg: HarnessRunConfig, signal: AbortSignal): AsyncIterable<HarnessEvent> {
		return fromOrchestratorEvents(this.provider.start(toOrchestratorRunConfig(this.id, cfg), signal));
	}
}
