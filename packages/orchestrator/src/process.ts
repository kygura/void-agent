/** Bun-backed subprocess handling for process-based Providers. */

export const MAX_STDOUT_LINE_BYTES = 1 << 20;
export const STDERR_TAIL_BYTES = 8 << 10;

const DEFAULT_KILL_GRACE_MS = 3000;
const DEFAULT_POST_KILL_TIMEOUT_MS = 1000;
const MAX_QUEUED_LINES = 32;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type ProcessSignal = NodeJS.Signals | number | null;
export type ProcessErrorSource = "spawn" | "stdout" | "stderr" | "wait";

export interface ProcessError {
	readonly source: ProcessErrorSource;
	readonly name: string;
	readonly message: string;
	readonly code?: string;
}

/** A final argv array plus process-local execution options. */
export interface ProcessSpec {
	readonly argv: readonly string[];
	readonly cwd?: string;
	/** The complete child environment. Omit it to inherit Bun's startup environment. */
	readonly env?: Readonly<Record<string, string | undefined>>;
	readonly stdin?: string | Uint8Array;
	readonly killGraceMs?: number;
	readonly postKillTimeoutMs?: number;
}

/** Terminal process data. Non-zero exits are represented by exitCode, not error. */
export interface ProcessResult {
	readonly exitCode: number;
	readonly signal: ProcessSignal;
	readonly stderrTail: string;
	readonly error?: ProcessError;
}

export interface ProcessHandle {
	readonly pid?: number;
	/** A bounded, single-consumer stream. Consume it while awaiting result. */
	readonly lines: AsyncIterable<string>;
	/** Resolves only after stdout/stderr are drained and the direct child is reaped. */
	readonly result: Promise<ProcessResult>;
	/** Idempotently requests SIGTERM followed by bounded SIGKILL escalation. */
	cancel(): Promise<void>;
	/** Stops line delivery, cancels the process group, drains its pipes, and reaps it. */
	close(): Promise<ProcessResult>;
}

interface BunErrorLike {
	readonly name?: string;
	readonly message: string;
	readonly code?: string;
}

interface BunSpawnReport {
	readonly exitCode: number | null;
	readonly signal: ProcessSignal;
	readonly error?: BunErrorLike;
}

interface BunSubprocess {
	readonly pid: number;
	readonly stdout: ReadableStream<Uint8Array>;
	readonly stderr: ReadableStream<Uint8Array>;
	readonly exited: Promise<number>;
	readonly signalCode: ProcessSignal;
	kill(signal?: NodeJS.Signals | number): void;
}

interface BunSpawnOptions {
	readonly cwd?: string;
	readonly env?: Readonly<Record<string, string | undefined>>;
	readonly detached: boolean;
	readonly stdin: "ignore" | Uint8Array;
	readonly stdout: "pipe";
	readonly stderr: "pipe";
	readonly onExit: (
		process: BunSubprocess,
		exitCode: number | null,
		signal: ProcessSignal,
		error?: BunErrorLike,
	) => void;
}

interface BunRuntime {
	spawn(argv: string[], options: BunSpawnOptions): BunSubprocess;
}

const bun = (globalThis as typeof globalThis & { readonly Bun: BunRuntime }).Bun;

class TailBuffer {
	private bytes = new Uint8Array(0);

	public constructor(private readonly maxBytes: number) {}

	public write(chunk: Uint8Array): void {
		if (this.maxBytes === 0) return;
		if (chunk.byteLength >= this.maxBytes) {
			this.bytes = chunk.slice(chunk.byteLength - this.maxBytes);
			return;
		}
		const overflow = Math.max(0, this.bytes.byteLength + chunk.byteLength - this.maxBytes);
		const retained = this.bytes.subarray(overflow);
		const next = new Uint8Array(retained.byteLength + chunk.byteLength);
		next.set(retained);
		next.set(chunk, retained.byteLength);
		this.bytes = next;
	}

	public toString(): string {
		return decoder.decode(this.bytes);
	}
}

class AsyncLineQueue implements AsyncIterable<string> {
	private readonly values: string[] = [];
	private readonly readers: Array<(result: IteratorResult<string>) => void> = [];
	private readonly producers: Array<() => void> = [];
	private ended = false;
	private discarding = false;
	private claimed = false;

	public constructor(private readonly capacity: number) {}

	public async push(value: string): Promise<void> {
		while (!this.ended && !this.discarding && this.values.length >= this.capacity && this.readers.length === 0) {
			await new Promise<void>((resolve) => this.producers.push(resolve));
		}
		if (this.ended || this.discarding) return;
		const reader = this.readers.shift();
		if (reader !== undefined) {
			reader({ value, done: false });
			return;
		}
		this.values.push(value);
	}

	public finish(): void {
		if (this.ended) return;
		this.ended = true;
		this.resolveReaders();
		this.resolveProducers();
	}

	public discard(): void {
		this.discarding = true;
		this.values.length = 0;
		this.finish();
	}

