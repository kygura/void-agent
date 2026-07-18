import assert from "node:assert";
import { describe, it } from "node:test";
import { Box } from "../src/components/box.js";
import { Columns } from "../src/components/columns.js";
import { Markdown } from "../src/components/markdown.js";
import type { Component } from "../src/tui.js";
import { truncateToWidth, visibleWidth } from "../src/utils.js";
import { defaultMarkdownTheme } from "./test-themes.js";

class StableLines implements Component {
	constructor(public readonly lines: string[]) {}

	invalidate(): void {}

	render(_width: number): string[] {
		return this.lines;
	}
}

describe("render cache performance", () => {
	it("reuses box output before rebuilding unchanged padded lines", () => {
		const child = new StableLines(["first", "second"]);
		let backgroundCalls = 0;
		const box = new Box(2, 1, (text) => {
			backgroundCalls++;
			return `<${text}>`;
		});
		box.addChild(child);

		const first = box.render(20);
		const callsAfterFirstRender = backgroundCalls;
		const second = box.render(20);

		assert.strictEqual(second, first, "unchanged boxes should reuse their rendered line array");
		assert.strictEqual(
			backgroundCalls,
			callsAfterFirstRender + 1,
			"cache hits should only sample the background function for theme changes",
		);

		child.lines[0] = "updated";
		const updated = box.render(20);
		assert.notStrictEqual(updated, first, "in-place child output changes must invalidate the cached result");
		assert.ok(updated.some((line) => line.includes("updated")));
	});

	it("reuses column layout output while detecting in-place child changes", () => {
		const left = new StableLines(["left"]);
		const right = new StableLines(["right"]);
		const columns = new Columns([
			{ component: left, width: 10 },
			{ component: right, width: 10 },
		]);

		const first = columns.render(21);
		const second = columns.render(21);
		assert.strictEqual(second, first, "unchanged columns should skip width measurement and line assembly");

		left.lines[0] = "changed";
		const updated = columns.render(21);
		assert.notStrictEqual(updated, first);
		assert.ok(updated[0]?.startsWith("changed"));
	});

	it("invalidates cached output when columns are added or removed", () => {
		const specs = [{ component: new StableLines(["left"]), width: 4 }];
		const columns = new Columns(specs);

		assert.deepStrictEqual(columns.render(9), ["left"]);

		specs.push({ component: new StableLines(["rght"]), width: 4 });
		assert.deepStrictEqual(columns.render(9), ["left rght"]);

		specs.pop();
		assert.doesNotThrow(() => columns.render(9));
		assert.deepStrictEqual(columns.render(9), ["left"]);
	});

	it("preserves column truncation output while measuring each source line once", () => {
		const source = "abcdefgh";
		const clipped = truncateToWidth(source, 5);
		const legacyOutput = clipped + " ".repeat(5 - visibleWidth(clipped));
		const columns = new Columns([{ component: new StableLines([source]), width: 5 }]);

		assert.deepStrictEqual(columns.render(5), [legacyOutput]);
	});

	it("keeps parsed markdown cached when setText receives the current value", () => {
		let headingStyleCalls = 0;
		const theme = {
			...defaultMarkdownTheme,
			heading: (text: string) => {
				headingStyleCalls++;
				return defaultMarkdownTheme.heading(text);
			},
		};
		const markdown = new Markdown("# Cached heading", 0, 0, theme);

		const first = markdown.render(80);
		const callsAfterFirstRender = headingStyleCalls;
		markdown.setText("# Cached heading");
		const second = markdown.render(80);

		assert.strictEqual(second, first, "identical text should preserve the parsed and rendered markdown cache");
		assert.strictEqual(headingStyleCalls, callsAfterFirstRender, "identical text should not recompute styles");
	});
});
