import { describe, expect, test } from "vitest";
import { codexArgs, parseCodexLine } from "../src/core/harness/codex.js";

describe("codexArgs", () => {
	test("builds a fresh-conversation argv", () => {
		expect(codexArgs({ prompt: "hello" })).toEqual(["exec", "hello", "--json"]);
	});

	test("builds a resume argv when providerSessionId is set", () => {
		expect(codexArgs({ prompt: "hello", providerSessionId: "sess-123" })).toEqual([
			"exec",
			"resume",
			"sess-123",
			"hello",
			"--json",
		]);
	});

	test("keeps a prompt with spaces as a single argv element", () => {
		const args = codexArgs({ prompt: "fix the bug in main.ts and add tests" });
		expect(args[1]).toBe("fix the bug in main.ts and add tests");
	});

	test("adds -m and -C when set", () => {
		expect(codexArgs({ prompt: "hi", model: "o3", cwd: "/tmp/work" })).toEqual([
			"exec",
			"hi",
			"--json",
			"-m",
			"o3",
			"-C",
			"/tmp/work",
		]);
	});

	test("appends extraArgs last", () => {
		expect(codexArgs({ prompt: "hi", extraArgs: ["--foo", "bar"] })).toEqual([
			"exec",
			"hi",
			"--json",
			"--foo",
			"bar",
		]);
	});
});

describe("parseCodexLine", () => {
	test("SessionConfigured emits started with the session id", () => {
		const events = parseCodexLine(JSON.stringify({ type: "SessionConfigured", session_id: "abc" }));
		expect(events).toEqual([{ kind: "started", timestamp: events[0]?.timestamp, providerSessionId: "abc" }]);
	});

	test("AgentMessage emits a text event", () => {
		const events = parseCodexLine(JSON.stringify({ type: "AgentMessage", message: "hi there" }));
		expect(events).toEqual([{ kind: "text", timestamp: events[0]?.timestamp, text: "hi there" }]);
	});

	test("AgentReasoning emits a thinking event", () => {
		const events = parseCodexLine(JSON.stringify({ type: "AgentReasoning", text: "hmm" }));
		expect(events).toEqual([{ kind: "thinking", timestamp: events[0]?.timestamp, text: "hmm" }]);
	});

	test("TaskComplete emits a result event", () => {
		const events = parseCodexLine(JSON.stringify({ type: "TaskComplete", last_agent_message: "done" }));
		expect(events).toEqual([{ kind: "result", timestamp: events[0]?.timestamp, text: "done" }]);
	});

	test("ExecCommandBegin/End emit tool events", () => {
		const begin = parseCodexLine(JSON.stringify({ type: "ExecCommandBegin", command: ["ls", "-la"] }));
		expect(begin).toEqual([{ kind: "tool", timestamp: begin[0]?.timestamp, tool: "exec", toolInput: "ls -la" }]);

		const end = parseCodexLine(JSON.stringify({ type: "ExecCommandEnd", exit_code: 0 }));
		expect(end).toEqual([
			{ kind: "tool", timestamp: end[0]?.timestamp, tool: "exec", toolInput: "exit 0", toolDone: true },
		]);
	});

	test("Error emits an error result", () => {
		const events = parseCodexLine(JSON.stringify({ type: "Error", message: "kaboom" }));
		expect(events).toEqual([{ kind: "result", timestamp: events[0]?.timestamp, isError: true, text: "kaboom" }]);
	});

	test("non-JSON line degrades to a raw text event", () => {
		const events = parseCodexLine("plain output");
		expect(events).toEqual([{ kind: "text", timestamp: events[0]?.timestamp, text: "plain output\n" }]);
	});

	test("unknown/newer-schema type is skipped, not fatal", () => {
		expect(parseCodexLine(JSON.stringify({ type: "ThreadItemAdded", item: {} }))).toEqual([]);
	});

	test("empty line yields no events", () => {
		expect(parseCodexLine("")).toEqual([]);
	});
});
