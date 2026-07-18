import { beforeAll, describe, expect, it } from "vitest";
import { getProviderPalette, isFrontierModel, styleModel } from "../src/modes/interactive/theme/provider-palette.js";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.js";

beforeAll(() => {
	initTheme(undefined, false);
});

describe("provider palettes", () => {
	it("keeps provider aliases in one stable palette", () => {
		expect(getProviderPalette("claude")).toEqual(getProviderPalette("anthropic"));
		expect(getProviderPalette("codex")).toEqual(getProviderPalette("openai"));
		expect(getProviderPalette("gemini")).toEqual(getProviderPalette("google-gemini-cli"));
		expect(getProviderPalette("github-copilot")).not.toEqual(getProviderPalette("pi"));
		expect(getProviderPalette("claude")).not.toEqual(getProviderPalette("codex"));
	});

	it("uses data-driven provider defaults", () => {
		expect(getProviderPalette("anthropic").base).toBe("#C2410C");
		expect(getProviderPalette("openai").base).toBe("#34D399");
	});

	it("colors frontier model aliases with their own provider's palette, not a bespoke one", () => {
		const anthropicStrong = theme.fgHex(getProviderPalette("anthropic").strong, "claude-fable-5");
		const openaiStrong = theme.fgHex(getProviderPalette("openai").strong, "gpt-5.6-sol");
		expect(styleModel("anthropic", "claude-fable-5")).toBe(theme.bold(anthropicStrong));
		expect(styleModel("openai", "gpt-5.6-sol")).toBe(theme.bold(openaiStrong));
	});

	it("uses a stronger shade from the provider palette for frontier aliases", () => {
		const claude = getProviderPalette("claude");
		const codex = getProviderPalette("codex");

		expect(claude.strong).not.toBe(claude.base);
		expect(codex.strong).not.toBe(codex.base);
		expect(isFrontierModel("Claude Fable 5")).toBe(true);
		expect(isFrontierModel("gpt-5.6-sol")).toBe(true);
		expect(isFrontierModel("claude-sonnet-5")).toBe(false);
	});

	it("assigns unknown providers deterministically", () => {
		expect(getProviderPalette("local-lab")).toEqual(getProviderPalette("LOCAL-LAB"));
	});
});
