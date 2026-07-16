import { describe, expect, it } from "vitest";
import { buildConfigOverrides, mergeConfig, parseConfigValue, setDottedPath } from "../src/core/merge-config.js";

describe("mergeConfig", () => {
	it("merges nested objects recursively", () => {
		const base = { compaction: { enabled: true, reserveTokens: 16384 }, theme: "dark" };
		const overlay = { compaction: { reserveTokens: 8192 } };
		expect(mergeConfig(base, overlay)).toEqual({
			compaction: { enabled: true, reserveTokens: 8192 },
			theme: "dark",
		});
	});

	it("replaces arrays entirely instead of merging them", () => {
		const base = { extensions: ["a", "b"] };
		const overlay = { extensions: ["c"] };
		expect(mergeConfig(base, overlay)).toEqual({ extensions: ["c"] });
	});

	it("deletes a key when overlay value is null", () => {
		const base = { theme: "dark", shellPath: "/bin/zsh" };
		const overlay = { shellPath: null };
		expect(mergeConfig(base, overlay)).toEqual({ theme: "dark" });
	});

	it("replaces scalars", () => {
		const base = { theme: "dark", editorPaddingX: 0 };
		const overlay = { theme: "light", editorPaddingX: 2 };
		expect(mergeConfig(base, overlay)).toEqual({ theme: "light", editorPaddingX: 2 });
	});

	it("ignores undefined overlay values, keeping the base value", () => {
		const base = { theme: "dark" };
		const overlay = { theme: undefined };
		expect(mergeConfig(base, overlay)).toEqual({ theme: "dark" });
	});

	it("adds new keys not present in base", () => {
		const base = { theme: "dark" };
		const overlay = { statusLine: ["model"] };
		expect(mergeConfig(base, overlay)).toEqual({ theme: "dark", statusLine: ["model"] });
	});

	it("does not mutate the base object", () => {
		const base = { compaction: { enabled: true } };
		mergeConfig(base, { compaction: { enabled: false } });
		expect(base).toEqual({ compaction: { enabled: true } });
	});
});

describe("setDottedPath", () => {
	it("sets a top-level key", () => {
		const target: Record<string, unknown> = {};
		setDottedPath(target, "theme", "dark");
		expect(target).toEqual({ theme: "dark" });
	});

	it("creates intermediate objects for nested paths", () => {
		const target: Record<string, unknown> = {};
		setDottedPath(target, "compaction.reserveTokens", 8192);
		expect(target).toEqual({ compaction: { reserveTokens: 8192 } });
	});

	it("overwrites a non-object intermediate value with an object", () => {
		const target: Record<string, unknown> = { compaction: "not-an-object" };
		setDottedPath(target, "compaction.enabled", true);
		expect(target).toEqual({ compaction: { enabled: true } });
	});

	it("preserves sibling keys when setting a nested path", () => {
		const target: Record<string, unknown> = { compaction: { enabled: true } };
		setDottedPath(target, "compaction.reserveTokens", 8192);
		expect(target).toEqual({ compaction: { enabled: true, reserveTokens: 8192 } });
	});
});

describe("parseConfigValue", () => {
	it("parses valid JSON", () => {
		expect(parseConfigValue("true")).toBe(true);
		expect(parseConfigValue("42")).toBe(42);
		expect(parseConfigValue('["model","git-branch"]')).toEqual(["model", "git-branch"]);
		expect(parseConfigValue('{"a":1}')).toEqual({ a: 1 });
	});

	it("falls back to the raw string when JSON parsing fails", () => {
		expect(parseConfigValue("dark")).toBe("dark");
		expect(parseConfigValue("/bin/zsh")).toBe("/bin/zsh");
	});
});

describe("buildConfigOverrides", () => {
	it("builds a nested object from repeated dotted entries", () => {
		const result = buildConfigOverrides([
			{ path: "theme", raw: "dark" },
			{ path: "compaction.reserveTokens", raw: "8192" },
			{ path: "statusLine", raw: '["model","git-branch"]' },
		]);
		expect(result).toEqual({
			theme: "dark",
			compaction: { reserveTokens: 8192 },
			statusLine: ["model", "git-branch"],
		});
	});
});
