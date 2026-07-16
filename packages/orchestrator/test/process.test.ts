import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import {
	MAX_STDOUT_LINE_BYTES,
	type ProcessHandle,
	readBoundedLines,
	STDERR_TAIL_BYTES,
	spawnProcess,
} from "../src/process.js";

const fixtureDirectory = new URL("./fixtures/process/", import.meta.url);

function fixture(name: string): string {
	return fileURLToPath(new URL(name, fixtureDirectory));
}

function fixtureArgv(name: string, ...args: readonly string[]): string[] {
	return [process.execPath, fixture(name), ...args];
}

async function collectLines(handle: ProcessHandle): Promise<string[]> {
	const lines: string[] = [];
	for await (const line of handle.lines) lines.push(line);
	return lines;
}

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

async function waitForProcessExit(pid: number): Promise<boolean> {
	const deadline = Date.now() + 2000;
	while (Date.now() < deadline) {
		if (!processExists(pid)) return true;
		await Bun.sleep(20);
	}
	return !processExists(pid);
}

describe("Bun process engine", () => {
	test("passes hostile prompt text as one literal argv element", async () => {
		const prompt = "quotes: ' \"; separators: ; &&; substitution: $(touch nope)\nsecond line";
		const handle = spawnProcess({ argv: fixtureArgv("argv.ts", "--prompt", prompt) });
		const lines = await collectLines(handle);
		const result = await handle.result;

		expect(lines).toEqual([JSON.stringify(["--prompt", prompt])]);
		expect(result).toMatchObject({ exitCode: 0, signal: null, stderrTail: "" });
		expect(result.error).toBeUndefined();
	});

	test("streams complete lines and the final unterminated line", async () => {
		const handle = spawnProcess({ argv: fixtureArgv("emit.ts", "lines") });
		const lines = await collectLines(handle);
		const result = await handle.result;

		expect(lines).toEqual(["first", "second", "final"]);
		expect(result.exitCode).toBe(0);
	});

	test("truncates a long stdout line and keeps only the stderr tail", async () => {
		const handle = spawnProcess({ argv: fixtureArgv("emit.ts", "bounded") });
		const lines = await collectLines(handle);
		const result = await handle.result;

		expect(lines.map((line) => line.length)).toEqual([MAX_STDOUT_LINE_BYTES, 5]);
		expect(lines[1]).toBe("after");
		expect(Buffer.byteLength(result.stderrTail)).toBe(STDERR_TAIL_BYTES);
		expect(result.stderrTail.endsWith("-tail")).toBe(true);
		expect(result.stderrTail.includes("discarded-")).toBe(false);
	});

	test("returns missing executables as terminal data", async () => {
		const handle = spawnProcess({ argv: ["/definitely/missing/void-v004-fixture"] });
		expect(await collectLines(handle)).toEqual([]);
		const result = await handle.result;

		expect(handle.pid).toBeUndefined();
		expect(result.exitCode).toBe(-1);
		expect(result.error?.source).toBe("spawn");
		expect(result.error?.message.includes("ENOENT")).toBe(true);
	});

	test("returns non-zero exits without throwing", async () => {
		const handle = spawnProcess({ argv: fixtureArgv("emit.ts", "nonzero") });
		expect(await collectLines(handle)).toEqual([]);
		const result = await handle.result;

		expect(result.exitCode).toBe(7);
		expect(result.signal).toBeNull();
		expect(result.stderrTail).toBe("fixture failed\n");
		expect(result.error).toBeUndefined();
	});

	test("returns stdout read failures as data after delivering prior lines", async () => {
		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode("before\n"));
				setTimeout(() => controller.error(new Error("fixture read failed")), 5);
			},
		});
		const lines: string[] = [];
		const error = await readBoundedLines(stream, (line) => {
			lines.push(line);
		});

		expect(lines).toEqual(["before"]);
		expect(error?.source).toBe("stdout");
		expect(error?.message).toBe("fixture read failed");
	});

	test("cancel escalates from SIGTERM to SIGKILL", async () => {
		const handle = spawnProcess({
			argv: fixtureArgv("sleep.ts", "--ignore-term"),
			killGraceMs: 100,
		});
		const linesPromise = collectLines(handle);
		await Bun.sleep(50);
		await handle.cancel();
		const lines = await linesPromise;
		const result = await handle.result;

		expect(lines).toEqual(["ready", "term"]);
		expect(result.exitCode).toBe(137);
		expect(result.signal).toBe("SIGKILL");
	});

	test("returns an unreapable child as terminal error data after the post-SIGKILL bound", async () => {
		const closedStream = (): ReadableStream<Uint8Array> =>
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.close();
				},
			});
		const runtime = {
			spawn: (_argv: string[], _options: unknown) => ({
				pid: 2_147_000_000,
				stdout: closedStream(),
				stderr: closedStream(),
				exited: new Promise<number>(() => {}),
				signalCode: null,
				kill: () => {},
			}),
		};
		const handle = spawnProcess(
			{ argv: ["fixture-unreapable"], killGraceMs: 5, postKillTimeoutMs: 5 },
			undefined,
			runtime,
		);
		const startedAt = Date.now();
		await handle.cancel();
		const result = await handle.result;

		expect(Date.now() - startedAt < 100).toBe(true);
		expect(result.exitCode).toBe(-1);
		expect(result.error?.source).toBe("wait");
		expect(result.error?.message.includes("unreapable")).toBe(true);
	});

	test("close kills a POSIX process group including its grandchild", async () => {
		if (process.platform === "win32") return;
		const handle = spawnProcess({
			argv: fixtureArgv("grandchild.ts"),
			killGraceMs: 100,
		});
		const iterator = handle.lines[Symbol.asyncIterator]();
		const first = await iterator.next();
		expect(first.done).toBe(false);
		const grandchildPid = Number(first.value);
		expect(processExists(grandchildPid)).toBe(true);

		const result = await handle.close();
		expect(result.exitCode).toBe(137);
		expect(await waitForProcessExit(grandchildPid)).toBe(true);
	});

	test("close reaps the direct child and leaves no zombie", async () => {
		const handle = spawnProcess({
			argv: fixtureArgv("sleep.ts", "--ignore-term"),
			killGraceMs: 50,
		});
		const pid = handle.pid;
		expect(pid === undefined).toBe(false);
		await handle.close();

		if (pid !== undefined) expect(await waitForProcessExit(pid)).toBe(true);
	});
});
