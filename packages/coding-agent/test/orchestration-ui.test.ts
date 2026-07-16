import type { OrchestratorState, RunSnapshot, SessionSnapshot, TaskRunSnapshot } from "@void/orchestrator";
import { beforeAll, describe, expect, it } from "vitest";
import type { HarnessRun } from "../src/core/harness/index.js";
import type { SubagentRunRecord } from "../src/core/tools/subagent.js";
import { collectAgentRuns, groupAgentRuns, renderRunRow } from "../src/modes/interactive/components/agent-runs.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

function run(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
	return {
		id: "run-1",
		provider: "mock",
		state: "running",
		startedAt: "2026-01-01T00:00:00.000Z",
		prompt: "inspect auth",
		...overrides,
	};
}

function taskRun(overrides: Partial<TaskRunSnapshot> = {}): TaskRunSnapshot {
	return {
		id: "task-1",
		provider: "mock",
		state: "running",
		startedAt: "2026-01-01T00:00:00.000Z",
		prompt: "inspect auth",
		...overrides,
	};
}

function session(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
	return {
		id: "child-1",
		provider: "mock",
		parentSessionId: "parent-1",
		name: "auth-review",
		created: "2026-01-01T00:00:00.000Z",
		runIds: ["run-1"],
		queue: { activeRunId: "run-1", prompts: [] },
		...overrides,
	};
}

function state(overrides: Partial<OrchestratorState> = {}): OrchestratorState {
	return {
		runs: [run({ sessionId: "child-1" })],
		sessions: [session()],
		taskRuns: [],
		defaultProvider: "mock",
		closing: false,
		...overrides,
	};
}

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("orchestration run UI", () => {
	beforeAll(() => initTheme(undefined, false));

	it("aggregates direct subagents, unlinked harness runs, child Sessions, and TaskRuns", () => {
		const direct: SubagentRunRecord = {
			id: "direct-1",
			agent: "reviewer",
			harness: "void",
			background: true,
			state: "running",
			startTime: "2026-01-01T00:00:03.000Z",
		};
		const harness: HarnessRun = {
			id: "harness-1",
			harnessId: "claude",
			state: "done",
			startTime: "2026-01-01T00:00:02.000Z",
			endTime: "2026-01-01T00:00:04.000Z",
			prompt: "review docs",
			config: { prompt: "review docs" },
			events: [],
		};
		const task = taskRun({ id: "task-1", state: "failed", name: "lint" });
		const summaries = collectAgentRuns(
			[direct],
			[harness],
			state({ runs: [...state().runs, task], taskRuns: [task] }),
		);

		expect(summaries.map((item) => [item.id, item.origin])).toEqual([
			["direct-1", "subagent"],
			["harness-1", "harness"],
			["child-1", "session"],
			["task-1", "task"],
		]);
	});

	it("groups running, pending, then interleaved finished rows", () => {
		const summaries = collectAgentRuns(
			[],
			[],
			state({
				runs: [
					run({ id: "running", sessionId: "running-child", state: "running" }),
					run({ id: "pending", sessionId: "pending-child", state: "pending" }),
					run({ id: "failed", state: "failed", endedAt: "2026-01-01T00:00:05.000Z" }),
					run({ id: "done", state: "done", endedAt: "2026-01-01T00:00:06.000Z" }),
				],
				sessions: [
					session({ id: "running-child", runIds: ["running"], queue: { activeRunId: "running", prompts: [] } }),
					session({ id: "pending-child", runIds: ["pending"], queue: { activeRunId: "pending", prompts: [] } }),
				],
				taskRuns: [
					taskRun({ id: "failed", state: "failed", endedAt: "2026-01-01T00:00:05.000Z" }),
					taskRun({ id: "done", state: "done", endedAt: "2026-01-01T00:00:06.000Z" }),
				],
			}),
		);
		expect(groupAgentRuns(summaries).map((group) => [group.label, group.runs.map((item) => item.runId)])).toEqual([
			["running", ["running"]],
			["pending", ["pending"]],
			["finished", ["done", "failed"]],
		]);
	});

	it.each([
		["pending", "○"],
		["running", "⠋"],
		["done", "✓"],
		["failed", "✗"],
		["cancelled", "⊘"],
	] as const)("renders the %s row with the design glyph", (runState, glyph) => {
		const [summary] = collectAgentRuns([], [], state({ runs: [run({ state: runState, sessionId: "child-1" })] }));
		const rendered = stripAnsi(renderRunRow(summary, 120, Date.parse("2026-01-01T00:01:32.000Z")));
		expect(rendered).toContain(glyph);
		expect(rendered).toContain("auth-review");
		expect(rendered).toContain("mock");
		expect(rendered).toContain(runState);
	});

	it("drops optional metadata before the glyph and name at narrow widths", () => {
		const [summary] = collectAgentRuns([], [], state());
		const rendered = stripAnsi(renderRunRow(summary, 18, Date.parse("2026-01-01T00:01:32.000Z")));
		expect(rendered).toContain("⠋");
		expect(rendered).toContain("auth-review".slice(0, 4));
		expect([...rendered].length).toBeLessThanOrEqual(18);
	});
});
