import type { AssistantMessage } from "@void/ai";
import type { Event, ProviderType, RunSnapshot, SessionSnapshot, Subscription } from "@void/orchestrator";
import { Box, Container, type Focusable, Spacer, Text, TruncatedText, type TUI, truncateToWidth } from "@void/tui";
import type { KeybindingsManager } from "../../../core/keybindings.js";
import type { ProcessLifetimeOrchestrationHost } from "../../../core/orchestration/host.js";
import { getEditorTheme, theme } from "../theme/theme.js";
import { type AgentRunCancelResult, type AgentRunSummary, renderRunRow } from "./agent-runs.js";
import { AssistantMessageComponent } from "./assistant-message.js";
import { CustomEditor } from "./custom-editor.js";
import { keyHint } from "./keybinding-hints.js";
import { ToolExecutionComponent } from "./tool-execution.js";
import { UserMessageComponent } from "./user-message.js";

export type ChildSessionTarget =
	| {
			kind: "session";
			session: SessionSnapshot;
			run: RunSnapshot;
			providerType: ProviderType;
	  }
	| { kind: "task"; run: RunSnapshot }
	| {
			kind: "external";
			summary: AgentRunSummary;
			getCurrent(): AgentRunSummary | undefined;
			getOutputText(): string;
			subscribe(listener: () => void): () => void;
			cancel(): AgentRunCancelResult;
	  };

export type ChildComposerRoute =
	| { mode: "queue" | "resume"; placeholder: string }
	| { mode: "disabled"; reason: string };

export interface ChildSessionViewActions {
	parentName: string;
	confirm(title: string, message: string): Promise<boolean>;
	notify(message: string, type?: "info" | "warning" | "error"): void;
	detach(): void;
	requestRender(): void;
}

export function getChildComposerRoute(target: ChildSessionTarget): ChildComposerRoute {
	if (target.kind === "task" || target.kind === "external") {
		return { mode: "disabled", reason: "task run — fire-and-forget, not attached to a session" };
	}
	if (target.providerType === "generic") {
		return { mode: "disabled", reason: "generic providers are not resumable — read-only" };
	}
	if (target.run.state === "pending" || target.run.state === "running") {
		return { mode: "queue", placeholder: "queue a follow-up…" };
	}
	if (target.session.providerSessionId === undefined) {
		return { mode: "disabled", reason: "no provider session id recorded — this child cannot be resumed" };
	}
	return { mode: "resume", placeholder: `resume ${target.session.provider} session…` };
}

