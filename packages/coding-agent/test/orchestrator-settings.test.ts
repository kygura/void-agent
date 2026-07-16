import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.js";

describe("orchestrator settings", () => {
	const testDir = join(process.cwd(), "test-orchestrator-settings-tmp");
	const agentDir = join(testDir, "agent");
	const projectDir = join(testDir, "project");

	beforeEach(() => {
		if (existsSync(testDir)) rmSync(testDir, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(testDir)) rmSync(testDir, { recursive: true });
	});

	it("keeps child Provider selection separate from the parent direct-model Provider", () => {
		const manager = SettingsManager.inMemory({
			defaultProvider: "anthropic",
			orchestrator: {
				defaultProvider: "mock",
				providers: { mock: { type: "mock" } },
			},
		});

		expect(manager.getDefaultProvider()).toBe("anthropic");
		expect(manager.getOrchestratorSettings()?.defaultProvider).toBe("mock");
	});

	it("preserves unknown and invalid orchestrator fields while saving an unrelated setting", async () => {
		const settingsPath = join(agentDir, "settings.json");
		const orchestrator = {
			defaultProvider: "local",
			futureField: { enabled: true },
			providers: {
				local: {
					type: "generic",
					command: "local-agent",
					args: ["--prompt={{prompt}}"],
					futureProviderField: "keep-me",
				},
			},
		};
		writeFileSync(settingsPath, JSON.stringify({ orchestrator, futureRootField: "keep-root" }));

		const manager = SettingsManager.create(projectDir, agentDir);
		manager.setTheme("dark");
		await manager.flush();

		const saved = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
		expect(saved.orchestrator).toEqual(orchestrator);
		expect(saved.futureRootField).toBe("keep-root");
		expect(saved.theme).toBe("dark");
	});
});
