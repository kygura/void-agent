import { describe, expect, test } from "bun:test";
import { defaultConfig, parseConfig, parseConfigJson } from "../src/config.js";

describe("orchestrator config", () => {
	test("matches the Go defaults and does not inject mock", () => {
		const config = defaultConfig();
		expect(config.defaultProvider).toBe("claude");
		expect(config.providers.claude.models).toEqual([
			"claude-fable-5",
			"claude-opus-4-8",
			"claude-sonnet-5",
			"claude-haiku-4-5",
		]);
		expect(config.providers.codex).toEqual({ type: "codex" });
		expect(config.providers.pi).toMatchObject({
			type: "generic",
			command: "pi",
			args: ["-p", "{{prompt}}"],
			modelFlag: "--model",
			effortFlag: "--thinking",
		});
		expect(config.providers.opencode).toMatchObject({
			type: "generic",
			command: "opencode",
			args: ["run", "{{prompt}}"],
			modelFlag: "-m",
			effortFlag: "--variant",
		});
		expect(config.providers.mock).toBeUndefined();
	});

	test("accepts explicit mock and generic providers", () => {
		const result = parseConfig({
			defaultProvider: "mock",
			providers: {
				mock: { type: "mock", auth: "auto" },
				local: {
					type: "generic",
					command: "local-agent",
					args: ["--prompt", "{{prompt}}"],
					modelFlag: "--model",
					effort: "high",
					env: ["TOKEN=secret"],
				},
			},
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.config.providers.mock).toEqual({ type: "mock", auth: "auto" });
			expect(result.config.providers.local.effort).toBe("high");
		}
	});

	test("returns structured errors without a partial config", () => {
		const result = parseConfigJson(
			JSON.stringify({
				defaultProvider: "missing",
				providers: {
					local: { type: "generic", command: "agent", args: ["{{prompt}}", "{{prompt}}"] },
					bad: { type: "unknown", auth: "bogus" },
				},
			}),
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect("config" in result).toBe(false);
			expect(result.errors.map((error) => error.path)).toEqual(
				expect.arrayContaining([
					"$.providers.local.args",
					"$.providers.bad.type",
					"$.providers.bad.auth",
					"$.defaultProvider",
				]),
			);
		}
	});

	test("rejects non-discrete prompt placeholders and malformed env entries", () => {
		const result = parseConfig({
			defaultProvider: "local",
			providers: {
				local: { type: "generic", command: "agent", args: ["--prompt={{prompt}}"], env: ["not-an-env"] },
			},
		});
		expect(result.ok).toBe(false);
	});
});
