import { basename } from "node:path";
import { Columns, type Component, type Focusable, getKeybindings, truncateToWidth, visibleWidth } from "@void/tui";
import { VERSION } from "../../../config.js";
import type { AgentSession } from "../../../core/agent-session.js";
import type { AgentSessionRuntime } from "../../../core/agent-session-runtime.js";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.js";
import type { ProcessLifetimeOrchestrationHost } from "../../../core/orchestration/host.js";
import { getActiveOrchestrationHost, getOrchestrationUiController } from "../../../core/orchestration/ui-bridge.js";
import type { SettingsManager } from "../../../core/settings-manager.js";
import { styleModel, styleProvider } from "../theme/provider-palette.js";
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
	modelProvider: string | undefined;
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
	agentRowIndexes: number[];
}

function fitToWidth(text: string, width: number, fill = " "): string {
	const fitted = truncateToWidth(text, Math.max(0, width), "");
	return fitted + fill.repeat(Math.max(0, width - visibleWidth(fitted)));
}

function rail(title: string | undefined, width: number, position: "top" | "middle" | "bottom"): string {
	if (width <= 0) return "";
	const left = position === "top" ? "┌" : position === "middle" ? "├" : "└";
	const right = position === "top" ? "┐" : position === "middle" ? "┤" : "┘";
	if (width === 1) return theme.fg("borderMuted", right);
	const innerWidth = width - 2;
	const heading =
		title === undefined
			? ""
			: `${theme.fg("borderMuted", "─ ")}${theme.fg("accent", theme.bold(title))}${theme.fg("borderMuted", " ")}`;
	const fittedHeading = truncateToWidth(heading, innerWidth, "");
	const rule = "─".repeat(Math.max(0, innerWidth - visibleWidth(fittedHeading)));
	return `${theme.fg("borderMuted", left)}${fittedHeading}${theme.fg("borderMuted", `${rule}${right}`)}`;
}

function framedRow(content: string, width: number, selected = false): string {
	if (width <= 0) return "";
	if (width === 1) return theme.fg("borderMuted", "│");
	const innerWidth = width - 2;
	const padding = innerWidth >= 2 ? 1 : 0;
	const contentWidth = Math.max(0, innerWidth - padding * 2);
	const interior = `${" ".repeat(padding)}${fitToWidth(content, contentWidth)}${" ".repeat(padding)}`;
	return `${theme.fg("borderMuted", "│")}${selected ? theme.bg("selectedBg", interior) : interior}${theme.fg("borderMuted", "│")}`;
}

function tableRow(label: string, value: string, width: number): string {
	if (width <= 0) return "";
	const labelWidth = Math.min(9, Math.max(0, width - 1));
	const gap = labelWidth < width ? 1 : 0;
	const valueWidth = Math.max(0, width - labelWidth - gap);
	const labelCell = theme.fg("dim", fitToWidth(label, labelWidth));
	return `${labelCell}${" ".repeat(gap)}${truncateToWidth(value, valueWidth, "")}`;
}

