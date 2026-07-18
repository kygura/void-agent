import { describe, expect, it } from "vitest";
import { getProviderPalette, isFrontierModel } from "../src/modes/interactive/theme/provider-palette.js";

describe("provider palettes", () => {
	it("keeps provider aliases in one stable palette", () => {
		expect(getProviderPalette("claude")).toEqual(getProviderPalette("anthropic"));
		expect(getProviderPalette("codex")).toEqual(getProviderPalette("openai"));
		expect(getProviderPalette("gemini")).toEqual(getProviderPalette("google-gemini-cli"));
		expect(getProviderPalette("github-copilot")).not.toEqual(getProviderPalette("pi"));
		expect(getProviderPalette("claude")).not.toEqual(getProviderPalette("codex"));
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
