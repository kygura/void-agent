import assert from "node:assert/strict";
import test from "node:test";
import { Loader, slideTextIntoWidth } from "../src/components/loader.js";
import type { TUI } from "../src/tui.js";
import { visibleWidth } from "../src/utils.js";

const ui = { requestRender: () => {} } as unknown as TUI;

test("slideTextIntoWidth enters from the right while preserving ANSI styling", () => {
	const styled = "\x1b[31mhello\x1b[39m";
	assert.equal(visibleWidth(slideTextIntoWidth(styled, 5, 0)), 5);
	assert.equal(slideTextIntoWidth(styled, 5, 1), styled);
	assert.match(slideTextIntoWidth(styled, 5, 0.5), /h/);
});

test("Loader keeps its animated row within the requested width", () => {
	const loader = new Loader(
		ui,
		(value) => `[${value}]`,
		(value) => value,
		"working",
	);
	try {
		const [blank, line] = loader.render(24);
		assert.equal(blank, "");
		assert.equal(visibleWidth(line ?? ""), 24);
	} finally {
		loader.stop();
	}
});
