import { describe, expect, test } from "vitest";
import { finalizeStructured, runHarnessProc } from "../src/core/harness/glue.js";
import type { ProcSpec } from "../src/core/harness/proc.js";
import type { HarnessEvent } from "../src/core/harness/types.js";

async function collect(iterable: AsyncIterable<HarnessEvent>): Promise<HarnessEvent[]> {
	const events: HarnessEvent[] = [];
	for await (const event of iterable) events.push(event);
	return events;
}

describe("finalizeStructured", () => {
	test("does nothing when a result was already parsed", () => {
		expect(finalizeStructured({ exitCode: 0, signal: null, stderrTail: "" }, true)).toBeUndefined();
	});

	test("synthesizes a clean, non-error result when the CLI exits 0 without one", () => {
		const event = finalizeStructured({ exitCode: 0, signal: null, stderrTail: "" }, false);
		expect(event?.kind).toBe("result");
		expect(event?.isError).toBeFalsy();
	});

	test("synthesizes an error result carrying the stderr tail on a crash", () => {
		const event = finalizeStructured({ exitCode: 1, signal: null, stderrTail: "  oh no  " }, false);
		expect(event?.kind).toBe("result");
		expect(event?.isError).toBe(true);
		expect(event?.text).toBe("oh no");
	});
});

describe("runHarnessProc", () => {
	// A CLI that never emits a JSON-parseable line, so parseLine always
	// degrades to a raw text event and never sets sawResult.
	const spec: ProcSpec = { path: process.execPath, args: ["-e", "console.log('line one'); console.log('line two');"] };
	const parseLine = (line: string): HarnessEvent[] => [{ kind: "text", timestamp: "t", text: line }];

	test("a stream with no result event gets a synthesized one, and always ends with exactly one exit event", async () => {
		const controller = new AbortController();
		const events = await collect(runHarnessProc(spec, parseLine, finalizeStructured, controller.signal));

		const textEvents = events.filter((e) => e.kind === "text");
		expect(textEvents.map((e) => e.text)).toEqual(["line one", "line two"]);

		const resultEvents = events.filter((e) => e.kind === "result");
		expect(resultEvents).toHaveLength(1);

		const exitEvents = events.filter((e) => e.kind === "exit");
		expect(exitEvents).toHaveLength(1);
		expect(exitEvents[0]?.exitCode).toBe(0);

		// exit must be the last event.
		expect(events[events.length - 1]?.kind).toBe("exit");
	});

	test("a parsed result event is not duplicated by finalize", async () => {
		const resultSpec: ProcSpec = { path: process.execPath, args: ["-e", "console.log(JSON.stringify({ok:true}));"] };
		const parseAsResult = (line: string): HarnessEvent[] => [{ kind: "result", timestamp: "t", text: line }];
		const controller = new AbortController();
		const events = await collect(runHarnessProc(resultSpec, parseAsResult, finalizeStructured, controller.signal));

		expect(events.filter((e) => e.kind === "result")).toHaveLength(1);
		expect(events[events.length - 1]?.kind).toBe("exit");
	});
});
