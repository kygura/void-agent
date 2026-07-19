import { visibleWidth } from "@void/tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.js";
import { FooterComponent } from "../src/modes/interactive/components/footer.js";
import { buildStatusLineItems, type StatusLineData } from "../src/modes/interactive/components/status-line.js";
import { styleModel } from "../src/modes/interactive/theme/provider-palette.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

function baseData(overrides: Partial<StatusLineData> = {}): StatusLineData {
	return {
		modelProvider: "anthropic",
		modelId: "claude-sonnet",
		modelSupportsThinking: false,
		thinkingLevel: "off",
		cwd: "/home/user/projects/void-ts",
		gitBranch: "main",
		gitDirty: false,
		gitRoot: "/home/user/projects/void-ts",
		contextPercent: 12.3,
		usedTokens: 12345,
		costUsd: 1.234,
		usingSubscription: false,
		sessionName: undefined,
		version: "1.2.3",
		extensionStatuses: new Map(),
		...overrides,
	};
}

beforeAll(() => {
	initTheme(undefined, false);
});

describe("buildStatusLineItems", () => {
	it("renders known catalog items", () => {
		const data = baseData({ modelSupportsThinking: true, thinkingLevel: "high" });
		const items = buildStatusLineItems(data, ["model", "thinking-level"]);
		expect(items).toEqual([styleModel("anthropic", "claude-sonnet"), "high"]);
		expect(stripAnsi(items[0]!)).toBe("claude-sonnet");
	});

	it("drops empty items instead of emitting blank entries", () => {
		const data = baseData({ modelId: undefined, sessionName: undefined });
		expect(buildStatusLineItems(data, ["model", "session-name", "version"])).toEqual(["1.2.3"]);
	});

	it("renders thinking-level as empty when the model doesn't support it", () => {
		const data = baseData({ modelSupportsThinking: false, thinkingLevel: "high" });
		expect(buildStatusLineItems(data, ["thinking-level"])).toEqual([]);
	});

	it("appends a dirty marker to git-branch when the tree is dirty", () => {
		expect(buildStatusLineItems(baseData({ gitDirty: true }), ["git-branch"])).toEqual(["main*"]);
		expect(buildStatusLineItems(baseData({ gitDirty: false }), ["git-branch"])).toEqual(["main"]);
	});

	it("renders empty git-branch/project-root when not in a repo", () => {
		const data = baseData({ gitBranch: null, gitRoot: null });
		expect(buildStatusLineItems(data, ["git-branch", "project-root"])).toEqual([]);
	});

	it("renders current-dir as basename, ~ for home", () => {
		const home = process.env.HOME || process.env.USERPROFILE || "";
		expect(buildStatusLineItems(baseData({ cwd: "/a/b/c" }), ["current-dir"])).toEqual(["c"]);
		if (home) {
			expect(buildStatusLineItems(baseData({ cwd: home }), ["current-dir"])).toEqual(["~"]);
		}
	});

	it("renders project-root as the basename of the git root", () => {
		expect(buildStatusLineItems(baseData({ gitRoot: "/x/y/void-ts" }), ["project-root"])).toEqual(["void-ts"]);
	});

	it("renders context-remaining, dropping it when unknown", () => {
		expect(buildStatusLineItems(baseData({ contextPercent: 40 }), ["context-remaining"])).toEqual(["60% left"]);
		expect(buildStatusLineItems(baseData({ contextPercent: null }), ["context-remaining"])).toEqual([]);
	});

	it("renders used-tokens in compact form, dropping when zero", () => {
		expect(buildStatusLineItems(baseData({ usedTokens: 1234 }), ["used-tokens"])).toEqual(["1.2k"]);
		expect(buildStatusLineItems(baseData({ usedTokens: 0 }), ["used-tokens"])).toEqual([]);
	});

	it("renders cost with a (sub) suffix, dropping when unavailable", () => {
		expect(buildStatusLineItems(baseData({ costUsd: 1.5 }), ["cost"])).toEqual(["$1.500"]);
		expect(buildStatusLineItems(baseData({ costUsd: 0, usingSubscription: true }), ["cost"])).toEqual([
			"$0.000 (sub)",
		]);
		expect(buildStatusLineItems(baseData({ costUsd: undefined }), ["cost"])).toEqual([]);
	});

	it("renders status as sorted, sanitized extension statuses", () => {
		const data = baseData({
			extensionStatuses: new Map([
				["z-ext", "second\nstatus"],
				["a-ext", "first status"],
			]),
		});
		expect(buildStatusLineItems(data, ["status"])).toEqual(["first status second status"]);
	});

	it("renders unknown ids as literal text, for custom labels/separators", () => {
		expect(buildStatusLineItems(baseData(), ["void:", "model", "|"])).toEqual([
			"void:",
			styleModel("anthropic", "claude-sonnet"),
			"|",
		]);
	});
});

