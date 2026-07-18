import { describe, expect, it } from "vitest";
import { getOAuthProvider, getOAuthProviders } from "../src/utils/oauth/index.js";

describe("OAuth provider registry", () => {
	it("getOAuthProvider returns github-copilot provider", () => {
		const provider = getOAuthProvider("github-copilot");
		expect(provider).toBeDefined();
		expect(provider?.id).toBe("github-copilot");
		expect(provider?.name).toBe("GitHub Copilot");
	});

	it("getOAuthProviders includes github-copilot", () => {
		const providers = getOAuthProviders();
		const githubCopilotProvider = providers.find((p) => p.id === "github-copilot");
		expect(githubCopilotProvider).toBeDefined();
		expect(githubCopilotProvider?.name).toBe("GitHub Copilot");
	});
});