	public [Symbol.asyncIterator](): AsyncIterator<string> {
		if (this.claimed) return emptyAsyncIterator();
		this.claimed = true;
		return {
			next: () => this.next(),
			return: async () => {
				this.discard();
				return { value: undefined, done: true };
			},
		};
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

	private resolveReaders(): void {
		for (const resolve of this.readers.splice(0)) resolve({ value: undefined, done: true });
	}

	private resolveProducers(): void {
		for (const resolve of this.producers.splice(0)) resolve();
	}
}

function emptyAsyncIterator(): AsyncIterator<string> {
	return { next: async () => ({ value: undefined, done: true }) };
}

/**
 * Drain a byte stream into bounded lines. The first maxLineBytes of an
 * oversized line are emitted; its remainder is discarded through the newline.
 */
export async function readBoundedLines(
	stream: ReadableStream<Uint8Array>,
	onLine: (line: string) => void | Promise<void>,
	maxLineBytes = MAX_STDOUT_LINE_BYTES,
): Promise<ProcessError | undefined> {
	const reader = stream.getReader();
	let chunks: Uint8Array[] = [];
	let length = 0;
	let overLimit = false;

	const emit = async (): Promise<void> => {
		let bytes = concatenate(chunks, length);
		if (bytes.byteLength > 0 && bytes[bytes.byteLength - 1] === 0x0d) bytes = bytes.subarray(0, -1);
		chunks = [];
		length = 0;
		await onLine(decoder.decode(bytes));
	};

	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			let offset = 0;
			while (offset < value.byteLength) {
				const newline = value.indexOf(0x0a, offset);
				const end = newline === -1 ? value.byteLength : newline;
				if (!overLimit && end > offset) {
					const piece = value.subarray(offset, end);
					const room = maxLineBytes - length;
					if (piece.byteLength >= room) {
						if (room > 0) {
							chunks.push(piece.subarray(0, room));
							length += room;
						}
						await emit();
						overLimit = true;
					} else {
						chunks.push(piece);
						length += piece.byteLength;
					}
				}
				if (newline === -1) break;
				if (!overLimit) await emit();
				overLimit = false;
				offset = newline + 1;
			}
		}
		if (length > 0) await emit();
		return undefined;
	} catch (error) {
		return processError("stdout", error);
	} finally {
		reader.releaseLock();
	}
}

async function readStderr(stream: ReadableStream<Uint8Array>, tail: TailBuffer): Promise<ProcessError | undefined> {
	const reader = stream.getReader();
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) return undefined;
			tail.write(value);
		}
	} catch (error) {
		return processError("stderr", error);
	} finally {
		reader.releaseLock();
	}
}

/** Spawn an argv array with Bun. This function never invokes a shell. */
export function spawnProcess(spec: ProcessSpec, signal?: AbortSignal, runtime: BunRuntime = bun): ProcessHandle {
	const queue = new AsyncLineQueue(MAX_QUEUED_LINES);
	const invalidArgv = spec.argv.length === 0 || spec.argv[0]?.length === 0;
	if (invalidArgv) {
		queue.finish();
		return terminalHandle({
			exitCode: -1,
			signal: null,
			stderrTail: "",
			error: processError("spawn", new Error("argv must contain a non-empty executable")),
		});
	}

	let report: BunSpawnReport | undefined;
	let subprocess: BunSubprocess;
	try {
		subprocess = runtime.spawn([...spec.argv], {
			cwd: spec.cwd,
			env: spec.env,
			detached: true,
			stdin: spec.stdin === undefined ? "ignore" : toBytes(spec.stdin),
			stdout: "pipe",
			stderr: "pipe",
			onExit: (_process, exitCode, exitSignal, error) => {
				report = { exitCode, signal: exitSignal, error };
			},
		});
	} catch (error) {
		queue.finish();
		return terminalHandle({
			exitCode: -1,
			signal: null,
			stderrTail: "",
			error: processError("spawn", error),
		});
	}

	const tail = new TailBuffer(STDERR_TAIL_BYTES);
	const stdoutDone = readBoundedLines(subprocess.stdout, (line) => queue.push(line)).finally(() => queue.finish());
	const stderrDone = readStderr(subprocess.stderr, tail);
	let reaped = false;
	const reapedResult = reap(subprocess, () => report).then((value) => {
		reaped = true;
		return value;
	});
	let cancellation: Promise<void> | undefined;
	let abortListener: (() => void) | undefined;
	let resolveUnreapable: (result: ProcessResult) => void = () => {};
	const unreapableResult = new Promise<ProcessResult>((resolve) => {
		resolveUnreapable = resolve;
	});

	const cancel = (): Promise<void> => {
		if (cancellation !== undefined) return cancellation;
		if (reaped && (process.platform === "win32" || !processGroupExists(subprocess.pid))) return Promise.resolve();
		cancellation = terminate(
			subprocess,
			reapedResult,
			normalizeGrace(spec.killGraceMs),
			normalizePostKillTimeout(spec.postKillTimeoutMs),
		).then((didReap) => {
			if (didReap) return;
			queue.discard();
			// No retry loop: one timed-out handle can leak at most its one unreapable child and pipe readers.
			resolveUnreapable({
				exitCode: -1,
				signal: "SIGKILL",
				stderrTail: tail.toString(),
				error: processError("wait", new Error("process wedged/unreapable after SIGKILL")),
			});
		});
		return cancellation;
	};
	void stdoutDone.then((error) => {
		if (error !== undefined) void cancel();
	});
	void stderrDone.then((error) => {
		if (error !== undefined) void cancel();
	});

	if (signal !== undefined) {
		abortListener = () => {
			void cancel();
		};
		if (signal.aborted) abortListener();
		else signal.addEventListener("abort", abortListener, { once: true });
	}

	const normalResult = (async (): Promise<ProcessResult> => {
		const [exit, stdoutError, stderrError] = await Promise.all([reapedResult, stdoutDone, stderrDone]);
		if (cancellation !== undefined) await cancellation;
		return {
			exitCode: exit.exitCode,
			signal: exit.signal,
			stderrTail: tail.toString(),
			error: exit.error ?? stdoutError ?? stderrError,
		};
	})();
	const result = Promise.race([normalResult, unreapableResult]).finally(() => {
		if (signal !== undefined && abortListener !== undefined) signal.removeEventListener("abort", abortListener);
	});

	return {
		pid: subprocess.pid,
		lines: queue,
		result,
		cancel,
		close: async () => {
			queue.discard();
			await cancel();
			return result;
		},
	};
}

