import type { Event, RunSnapshot, SessionSnapshot } from "@void/orchestrator";
import { Box, Container, type Focusable, getKeybindings, Text, truncateToWidth } from "@void/tui";
import {
	type AgentRunSummary,
	lastOrchestratorActivity,
	renderRunRow,
} from "../../modes/interactive/components/agent-runs.js";
import type { Theme } from "../../modes/interactive/theme/theme.js";
import type { MessageRenderer } from "../extensions/types.js";
import type { ProcessLifetimeOrchestrationHost } from "./host.js";
import { VOID_SPAWN_CUSTOM_TYPE, type VoidSpawnMessageDetails } from "./messages.js";
import { getOrchestrationUiController } from "./ui-bridge.js";

const MAX_EXPANDED_EVENTS = 8;

export function createVoidSpawnRenderer(
	host: ProcessLifetimeOrchestrationHost,
): MessageRenderer<VoidSpawnMessageDetails> {
	return (message, options, theme) => {
		if (message.customType !== VOID_SPAWN_CUSTOM_TYPE || typeof message.details?.childSessionId !== "string") {
			return undefined;
		}
		return new VoidSpawnEntryComponent(host, message.details.childSessionId, options.expanded, theme);
	};
}

export class VoidSpawnEntryComponent extends Container implements Focusable {
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
	}

	constructor(
		private readonly host: ProcessLifetimeOrchestrationHost,
		private readonly childSessionId: string,
		private readonly expanded: boolean,
		private readonly entryTheme: Theme,
	) {
		super();
	}

	handleInput(data: string): void {
		const keybindings = getKeybindings();
		if (keybindings.matches(data, "app.child.enter")) {
			getOrchestrationUiController()?.openChild(this.childSessionId);
		} else if (keybindings.matches(data, "app.child.cancel")) {
			getOrchestrationUiController()?.requestCancel(this.childSessionId);
		}
	}

	override render(width: number): string[] {
		const resolved = resolveSpawnEntry(this.host, this.childSessionId);
		if (resolved === undefined) {
			const unknown = this.entryTheme.fg("dim", `[spawn] ○ ${this.childSessionId}  unavailable`);
			const box = new Box(1, 0, (text) => this.entryTheme.bg("customMessageBg", text));
			box.addChild(new Text(unknown, 0, 0));
			return box.render(width);
		}
		const bg =
			resolved.summary.state === "done"
				? "toolSuccessBg"
				: resolved.summary.state === "failed"
					? "toolErrorBg"
					: resolved.summary.state === "cancelled"
						? "customMessageBg"
						: "toolPendingBg";
		const box = new Box(1, 0, (text) => this.entryTheme.bg(bg, text));
		const label = this.entryTheme.fg("customMessageLabel", this.entryTheme.bold("[spawn]"));
		const focus = this.focused ? this.entryTheme.fg("accent", "› ") : "";
		box.addChild(new Text(`${focus}${label} ${renderRunRow(resolved.summary, Math.max(1, width - 4))}`, 0, 0));
		if (this.expanded) {
			const visible = resolved.events.slice(-MAX_EXPANDED_EVENTS);
			for (const event of visible) box.addChild(new Text(this.entryTheme.fg("muted", eventLine(event)), 1, 0));
			const hidden = resolved.events.length - visible.length;
			if (hidden > 0) box.addChild(new Text(this.entryTheme.fg("dim", `… ${hidden} more lines`), 1, 0));
		}
		return box.render(width);
	}
}

interface ResolvedSpawnEntry {
	summary: AgentRunSummary;
	events: readonly Event[];
}

function resolveSpawnEntry(
	host: ProcessLifetimeOrchestrationHost,
	childSessionId: string,
): ResolvedSpawnEntry | undefined {
	const snapshot = host.snapshot();
	const session = snapshot.sessions.find((item) => item.id === childSessionId);
	const runId = session?.runIds.at(-1) ?? host.spawnState(childSessionId)?.runId;
	const run = runId === undefined ? undefined : snapshot.runs.find((item) => item.id === runId);
	if (session !== undefined && run !== undefined) return fromLive(host, session, run);
	const restored = host.spawnState(childSessionId);
	if (restored === undefined) return undefined;
	return {
		summary: {
			id: childSessionId,
			runId: restored.runId,
			name: restored.childName ?? restored.provider,
			provider: restored.provider,
			harnessId: restored.provider,
			origin: "session",
			state: restored.state,
			startTime: new Date().toISOString(),
			...(restored.result?.text ? { lastActivity: restored.result.text } : {}),
		},
		events: [],
	};
}

function fromLive(
	host: ProcessLifetimeOrchestrationHost,
	session: SessionSnapshot,
	run: RunSnapshot,
): ResolvedSpawnEntry {
	const events = host.runEvents(run.id);
	return {
		summary: {
			id: session.id,
			runId: run.id,
			name: session.name ?? run.name ?? run.provider,
			provider: run.provider,
			harnessId: run.provider,
			origin: "session",
			state: run.state,
			startTime: run.startedAt,
			...(run.endedAt === undefined ? {} : { endTime: run.endedAt }),
			...(lastOrchestratorActivity(events) === undefined ? {} : { lastActivity: lastOrchestratorActivity(events) }),
			parentSessionId: session.parentSessionId,
			...(session.model === undefined ? {} : { model: session.model }),
			...(session.effort === undefined ? {} : { effort: session.effort }),
		},
		events,
	};
}

function eventLine(event: Event): string {
	if (event.kind === "text" || event.kind === "thinking" || event.kind === "result")
		return truncateToWidth(event.text ?? "", 100);
	if (event.kind === "tool")
		return `${event.done ? "✓" : "○"} ${event.tool ?? "tool"}${event.detail ? ` · ${event.detail}` : ""}`;
	if (event.kind === "exit") return `exit ${event.exitCode}`;
	if (event.kind === "started") return event.providerSessionId ? `session ${event.providerSessionId}` : "started";
	if (event.kind === "subagentResult") return `${event.state ?? "done"} · ${event.text ?? ""}`;
	return "";
}
