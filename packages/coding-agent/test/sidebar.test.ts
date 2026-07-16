import { setKeybindings } from "@void/tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import {
	buildSidebarLines,
	isSidebarVisible,
	SIDEBAR_MIN_TERMINAL_WIDTH,
	Sidebar,
	type SidebarData,
} from "../src/modes/interactive/components/sidebar.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function baseData(overrides: Partial<SidebarData> = {}): SidebarData {
	return {
		sessionName: "my-session",
		version: "1.2.3",
		modelId: "claude-sonnet",
		modelSupportsThinking: false,
		thinkingLevel: "off",
		contextPercent: 12.3,
		contextWindow: 200_000,
		gitBranch: "main",
		gitDirty: false,
		gitRoot: "/home/user/projects/void-ts",
		agentRuns: [],
		...overrides,
	};
}

function interactiveSidebar(sessionName = "agents-refactor") {
	const records = [
		{
			id: "newest",
			agent: "reviewer",
			harness: "void",
			background: true,
			state: "running" as const,
			startTime: "2026-01-01T00:00:03.000Z",
		},
		{
			id: "middle",
			agent: "planner",
			harness: "void",
			background: true,
			state: "running" as const,
			startTime: "2026-01-01T00:00:02.000Z",
		},
		{
			id: "oldest",
			agent: "tester",
			harness: "void",
			background: true,
			state: "running" as const,
			startTime: "2026-01-01T00:00:01.000Z",
		},
	];
	const sidebar = new Sidebar(
		{
			state: { thinkingLevel: "off" },
			getContextUsage: () => undefined,
			sessionId: "parent-1",
			sessionManager: { getSessionName: () => sessionName },
		} as never,
		{ subagentRegistry: { list: () => records } } as never,
		{ getGitBranch: () => "main", getGitDirty: () => false, getGitRoot: () => undefined } as never,
	);
	const actions = { onEnter: vi.fn(), onCancel: vi.fn(), onBlur: vi.fn() };
	sidebar.setActions(actions);
	return { sidebar, actions };
}

describe("isSidebarVisible", () => {
	it("is visible only when enabled and width >= 120", () => {
		expect(isSidebarVisible(120, true)).toBe(true);
		expect(isSidebarVisible(200, true)).toBe(true);
		expect(isSidebarVisible(119, true)).toBe(false);
		expect(isSidebarVisible(80, true)).toBe(false);
		expect(isSidebarVisible(200, false)).toBe(false);
		expect(isSidebarVisible(119, false)).toBe(false);
	});

	it("uses the documented breakpoint constant", () => {
		expect(SIDEBAR_MIN_TERMINAL_WIDTH).toBe(120);
	});
});

