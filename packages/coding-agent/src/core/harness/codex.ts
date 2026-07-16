/**
 * Harness adapter for the `codex exec --json` CLI. codex's JSONL schema has
 * shifted across versions (older TaskStarted/TaskComplete/AgentMessage shape
 * vs. newer thread/item naming); parseCodexLine is best-effort and skips
 * anything it doesn't recognize.
 */

import { buildCodexArgv, CodexProvider, parseCodexLine as parseOrchestratorCodexLine } from "@void/orchestrator";
import {
	fromOrchestratorEvent,
	fromOrchestratorEvents,
	type Harness,
	type HarnessEvent,
	type HarnessRunConfig,
	toOrchestratorRunConfig,
} from "./types.js";

/**
 * Builds the argv for a codex run. Pure function so tests can assert the
 * exact array without spawning a process; the prompt is always a single,
 * discrete argv element (never shell-interpolated).
 */
export function codexArgs(cfg: HarnessRunConfig): string[] {
	return [...buildCodexArgv(toOrchestratorRunConfig("codex", cfg))].slice(1);
}

/** Covers fields used across the event types this adapter recognizes. */
interface CodexEnvelope {
	type?: string;
	session_id?: string;
	// AgentMessage, Error
	message?: string;
	// AgentReasoning
	text?: string;
	// TaskComplete
	last_agent_message?: string;
	// ExecCommandBegin
	command?: string | string[];
	// ExecCommandEnd
	exit_code?: number;
}

function formatCommand(command?: string | string[]): string {
	return Array.isArray(command) ? command.join(" ") : (command ?? "");
}

/**
 * Turns one line of codex's --json JSONL into zero or more events. Pure
 * function so tests can feed fixture lines directly.
 */
export function parseCodexLine(line: string): HarnessEvent[] {
	const normalized = normalizeLegacyCommand(line);
	return parseOrchestratorCodexLine(normalized).flatMap((event) => {
		const converted = fromOrchestratorEvent(event);
		return converted === undefined ? [] : [converted];
	});
}

function normalizeLegacyCommand(line: string): string {
	let value: CodexEnvelope;
	try {
		value = JSON.parse(line) as CodexEnvelope;
	} catch {
		return line;
	}
	if (value.type !== "ExecCommandBegin" || !Array.isArray(value.command)) return line;
	return JSON.stringify({ ...value, command: formatCommand(value.command) });
}

/** Adapts the `codex` CLI. No config needed: the binary is looked up on PATH. */
export class CodexHarness implements Harness {
	readonly id = "codex";
	readonly resumable = true;
	private readonly provider = new CodexProvider();

	start(cfg: HarnessRunConfig, signal: AbortSignal): AsyncIterable<HarnessEvent> {
		return fromOrchestratorEvents(this.provider.start(toOrchestratorRunConfig(this.id, cfg), signal));
	}
}
