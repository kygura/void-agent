import { basename } from "node:path";
import { Columns, type Component, type Focusable, getKeybindings, truncateToWidth } from "@void/tui";
import { VERSION } from "../../../config.js";
import type { AgentSession } from "../../../core/agent-session.js";
import type { AgentSessionRuntime } from "../../../core/agent-session-runtime.js";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.js";
import type { ProcessLifetimeOrchestrationHost } from "../../../core/orchestration/host.js";
import { getActiveOrchestrationHost, getOrchestrationUiController } from "../../../core/orchestration/ui-bridge.js";
import type { SettingsManager } from "../../../core/settings-manager.js";
import { theme } from "../theme/theme.js";
import { type AgentRunSummary, collectAgentRuns, groupAgentRuns, renderRunRow } from "./agent-runs.js";
import { formatTokens } from "./status-line.js";

/** Fixed sidebar column width, in terminal columns. */
export const SIDEBAR_WIDTH = 34;
/** Minimum terminal width for the sidebar to be shown. */
export const SIDEBAR_MIN_TERMINAL_WIDTH = 120;
/** Most recent agent runs shown in the sidebar's Agents section. */
const MAX_AGENT_ROWS = 6;

/** Whether the sidebar should be visible for a given terminal width and setting. */
export function isSidebarVisible(width: number, enabled: boolean): boolean {
	return enabled && width >= SIDEBAR_MIN_TERMINAL_WIDTH;
}

export interface SidebarData {
	sessionName: string | undefined;
	version: string;
	modelId: string | undefined;
	modelSupportsThinking: boolean;
	thinkingLevel: string;
	contextPercent: number | null;
	contextWindow: number;
	gitBranch: string | null;
	gitDirty: boolean | null;
	gitRoot: string | null;
	agentRuns: AgentRunSummary[];
}

export interface SidebarContent {
	lines: string[];
	agentRowsStartIndex: number;
}

/** Pure content builder with structural row metadata, not width-clamped. */
export function buildSidebarContent(data: SidebarData, now: number = Date.now()): SidebarContent {
	const lines: string[] = [];

	lines.push(theme.bold(data.sessionName ?? "(unnamed session)"));
	lines.push(theme.fg("dim", `void v${data.version}`));
	lines.push("");

	lines.push(data.modelId ? theme.fg("accent", data.modelId) : theme.fg("dim", "no model"));
	if (data.modelSupportsThinking) {
		lines.push(theme.fg("dim", `thinking: ${data.thinkingLevel}`));
	}
	lines.push("");

	const contextLine =
		data.contextPercent === null
			? `context: ?/${formatTokens(data.contextWindow)}`
			: `context: ${data.contextPercent.toFixed(1)}%/${formatTokens(data.contextWindow)}`;
	lines.push(theme.fg("dim", contextLine));
	lines.push("");

	if (data.gitBranch) {
		const branch = data.gitDirty ? `${data.gitBranch}*` : data.gitBranch;
		const root = data.gitRoot ? ` (${basename(data.gitRoot)})` : "";
		lines.push(`${branch}${theme.fg("dim", root)}`);
	} else {
		lines.push(theme.fg("dim", "no git"));
	}
	lines.push("");

	const live = data.agentRuns.filter((run) => run.state === "pending" || run.state === "running").length;
	const done = data.agentRuns.filter((run) => run.state === "done").length;
	lines.push(`${theme.fg("dim", "agents")} ${theme.fg("accent", `${live}▶`)} ${theme.fg("success", `${done}✓`)}`);
	const agentRowsStartIndex = lines.length;
	if (data.agentRuns.length === 0) {
		lines.push(theme.fg("dim", "no runs yet"));
	} else {
		const grouped = groupAgentRuns(data.agentRuns).flatMap((group) => group.runs);
		for (const run of grouped.slice(0, MAX_AGENT_ROWS)) lines.push(renderRunRow(run, SIDEBAR_WIDTH - 2, now));
		if (grouped.length > MAX_AGENT_ROWS) lines.push(theme.fg("dim", `…and ${grouped.length - MAX_AGENT_ROWS} more`));
		const recentSessions = grouped.filter(
			(run) => run.origin === "session" && run.state !== "pending" && run.state !== "running",
		);
		if (recentSessions.length > 0) {
			lines.push(theme.fg("dim", "─".repeat(SIDEBAR_WIDTH - 2)));
			for (const session of recentSessions.slice(0, 3)) {
				lines.push(truncateToWidth(theme.fg("muted", `↳ ${session.name}  ${session.state}`), SIDEBAR_WIDTH - 2));
			}
		}
	}

	return { lines, agentRowsStartIndex };
}

/** Pure line builder retained for callers that only need rendered content. */
export function buildSidebarLines(data: SidebarData, now: number = Date.now()): string[] {
	return buildSidebarContent(data, now).lines;
}

/**
 * Live sidebar pane: session/model/context/git summary plus the focusable run
 * list. Pulls every registry fresh on render so it follows session replacement.
 */