/** Full-width child transcript and discrete-prompt composer from DESIGN.md §3A. */
export class ChildSessionView extends Container implements Focusable {
	private readonly header = new Container();
	private readonly transcript = new Container();
	private readonly queue = new Container();
	private readonly composer = new Container();
	private readonly editor: CustomEditor;
	private subscription?: Subscription;
	private externalUnsubscribe?: () => void;
	private current: ChildSessionTarget;
	private detachScheduled = false;
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.editor.focused = value;
	}

	constructor(
		private readonly host: ProcessLifetimeOrchestrationHost,
		target: ChildSessionTarget,
		private readonly tui: TUI,
		private readonly keybindings: KeybindingsManager,
		private readonly actions: ChildSessionViewActions,
	) {
		super();
		this.current = target;
		this.editor = new CustomEditor(tui, getEditorTheme(), keybindings, { paddingX: 1 });
		this.editor.onSubmit = (text) => this.submit(text);
		this.editor.onChange = () => this.renderComposer();
		this.addChild(this.header);
		this.addChild(this.transcript);
		this.addChild(this.queue);
		this.addChild(this.composer);
		if (target.kind === "external") {
			this.externalUnsubscribe = target.subscribe(() => {
				this.refresh();
				this.actions.requestRender();
			});
		} else {
			this.subscription = host.subscribe(() => {
				this.refresh();
				this.actions.requestRender();
			});
		}
		this.refresh();
	}

	get childSessionId(): string | undefined {
		return this.current.kind === "session" ? this.current.session.id : undefined;
	}

	get runId(): string {
		return this.current.kind === "external" ? this.current.summary.runId : this.current.run.id;
	}

	dispose(): void {
		this.subscription?.unsubscribe();
		this.subscription = undefined;
		this.externalUnsubscribe?.();
		this.externalUnsubscribe = undefined;
	}

	override invalidate(): void {
		this.refresh();
		super.invalidate();
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "app.child.detach")) {
			if (this.editor.getText().length > 0) {
				this.editor.setText("");
				this.renderComposer();
				this.actions.requestRender();
			} else {
				this.actions.detach();
			}
			return;
		}
		if (this.keybindings.matches(data, "app.child.queueDrop")) {
			if (this.current.kind === "session" && this.host.removeQueuedPrompt(this.current.session.id) !== undefined) {
				this.actions.notify("dropped queued prompt", "info");
				this.refresh();
				this.actions.requestRender();
			}
			return;
		}
		if (this.keybindings.matches(data, "app.child.cancel")) {
			void this.confirmCancel();
			return;
		}
		if (getChildComposerRoute(this.current).mode !== "disabled") this.editor.handleInput(data);
	}

	private refresh(): void {
		if (this.current.kind === "session") {
			const current = this.current;
			const snapshot = this.host.snapshot();
			const session = snapshot.sessions.find((item) => item.id === current.session.id);
			if (session === undefined) {
				this.scheduleMissingSessionDetach();
				return;
			}
			const runId = session.runIds.at(-1);
			const run = runId === undefined ? undefined : snapshot.runs.find((item) => item.id === runId);
			if (run !== undefined) {
				this.current = {
					kind: "session",
					session,
					run,
					providerType: this.host.providerConfig(session.provider)?.type ?? current.providerType,
				};
			}
		} else if (this.current.kind === "task") {
			const current = this.current;
			const run = this.host.snapshot().runs.find((item) => item.id === current.run.id);
			if (run !== undefined) this.current = { kind: "task", run };
		} else {
			const current = this.current;
			const summary = current.getCurrent();
			if (summary !== undefined) this.current = { ...current, summary };
		}
		this.renderHeader();
		this.renderTranscript();
		this.renderQueue();
		this.renderComposer();
	}

	private renderHeader(): void {
		this.header.clear();
		this.header.addChild(new Spacer(1));
		this.header.addChild(
			new Text(
				buildChildHeaderLine(this.current, this.actions.parentName, this.tui.terminal.columns, Date.now()),
				1,
				0,
			),
		);
		const summary = targetSummary(this.current);
		const live = summary.state === "pending" || summary.state === "running";
		const queued = this.current.kind === "session" ? this.current.session.queue.prompts.length : 0;
		const hints = [
			keyHint("app.child.detach", "detach"),
			...(live ? [keyHint("app.child.cancel", "cancel")] : []),
			...(queued > 0 ? [`queued ${queued}`, keyHint("app.child.queueDrop", "drop newest")] : []),
		];
		this.header.addChild(new TruncatedText(theme.fg("dim", hints.join(" · ")), 1, 0));
	}

	private renderTranscript(): void {
		this.transcript.clear();
		if (this.current.kind === "external") {
			if (this.current.summary.description) {
				this.transcript.addChild(new UserMessageComponent(this.current.summary.description));
			}
			this.transcript.addChild(new Text(this.current.getOutputText(), 1, 0));
			return;
		}
		if (this.current.kind === "task") {
			this.transcript.addChild(new UserMessageComponent(this.current.run.prompt));
			this.addEvents(this.current.run, this.host.runEvents(this.current.run.id));
			return;
		}
		const snapshot = this.host.snapshot();
		for (const runId of this.current.session.runIds) {
			const run = snapshot.runs.find((item) => item.id === runId);
			if (run === undefined) continue;
			this.transcript.addChild(new UserMessageComponent(run.prompt));
			this.addEvents(run, this.host.runEvents(run.id));
		}
	}

	private addEvents(run: RunSnapshot, events: readonly Event[]): void {
		for (const [index, event] of events.entries()) {
			if (event.kind === "text" || event.kind === "thinking") {
				this.transcript.addChild(new AssistantMessageComponent(toAssistantMessage(run, event)));
			} else if (event.kind === "tool") {
				const component = new ToolExecutionComponent(
					event.tool ?? "tool",
					`${run.id}:${index}`,
					{ detail: event.detail },
					{},
					undefined,
					this.tui,
				);
				if (event.done) component.updateResult({ content: [], isError: false });
				this.transcript.addChild(component);
			} else if (event.kind === "result") {
				const box = new Box(1, 1, (text) => theme.bg(event.isError ? "toolErrorBg" : "toolSuccessBg", text));
				box.addChild(
					new Text(
						theme.fg(event.isError ? "error" : "success", event.text || (event.isError ? "failed" : "done")),
						0,
						0,
					),
				);
				this.transcript.addChild(new Spacer(1));
				this.transcript.addChild(box);
			}
		}
	}

	private renderQueue(): void {
		this.queue.clear();
		if (this.current.kind !== "session") return;
		for (const [index, prompt] of this.current.session.queue.prompts.entries()) {
			this.queue.addChild(new TruncatedText(theme.fg("dim", `${index + 1}· ${prompt}`), 1, 0));
		}
	}

	private renderComposer(): void {
		this.composer.clear();
		const route = getChildComposerRoute(this.current);
		if (route.mode === "disabled") {
			this.composer.addChild(new Text(theme.fg("dim", route.reason), 1, 0));
			return;
		}
		if (this.editor.getText().length === 0) {
			this.composer.addChild(new Text(theme.fg("dim", route.placeholder), 1, 0));
		}
		this.composer.addChild(this.editor);
	}

	private submit(text: string): void {
		const prompt = text.trim();
		if (prompt === "" || this.current.kind !== "session") return;
		const route = getChildComposerRoute(this.current);
		if (route.mode === "disabled") return;
		this.host.resume(this.current.session.parentSessionId ?? "", this.current.session.id, prompt);
		this.editor.setText("");
		this.refresh();
		this.actions.requestRender();
	}

	private async confirmCancel(): Promise<void> {
		const summary = targetSummary(this.current);
		const live = summary.state === "pending" || summary.state === "running";
		if (!live) return;
		const queued = this.current.kind === "session" ? this.current.session.queue.prompts.length : 0;
		const message =
			queued === 0
				? "cancel run?"
				: `cancel run? ${queued} queued prompt${queued === 1 ? "" : "s"} — the oldest starts next`;
		if (!(await this.actions.confirm("Cancel child Run", message))) return;
		if (this.current.kind === "external") {
			const result = this.current.cancel();
			if (!result.cancelled) this.actions.notify(result.reason, "warning");
		} else {
			this.host.cancel(this.current.kind === "session" ? this.current.session.id : this.current.run.id);
		}
	}

	private scheduleMissingSessionDetach(): void {
		if (this.detachScheduled) return;
		this.detachScheduled = true;
		queueMicrotask(() => {
			this.actions.notify("child session ended — detached", "info");
			this.actions.detach();
		});
	}
}

