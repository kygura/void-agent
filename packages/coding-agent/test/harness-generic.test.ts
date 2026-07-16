import { describe, expect, test } from "vitest";
import {
	finalizeGeneric,
	type GenericHarnessConfig,
	genericArgs,
	parseGenericLine,
} from "../src/core/harness/generic.js";

describe("genericArgs", () => {
	test("substitutes {{prompt}} as a whole argv element", () => {
		const config: GenericHarnessConfig = { id: "gemini", command: "gemini", args: ["-p", "{{prompt}}", "--json"] };
		expect(genericArgs(config, { prompt: "hello" })).toEqual(["-p", "hello", "--json"]);
	});

	test("keeps a prompt with spaces as a single argv element, not a substring", () => {
		const config: GenericHarnessConfig = { id: "x", command: "x", args: ["{{prompt}}"] };
		const args = genericArgs(config, { prompt: "fix the bug in main.ts and add tests" });
		expect(args).toEqual(["fix the bug in main.ts and add tests"]);
	});

	test("appends the model flag only when both the config and run set a model", () => {
		const config: GenericHarnessConfig = { id: "x", command: "x", args: ["{{prompt}}"], modelFlag: "--model" };
		expect(genericArgs(config, { prompt: "hi", model: "big-model" })).toEqual(["hi", "--model", "big-model"]);
		expect(genericArgs(config, { prompt: "hi" })).toEqual(["hi"]);

		const noFlagConfig: GenericHarnessConfig = { id: "x", command: "x", args: ["{{prompt}}"] };
		expect(genericArgs(noFlagConfig, { prompt: "hi", model: "big-model" })).toEqual(["hi"]);
	});
});

describe("parseGenericLine", () => {
	test("every line becomes a text event", () => {
		const events = parseGenericLine("some plain output");
		expect(events).toEqual([{ kind: "text", timestamp: events[0]?.timestamp, text: "some plain output\n" }]);
	});
});

describe("finalizeGeneric", () => {
	test("isError is false on a clean exit", () => {
		expect(finalizeGeneric({ exitCode: 0, signal: null, stderrTail: "" })).toEqual({
			kind: "result",
			timestamp: expect.any(String),
			isError: false,
		});
	});

	test("isError is true on a non-zero exit", () => {
		const event = finalizeGeneric({ exitCode: 1, signal: null, stderrTail: "" });
		expect(event.isError).toBe(true);
	});

	test("isError is true on a spawn/IO error", () => {
		const event = finalizeGeneric({ exitCode: -1, signal: null, stderrTail: "", error: new Error("ENOENT") });
		expect(event.isError).toBe(true);
	});
});
