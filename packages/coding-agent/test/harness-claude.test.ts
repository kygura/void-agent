import { describe, expect, test } from "vitest";
import { claudeArgs, parseClaudeLine } from "../src/core/harness/claude.js";

describe("claudeArgs", () => {
	test("builds the base argv", () => {
		expect(claudeArgs({ prompt: "hello" })).toEqual([
			"-p",
			"hello",
			"--output-format",
			"stream-json",
			"--verbose",
			"--include-partial-messages",
		]);
	});

	test("keeps a prompt with spaces as a single argv element", () => {
		const args = claudeArgs({ prompt: "fix the bug in main.ts and add tests" });
		expect(args[1]).toBe("fix the bug in main.ts and add tests");
		expect(args).toHaveLength(6);
	});

	test("adds --model when set", () => {
		const args = claudeArgs({ prompt: "hi", model: "claude-sonnet-4-5" });
		expect(args).toEqual([
			"-p",
			"hi",
			"--output-format",
			"stream-json",
			"--verbose",
			"--include-partial-messages",
			"--model",
			"claude-sonnet-4-5",
		]);
	});

	test("adds --resume when providerSessionId is set", () => {
		const args = claudeArgs({ prompt: "hi", providerSessionId: "sess-123" });
		expect(args).toEqual([
			"-p",
			"hi",
			"--output-format",
			"stream-json",
			"--verbose",
			"--include-partial-messages",
			"--resume",
			"sess-123",
		]);
	});

	test("appends extraArgs last", () => {
		const args = claudeArgs({
			prompt: "hi",
			model: "claude-sonnet-4-5",
			providerSessionId: "sess-123",
			extraArgs: ["--permission-mode", "acceptEdits"],
		});
		expect(args).toEqual([
			"-p",
			"hi",
			"--output-format",
			"stream-json",
			"--verbose",
			"--include-partial-messages",
			"--model",
			"claude-sonnet-4-5",
			"--resume",
			"sess-123",
			"--permission-mode",
			"acceptEdits",
		]);
	});
});

describe("parseClaudeLine", () => {
	test("system/init emits started with the session id", () => {
		const events = parseClaudeLine(JSON.stringify({ type: "system", subtype: "init", session_id: "abc-123" }));
		expect(events).toEqual([{ kind: "started", timestamp: events[0]?.timestamp, providerSessionId: "abc-123" }]);
	});

	test("system with other subtype is skipped", () => {
		expect(parseClaudeLine(JSON.stringify({ type: "system", subtype: "other" }))).toEqual([]);
	});

	test("stream_event text_delta emits a text event", () => {
		const line = JSON.stringify({
			type: "stream_event",
			event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } },
		});
		const events = parseClaudeLine(line);
		expect(events).toEqual([{ kind: "text", timestamp: events[0]?.timestamp, text: "Hello" }]);
	});

	test("stream_event thinking_delta emits a thinking event", () => {
		const line = JSON.stringify({
			type: "stream_event",
			event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "pondering" } },
		});
		const events = parseClaudeLine(line);
		expect(events).toEqual([{ kind: "thinking", timestamp: events[0]?.timestamp, text: "pondering" }]);
	});

	test("assistant message with tool_use emits a tool event, text/thinking blocks skipped", () => {
		const line = JSON.stringify({
			type: "assistant",
			message: {
				content: [
					{ type: "text", text: "should be ignored" },
					{ type: "tool_use", name: "bash", input: { command: "ls" } },
				],
			},
		});
		const events = parseClaudeLine(line);
		expect(events).toEqual([
			{ kind: "tool", timestamp: events[0]?.timestamp, tool: "bash", toolInput: JSON.stringify({ command: "ls" }) },
		]);
	});

	test("result emits a result event with usage and cost", () => {
		const line = JSON.stringify({
			type: "result",
			result: "final answer",
			is_error: false,
			total_cost_usd: 0.05,
			usage: { input_tokens: 100, output_tokens: 50 },
		});
		const events = parseClaudeLine(line);
		expect(events).toEqual([
			{
				kind: "result",
				timestamp: events[0]?.timestamp,
				text: "final answer",
				isError: false,
				usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.05 },
			},
		]);
	});

	test("result with is_error true is surfaced", () => {
		const events = parseClaudeLine(JSON.stringify({ type: "result", result: "boom", is_error: true }));
		expect(events[0]?.isError).toBe(true);
	});

	test("non-JSON line degrades to a raw text event", () => {
		const events = parseClaudeLine("not json at all");
		expect(events).toEqual([{ kind: "text", timestamp: events[0]?.timestamp, text: "not json at all\n" }]);
	});

	test("unknown top-level type is skipped", () => {
		expect(parseClaudeLine(JSON.stringify({ type: "some_future_type", foo: "bar" }))).toEqual([]);
	});

	test("empty line yields no events", () => {
		expect(parseClaudeLine("")).toEqual([]);
	});
});