export interface SidebarActions {
	onEnter(run: AgentRunSummary): void;
	onCancel(run: AgentRunSummary): void;
	onBlur(): void;
}

export class Sidebar implements Component, Focusable {
	private session: AgentSession;
	private runs: AgentRunSummary[] = [];
	private selectedIndex = 0;
	private actions?: SidebarActions;
	private readonly orchestrationHost?: ProcessLifetimeOrchestrationHost;
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
	}

	constructor(
		session: AgentSession,
		private readonly runtimeHost: AgentSessionRuntime,
		private readonly footerData: ReadonlyFooterDataProvider,
	) {
		this.session = session;
		this.orchestrationHost = getActiveOrchestrationHost();
	}

	setActions(actions: SidebarActions): void {
		this.actions = actions;
	}

	setSession(session: AgentSession): void {
		this.session = session;
	}

	invalidate(): void {
		// No cached state to invalidate.
	}

	private collectData(): SidebarData {
		const state = this.session.state;
		const contextUsage = this.session.getContextUsage();
		const contextWindow = contextUsage?.contextWindow ?? state.model?.contextWindow ?? 0;
		const recentCutoff = Date.now() - 30_000;
		const agentRuns = collectAgentRuns(
			this.runtimeHost.subagentRegistry?.list() ?? [],
			this.runtimeHost.harnessRunManager?.runs() ?? [],
			this.orchestrationHost?.snapshot(),
		).filter(
			(run) =>
				(run.origin !== "session" || run.parentSessionId === this.session.sessionId) &&
				(run.state === "pending" ||
					run.state === "running" ||
					(run.endTime !== undefined && Date.parse(run.endTime) >= recentCutoff)),
		);
		this.runs = groupAgentRuns(agentRuns)
			.flatMap((group) => group.runs)
			.slice(0, MAX_AGENT_ROWS);
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.runs.length - 1));

		return {
			sessionName: this.session.sessionManager.getSessionName(),
			version: VERSION,
			modelId: state.model?.id,
			modelSupportsThinking: !!state.model?.reasoning,
			thinkingLevel: state.thinkingLevel || "off",
			contextPercent: contextUsage?.percent ?? null,
			contextWindow,
			gitBranch: this.footerData.getGitBranch(),
			gitDirty: this.footerData.getGitDirty(),
			gitRoot: this.footerData.getGitRoot(),
			agentRuns,
		};
	}

	render(width: number): string[] {
		const content = buildSidebarContent(this.collectData());
		const lines = content.lines.map((line) => truncateToWidth(line, width));
		if (!this.focused || this.runs.length === 0) return lines;
		const rowIndex = content.agentRowsStartIndex + this.selectedIndex;
		if (rowIndex >= 0 && lines[rowIndex] !== undefined) lines[rowIndex] = theme.bg("selectedBg", lines[rowIndex]);
		return lines;
	}

	handleInput(data: string): void {
		const keybindings = getKeybindings();
		if (keybindings.matches(data, "tui.select.cancel")) {
			this.actions?.onBlur();
			return;
		}
		if (keybindings.matches(data, "tui.select.up")) {
			this.selectedIndex =
				this.runs.length === 0 ? 0 : (this.selectedIndex - 1 + this.runs.length) % this.runs.length;
			getOrchestrationUiController()?.requestRender();
			return;
		}
		if (keybindings.matches(data, "tui.select.down")) {
			this.selectedIndex = this.runs.length === 0 ? 0 : (this.selectedIndex + 1) % this.runs.length;
			getOrchestrationUiController()?.requestRender();
			return;
		}
		if (keybindings.matches(data, "app.child.enter")) {
			const selected = this.runs[this.selectedIndex];
			if (selected !== undefined) this.actions?.onEnter(selected);
			return;
		}
		if (keybindings.matches(data, "app.child.cancel")) {
			const selected = this.runs[this.selectedIndex];
			if (selected !== undefined) this.actions?.onCancel(selected);
		}
	}
}

/**
 * Wraps a "chat" component and the Sidebar side by side via Columns, applying the
 * width/setting breakpoint on every render. Below the breakpoint, renders `chat`
 * alone with no wrapping overhead — output is byte-identical to not having a
 * sidebar at all, satisfying the "zero behavior change" requirement.
 */
export class SidebarLayout implements Component {
	constructor(
		private readonly chat: Component,
		private readonly sidebar: Sidebar,
		private readonly settingsManager: SettingsManager,
	) {}

	invalidate(): void {
		this.chat.invalidate?.();
		this.sidebar.invalidate();
	}

	render(width: number): string[] {
		if (!isSidebarVisible(width, this.settingsManager.getSidebar())) {
			return this.chat.render(width);
		}
		return new Columns([
			{ component: this.chat, flex: 1 },
			{ component: this.sidebar, width: SIDEBAR_WIDTH },
		]).render(width);
	}
}
