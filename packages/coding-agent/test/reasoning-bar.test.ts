import type { ThinkingLevel } from "@void/agent";
import { visibleWidth } from "@void/tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it } from "vitest";
import {
	buildReasoningBar,
	buildReasoningGauge,
	ReasoningBarComponent,
	type ReasoningBarData,
	stepThinkingLevel,
} from "../src/modes/interactive/components/reasoning-bar.js";
import { getActiveSplashBandStyles } from "../src/modes/interactive/components/splash.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

const LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

function baseData(overrides: Partial<ReasoningBarData> = {}): ReasoningBarData {
	return {
		modelSupportsThinking: true,
		thinkingLevel: "off",
		availableLevels: LEVELS,
		...overrides,
	};
}

function blocks(line: string): string {
	return stripAnsi(line).split(" ")[0]!;
}

beforeAll(() => {
	initTheme(undefined, false);
});

describe("buildReasoningBar", () => {
	it("fills one block per level up to and including the current one", () => {
		const line = buildReasoningBar(baseData({ thinkingLevel: "medium" }), 80);
		expect(blocks(line)).toBe("████░░");
		expect(stripAnsi(line)).toBe("████░░ medium");
	});

	it("leaves every block empty when thinking is off", () => {
		const data = baseData({ thinkingLevel: "off" });
		expect(blocks(buildReasoningBar(data, 80))).toBe("░░░░░░");
		expect(stripAnsi(buildReasoningGauge(data, 80))).toBe("░░░░░░");
	});

	it("fills every block at the highest level", () => {
		expect(blocks(buildReasoningBar(baseData({ thinkingLevel: "xhigh" }), 80))).toBe("██████");
	});

	it("renders one block per available level when xhigh is unsupported", () => {
		const data = baseData({ thinkingLevel: "high", availableLevels: LEVELS.slice(0, 5) });
		expect(blocks(buildReasoningBar(data, 80))).toBe("█████");
	});

	it("renders an unavailable marker when the model doesn't support thinking", () => {
		const line = buildReasoningBar(baseData({ modelSupportsThinking: false, thinkingLevel: "high" }), 80);
		expect(stripAnsi(line)).toBe("reasoning unavailable");
		expect(stripAnsi(line)).not.toContain("█");
	});

	it("drops the label and stays within narrow widths", () => {
		const data = baseData({ thinkingLevel: "high" });
		expect(stripAnsi(buildReasoningBar(data, 8))).toBe("█████░");
		for (const width of [0, 1, 3, 6, 8, 20]) {
			expect(visibleWidth(buildReasoningBar(data, width))).toBeLessThanOrEqual(width);
		}
	});

	it("renders a compact gauge without a duplicate level label", () => {
		const line = buildReasoningGauge(baseData({ thinkingLevel: "medium" }), 80);
		expect(stripAnsi(line)).toBe("████░░");
		expect(line).not.toContain("medium");
	});

	it("always colors filled blocks from the active splash palette", () => {
		const line = buildReasoningGauge(baseData({ thinkingLevel: "xhigh" }), 80);
		for (const style of getActiveSplashBandStyles()) {
			expect(line).toContain(style("█"));
		}
	});
});

describe("ReasoningBarComponent", () => {
	it("renders exactly one line", () => {
		const component = new ReasoningBarComponent(() => baseData({ thinkingLevel: "low" }));
		const lines = component.render(80);
		expect(lines).toHaveLength(1);
		expect(stripAnsi(lines[0]!)).toBe("███░░░ low");
	});

	it("renders nothing at zero width instead of a broken line", () => {
		const component = new ReasoningBarComponent(() => baseData());
		expect(component.render(0)).toEqual([]);
	});
});

describe("stepThinkingLevel", () => {
	it("steps up and down one level", () => {
		expect(stepThinkingLevel("low", LEVELS, 1)).toBe("medium");
		expect(stepThinkingLevel("low", LEVELS, -1)).toBe("minimal");
	});

	it("clamps at both ends without wrapping", () => {
		expect(stepThinkingLevel("off", LEVELS, -1)).toBe("off");
		expect(stepThinkingLevel("xhigh", LEVELS, 1)).toBe("xhigh");
	});

	it("clamps to the highest available level for the model", () => {
		const capped = LEVELS.slice(0, 5);
		expect(stepThinkingLevel("high", capped, 1)).toBe("high");
	});

	it("returns undefined when no levels are available", () => {
		expect(stepThinkingLevel("off", [], 1)).toBeUndefined();
	});

	it("falls back to the first level when the current one is not available", () => {
		expect(stepThinkingLevel("xhigh", ["off", "minimal"], 1)).toBe("minimal");
	});
});
