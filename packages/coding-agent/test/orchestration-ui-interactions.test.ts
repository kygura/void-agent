import type { OrchestratorState, RunSnapshot, SessionSnapshot, TaskRunSnapshot } from "@void/orchestrator";
import { type Component, Container, setKeybindings, TUI } from "@void/tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.js";
import { KeybindingsManager } from "../src/core/keybindings.js";
import type { ProcessLifetimeOrchestrationHost } from "../src/core/orchestration/host.js";
import { VoidSpawnEntryComponent } from "../src/core/orchestration/spawn-entry.js";
import { installOrchestrationUiController, setActiveOrchestrationHost } from "../src/core/orchestration/ui-bridge.js";
import type { AgentRunSummary } from "../src/modes/interactive/components/agent-runs.js";
import { AgentsOverlayComponent } from "../src/modes/interactive/components/agents-overlay.js";
import { type ChildSessionTarget, ChildSessionView } from "../src/modes/interactive/components/child-session-view.js";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.js";
import { CustomMessageComponent } from "../src/modes/interactive/components/custom-message.js";
import { Sidebar } from "../src/modes/interactive/components/sidebar.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { getEditorTheme, initTheme, theme } from "../src/modes/interactive/theme/theme.js";

function childState(prompts: string[] = []): OrchestratorState {
	const run: RunSnapshot = {
		id: "run-1",
		provider: "mock",
		sessionId: "child-1",
		state: "running",
		startedAt: "2026-01-01T00:00:00.000Z",
		prompt: "initial prompt",
	};
	const session: SessionSnapshot = {
		id: "child-1",
		provider: "mock",
		providerSessionId: "provider-session",
		parentSessionId: "parent-1",
		name: "reviewer",
		created: "2026-01-01T00:00:00.000Z",
		runIds: [run.id],
		queue: { activeRunId: run.id, prompts },
	};
	return { runs: [run], sessions: [session], taskRuns: [], defaultProvider: "mock", closing: false };
}

function fakeHost(prompts: string[] = []) {
	let state = childState(prompts);
	const resume = vi.fn((_parentId: string, _sessionId: string, prompt: string) => {
		const session = state.sessions[0]!;
		state = {
			...state,
			sessions: [{ ...session, queue: { ...session.queue, prompts: [...session.queue.prompts, prompt] } }],
		};
	});
	const cancel = vi.fn();
	const host = {
		snapshot: () => state,
		subscribe: () => ({ unsubscribe: vi.fn() }),
		providerConfig: () => ({ type: "mock" }),
		runEvents: () => [],
		resume,
		cancel,
		removeQueuedPrompt: () => {
			const session = state.sessions[0];
			const removed = session?.queue.prompts.at(-1);
			if (session !== undefined && removed !== undefined) {
				state = {
					...state,
					sessions: [{ ...session, queue: { ...session.queue, prompts: session.queue.prompts.slice(0, -1) } }],
				};
			}
			return removed;
		},
	} as unknown as ProcessLifetimeOrchestrationHost;
	return {
		host,
		get state() {
			return state;
		},
		setRunState(runState: RunSnapshot["state"]) {
			state = { ...state, runs: state.runs.map((run) => ({ ...run, state: runState })) };
		},
		resume,
		cancel,
	};
}

function stripAnsi(value: string): string {
	return value.replace(/\x1b\[[0-9;]*m/g, "");
}

const cleanups: Array<() => void> = [];

beforeAll(() => initTheme(undefined, false));

afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
});

