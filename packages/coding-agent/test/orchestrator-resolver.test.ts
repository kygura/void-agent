import { ConfiguredProvider, MockProvider, Orchestrator } from "@void/orchestrator";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_MAX_CONCURRENT_SUBAGENTS,
	resolveMaxConcurrentSubagents,
	resolveOrchestratorSettings,
} from "../src/core/orchestrator-config.js";

describe("orchestrator Provider resolution", () => {
	it("uses the exact defaults when orchestrator settings are missing", () => {
		const result = resolveOrchestratorSettings({});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.config.defaultProvider).toBe("claude");
		expect(Object.keys(result.providers)).toEqual(["claude", "codex", "pi", "opencode"]);
		expect(result.providers.claude.type).toBe("claude");
		expect(result.providers.codex.type).toBe("codex");
		expect(result.providers.pi.type).toBe("generic");
		expect(result.providers.opencode.type).toBe("generic");
		expect(result.providers.mock).toBeUndefined();
		expect(result.orchestrator).toBeInstanceOf(Orchestrator);
		expect(result.orchestrator.snapshot().defaultProvider).toBe("claude");
	});

	it.each([
		[
			"default reference",
			{
				defaultProvider: "missing",
				providers: { mock: { type: "mock" } },
			},
			"$.orchestrator.defaultProvider",
		],
		[
			"Provider type",
			{
				defaultProvider: "broken",
				providers: { broken: { type: "future-provider" } },
			},
			"$.orchestrator.providers.broken.type",
		],
		[
			"generic prompt template",
			{
				defaultProvider: "local",
				providers: {
					local: { type: "generic", command: "local-agent", args: ["--prompt={{prompt}}"] },
				},
			},
			"$.orchestrator.providers.local.args",
		],
		[
			"generic environment",
			{
				defaultProvider: "local",
				providers: {
					local: {
						type: "generic",
						command: "local-agent",
						args: ["{{prompt}}"],
						env: ["1TOKEN=super-secret-value"],
					},
				},
			},
			"$.orchestrator.providers.local.env[0]",
		],
	] as const)("reports an invalid %s without constructing Providers", (_name, orchestrator, path) => {
		const result = resolveOrchestratorSettings({ orchestrator });

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics.some((diagnostic) => diagnostic.path === path)).toBe(true);
		expect(JSON.stringify(result.diagnostics)).not.toContain("super-secret-value");
	});

	it("redacts environment values from construction diagnostics", () => {
		const secret = "construction-secret-value";
		const result = resolveOrchestratorSettings({
			orchestrator: {
				defaultProvider: "local",
				providers: {
					local: {
						type: "generic",
						command: "local-agent",
						args: ["{{prompt}}"],
						env: [`TOKEN=${secret}\0`],
					},
				},
			},
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(JSON.stringify(result.diagnostics)).not.toContain(secret);
	});

	it("resolves configured claude, codex, generic, and mock Providers", () => {
		const result = resolveOrchestratorSettings({
			orchestrator: {
				defaultProvider: "fake",
				providers: {
					anthropicChild: { type: "claude" },
					openaiChild: { type: "codex" },
					local: { type: "generic", command: "local-agent", args: ["-p", "{{prompt}}"] },
					fake: { type: "mock" },
				},
			},
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.providers.anthropicChild).toBeInstanceOf(ConfiguredProvider);
		expect(result.providers.anthropicChild.type).toBe("claude");
		expect(result.providers.openaiChild).toBeInstanceOf(ConfiguredProvider);
		expect(result.providers.openaiChild.type).toBe("codex");
		expect(result.providers.local).toBeInstanceOf(ConfiguredProvider);
		expect(result.providers.local.type).toBe("generic");
		expect(result.providers.fake).toBeInstanceOf(MockProvider);
		expect(result.providers.fake.type).toBe("mock");
		expect(result.orchestrator.snapshot().defaultProvider).toBe("fake");
	});
});

describe("maxConcurrentSubagents", () => {
	it("defaults when the config is missing entirely", () => {
		expect(resolveMaxConcurrentSubagents(undefined)).toEqual({ value: DEFAULT_MAX_CONCURRENT_SUBAGENTS });
	});

	it("defaults when the field is absent from the orchestrator settings", () => {
		expect(resolveMaxConcurrentSubagents({ defaultProvider: "claude", providers: {} })).toEqual({
			value: DEFAULT_MAX_CONCURRENT_SUBAGENTS,
		});
	});

	it.each([
		["a string", "6"],
		["zero", 0],
		["negative", -1],
		["a float", 3.5],
	] as const)("reports a diagnostic and falls back to the default for %s", (_name, invalid) => {
		const result = resolveMaxConcurrentSubagents({ maxConcurrentSubagents: invalid });

		expect(result.value).toBe(DEFAULT_MAX_CONCURRENT_SUBAGENTS);
		expect(result.diagnostic?.path).toBe("$.orchestrator.maxConcurrentSubagents");
		expect(result.diagnostic?.code).toBe("invalid-value");
	});

	it("surfaces an explicit valid override with no diagnostic", () => {
		const result = resolveMaxConcurrentSubagents({ maxConcurrentSubagents: 3 });

		expect(result).toEqual({ value: 3 });
	});

	it("does not break Provider resolution when maxConcurrentSubagents sits alongside valid provider config", () => {
		const result = resolveOrchestratorSettings({
			orchestrator: {
				defaultProvider: "fake",
				maxConcurrentSubagents: 4,
				providers: { fake: { type: "mock" } },
			},
		});

		expect(result.ok).toBe(true);
	});
});
