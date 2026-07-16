/**
 * Compatibility adapter for the committed harness process surface. Actual
 * child-process ownership stays in @void/orchestrator; this module only maps
 * its normalized stream back to the legacy ProcHandle shape.
 *
 * Trust boundary (non-negotiable): the child is launched via an argv array
 * (spawn with shell: false), never a shell. Callers place the prompt as a
 * discrete Spec.args element or in Spec.stdin; this module never builds a
 * shell command line, so prompt text is never interpreted by a shell.
 */

import { type Adapter, type Event, runProcessAdapter } from "@void/orchestrator";

const LINE_QUEUE_CAPACITY = 32;

/** Describes a child process to launch. */
export interface ProcSpec {
	/** Executable to run (looked up on PATH if not absolute). */
	path: string;
	/** argv after path; the prompt goes here as a discrete element. */
	args: string[];
	/** Working directory (undefined = inherit). */
	cwd?: string;
	/** Full environment (undefined = inherit parent's). */
	env?: Record<string, string>;
	/** Written to the child's stdin then closed (undefined = no stdin). */
	stdin?: string;
	/** Grace period after SIGTERM before SIGKILL on abort. Defaults to 3000ms. */
	killGraceMs?: number;
}

/** The terminal outcome of a run. */
export interface ProcResult {
	/** Process exit code; 128+signal for signal deaths; -1 on a spawn/IO error. */
	exitCode: number;
	/** Non-null when the process was killed by a signal. */
	signal: NodeJS.Signals | null;
	/** Tail of the child's stderr (last STDERR_TAIL_BYTES). */
	stderrTail: string;
	/** Set only on a non-exit failure (e.g. the executable could not be spawned). */
	error?: Error;
}

/** A running (or finished) child: range over lines, then await result. */
export interface ProcHandle {
	/** Delivers one stdout line at a time (CR/LF stripped); ends at stdout EOF. */
	lines: AsyncIterable<string>;
	/** Resolves once the process has fully exited. */
	result: Promise<ProcResult>;
}

class LineAdapter implements Adapter {
	parseLine(line: string): readonly Event[] {
		return [{ kind: "text", text: line }];
	}

	finish(_exitCode: number): readonly Event[] {
		return [];
	}
}

class LineQueue implements AsyncIterable<string> {
	private readonly values: string[] = [];
	private readonly readers: Array<(result: IteratorResult<string>) => void> = [];
	private readonly producers: Array<() => void> = [];
	private ended = false;

	async push(value: string): Promise<void> {
		while (!this.ended && this.values.length >= LINE_QUEUE_CAPACITY && this.readers.length === 0) {
			await new Promise<void>((resolve) => this.producers.push(resolve));
		}
		if (this.ended) return;
		const reader = this.readers.shift();
		if (reader !== undefined) reader({ value, done: false });
		else this.values.push(value);
	}

	finish(): void {
		if (this.ended) return;
		this.ended = true;
		for (const reader of this.readers.splice(0)) reader({ value: undefined, done: true });
		for (const producer of this.producers.splice(0)) producer();
	}

	[Symbol.asyncIterator](): AsyncIterator<string> {
		return { next: () => this.next() };
	}

	private next(): Promise<IteratorResult<string>> {
		const value = this.values.shift();
		if (value !== undefined) {
			this.producers.shift()?.();
			return Promise.resolve({ value, done: false });
		}
		if (this.ended) return Promise.resolve({ value: undefined, done: true });
		return new Promise<IteratorResult<string>>((resolve) => this.readers.push(resolve));
	}
}

/**
 * Launches the child described by spec and begins streaming its stdout. The
 * child runs detached (its own process group) so a single kill reaches any
 * grandchildren it spawned. When signal aborts, the process group is sent
 * SIGTERM, then SIGKILL after killGraceMs.
 */
export function spawnProc(spec: ProcSpec, signal: AbortSignal): ProcHandle {
	const lines = new LineQueue();
	let resolveResult = (_result: ProcResult): void => {};
	const result = new Promise<ProcResult>((resolve) => {
		resolveResult = resolve;
	});

	void consume(spec, signal, lines).then(resolveResult);
	return { lines, result };
}

async function consume(spec: ProcSpec, signal: AbortSignal, lines: LineQueue): Promise<ProcResult> {
	let resultText = "";
	let resultIsError = false;
	let exitCode = -1;
	try {
		for await (const event of runProcessAdapter(
			{
				spec: {
					argv: [spec.path, ...spec.args],
					...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
					...(spec.env === undefined ? {} : { env: spec.env }),
					...(spec.stdin === undefined ? {} : { stdin: spec.stdin }),
					...(spec.killGraceMs === undefined ? {} : { killGraceMs: spec.killGraceMs }),
				},
				adapter: new LineAdapter(),
				resultPolicy: "plain",
			},
			signal,
		)) {
			if (event.kind === "text") await lines.push(event.text ?? "");
			else if (event.kind === "result") {
				resultText = event.text ?? "";
				resultIsError = event.isError === true;
			} else if (event.kind === "exit") exitCode = event.exitCode ?? -1;
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { exitCode: -1, signal: null, stderrTail: message, error: new Error(message) };
	} finally {
		lines.finish();
	}
	return {
		exitCode,
		signal: null,
		stderrTail: resultText,
		...(exitCode === -1 && resultIsError ? { error: new Error(resultText || "process failed") } : {}),
	};
}