describe("child-session entry origins", () => {
	it("enters from an inline spawn entry through the configurable action", () => {
		const { host } = fakeHost();
		setKeybindings(KeybindingsManager.create());
		const openChild = vi.fn();
		cleanups.push(
			installOrchestrationUiController({
				openAgents: vi.fn(),
				openChild,
				requestCancel: vi.fn(),
				requestRender: vi.fn(),
				focusedChildSessionId: () => undefined,
				focusedRunId: () => undefined,
			}),
		);
		new VoidSpawnEntryComponent(host, "child-1", false, theme).handleInput("\r");
		expect(openChild).toHaveBeenCalledWith("child-1");
	});

	it("focuses the most recent live inline spawn entry before entering it", () => {
		const { host } = fakeHost();
		setActiveOrchestrationHost(host);
		const keybindings = new KeybindingsManager({ "app.child.enter": "ctrl+e", "app.child.cancel": "ctrl+k" });
		setKeybindings(keybindings);
		const terminal = new VirtualTerminal(100, 30);
		const tui = new TUI(terminal);
		const editor = new CustomEditor(tui, getEditorTheme(), keybindings);
		const chatContainer = new Container();
		const entry = new CustomMessageComponent(
			{
				role: "custom",
				customType: "void:spawn",
				content: "child-1",
				display: true,
				details: { childSessionId: "child-1" },
				timestamp: 0,
			},
			() => new VoidSpawnEntryComponent(host, "child-1", false, theme),
		);
		chatContainer.addChild(entry);
		const openChild = vi.fn();
		const requestCancel = vi.fn();
		cleanups.push(
			installOrchestrationUiController({
				openAgents: vi.fn(),
				openChild,
				requestCancel,
				requestRender: vi.fn(),
				focusedChildSessionId: () => undefined,
				focusedRunId: () => undefined,
			}),
		);
		const mode = Object.assign(Object.create(InteractiveMode.prototype) as object, {
			defaultEditor: editor,
			editor,
			ui: tui,
			chatContainer,
		});
		const setupKeyHandlers = Reflect.get(InteractiveMode.prototype, "setupKeyHandlers") as (this: object) => void;
		setupKeyHandlers.call(mode);

		editor.handleInput("\x05");
		const focusedEntry = entry as Component;
		expect("focused" in focusedEntry && focusedEntry.focused).toBe(true);
		focusedEntry.handleInput?.("\x05");
		expect(openChild).toHaveBeenCalledWith("child-1");
		focusedEntry.handleInput?.("\x0b");
		expect(requestCancel).toHaveBeenCalledWith("child-1");
	});

	it("keeps one inline entry and reveals event detail only when expanded", () => {
		const { host } = fakeHost();
		const withEvents = {
			...host,
			runEvents: () => [{ kind: "text", text: "stream detail" }],
		} as unknown as ProcessLifetimeOrchestrationHost;
		const collapsed = stripAnsi(
			new VoidSpawnEntryComponent(withEvents, "child-1", false, theme).render(80).join("\n"),
		);
		const expanded = stripAnsi(new VoidSpawnEntryComponent(withEvents, "child-1", true, theme).render(80).join("\n"));
		expect(collapsed.match(/stream detail/g)).toHaveLength(1);
		expect(expanded.match(/stream detail/g)).toHaveLength(2);
	});

	it.each([
		["running", "⠋"],
		["done", "✓"],
		["failed", "✗"],
		["cancelled", "⊘"],
	] as const)("renders the inline %s state", (runState, glyph) => {
		const { host, setRunState } = fakeHost();
		setRunState(runState);
		expect(stripAnsi(new VoidSpawnEntryComponent(host, "child-1", false, theme).render(80).join("\n"))).toContain(
			glyph,
		);
	});

	it("enters the selected child from the overlay", () => {
		const { host } = fakeHost();
		setKeybindings(KeybindingsManager.create());
		const onEnter = vi.fn();
		const overlay = new AgentsOverlayComponent(undefined, undefined, vi.fn(), vi.fn(), {
			orchestrationHost: host,
			parentSessionId: "parent-1",
			onEnter,
		});
		overlay.render(100);
		overlay.handleInput("\r");
		expect(onEnter).toHaveBeenCalledWith(expect.objectContaining({ id: "child-1", origin: "session" }));
	});

	it("shows grouped rows plus empty and filtered-empty states", () => {
		const source = fakeHost();
		const task: TaskRunSnapshot = {
			id: "task-done",
			provider: "mock",
			state: "done",
			startedAt: "2026-01-01T00:00:00.000Z",
			endedAt: "2026-01-01T00:00:01.000Z",
			prompt: "finished task",
		};
		const groupedState: OrchestratorState = {
			...source.state,
			runs: [...source.state.runs, task],
			taskRuns: [task],
		};
		const groupedHost = { ...source.host, snapshot: () => groupedState } as ProcessLifetimeOrchestrationHost;
		const overlay = new AgentsOverlayComponent(undefined, undefined, vi.fn(), vi.fn(), {
			orchestrationHost: groupedHost,
		});
		const grouped = stripAnsi(overlay.render(100).join("\n"));
		expect(grouped).toContain("running");
		expect(grouped).toContain("finished");
		for (const character of "missing") overlay.handleInput(character);
		expect(stripAnsi(overlay.render(100).join("\n"))).toContain("no runs match this filter");

		const emptyState: OrchestratorState = { ...childState(), runs: [], sessions: [] };
		const emptyHost = { snapshot: () => emptyState } as unknown as ProcessLifetimeOrchestrationHost;
		const empty = new AgentsOverlayComponent(undefined, undefined, vi.fn(), vi.fn(), {
			orchestrationHost: emptyHost,
		});
		expect(stripAnsi(empty.render(100).join("\n"))).toContain("no runs yet");
	});

	it("enters the selected child from the focused sidebar", () => {
		const { host } = fakeHost();
		setActiveOrchestrationHost(host);
		setKeybindings(KeybindingsManager.create());
		const onEnter = vi.fn();
		const sidebar = new Sidebar(
			{
				state: { thinkingLevel: "off" },
				getContextUsage: () => undefined,
				sessionId: "parent-1",
				sessionManager: { getSessionName: () => "parent" },
			} as never,
			{} as never,
			{ getGitBranch: () => undefined, getGitDirty: () => false, getGitRoot: () => undefined } as never,
		);
		sidebar.setActions({ onEnter, onCancel: vi.fn(), onBlur: vi.fn() });
		sidebar.render(32);
		sidebar.handleInput("\r");
		expect(onEnter).toHaveBeenCalledWith(expect.objectContaining({ id: "child-1", origin: "session" }));
	});

	it("cancels a sidebar harness run through the harness manager", async () => {
		const cancel = vi.fn();
		const notify = vi.fn();
		const mode = {
			runtimeHost: { harnessRunManager: { cancel } },
			showExtensionConfirm: vi.fn(async () => true),
			showExtensionNotify: notify,
		};
		const requestCancel = Reflect.get(InteractiveMode.prototype, "requestAgentRunCancel") as (
			this: object,
			run: AgentRunSummary,
		) => Promise<void>;
		await requestCancel.call(mode, {
			id: "harness-run",
			runId: "harness-run",
			name: "claude",
			provider: "claude",
			harnessId: "claude",
			origin: "harness",
			state: "running",
			startTime: "2026-01-01T00:00:00.000Z",
		});

		expect(cancel).toHaveBeenCalledWith("harness-run");
		expect(notify).not.toHaveBeenCalled();
	});

	it("explains when a sidebar subagent cannot be cancelled", async () => {
		const notify = vi.fn();
		const mode = {
			runtimeHost: {},
			showExtensionConfirm: vi.fn(async () => true),
			showExtensionNotify: notify,
		};
		const requestCancel = Reflect.get(InteractiveMode.prototype, "requestAgentRunCancel") as (
			this: object,
			run: AgentRunSummary,
		) => Promise<void>;
		await requestCancel.call(mode, {
			id: "void-run",
			runId: "void-run",
			name: "reviewer",
			provider: "void",
			harnessId: "void",
			origin: "subagent",
			state: "running",
			startTime: "2026-01-01T00:00:00.000Z",
		});

		expect(notify).toHaveBeenCalledWith(expect.stringContaining("cannot cancel"), "warning");
	});
});

