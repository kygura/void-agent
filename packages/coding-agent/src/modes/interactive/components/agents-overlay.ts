import { Container, type Focusable, getKeybindings, type SelectItem, SelectList, Spacer, Text } from "@void/tui";
import type { HarnessRunManager } from "../../../core/harness/index.js";
import type { ProcessLifetimeOrchestrationHost } from "../../../core/orchestration/host.js";
import type { SubagentRegistry } from "../../../core/tools/subagent.js";
import { getSelectListTheme, theme } from "../theme/theme.js";
import { type AgentRunSummary, cancelAgentRun, collectAgentRuns, groupAgentRuns, renderRunRow } from "./agent-runs.js";
import { DynamicBorder } from "./dynamic-border.js";
import { keyHint } from "./keybinding-hints.js";

const MAX_VISIBLE_ROWS = 16;

export interface AgentsOverlayOptions {
	orchestrationHost?: ProcessLifetimeOrchestrationHost;
	parentSessionId?: string;
	onEnter?(run: AgentRunSummary): void;
	confirm?(title: string, message: string): Promise<boolean>;
}

/** Filterable, grouped dashboard for every direct and orchestrated run source. */
export class AgentsOverlayComponent extends Container implements Focusable {
	private allRuns: AgentRunSummary[] = [];
	private visibleRuns: AgentRunSummary[] = [];
	private selectedId?: string;
	private filter = "";
	private list?: SelectList;
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
	}

	constructor(
		private readonly subagentRegistry: SubagentRegistry | undefined,
		private readonly harnessRunManager: HarnessRunManager | undefined,
		private readonly onCancel: () => void,
		private readonly requestRender: () => void,
		private readonly options: AgentsOverlayOptions = {},
	) {
		super();
		this.refresh();
	}

	override invalidate(): void {
		this.refresh();
	}

	override render(width: number): string[] {
		this.refresh();
		return super.render(width);
	}

	handleInput(data: string): void {
		const keybindings = getKeybindings();
		if (keybindings.matches(data, "app.child.cancel")) {
			void this.cancelSelected();
			return;
		}
		if (keybindings.matches(data, "tui.editor.deleteCharBackward")) {
			if (this.filter.length > 0) {
				this.filter = this.filter.slice(0, -1);
				this.refresh();
				this.requestRender();
			}
			return;
		}
		if (isPrintable(data)) {
			this.filter += data;
			this.refresh();
			this.requestRender();
			return;
		}
		this.list?.handleInput(data);
		this.requestRender();
	}

	private refresh(): void {
		const orchestration = this.options.orchestrationHost?.snapshot();
		this.allRuns = collectAgentRuns(
			this.subagentRegistry?.list() ?? [],
			this.harnessRunManager?.runs() ?? [],
			orchestration,
		).filter(
			(run) =>
				this.options.parentSessionId === undefined ||
				run.origin !== "session" ||
				run.parentSessionId === this.options.parentSessionId,
		);
		const query = this.filter.toLowerCase();
		this.visibleRuns = this.allRuns.filter((run) =>
			`${run.name} ${run.provider} ${run.state}`.toLowerCase().includes(query),
		);
		this.rebuild();
	}

	private rebuild(): void {
		this.clear();
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
		this.addChild(new Text(theme.bold("Agent Runs"), 1, 0));
		this.addChild(new Text(theme.fg("dim", `filter: ${this.filter || "type to filter"}`), 1, 0));
		this.addChild(new Spacer(1));

		if (this.allRuns.length === 0) {
			this.addChild(new Text(theme.fg("dim", "no runs yet — spawn one with /spawn"), 1, 0));
			this.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
			this.list = undefined;
			return;
		}
		if (this.visibleRuns.length === 0) {
			this.addChild(new Text(theme.fg("dim", "no runs match this filter"), 1, 0));
			this.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
			this.list = undefined;
			return;
		}

		const items: SelectItem[] = [];
		for (const group of groupAgentRuns(this.visibleRuns)) {
			for (const [index, run] of group.runs.entries()) {
				items.push({
					value: run.id,
					label: `${index === 0 ? `${theme.fg("dim", group.label)}  ` : "          "}${renderRunRow(run, 100)}`,
					description: run.origin === "task" ? "task" : run.origin,
				});
			}
		}
		this.list = new SelectList(items, MAX_VISIBLE_ROWS, getSelectListTheme(), {
			minPrimaryColumnWidth: 24,
			maxPrimaryColumnWidth: 90,
		});
		const selectedIndex = Math.max(
			0,
			items.findIndex((item) => item.value === this.selectedId),
		);
		this.list.setSelectedIndex(selectedIndex);
		this.selectedId = items[selectedIndex]?.value;
		this.list.onSelectionChange = (item) => {
			this.selectedId = item.value;
		};
		this.list.onSelect = (item) => {
			const run = this.visibleRuns.find((candidate) => candidate.id === item.value);
			if (run !== undefined) this.options.onEnter?.(run);
		};
		this.list.onCancel = this.onCancel;
		this.addChild(this.list);
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				theme.fg(
					"muted",
					`${keyHint("tui.select.confirm", "view")} · ${keyHint("app.child.cancel", "cancel")} · ${keyHint("tui.select.cancel", "close")}`,
				),
				1,
				0,
			),
		);
		this.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
	}

	private async cancelSelected(): Promise<void> {
		const run = this.visibleRuns.find((candidate) => candidate.id === this.selectedId);
		if (run === undefined || (run.state !== "pending" && run.state !== "running")) return;
		const queued = run.queue?.length ?? 0;
		const message =
			queued === 0
				? `cancel ${run.name}?`
				: `cancel run? ${queued} queued prompt${queued === 1 ? "" : "s"} — the oldest starts next`;
		if (this.options.confirm !== undefined && !(await this.options.confirm("Cancel child Run", message))) {
			return;
		}
		cancelAgentRun(run, this.harnessRunManager, this.options.orchestrationHost);
	}
}

function isPrintable(data: string): boolean {
	return data.length === 1 && data >= " " && data !== "\x7f";
}
