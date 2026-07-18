/**
 * Tests for the permission prompt component: summary rendering and keystroke decisions.
 */

import { setKeybindings } from "@void/tui";
import { beforeAll, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import type { PermissionDecision, PermissionRequest } from "../src/core/permissions.js";
import {
	describeRequest,
	describeTarget,
	PermissionPromptComponent,
} from "../src/modes/interactive/components/permission-prompt.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

function request(partial: Partial<PermissionRequest> & Pick<PermissionRequest, "toolName">): PermissionRequest {
	return { args: {}, cwd: "/tmp", ...partial };
}

// The prompt maps escape via the "app.interrupt" binding, registered by the coding-agent
// keybindings manager (not the bare TUI default), so install it before rendering.
beforeAll(() => {
	initTheme(undefined, false);
	setKeybindings(new KeybindingsManager());
});

describe("describeRequest", () => {
	it("counts additions and deletions for a single-edit call", () => {
		const summary = describeRequest(
			request({ toolName: "edit", args: { path: "a.ts", oldText: "a\nb\nc", newText: "x\ny" } }),
		);
		expect(summary).toBe("~ 2 additions, 3 deletions");
	});

	it("sums counts across a multi-edit call", () => {
		const summary = describeRequest(
			request({
				toolName: "edit",
				args: {
					path: "a.ts",
					edits: [
						{ oldText: "a", newText: "x\ny" },
						{ oldText: "b\nc", newText: "z" },
					],
				},
			}),
		);
		expect(summary).toBe("~ 3 additions, 3 deletions");
	});

	it("reports a line count for write", () => {
		expect(describeRequest(request({ toolName: "write", args: { path: "a.ts", content: "one\ntwo" } }))).toBe(
			"write 2 lines",
		);
	});

	it("shows the command for bash", () => {
		expect(describeRequest(request({ toolName: "bash", args: { command: "rm -rf build" } }))).toBe("rm -rf build");
	});
});

describe("describeTarget", () => {
	it("shortens a file path", () => {
		expect(describeTarget(request({ toolName: "write", args: { path: "src/a.ts" } }))).toContain("a.ts");
	});

	it("falls back to subagent type", () => {
		expect(describeTarget(request({ toolName: "subagent", args: { subagent_type: "explorer" } }))).toBe("explorer");
	});
});

describe("PermissionPromptComponent keystrokes", () => {
	function decideOn(keys: string[]): PermissionDecision | undefined {
		let decision: PermissionDecision | undefined;
		const prompt = new PermissionPromptComponent(request({ toolName: "write", args: { path: "a.ts" } }), (d) => {
			decision = d;
		});
		for (const key of keys) prompt.handleInput(key);
		return decision;
	}

	it("maps a/A/d to allow/always/deny", () => {
		expect(decideOn(["a"])).toBe("allow");
		expect(decideOn(["A"])).toBe("always");
		expect(decideOn(["d"])).toBe("deny");
	});

	it("maps escape to cancel", () => {
		expect(decideOn([""])).toBe("cancel");
	});
	it("ignores unrelated keys", () => {
		expect(decideOn(["x", "1", " "])).toBeUndefined();
	});

	it("only settles once", () => {
		const decisions: PermissionDecision[] = [];
		const prompt = new PermissionPromptComponent(request({ toolName: "write", args: { path: "a.ts" } }), (d) =>
			decisions.push(d),
		);
		prompt.handleInput("a");
		prompt.handleInput("d");
		prompt.settle("cancel");
		expect(decisions).toEqual(["allow"]);
		expect(prompt.isSettled()).toBe(true);
	});

	it("renders without throwing at a narrow width", () => {
		const prompt = new PermissionPromptComponent(
			request({ toolName: "bash", args: { command: "a".repeat(500) } }),
			() => {},
		);
		expect(() => prompt.render(20)).not.toThrow();
	});
});
