import type { Terminal } from "@void/tui";
import { visibleWidth } from "@void/tui";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import {
	FRAME_INTERVAL_MS,
	fits,
	MAX_HEIGHT,
	MAX_WIDTH,
	MIN_HEIGHT,
	MIN_WIDTH,
	renderSplash,
	resetSplashAnimation,
	SplashAnimator,
	SplashComponent,
} from "../src/modes/interactive/components/splash.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

const FIXED_TIME = 1_700_000_123_000;

function stripAnsi(value: string): string {
	return value.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("startup splash", () => {
	beforeAll(() => initTheme("dark"));

	afterEach(() => {
		vi.useRealTimers();
		resetSplashAnimation();
	});

	test("falls back below the minimum art box", () => {
		expect(renderSplash(MIN_WIDTH - 1, MIN_HEIGHT, FIXED_TIME)).toBe("");
		expect(renderSplash(MIN_WIDTH, MIN_HEIGHT - 1, FIXED_TIME)).toBe("");
		expect(fits(MIN_WIDTH, MIN_HEIGHT)).toBe(true);
	});

	test("keeps the requested box and clamps oversized terminals", () => {
		resetSplashAnimation();
		const moderate = renderSplash(44, 16, FIXED_TIME);
		expect(moderate.split("\n")).toHaveLength(16);
		expect(Math.max(...moderate.split("\n").map((line) => visibleWidth(line)))).toBeLessThanOrEqual(44);

		const oversized = renderSplash(200, 200, FIXED_TIME);
		const lines = oversized.split("\n");
		expect(lines).toHaveLength(MAX_HEIGHT);
		expect(Math.max(...lines.map((line) => visibleWidth(stripAnsi(line))))).toBeLessThanOrEqual(MAX_WIDTH);
	});

	test("shows pyramid and background orbiter glyphs", () => {
		resetSplashAnimation();
		const frames = Array.from({ length: 20 }, (_, frame) =>
			stripAnsi(renderSplash(60, 20, FIXED_TIME + frame * FRAME_INTERVAL_MS)),
		).join("\n");
		expect(frames).toMatch(/[.:=*#@]/);
		expect(frames).toMatch(/[·oO]/);
	});

	test("moves all three rotation axes with finite values", () => {
		const animator = new SplashAnimator();
		const moved = [false, false, false];
		for (let frame = 0; frame < 400; frame++) {
			const angles = animator.advance(FIXED_TIME + frame * FRAME_INTERVAL_MS);
			angles.forEach((angle, axis) => {
				expect(Number.isFinite(angle)).toBe(true);
				if (Math.abs(angle) > 0.05) moved[axis] = true;
			});
		}
		expect(moved).toEqual([true, true, true]);
	});

	test("changes frames as time advances", () => {
		resetSplashAnimation();
		const first = renderSplash(50, 18, FIXED_TIME);
		const second = renderSplash(50, 18, FIXED_TIME + 400);
		expect(second).not.toBe(first);
	});

	test("uses the static wordmark below the minimum terminal height", () => {
		const requestRender = vi.fn();
		const terminal = { rows: MIN_HEIGHT - 1 } as unknown as Terminal;
		const splash = new SplashComponent({ terminal, requestRender });
		expect(stripAnsi(splash.render(80).join("\n"))).toContain("void");
		splash.stop();
		expect(splash.isRunning).toBe(false);
	});

	test("stops requesting frames after transcript content appears", () => {
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const terminal = { rows: MIN_HEIGHT } as unknown as Terminal;
		const splash = new SplashComponent({ terminal, requestRender });
		vi.advanceTimersByTime(FRAME_INTERVAL_MS * 2);
		expect(requestRender).toHaveBeenCalledTimes(2);

		splash.stop();
		vi.advanceTimersByTime(FRAME_INTERVAL_MS * 2);
		expect(requestRender).toHaveBeenCalledTimes(2);
	});
});