describe("attached child-session interactions", () => {
	function view(prompts: string[] = []) {
		const source = fakeHost(prompts);
		const terminal = new VirtualTerminal(100, 30);
		const tui = new TUI(terminal);
		const detach = vi.fn();
		const confirm = vi.fn(async () => true);
		const target = {
			kind: "session" as const,
			session: source.state.sessions[0]!,
			run: source.state.runs[0]!,
			providerType: "mock" as const,
		};
		const component = new ChildSessionView(source.host, target, tui, KeybindingsManager.create(), {
			parentName: "parent",
			confirm,
			notify: vi.fn(),
			detach,
			requestRender: vi.fn(),
		});
		cleanups.push(() => component.dispose());
		return {
			...source,
			get state() {
				return source.state;
			},
			component,
			detach,
			confirm,
		};
	}

	it("renders the FIFO queue oldest-first and drops only the newest prompt", () => {
		const source = view(["oldest", "newest"]);
		const { component } = source;
		const rendered = stripAnsi(component.render(100).join("\n"));
		expect(rendered.indexOf("1· oldest")).toBeLessThan(rendered.indexOf("2· newest"));
		component.handleInput("\x1b\x7f");
		expect(source.state.sessions[0]?.queue.prompts).toEqual(["oldest"]);
	});

	it("queues a submitted follow-up while the Run is live", () => {
		const { component, resume } = view();
		for (const character of "follow up") component.handleInput(character);
		component.handleInput("\r");
		expect(resume).toHaveBeenCalledWith("parent-1", "child-1", "follow up");
	});

	it("detaches without cancelling the running child", () => {
		const { component, detach, cancel, state } = view();
		component.handleInput("\x1b");
		expect(detach).toHaveBeenCalledOnce();
		expect(cancel).not.toHaveBeenCalled();
		expect(state.runs[0]?.state).toBe("running");
	});

	it("requires confirmation before cancelling the live Run", async () => {
		const { component, confirm, cancel } = view(["queued"]);
		component.handleInput("\x18");
		await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith("child-1"));
		expect(confirm).toHaveBeenCalledWith("Cancel child Run", expect.stringContaining("1 queued prompt"));
	});

	it("renders and live-updates output for a harness-origin run", () => {
		const source = fakeHost();
		const terminal = new VirtualTerminal(100, 30);
		const tui = new TUI(terminal);
		let output = "first harness chunk";
		let update = () => {};
		const summary: AgentRunSummary = {
			id: "harness-run",
			runId: "harness-run",
			name: "claude",
			provider: "claude",
			harnessId: "claude",
			origin: "harness",
			state: "running",
			startTime: "2026-01-01T00:00:00.000Z",
			description: "review the patch",
		};
		const target = {
			kind: "external" as const,
			summary,
			getCurrent: () => summary,
			getOutputText: () => output,
			subscribe: (listener: () => void) => {
				update = listener;
				return vi.fn();
			},
			cancel: () => ({ cancelled: true as const }),
		} as unknown as ChildSessionTarget;
		const component = new ChildSessionView(source.host, target, tui, KeybindingsManager.create(), {
			parentName: "parent",
			confirm: vi.fn(async () => true),
			notify: vi.fn(),
			detach: vi.fn(),
			requestRender: vi.fn(),
		});
		cleanups.push(() => component.dispose());

		expect(stripAnsi(component.render(100).join("\n"))).toContain("first harness chunk");
		output = "first harness chunk\nsecond harness chunk";
		update();
		expect(stripAnsi(component.render(100).join("\n"))).toContain("second harness chunk");
	});
});