function terminalHandle(result: ProcessResult): ProcessHandle {
	const lines = new AsyncLineQueue(1);
	lines.finish();
	return {
		lines,
		result: Promise.resolve(result),
		cancel: async () => {},
		close: async () => result,
	};
}

async function reap(
	subprocess: BunSubprocess,
	getReport: () => BunSpawnReport | undefined,
): Promise<{ exitCode: number; signal: ProcessSignal; error?: ProcessError }> {
	let exitedCode = -1;
	let waitError: ProcessError | undefined;
	try {
		exitedCode = await subprocess.exited;
	} catch (error) {
		waitError = processError("wait", error);
	}
	await Promise.resolve();
	const report = getReport();
	return {
		exitCode: report?.exitCode ?? exitedCode,
		signal: report?.signal ?? subprocess.signalCode,
		error: report?.error === undefined ? waitError : processError("wait", report.error),
	};
}

async function terminate(
	subprocess: BunSubprocess,
	reaped: Promise<{ exitCode: number }>,
	graceMs: number,
	postKillTimeoutMs: number,
): Promise<boolean> {
	signalProcess(subprocess, "SIGTERM");
	let graceElapsed = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let resolveGrace: (() => void) | undefined;
	const grace = new Promise<void>((resolve) => {
		resolveGrace = resolve;
		timer = setTimeout(() => {
			graceElapsed = true;
			resolve();
		}, graceMs);
	});

	await Promise.race([reaped, grace]);
	if (!graceElapsed && (process.platform === "win32" || !processGroupExists(subprocess.pid))) {
		if (timer !== undefined) clearTimeout(timer);
		resolveGrace?.();
		return true;
	}
	if (!graceElapsed) await grace;
	signalProcess(subprocess, "SIGKILL");
	return resolvesWithin(reaped, postKillTimeoutMs);
}

function signalProcess(subprocess: BunSubprocess, signal: NodeJS.Signals): void {
	if (process.platform !== "win32") {
		try {
			process.kill(-subprocess.pid, signal);
			return;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
		}
	}
	try {
		subprocess.kill(signal);
	} catch {
		// The process has already exited or this platform cannot deliver the signal.
	}
}

function processGroupExists(pid: number): boolean {
	if (process.platform === "win32") return true;
	try {
		process.kill(-pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

function normalizeGrace(value: number | undefined): number {
	return value === undefined || !Number.isFinite(value) || value <= 0 ? DEFAULT_KILL_GRACE_MS : value;
}

function normalizePostKillTimeout(value: number | undefined): number {
	return value === undefined || !Number.isFinite(value) || value <= 0 ? DEFAULT_POST_KILL_TIMEOUT_MS : value;
}

function resolvesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(false), timeoutMs);
		void promise.then(
			() => {
				clearTimeout(timer);
				resolve(true);
			},
			() => {
				clearTimeout(timer);
				resolve(true);
			},
		);
	});
}

function toBytes(value: string | Uint8Array): Uint8Array {
	return typeof value === "string" ? encoder.encode(value) : value;
}

function concatenate(chunks: readonly Uint8Array[], length: number): Uint8Array {
	if (chunks.length === 1) return chunks[0] ?? new Uint8Array(0);
	const result = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return result;
}

function processError(source: ProcessErrorSource, value: unknown): ProcessError {
	if (value instanceof Error) {
		const code = (value as NodeJS.ErrnoException).code;
		return { source, name: value.name, message: value.message, ...(code === undefined ? {} : { code }) };
	}
	if (isErrorLike(value)) {
		return {
			source,
			name: value.name ?? "Error",
			message: value.message,
			...(value.code === undefined ? {} : { code: value.code }),
		};
	}
	return { source, name: "Error", message: String(value) };
}

function isErrorLike(value: unknown): value is BunErrorLike {
	return typeof value === "object" && value !== null && "message" in value && typeof value.message === "string";
}