function renderSidebarContent(
	data: SidebarData,
	now: number,
	width: number,
	selectedAgentIndex?: number,
): SidebarContent {
	const renderWidth = Math.max(0, width);
	const rowContentWidth = Math.max(0, renderWidth - (renderWidth >= 4 ? 4 : 2));
	const lines: string[] = [];
	const agentRowIndexes: number[] = [];
	const pushRow = (content: string, selected = false): void => {
		lines.push(framedRow(content, renderWidth, selected));
	};
	const pushTableRow = (label: string, value: string): void => {
		pushRow(tableRow(label, value, rowContentWidth));
	};

	lines.push(rail("SESSION", renderWidth, "top"));
	pushTableRow("Name", data.sessionName ? theme.fg("text", data.sessionName) : theme.fg("dim", "(unnamed session)"));
	pushTableRow("Version", theme.fg("text", `void v${data.version}`));

	lines.push(rail("MODEL / RUNTIME", renderWidth, "middle"));
	if (data.modelProvider) pushTableRow("Provider", styleProvider(data.modelProvider));
	pushTableRow(
		"Model",
		data.modelId
			? data.modelProvider
				? styleModel(data.modelProvider, data.modelId)
				: theme.fg("accent", data.modelId)
			: theme.fg("dim", "no model"),
	);
	if (data.modelSupportsThinking) {
		pushTableRow("Thinking", theme.fg("text", data.thinkingLevel));
	}

	const contextValue =
		data.contextPercent === null
			? `? / ${formatTokens(data.contextWindow)}`
			: `${data.contextPercent.toFixed(1)}% / ${formatTokens(data.contextWindow)}`;
	pushTableRow("Context", theme.fg("text", contextValue));

	lines.push(rail("WORKSPACE / GIT", renderWidth, "middle"));
	if (data.gitBranch) {
		if (data.gitRoot) pushTableRow("Root", theme.fg("text", basename(data.gitRoot)));
		pushTableRow("Branch", theme.fg("text", data.gitBranch));
		pushTableRow(
			"Status",
			data.gitDirty === null
				? theme.fg("dim", "unknown")
				: theme.fg(data.gitDirty ? "warning" : "success", data.gitDirty ? "dirty" : "clean"),
		);
	} else {
		pushTableRow("Git", theme.fg("dim", "no git"));
	}

	lines.push(rail("AGENTS", renderWidth, "middle"));
	const live = data.agentRuns.filter((run) => run.state === "pending" || run.state === "running").length;
	const done = data.agentRuns.filter((run) => run.state === "done").length;
	pushTableRow("Runs", `${theme.fg("accent", `${live}▶`)} ${theme.fg("success", `${done}✓`)}`);
	if (data.agentRuns.length === 0) {
		pushRow(theme.fg("dim", "no runs yet"));
	} else {
		const grouped = groupAgentRuns(data.agentRuns).flatMap((group) => group.runs);
		for (const [index, run] of grouped.slice(0, MAX_AGENT_ROWS).entries()) {
			agentRowIndexes.push(lines.length);
			pushRow(renderRunRow(run, Math.max(1, rowContentWidth), now), selectedAgentIndex === index);
		}
		if (grouped.length > MAX_AGENT_ROWS) pushRow(theme.fg("dim", `…and ${grouped.length - MAX_AGENT_ROWS} more`));
		const recentSessions = grouped.filter(
			(run) => run.origin === "session" && run.state !== "pending" && run.state !== "running",
		);
		if (recentSessions.length > 0) {
			pushRow(theme.fg("borderMuted", "─".repeat(rowContentWidth)));
			for (const session of recentSessions.slice(0, 3)) {
				pushRow(theme.fg("muted", `↳ ${session.name}  ${session.state}`));
			}
		}
	}
	lines.push(rail(undefined, renderWidth, "bottom"));

	return { lines, agentRowIndexes };
}

/** Pure width-aware content builder with structural row metadata. */
export function buildSidebarContent(
	data: SidebarData,
	now: number = Date.now(),
	width: number = SIDEBAR_WIDTH,
): SidebarContent {
	return renderSidebarContent(data, now, width);
}

/** Pure line builder retained for callers that only need rendered content. */
export function buildSidebarLines(
	data: SidebarData,
	now: number = Date.now(),
	width: number = SIDEBAR_WIDTH,
): string[] {
	return buildSidebarContent(data, now, width).lines;
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
			modelProvider: state.model?.provider,
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
		return renderSidebarContent(
			this.collectData(),
			Date.now(),
			width,
			this.focused && this.runs.length > 0 ? this.selectedIndex : undefined,
		).lines;
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
	private readonly columns: Columns;

	constructor(
		private readonly chat: Component,
		private readonly sidebar: Sidebar,
		private readonly settingsManager: SettingsManager,
	) {
		this.columns = new Columns([
			{ component: this.chat, flex: 1 },
			{ component: this.sidebar, width: SIDEBAR_WIDTH },
		]);
	}

	invalidate(): void {
		this.chat.invalidate?.();
		this.sidebar.invalidate();
	}

	render(width: number): string[] {
		if (!isSidebarVisible(width, this.settingsManager.getSidebar())) {
			return this.chat.render(width);
		}
		return this.columns.render(width);
	}
}