function createSession(options: {
	/** "absent" = no settingsManager at all (matches some test doubles); "unset" = present but statusLine unconfigured */
	settingsManager?: "absent" | "unset" | string[];
	statusLineSeparator?: string;
	modelId?: string;
	provider?: string;
	reasoning?: boolean;
	thinkingLevel?: string;
}): AgentSession {
	const mode = options.settingsManager ?? "unset";
	const session = {
		state: {
			model: {
				id: options.modelId ?? "test-model",
				provider: options.provider ?? "test",
				contextWindow: 200_000,
				reasoning: options.reasoning ?? false,
			},
			thinkingLevel: options.thinkingLevel ?? "off",
		},
		sessionManager: {
			getEntries: () => [],
			getSessionName: () => undefined,
			getCwd: () => "/tmp/project",
		},
		getContextUsage: () => ({ contextWindow: 200_000, percent: 12.3 }),
		modelRegistry: {
			isUsingOAuth: () => false,
		},
		settingsManager:
			mode === "absent"
				? undefined
				: {
						getStatusLine: () => (mode === "unset" ? undefined : mode),
						getStatusLineSeparator: () => options.statusLineSeparator ?? " · ",
					},
	};

	return session as unknown as AgentSession;
}

function createFooterData(providerCount = 1): ReadonlyFooterDataProvider {
	return {
		getGitBranch: () => "main",
		getGitRoot: () => "/tmp/project",
		getGitDirty: () => false,
		getExtensionStatuses: () => new Map<string, string>(),
		getAvailableProviderCount: () => providerCount,
		onBranchChange: () => () => {},
	};
}

describe("FooterComponent statusline integration", () => {
	it("renders the legacy multi-line footer when statusLine is unset (default behavior)", () => {
		const session = createSession({ settingsManager: "unset" });
		const footer = new FooterComponent(session, createFooterData());
		const lines = footer.render(80);
		// Legacy footer: pwd line + stats line (no statusLine configured)
		expect(lines.length).toBe(2);
	});

	it("renders the legacy footer when settingsManager itself is absent (e.g. test doubles)", () => {
		const session = createSession({ settingsManager: "absent" });
		const footer = new FooterComponent(session, createFooterData());
		const lines = footer.render(80);
		expect(lines.length).toBe(2);
	});

	it("renders the compact reasoning gauge beside the model without duplicate text", () => {
		const session = createSession({ settingsManager: "unset", reasoning: true, thinkingLevel: "medium" });
		const footer = new FooterComponent(session, createFooterData());
		const line = stripAnsi(footer.render(80)[1]!);

		expect(line).toContain("test-model ████░░");
		expect(line).not.toContain("thinking");
	});

	it("keeps the configured status line free of the legacy reasoning gauge", () => {
		const session = createSession({
			settingsManager: ["model", "git-branch"],
			reasoning: true,
			thinkingLevel: "high",
		});
		const footer = new FooterComponent(session, createFooterData());
		const line = stripAnsi(footer.render(80)[0]!);

		expect(line).toBe("test-model · main");
		expect(line).not.toContain("█");
	});

	it("drops the legacy provider when only the model fits", () => {
		const footer = new FooterComponent(createSession({ settingsManager: "unset" }), createFooterData(2));
		const width = 29;
		const lines = footer.render(width);

		expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		expect(stripAnsi(lines[1]!)).toBe("12.3%/200k (auto)  test-model");
	});

	it("truncates the legacy model to the available right-side width", () => {
		const footer = new FooterComponent(createSession({ settingsManager: "unset" }), createFooterData());
		const width = 23;
		const lines = footer.render(width);

		expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		expect(stripAnsi(lines[1]!)).toBe("12.3%/200k (auto)  test");
	});

	it("omits the legacy model when no right-side width is available", () => {
		const footer = new FooterComponent(createSession({ settingsManager: "unset" }), createFooterData());
		const width = 19;
		const lines = footer.render(width);

		expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		expect(stripAnsi(lines[1]!)).toBe("12.3%/200k (auto)");
	});

	it("colors the legacy footer model with its palette", () => {
		const session = createSession({
			settingsManager: "unset",
			provider: "anthropic",
			modelId: "claude-fable",
		});
		const footer = new FooterComponent(session, createFooterData(2));
		const lines = footer.render(80);

		expect(lines[1]).toContain(styleModel("anthropic", "claude-fable"));
		expect(lines[1]).not.toContain("(anthropic)");
	});

	it("renders a single themed line when statusLine is configured", () => {
		const session = createSession({
			settingsManager: ["model", "git-branch"],
			provider: "anthropic",
			modelId: "claude-sonnet",
		});
		const footer = new FooterComponent(session, createFooterData());
		const lines = footer.render(80);
		expect(lines.length).toBe(1);
		expect(lines[0]).toContain(styleModel("anthropic", "claude-sonnet"));
		expect(lines[0]).toContain("main");
	});

	it("keeps a narrow configured status line within terminal width", () => {
		const footer = new FooterComponent(
			createSession({
				settingsManager: ["model", "git-branch"],
				provider: "anthropic",
				modelId: "claude-sonnet",
			}),
			createFooterData(),
		);
		const width = 10;
		const [line] = footer.render(width);

		expect(visibleWidth(line!)).toBeLessThanOrEqual(width);
	});

	it("uses the configured separator between items", () => {
		const session = createSession({
			settingsManager: ["model", "git-branch"],
			statusLineSeparator: " | ",
			modelId: "claude-sonnet",
		});
		const footer = new FooterComponent(session, createFooterData());
		const lines = footer.render(80);
		expect(lines[0]).toContain("|");
	});
});
