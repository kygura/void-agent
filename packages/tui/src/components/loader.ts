import type { TUI } from "../tui.js";
import { truncateToWidth, visibleWidth } from "../utils.js";
import { Text } from "./text.js";

export const MESSAGE_ENTRANCE_MS = 240;

function easeOutCubic(progress: number): number {
	const inverse = 1 - Math.max(0, Math.min(1, progress));
	return 1 - inverse ** 3;
}

/**
 * Slide styled text in from the right edge of a fixed-width viewport.
 * ANSI sequences are preserved while the visible content is clipped.
 */
export function slideTextIntoWidth(text: string, width: number, progress: number): string {
	if (width <= 0) return "";
	const clipped = truncateToWidth(text, width, "");
	const offset = Math.ceil((1 - easeOutCubic(progress)) * width);
	return truncateToWidth(" ".repeat(offset) + clipped, width, "");
}

/**
 * Loader component that updates every 80ms with spinning animation
 */
export class Loader extends Text {
	private frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
	private currentFrame = 0;
	private intervalId: NodeJS.Timeout | null = null;
	private ui: TUI | null = null;
	private messageAnimationStart = Date.now();

	constructor(
		ui: TUI,
		private spinnerColorFn: (str: string) => string,
		private messageColorFn: (str: string) => string,
		private message: string = "Loading...",
	) {
		super("", 1, 0);
		this.ui = ui;
		this.start();
	}

	render(width: number): string[] {
		const contentWidth = Math.max(0, width - 2);
		const progress = (Date.now() - this.messageAnimationStart) / MESSAGE_ENTRANCE_MS;
		const spinner = this.spinnerColorFn(this.frames[this.currentFrame]!);
		const message = slideTextIntoWidth(
			this.messageColorFn(this.message),
			contentWidth - visibleWidth(spinner) - 1,
			progress,
		);
		const line = ` ${spinner} ${message}`;
		return ["", truncateToWidth(line, width, "") + " ".repeat(Math.max(0, width - visibleWidth(line)))];
	}

	start() {
		this.updateDisplay();
		this.intervalId = setInterval(() => {
			this.currentFrame = (this.currentFrame + 1) % this.frames.length;
			this.updateDisplay();
		}, 80);
	}

	stop() {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = null;
		}
	}

	setMessage(message: string) {
		if (message === this.message) return;
		this.message = message;
		this.messageAnimationStart = Date.now();
		this.updateDisplay();
	}

	private updateDisplay() {
		const frame = this.frames[this.currentFrame];
		this.setText(`${this.spinnerColorFn(frame)} ${this.messageColorFn(this.message)}`);
		if (this.ui) {
			this.ui.requestRender();
		}
	}
}
