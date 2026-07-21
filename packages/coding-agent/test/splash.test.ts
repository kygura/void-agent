import type { Terminal } from "@void/tui";
import { truncateToWidth, visibleWidth } from "@void/tui";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import {
	FRAME_INTERVAL_MS,
	fits,
	getActiveSplashBandStyles,
	getSplashPaletteNames,
	getSplashPalettePreference,
	MAX_HEIGHT,
	MAX_WIDTH,
	MIN_HEIGHT,
	MIN_WIDTH,
	renderSplash,
	renderStaticWordmark,
	resetSplashAnimation,
	SplashAnimator,
	SplashComponent,
	setSplashPalette,
	WORDMARK_ENTRANCE_MS,
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

	test("shows crystal and background orbiter glyphs", () => {
		resetSplashAnimation();
		const frames = Array.from({ length: 20 }, (_, frame) =>
			stripAnsi(renderSplash(60, 20, FIXED_TIME + frame * FRAME_INTERVAL_MS)),
		).join("\n");
		// Upper and lower pyramid halves use distinct glyph ramps
		expect(frames).toMatch(/[.:=*#%]/);
		expect(frames).toMatch(/['\-~+x&]/);
		expect(frames).not.toMatch(/@/);
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

	test("pins the splash palette by name and restores random", () => {
		expect(getSplashPaletteNames()).toEqual([
			"amber",
			"green",
			"blue",
			"red",
			"violet",
			"cyan",
			"pink",
			"teal",
			"gold",
			"slate",
		]);

		setSplashPalette("blue");
		expect(getSplashPalettePreference()).toBe("blue");
		const blue = getActiveSplashBandStyles().map((style) => style("x"));

		setSplashPalette("amber");
		expect(getActiveSplashBandStyles().map((style) => style("x"))).not.toEqual(blue);

		setSplashPalette("blue");
		expect(getActiveSplashBandStyles().map((style) => style("x"))).toEqual(blue);

		setSplashPalette("random");
		expect(getSplashPalettePreference()).toBe("random");
	});

	test("animates wordmark halves from opposite sides deterministically", () => {
		resetSplashAnimation();
		const initial = stripAnsi(renderSplash(50, 18, FIXED_TIME)).split("\n")[1]!;
		const settled = stripAnsi(renderSplash(50, 18, FIXED_TIME + WORDMARK_ENTRANCE_MS)).split("\n")[1]!;
		expect(initial).not.toBe(settled);
		expect(settled).toContain("V O I D");

		resetSplashAnimation();
		const replay = stripAnsi(renderSplash(50, 18, FIXED_TIME)).split("\n")[1]!;
		expect(replay).toBe(initial);
	});

	test("renders rotating faceted cubes within the art bounds", () => {
		resetSplashAnimation();
		const first = stripAnsi(renderSplash(60, 20, FIXED_TIME));
		const later = stripAnsi(renderSplash(60, 20, FIXED_TIME + FRAME_INTERVAL_MS * 5));
		expect(later).not.toBe(first);
		expect(first).toMatch(/[·.:oO0]/);
		expect(first.split("\n").every((line) => visibleWidth(line) <= 60)).toBe(true);
		expect(later.split("\n").every((line) => visibleWidth(line) <= 60)).toBe(true);
	});

	test("starts each component wordmark entrance at its own lifecycle epoch", () => {
		vi.useFakeTimers();
		vi.setSystemTime(FIXED_TIME);
		const requestRender = vi.fn();
		const terminal = { rows: 20 } as unknown as Terminal;

		const first = new SplashComponent({ terminal, requestRender });
		const firstInitial = stripAnsi(first.render(50)[1]!);
		vi.advanceTimersByTime(WORDMARK_ENTRANCE_MS / 2);
		first.stop();

		const second = new SplashComponent({ terminal, requestRender });
		const secondInitial = stripAnsi(second.render(50)[1]!);
		expect(secondInitial).toBe(firstInitial);
		second.stop();
	});

	test("uses the static wordmark below the minimum terminal height", () => {
		// Fake timers so the component's frame interval never becomes a real
		// leaked handle if an assertion fails before stop().
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const terminal = { rows: MIN_HEIGHT - 1 } as unknown as Terminal;
		const splash = new SplashComponent({ terminal, requestRender });
		expect(stripAnsi(splash.render(80).join("\n"))).toContain("void");
		splash.stop();
		expect(splash.isRunning).toBe(false);
	});

	test("centers capped art with one shared margin", () => {
		vi.useFakeTimers();
		vi.setSystemTime(FIXED_TIME);
		const requestRender = vi.fn();
		const terminal = { rows: 20 } as unknown as Terminal;
		const splash = new SplashComponent({ terminal, requestRender });
		const lines = splash.render(80);
		const artLines = renderSplash(80, terminal.rows, FIXED_TIME).split("\n");

		expect(lines).toEqual(artLines.map((line) => `          ${line}`));
		splash.stop();
	});

	test("keeps the odd extra column on the right", () => {
		vi.useFakeTimers();
		vi.setSystemTime(FIXED_TIME);
		const requestRender = vi.fn();
		const terminal = { rows: 20 } as unknown as Terminal;
		const splash = new SplashComponent({ terminal, requestRender });
		const lines = splash.render(81).map(stripAnsi);
		const artLines = stripAnsi(renderSplash(81, terminal.rows, FIXED_TIME)).split("\n");

		expect(lines.every((line) => line.startsWith(" ".repeat(10)))).toBe(true);
		expect(lines).toEqual(artLines.map((line) => `          ${line}`));
		splash.stop();
	});

	test("centers the static fallback wordmark", () => {
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const terminal = { rows: MIN_HEIGHT - 1 } as unknown as Terminal;
		const splash = new SplashComponent({ terminal, requestRender }, "void");
		const line = splash.render(10)[0]!;

		expect(stripAnsi(line)).toBe("   void");
		expect(visibleWidth(line)).toBe(7);
		splash.stop();
	});

	test("truncates a narrow static fallback wordmark", () => {
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const terminal = { rows: MIN_HEIGHT - 1 } as unknown as Terminal;
		const splash = new SplashComponent({ terminal, requestRender }, "void");
		const line = splash.render(3)[0]!;

		expect(stripAnsi(line)).toBe(stripAnsi(truncateToWidth(renderStaticWordmark("void"), 3, "")));
		expect(visibleWidth(line)).toBeLessThanOrEqual(3);
		splash.stop();
	});

	test("keeps every returned line within the requested width", () => {
		vi.useFakeTimers();
		const requestRender = vi.fn();
		for (const [width, rows] of [
			[0, MIN_HEIGHT - 1],
			[3, MIN_HEIGHT - 1],
			[MIN_WIDTH - 1, MIN_HEIGHT],
			[MIN_WIDTH, MIN_HEIGHT],
			[80, 20],
		] as const) {
			const terminal = { rows } as unknown as Terminal;
			const splash = new SplashComponent({ terminal, requestRender }, "a longer fallback wordmark");
			expect(splash.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
			splash.stop();
		}
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
