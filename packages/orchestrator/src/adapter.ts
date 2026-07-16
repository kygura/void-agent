import type { ProcessResult, ProcessSpec } from "./process.js";
import { spawnProcess } from "./process.js";
import type { Adapter, Event } from "./types.js";

export type ResultPolicy = "structured" | "plain";

export interface ProcessAdapterOptions {
	readonly spec: ProcessSpec;
	readonly adapter: Adapter;
	readonly resultPolicy?: ResultPolicy;
}

/**
 * Run one process-backed Adapter. All failures after the request is accepted
 * are normalized into a single result followed by a single exit event.
 */
export async function* runProcessAdapter(options: ProcessAdapterOptions, signal?: AbortSignal): AsyncIterable<Event> {
	let parsedResult: Event | undefined;
	let parserFailure: string | undefined;
	const handle = spawnProcess(options.spec, signal);

	try {
		for await (const line of handle.lines) {
			let events: readonly Event[];
			try {
				events = options.adapter.parseLine(line);
			} catch (error) {
				parserFailure = errorMessage(error);
				await handle.cancel();
				break;
			}
			for (const event of events) {
				if (event.kind === "exit") continue;
				if (event.kind === "result") {
					parsedResult ??= event;
					continue;
				}
				yield event;
			}
		}
	} catch (error) {
		parserFailure = errorMessage(error);
		await handle.cancel();
	}

	const processResult = await handle.result;
	let finishEvents: readonly Event[] = [];
	try {
		finishEvents = options.adapter.finish(processResult.exitCode);
	} catch (error) {
		parserFailure ??= errorMessage(error);
	}
	for (const event of finishEvents) {
		if (event.kind === "result") parsedResult ??= event;
		else if (event.kind !== "exit") yield event;
	}

	yield finalResult(options.resultPolicy ?? "structured", parsedResult, processResult, parserFailure);
	yield { kind: "exit", exitCode: processResult.exitCode };
}

/** A failed Run stream for validation errors such as unsupported resume. */
export async function* failedRun(message: string, exitCode = -1): AsyncIterable<Event> {
	yield { kind: "result", text: message, isError: true };
	yield { kind: "exit", exitCode };
}

function finalResult(
	policy: ResultPolicy,
	parsed: Event | undefined,
	processResult: ProcessResult,
	parserFailure: string | undefined,
): Event {
	const failed = processResult.exitCode !== 0 || processResult.error !== undefined || parserFailure !== undefined;
	const diagnostic = terminalDiagnostic(processResult, parserFailure);
	if (policy === "plain") {
		return {
			kind: "result",
			...(failed ? { isError: true } : { isError: false }),
			...(failed && diagnostic !== "" ? { text: diagnostic } : {}),
		};
	}
	if (parsed === undefined) {
		return {
			kind: "result",
			...(failed ? { isError: true } : { isError: false }),
			...(diagnostic === "" ? {} : { text: diagnostic }),
		};
	}
	if (!failed) return parsed;
	return {
		...parsed,
		isError: true,
		...(parsed.text === undefined && diagnostic !== "" ? { text: diagnostic } : {}),
	};
}

function terminalDiagnostic(result: ProcessResult, parserFailure: string | undefined): string {
	if (parserFailure !== undefined) return `adapter parser failed: ${parserFailure}`;
	const stderr = result.stderrTail.trim();
	if (stderr !== "") return stderr;
	if (result.error !== undefined) return `${result.error.source}: ${result.error.message}`;
	return "";
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
