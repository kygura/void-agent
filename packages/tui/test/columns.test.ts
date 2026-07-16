import assert from "node:assert";
import { describe, it } from "node:test";
import { Chalk } from "chalk";
import { Columns } from "../src/components/columns.js";
import type { Component } from "../src/tui.js";
import { visibleWidth } from "../src/utils.js";

// Force full color in CI so ANSI assertions are deterministic
const chalk = new Chalk({ level: 3 });

/** Minimal test double: renders fixed lines regardless of width, tracks the width it was called with. */
class FixedLines implements Component {
	public lastWidth = 0;
	constructor(private readonly lines: string[]) {}
	invalidate(): void {}
	render(width: number): string[] {
		this.lastWidth = width;
		return this.lines;
	}
}

describe("Columns component", () => {
	it("lays out two fixed-width columns side by side, padded to width", () => {
		const left = new FixedLines(["A"]);
		const right = new FixedLines(["B"]);
		const columns = new Columns([
			{ component: left, width: 10 },
			{ component: right, width: 10 },
		]);
		const lines = columns.render(30);

		assert.strictEqual(lines.length, 1);
		assert.strictEqual(left.lastWidth, 10);
		assert.strictEqual(right.lastWidth, 10);
		// 10 (left, padded) + 1 (gap) + 10 (right, padded) = 21
		assert.strictEqual(visibleWidth(lines[0]), 21);
		assert.ok(lines[0].startsWith("A"));
	});

	it("distributes remaining width across flex columns proportionally", () => {
		const a = new FixedLines(["a"]);
		const b = new FixedLines(["b"]);
		const columns = new Columns([
			{ component: a, flex: 1 },
			{ component: b, flex: 2 },
		]);
		// width=100, gap=1 -> 99 remaining split 1:2 -> 33 / 66
		columns.render(100);

		assert.strictEqual(a.lastWidth, 33);
		assert.strictEqual(b.lastWidth, 66);
	});

	it("gives a flex column the full remaining width when it's the only flex column beside a fixed one", () => {
		const chat = new FixedLines(["chat"]);
		const sidebar = new FixedLines(["sidebar"]);
		const columns = new Columns([
			{ component: chat, flex: 1 },
			{ component: sidebar, width: 34 },
		]);
		const lines = columns.render(120);

		// 120 - 1 (gap) - 34 (sidebar) = 85 for chat
		assert.strictEqual(chat.lastWidth, 85);
		assert.strictEqual(visibleWidth(lines[0]), 120);
	});

	it("truncates and pads ANSI content to exactly the column width, preserving styling", () => {
		const styled = new FixedLines([chalk.red("Hello world, this is a long styled line")]);
		const plain = new FixedLines(["short"]);
		const columns = new Columns([
			{ component: styled, width: 15 },
			{ component: plain, width: 10 },
		]);
		const lines = columns.render(30);

		assert.strictEqual(lines.length, 1);
		// Total visible width matches exactly: 15 + 1 (gap) + 10 = 26
		assert.strictEqual(visibleWidth(lines[0]), 26);
		assert.ok(lines[0].includes("\x1b["));
	});

	it("pads shorter columns with blank lines to match the tallest column", () => {
		const tall = new FixedLines(["one", "two", "three"]);
		const short = new FixedLines(["only"]);
		const columns = new Columns([
			{ component: tall, width: 10 },
			{ component: short, width: 10 },
		]);
		const lines = columns.render(30);

		assert.strictEqual(lines.length, 3);
		for (const line of lines) {
			assert.strictEqual(visibleWidth(line), 21);
		}
		assert.ok(lines[0].includes("one") && lines[0].includes("only"));
		assert.ok(lines[1].includes("two"));
		assert.ok(!lines[1].includes("only"));
		assert.ok(lines[2].includes("three"));
	});

	it("returns an empty array for zero columns", () => {
		const columns = new Columns([]);
		assert.deepStrictEqual(columns.render(50), []);
	});

	it("respects a custom gap", () => {
		const left = new FixedLines(["A"]);
		const right = new FixedLines(["B"]);
		const columns = new Columns(
			[
				{ component: left, width: 5 },
				{ component: right, width: 5 },
			],
			{ gap: 3 },
		);
		const lines = columns.render(20);
		assert.strictEqual(visibleWidth(lines[0]), 13);
	});
});
