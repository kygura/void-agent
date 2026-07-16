import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.js";

describe("SettingsManager layering (global -> profile -> project -> CLI overrides)", () => {
	const testDir = join(process.cwd(), "test-settings-layers-tmp");
	const agentDir = join(testDir, "agent");
	const profilesDir = join(agentDir, "profiles");
	const projectDir = join(testDir, "project");

	beforeEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
		mkdirSync(profilesDir, { recursive: true });
		mkdirSync(join(projectDir, ".void"), { recursive: true });
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
	});

	function writeGlobal(settings: Record<string, unknown>): void {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings));
	}

	function writeProfile(name: string, settings: Record<string, unknown>): void {
		writeFileSync(join(profilesDir, `${name}.json`), JSON.stringify(settings));
	}

	function writeProject(settings: Record<string, unknown>): void {
		writeFileSync(join(projectDir, ".void", "settings.json"), JSON.stringify(settings));
	}

	it("uses only global settings when no other layer is present", () => {
		writeGlobal({ theme: "dark", defaultModel: "claude-sonnet" });
		const manager = SettingsManager.create(projectDir, agentDir);
		expect(manager.getTheme()).toBe("dark");
		expect(manager.getDefaultModel()).toBe("claude-sonnet");
	});

	it("project settings win over global for the same key", () => {
		writeGlobal({ theme: "dark" });
		writeProject({ theme: "light" });
		const manager = SettingsManager.create(projectDir, agentDir);
		expect(manager.getTheme()).toBe("light");
	});

	it("profile settings win over global but lose to project", () => {
		writeGlobal({ theme: "dark", defaultModel: "global-model" });
		writeProfile("work", { theme: "profile-theme", defaultModel: "profile-model" });
		writeProject({ theme: "project-theme" });

		const manager = SettingsManager.create(projectDir, agentDir, { profile: "work" });
		// project wins over profile
		expect(manager.getTheme()).toBe("project-theme");
		// profile wins over global (no project override for defaultModel)
		expect(manager.getDefaultModel()).toBe("profile-model");
	});

	it("merges nested objects across every layer", () => {
		writeGlobal({ compaction: { enabled: true, reserveTokens: 16384 } });
		writeProfile("work", { compaction: { reserveTokens: 8192 } });
		writeProject({ compaction: { keepRecentTokens: 5000 } });

		const manager = SettingsManager.create(projectDir, agentDir, { profile: "work" });
		expect(manager.getCompactionSettings()).toEqual({
			enabled: true,
			reserveTokens: 8192,
			keepRecentTokens: 5000,
		});
	});

	it("CLI overrides win over every file layer", () => {
		writeGlobal({ theme: "dark" });
		writeProfile("work", { theme: "profile-theme" });
		writeProject({ theme: "project-theme" });

		const manager = SettingsManager.create(projectDir, agentDir, {
			profile: "work",
			cliOverrides: { theme: "cli-theme" },
		});
		expect(manager.getTheme()).toBe("cli-theme");
	});

	it("CLI overrides apply without a profile", () => {
		writeGlobal({ theme: "dark" });
		const manager = SettingsManager.create(projectDir, agentDir, {
			cliOverrides: { statusLine: ["model", "git-branch"] },
		});
		expect(manager.getStatusLine()).toEqual(["model", "git-branch"]);
		expect(manager.getTheme()).toBe("dark");
	});

	it("throws a clear error listing available profiles when the profile file is missing", () => {
		writeProfile("work", {});
		writeProfile("personal", {});
		expect(() => SettingsManager.create(projectDir, agentDir, { profile: "missing" })).toThrowError(
			/Profile "missing" not found.*Available profiles:.*(work|personal)/s,
		);
	});

	it("throws a clear error when no profiles exist at all", () => {
		rmSync(profilesDir, { recursive: true });
		expect(() => SettingsManager.create(projectDir, agentDir, { profile: "missing" })).toThrowError(
			/Profile "missing" not found.*\(none found\)/s,
		);
	});

	it("writes (setTheme) still persist to the global settings file, not merged/layered output", async () => {
		writeGlobal({ theme: "dark" });
		writeProfile("work", { theme: "profile-theme" });
		writeProject({});

		const manager = SettingsManager.create(projectDir, agentDir, { profile: "work" });
		manager.setTheme("light");
		await manager.flush();

		const savedGlobal = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
		expect(savedGlobal.theme).toBe("light");
		const profileFile = JSON.parse(readFileSync(join(profilesDir, "work.json"), "utf-8"));
		expect(profileFile.theme).toBe("profile-theme");
	});
});
