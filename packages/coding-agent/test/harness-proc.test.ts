import { describe, expect, test } from "vitest";
import { spawnProc } from "../src/core/harness/proc.js";

async function collectLines(iterable: AsyncIterable<string>): Promise<string[]> {
	const lines: string[] = [];
	for await (const line of iterable) lines.push(line);
	return lines;
}

describe("spawnProc", () => {
	test("streams stdout lines and reports a clean exit", async () => {
		const controller = new AbortController();
		const handle = spawnProc(
			{ path: process.execPath, args: ["-e", "console.log('a'); console.log('b');"] },
			controller.signal,
		);
		const lines = await collectLines(handle.lines);
		const result = await handle.result;

		expect(lines).toEqual(["a", "b"]);
		expect(result.exitCode).toBe(0);
		expect(result.signal).toBeNull();
	});

	test("reports a non-zero exit code", async () => {
		const controller = new AbortController();
		const handle = spawnProc({ path: process.execPath, args: ["-e", "process.exit(3);"] }, controller.signal);
		await collectLines(handle.lines);
		const result = await handle.result;

		expect(result.exitCode).toBe(3);
	});

	test("captures a tail of stderr", async () => {
		const controller = new AbortController();
		const handle = spawnProc(
			{ path: process.execPath, args: ["-e", "console.error('boom'); process.exit(1);"] },
			controller.signal,
		);
		await collectLines(handle.lines);
		const result = await handle.result;

		expect(result.stderrTail).toContain("boom");
		expect(result.exitCode).toBe(1);
	});

	test("delivers a final line with no trailing newline", async () => {
		const controller = new AbortController();
		const handle = spawnProc(
			{ path: process.execPath, args: ["-e", "process.stdout.write('no-newline');"] },
			controller.signal,
		);
		const lines = await collectLines(handle.lines);

		expect(lines).toEqual(["no-newline"]);
	});

	test("writes prompt via argv, never through a shell", async () => {
		// A prompt containing shell metacharacters must arrive at the child
		// verbatim as argv[2], never interpreted by a shell.
		const prompt = "hello; rm -rf / && echo pwned";
		const controller = new AbortController();
		const handle = spawnProc(
			{ path: process.execPath, args: ["-e", "console.log(process.argv[1]);", prompt] },
			controller.signal,
		);
		const lines = await collectLines(handle.lines);

		expect(lines).toEqual([prompt]);
	});

	test("passes stdin through and closes it", async () => {
		const controller = new AbortController();
		const handle = spawnProc(
			{
				path: process.execPath,
				args: ["-e", "process.stdin.on('data', (d) => process.stdout.write(d));"],
				stdin: "hello from stdin",
			},
			controller.signal,
		);
		const lines = await collectLines(handle.lines);

		expect(lines.join("\n")).toContain("hello from stdin");
	});
});