export function buildChildHeaderLine(
	target: ChildSessionTarget,
	parentName: string,
	width: number,
	now: number,
): string {
	const summary = targetSummary(target);
	const label = theme.fg("customMessageLabel", theme.bold("[agent]"));
	const parent = theme.fg("dim", `↩ parent: ${parentName}`);
	const available = Math.max(1, width - 2);
	const row = renderRunRow(summary, 1_000, now);
	const full = `${label} ${row}   ${parent}`;
	return truncateToWidth(full, available);
}

function targetSummary(target: ChildSessionTarget): AgentRunSummary {
	if (target.kind === "external") return target.summary;
	const run = target.run;
	return {
		id: target.kind === "session" ? target.session.id : run.id,
		runId: run.id,
		name: target.kind === "session" ? (target.session.name ?? run.name ?? run.provider) : (run.name ?? run.provider),
		provider: run.provider,
		harnessId: run.provider,
		origin: target.kind === "session" ? "session" : "task",
		state: run.state,
		startTime: run.startedAt,
		...(run.endedAt === undefined ? {} : { endTime: run.endedAt }),
		...(target.kind === "session" && target.session.model !== undefined ? { model: target.session.model } : {}),
		...(target.kind === "session" && target.session.effort !== undefined ? { effort: target.session.effort } : {}),
	};
}

function toAssistantMessage(run: RunSnapshot, event: Event): AssistantMessage {
	const content =
		event.kind === "text"
			? [{ type: "text" as const, text: event.text ?? "" }]
			: [{ type: "thinking" as const, thinking: event.text ?? "" }];
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: run.provider,
		model: run.model ?? run.provider,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}
