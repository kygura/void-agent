import type { ThinkingLevel } from "@void/agent";
import { type Component, truncateToWidth } from "@void/tui";
import { theme } from "../theme/theme.js";
import { getActiveSplashBandStyles } from "./splash.js";

const FILLED_BLOCK = "█";
const EMPTY_BLOCK = "░";

export interface ReasoningBarData {
	modelSupportsThinking: boolean;
	thinkingLevel: ThinkingLevel;
	/** Ordered levels available for the active model (AgentSession.getAvailableThinkingLevels). */
	availableLevels: ThinkingLevel[];
}

/**
 * Step the thinking level by `delta` positions within the available levels.
 * Clamps at both ends (no wrap-around, unlike the shift+tab cycle).
 */
export function stepThinkingLevel(
	current: ThinkingLevel,
	availableLevels: ThinkingLevel[],
	delta: number,
): ThinkingLevel | undefined {
	if (availableLevels.length === 0) return undefined;
	const currentIndex = availableLevels.indexOf(current);
	const from = currentIndex === -1 ? 0 : currentIndex;
	const next = Math.max(0, Math.min(availableLevels.length - 1, from + delta));
	return availableLevels[next];
}

function buildReasoningBlocks(data: ReasoningBarData): string {
	const currentIndex = Math.max(0, data.availableLevels.indexOf(data.thinkingLevel));
	const splashBands = getActiveSplashBandStyles();
	return data.availableLevels
		.map((_level, index) => (index > currentIndex ? theme.fg("dim", EMPTY_BLOCK) : splashBands[index]!(FILLED_BLOCK)))
		.join("");
}

/** Build the compact colored reasoning gauge without a duplicate level label. */
export function buildReasoningGauge(data: ReasoningBarData, width: number): string {
	if (width <= 0 || !data.modelSupportsThinking || data.availableLevels.length === 0) return "";
	return truncateToWidth(buildReasoningBlocks(data), width, "");
}

/** Build the single-line reasoning gauge. Returns "" when there is nothing to show. */
export function buildReasoningBar(data: ReasoningBarData, width: number): string {
	if (width <= 0) return "";

	if (!data.modelSupportsThinking || data.availableLevels.length === 0) {
		return truncateToWidth(theme.fg("dim", "reasoning unavailable"), width);
	}

	const blocks = buildReasoningBlocks(data);

	// Plain-width budget: blocks + " " + level name. Drop the label first on narrow terminals.
	const currentIndex = Math.max(0, data.availableLevels.indexOf(data.thinkingLevel));
	const label = data.availableLevels[currentIndex] ?? data.thinkingLevel;
	if (data.availableLevels.length + 1 + label.length > width) {
		return truncateToWidth(blocks, width, "");
	}
	return `${blocks} ${theme.fg("dim", label)}`;
}

/** Top-of-screen reasoning level gauge. */
export class ReasoningBarComponent implements Component {
	constructor(private getData: () => ReasoningBarData) {}

	/** Stateless: data is pulled fresh on every render. */
	invalidate(): void {}

	render(width: number): string[] {
		const line = buildReasoningBar(this.getData(), width);
		return line.length > 0 ? [line] : [];
	}
}