describe("buildSidebarLines", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("shows session name and void version", () => {
		const lines = buildSidebarLines(baseData()).map(stripAnsi);
		expect(lines).toContain("my-session");
		expect(lines).toContain("void v1.2.3");
	});

	it("falls back to a placeholder when the session has no name", () => {
		const lines = buildSidebarLines(baseData({ sessionName: undefined })).map(stripAnsi);
		expect(lines).toContain("(unnamed session)");
	});

	it("shows model id and thinking level only when the model supports thinking", () => {
		const withThinking = buildSidebarLines(baseData({ modelSupportsThinking: true, thinkingLevel: "high" })).map(
			stripAnsi,
		);
		expect(withThinking).toContain("claude-sonnet");
		expect(withThinking).toContain("thinking: high");

		const withoutThinking = buildSidebarLines(baseData({ modelSupportsThinking: false })).map(stripAnsi);
		expect(withoutThinking.some((l) => l.startsWith("thinking:"))).toBe(false);
	});

	it("shows 'no model' when no model is set", () => {
		const lines = buildSidebarLines(baseData({ modelId: undefined })).map(stripAnsi);
		expect(lines).toContain("no model");
	});

	it("formats context usage as a percentage, or '?' when unknown", () => {
		const known = buildSidebarLines(baseData({ contextPercent: 42.5, contextWindow: 200_000 })).map(stripAnsi);
		expect(known).toContain("context: 42.5%/200k");

		const unknown = buildSidebarLines(baseData({ contextPercent: null, contextWindow: 200_000 })).map(stripAnsi);
		expect(unknown).toContain("context: ?/200k");
	});

	it("shows git branch with a dirty marker and project root basename", () => {
		const clean = buildSidebarLines(baseData({ gitBranch: "main", gitDirty: false })).map(stripAnsi);
		expect(clean.some((l) => l === "main (void-ts)")).toBe(true);

		const dirty = buildSidebarLines(baseData({ gitBranch: "main", gitDirty: true })).map(stripAnsi);
		expect(dirty.some((l) => l === "main* (void-ts)")).toBe(true);
	});

	it("shows 'no git' when not in a repo", () => {
		const lines = buildSidebarLines(baseData({ gitBranch: null, gitRoot: null })).map(stripAnsi);
		expect(lines).toContain("no git");
	});

	it("shows '(none)' in the Agents section when there are no runs", () => {
		const lines = buildSidebarLines(baseData({ agentRuns: [] })).map(stripAnsi);
		expect(lines).toContain("agents 0▶ 0✓");
		expect(lines).toContain("no runs yet");
	});

	it("renders one line per agent run with state glyph, name, and elapsed time", () => {
		const now = Date.parse("2026-01-01T00:00:10.000Z");
		const lines = buildSidebarLines(
			baseData({
				agentRuns: [
					{
						id: "1",
						runId: "1",
						name: "reviewer",
						provider: "void",
						harnessId: "void",
						origin: "subagent",
						state: "running",
						startTime: "2026-01-01T00:00:05.000Z",
					},
					{
						id: "2",
						runId: "2",
						name: "planner",
						provider: "void",
						harnessId: "void",
						origin: "subagent",
						state: "done",
						startTime: "2026-01-01T00:00:00.000Z",
						endTime: "2026-01-01T00:00:02.000Z",
					},
				],
			}),
			now,
		).map(stripAnsi);

		expect(lines.some((l) => l.includes("⠋") && l.includes("reviewer") && l.includes("5s"))).toBe(true);
		expect(lines.some((l) => l.includes("✓") && l.includes("planner") && l.includes("2s"))).toBe(true);
	});

	it("shows failed/cancelled runs with a distinct glyph", () => {
		const lines = buildSidebarLines(
			baseData({
				agentRuns: [
					{
						id: "1",
						runId: "1",
						name: "a",
						provider: "void",
						harnessId: "void",
						origin: "subagent",
						state: "failed",
						startTime: "2026-01-01T00:00:00.000Z",
					},
					{
						id: "2",
						runId: "2",
						name: "b",
						provider: "void",
						harnessId: "void",
						origin: "subagent",
						state: "cancelled",
						startTime: "2026-01-01T00:00:00.000Z",
					},
				],
			}),
		).map(stripAnsi);

		expect(lines.some((line) => line.includes("✗") && line.includes("a"))).toBe(true);
		expect(lines.some((line) => line.includes("⊘") && line.includes("b"))).toBe(true);
	});

	it("shows only the 8 most recent agent runs, most recent first", () => {
		const runs = Array.from({ length: 12 }, (_, i) => ({
			id: `${i}`,
			runId: `${i}`,
			name: `run-${i}`,
			provider: "void",
			harnessId: "void",
			origin: "subagent" as const,
			state: "done" as const,
			startTime: new Date(2026, 0, 1, 0, 0, i).toISOString(),
		}));
		const lines = buildSidebarLines(baseData({ agentRuns: runs })).map(stripAnsi);
		const runLines = lines.filter((l) => l.includes("run-"));

		expect(runLines.length).toBe(6);
		// Most recent (run-11) first, oldest of the visible window (run-6) last.
		expect(runLines[0]).toContain("run-11");
		expect(runLines[runLines.length - 1]).toContain("run-6");
	});
});

describe("Sidebar focus and navigation", () => {
	beforeAll(() => {
		initTheme(undefined, false);
		setKeybindings(new KeybindingsManager());
	});

	it("highlights the selected run when the session name contains agents", () => {
		const { sidebar } = interactiveSidebar();
		sidebar.focused = false;
		const unfocused = sidebar.render(34);
		sidebar.focused = true;
		const focused = sidebar.render(34);
		const changed = focused.flatMap((line, index) => (line === unfocused[index] ? [] : [index]));
		const reviewerIndex = focused.findIndex((line) => stripAnsi(line).includes("reviewer"));

		expect(reviewerIndex).toBeGreaterThanOrEqual(0);
		expect(changed).toEqual([reviewerIndex]);
	});

	it("wraps up and down at the run-list bounds", () => {
		const { sidebar, actions } = interactiveSidebar("parent");
		sidebar.render(34);

		sidebar.handleInput("\x1b[A");
		sidebar.handleInput("\r");
		expect(actions.onEnter).toHaveBeenLastCalledWith(expect.objectContaining({ id: "oldest" }));

		sidebar.handleInput("\x1b[B");
		sidebar.handleInput("\r");
		expect(actions.onEnter).toHaveBeenLastCalledWith(expect.objectContaining({ id: "newest" }));
	});

	it("returns focus to the composer when selection is cancelled", () => {
		const { sidebar, actions } = interactiveSidebar("parent");
		sidebar.handleInput("\x1b");
		expect(actions.onBlur).toHaveBeenCalledOnce();
	});
});
