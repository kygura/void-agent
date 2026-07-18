/**
 * Approval prompt for a single gated tool call.
 *
 * One instance is shown per pending request. The PermissionGate serializes requests, so a
 * batch of parallel tool calls produces these one after another rather than all at once.
 */

import { Container, type Focusable, getKeybindings, Spacer, Text, truncateToWidth } from "@void/tui";
import type { PermissionDecision, PermissionRequest } from "../../../core/permissions.js";
import { shortenPath } from "../../../core/tools/render-utils.js";
import { theme } from "../theme/theme.js";
import { DynamicBorder } from "./dynamic-border.js";
import { rawKeyHint } from "./keybinding-hints.js";

const INDENT = "  ";
/** Indent on both sides, plus a column of slack so nothing lands on the last cell. */
const CHROME_WIDTH = 5;

/**
 * One-line summary of what the call will do.
 *
 * Kept intentionally cheap: no file I/O and no second differ. The edit tool's own diff renderer
 * runs later when the call actually executes; here we only need enough to decide.
 */
export function describeRequest(request: PermissionRequest): string {
	const args = request.args;
	switch (request.toolName) {
		case "edit": {
			const edits = Array.isArray(args.edits) ? (args.edits as Array<Record<string, unknown>>) : undefined;
			const pairs = edits ?? [{ oldText: args.oldText, newText: args.newText }];
			let additions = 0;
			let deletions = 0;
			for (const pair of pairs) {
				additions += countLines(pair.newText);
				deletions += countLines(pair.oldText);
			}
			return `~ ${plural(additions, "addition")}, ${plural(deletions, "deletion")}`;
		}
		case "write":
			return `write ${plural(countLines(args.content), "line")}`;
		case "bash":
			return typeof args.command === "string" ? args.command : "";
		case "subagent":
			return typeof args.prompt === "string" ? args.prompt : "";
		case "subagent_send":
			return typeof args.message === "string" ? args.message : "";
		default:
			return "";
	}
}

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function countLines(value: unknown): number {
	if (typeof value !== "string" || value.length === 0) return 0;
	return value.split("\n").length;
}

/** Target of the call, for the header line. */
export function describeTarget(request: PermissionRequest): string {
	const path = request.args.path ?? request.args.file_path;
	if (typeof path === "string") {
		return shortenPath(path);
	}
	if (request.toolName === "subagent" && typeof request.args.subagent_type === "string") {
		return request.args.subagent_type;
	}
	return "";
}

export class PermissionPromptComponent extends Container implements Focusable {
	private readonly onDecide: (decision: PermissionDecision) => void;
	private readonly headerPlain: string;
	private readonly summaryPlain: string;
	private readonly headerText: Text;
	private readonly summaryText: Text;
	private settled = false;

	focused = false;

	constructor(request: PermissionRequest, onDecide: (decision: PermissionDecision) => void) {
		super();
		this.onDecide = onDecide;

		const origin = request.origin ? ` (${request.origin})` : "";
		const target = describeTarget(request);
		this.headerPlain = `${request.toolName}${origin}${target ? `  ${target}` : ""}`;
		this.summaryPlain = describeRequest(request);

		this.headerText = new Text("", 1, 0);
		this.summaryText = new Text("", 1, 0);

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(this.headerText);
		if (this.summaryPlain) {
			this.addChild(this.summaryText);
		}
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				INDENT +
					[
						rawKeyHint("a", "allow once"),
						rawKeyHint("A", `always allow ${request.toolName}`),
						rawKeyHint("d", "deny"),
						rawKeyHint("esc", "cancel turn"),
					].join("   "),
				1,
				0,
			),
		);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
	}

	/**
	 * Truncate against the live viewport width, then colorize.
	 *
	 * Order matters: ANSI codes have zero visible width but non-zero string length, so measuring
	 * coloured text over-truncates and can slice an escape sequence in half.
	 */
	render(width: number): string[] {
		const available = Math.max(10, width - CHROME_WIDTH);
		this.headerText.setText(INDENT + theme.fg("accent", truncateToWidth(this.headerPlain, available)));
		if (this.summaryPlain) {
			this.summaryText.setText(INDENT + theme.fg("muted", truncateToWidth(this.summaryPlain, available)));
		}
		return super.render(width);
	}

	handleInput(keyData: string): void {
		if (this.settled) return;

		if (getKeybindings().matches(keyData, "app.interrupt")) {
			this.settle("cancel");
			return;
		}

		switch (keyData) {
			case "a":
				this.settle("allow");
				return;
			case "A":
				this.settle("always");
				return;
			case "d":
			case "D":
				this.settle("deny");
				return;
			default:
				// Ignore everything else: approval must be an explicit keystroke, never a stray one.
				return;
		}
	}

	/**
	 * Force a decision from outside (abort signal, session teardown).
	 *
	 * Idempotent, so an abort racing a keystroke cannot resolve the same request twice.
	 */
	settle(decision: PermissionDecision): void {
		if (this.settled) return;
		this.settled = true;
		this.onDecide(decision);
	}

	isSettled(): boolean {
		return this.settled;
	}
}
