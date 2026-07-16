/**
 * Shared adapter runtime behind every harness in this directory: it spawns a
 * process via proc.ts, feeds each stdout line to a pure parseLine, forwards
 * every event produced, and once the process exits calls finalize to decide
 * whether a trailing "result" event must be synthesized. It always ends the
 * stream with exactly one "exit" event.
 *
 * Shared resilience rule: a non-JSON line on a JSON stream and an unknown
 * event type are never fatal — adapters express that in parseLine by
 * degrading to a raw text event or returning no events, never throwing.
 */

import { type ProcResult, type ProcSpec, spawnProc } from "./proc.js";
import { type HarnessEvent, nowIso } from "./types.js";

export type ParseLine = (line: string) => HarnessEvent[];

/**
 * Decides whether a trailing "result" event must be synthesized once the
 * process has exited. Returning undefined means a result was already parsed
 * from the stream (sawResult) and nothing more is needed.
 */
export type Finalize = (result: ProcResult, sawResult: boolean) => HarnessEvent | undefined;

/**
 * Runs spec to completion, yielding every HarnessEvent parseLine produces
 * from stdout, then finalize's synthesized result (if any), then exactly one
 * "exit" event.
 */
export async function* runHarnessProc(
	spec: ProcSpec,
	parseLine: ParseLine,
	finalize: Finalize,
	signal: AbortSignal,
): AsyncGenerator<HarnessEvent> {
	const handle = spawnProc(spec, signal);
	let sawResult = false;
	for await (const line of handle.lines) {
		for (const event of parseLine(line)) {
			if (event.kind === "result") sawResult = true;
			yield event;
		}
	}
	const result = await handle.result;
	const finalEvent = finalize(result, sawResult);
	if (finalEvent) yield finalEvent;
	yield { kind: "exit", timestamp: nowIso(), exitCode: result.exitCode };
}

/**
 * The end-of-run policy shared by claude.ts and codex.ts: both adapters
 * normally parse their own "result" event out of the CLI's JSON stream. When
 * the CLI exits without one, a result is synthesized so callers always get
 * exactly one "result" event to close the turn: a non-error result on a
 * clean exit (the CLI just never printed a result line), or an error result
 * carrying the stderr tail when the process died (non-zero exit, signal
 * death, or a spawn/IO error). When a result was already parsed, do nothing.
 */
export function finalizeStructured(result: ProcResult, sawResult: boolean): HarnessEvent | undefined {
	if (sawResult) return undefined;
	if (result.exitCode === 0 && !result.error) {
		return { kind: "result", timestamp: nowIso() };
	}
	return { kind: "result", timestamp: nowIso(), isError: true, text: result.stderrTail.trim() };
}
