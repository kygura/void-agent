import { describe, expect, it } from "vitest";
import type { HarnessRun } from "../src/core/harness/index.js";
import type { SubagentRegistry, SubagentRunRecord } from "../src/core/tools/subagent.js";
import {
	collectAgentRuns,
	elapsedMs,
	formatElapsed,
	getRunOutputText,
} from "../src/modes/interactive/components/agent-runs.js";

function subagentRun(overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
	return {
		id: "sa-1",
		agent: "reviewer",
		harness: "void",
		background: false,
		state: "running",
		startTime: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

function harnessRun(overrides: Partial<HarnessRun> = {}): HarnessRun {
	return {
		id: "hr-1",
		harnessId: "claude",
		state: "running",
		startTime: "2026-01-01T00:00:00.000Z",
		prompt: "do the thing",
		config: { prompt: "do the thing" },
		events: [],
		...overrides,
	};
}

describe("formatElapsed", () => {
	it("formats sub-second, second, and minute scales", () => {
		expect(formatElapsed(500)).toBe("500ms");
		expect(formatElapsed(1500)).toBe("1s");
		expect(formatElapsed(90_000)).toBe("1m30s");
	});

	it("clamps negative durations to zero", () => {
		expect(formatElapsed(-100)).toBe("0ms");
	});
});

describe("elapsedMs", () => {
	it("uses endTime - startTime when finished", () => {
		const ms = elapsedMs({ startTime: "2026-01-01T00:00:00.000Z", endTime: "2026-01-01T00:00:05.000Z" });
		expect(ms).toBe(5000);
	});

	it("uses now - startTime when still running", () => {
		const now = Date.parse("2026-01-01T00:00:10.000Z");
		const ms = elapsedMs({ startTime: "2026-01-01T00:00:00.000Z" }, now);
		expect(ms).toBe(10_000);
	});
});

describe("collectAgentRuns", () => {
	it("includes void-harness subagent runs", () => {
		const runs = collectAgentRuns([subagentRun({ harness: "void" })], []);
		expect(runs).toHaveLength(1);
		expect(runs[0]).toMatchObject({ id: "sa-1", name: "reviewer", harnessId: "void" });
	});

	it("excludes a harness run already linked to a subagent record via harnessRunId", () => {
		const runs = collectAgentRuns(
			[subagentRun({ id: "sa-1", harness: "claude", harnessRunId: "hr-1" })],
			[harnessRun({ id: "hr-1" })],
		);
		expect(runs).toHaveLength(1);
		expect(runs[0]?.id).toBe("sa-1");
	});

	it("includes a standalone harness run not linked to any subagent record", () => {
		const runs = collectAgentRuns([], [harnessRun({ id: "hr-2" })]);
		expect(runs).toHaveLength(1);
		expect(runs[0]).toMatchObject({ id: "hr-2", name: "claude", description: "do the thing" });
	});

	it("merges both sources when unlinked", () => {
		const runs = collectAgentRuns([subagentRun({ id: "sa-1" })], [harnessRun({ id: "hr-2" })]);
		expect(runs.map((r) => r.id).sort()).toEqual(["hr-2", "sa-1"]);
	});
});

describe("getRunOutputText", () => {
	function fakeRegistry(record: SubagentRunRecord | undefined): SubagentRegistry {
		return { get: () => record } as unknown as SubagentRegistry;
	}

	it("returns finalText when available", () => {
		const registry = fakeRegistry(subagentRun({ state: "done", finalText: "all done" }));
		const text = getRunOutputText(
			{
				id: "sa-1",
				runId: "sa-1",
				name: "r",
				provider: "void",
				harnessId: "void",
				origin: "subagent",
				state: "done",
				startTime: "t",
			},
			registry,
			undefined,
		);
		expect(text).toBe("all done");
	});

	it("returns the error message when the run failed with no output", () => {
		const registry = fakeRegistry(subagentRun({ state: "failed", error: "boom" }));
		const text = getRunOutputText(
			{
				id: "sa-1",
				runId: "sa-1",
				name: "r",
				provider: "void",
				harnessId: "void",
				origin: "subagent",
				state: "failed",
				startTime: "t",
			},
			registry,
			undefined,
		);
		expect(text).toBe("Error: boom");
	});

	it("falls back to accumulated harness events for a run with no subagent record", () => {
		const manager = {
			runEvents: () => [
				{ kind: "text", timestamp: "t", text: "hello" },
				{ kind: "tool", timestamp: "t", tool: "bash", toolInput: "ls" },
			],
		} as unknown as Parameters<typeof getRunOutputText>[2];
		const text = getRunOutputText(
			{
				id: "hr-2",
				runId: "hr-2",
				name: "claude",
				provider: "claude",
				harnessId: "claude",
				origin: "harness",
				state: "running",
				startTime: "t",
			},
			undefined,
			manager,
		);
		expect(text).toBe("hello\n[tool: bash ls]");
	});

	it("shows a running placeholder before a harness emits output", () => {
		const manager = { runEvents: () => [] } as unknown as Parameters<typeof getRunOutputText>[2];
		const text = getRunOutputText(
			{
				id: "hr-2",
				runId: "hr-2",
				name: "claude",
				provider: "claude",
				harnessId: "claude",
				origin: "harness",
				state: "running",
				startTime: "t",
			},
			undefined,
			manager,
		);
		expect(text).toBe("(running, no output yet)");
	});

	it("returns a placeholder when there is no registry, manager, or output", () => {
		const text = getRunOutputText(
			{
				id: "x",
				runId: "x",
				name: "x",
				provider: "void",
				harnessId: "void",
				origin: "subagent",
				state: "running",
				startTime: "t",
			},
			undefined,
			undefined,
		);
		expect(text).toBe("(no output)");
	});
});
