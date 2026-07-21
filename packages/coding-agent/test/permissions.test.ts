/**
 * Tests for opt-in permission gating of mutating tool calls.
 *
 * Covers the default auto-approve path, deny/always-allow decisions, batch queueing across a
 * parallel tool-call preflight, abort handling, and the subagent (no-TTY) escalation policy.
 */

import { Type } from "@sinclair/typebox";
import { type AgentContext, type AgentLoopConfig, type AgentMessage, type AgentTool, agentLoop } from "@void/agent";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Message,
	type Model,
	type UserMessage,
} from "@void/ai";
import { describe, expect, it, vi } from "vitest";
import {
	createPermissionGate,
	isMutatingTool,
	MUTATING_TOOL_NAMES,
	type PermissionDecision,
	PermissionGate,
	type PermissionRequest,
} from "../src/core/permissions.js";
import { InMemorySettingsStorage, SettingsManager } from "../src/core/settings-manager.js";

// ---------------------------------------------------------------------------
// Agent-loop harness (mirrors packages/agent/test/agent-loop.test.ts)
// ---------------------------------------------------------------------------

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createModel(): Model<"openai-responses"> {
	return {
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function createAssistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: createUsage(),
		stopReason,
		timestamp: Date.now(),
	};
}

function createUserMessage(text: string): UserMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

/** A stand-in for a mutating tool that records every execution. */
function createRecordingTool(name: string, executed: string[]): AgentTool<any> {
	const schema = Type.Object({ path: Type.String() });
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: schema,
		async execute(_toolCallId, params: { path: string }) {
			executed.push(`${name}:${params.path}`);
			return { content: [{ type: "text", text: "ok" }], details: {} };
		},
	} as AgentTool<any>;
}

type ToolCallSpec = { id: string; name: string; path: string };

/**
 * Run one assistant turn that issues the given tool calls, then stops.
 *
 * Returns which tools actually executed plus the tool results the model would read back.
 */
async function runTurn(
	calls: ToolCallSpec[],
	tools: AgentTool<any>[],
	gate: PermissionGate | undefined,
	signal?: AbortSignal,
): Promise<{ executed: string[]; results: Array<{ name: string; isError: boolean; text: string }> }> {
	const executed: string[] = [];
	const toolsWithRecording = tools.length > 0 ? tools : [];

	const context: AgentContext = {
		systemPrompt: "",
		messages: [],
		tools: toolsWithRecording,
	};

	const config: AgentLoopConfig = {
		model: createModel(),
		convertToLlm: identityConverter,
		...(gate
			? {
					beforeToolCall: async ({ toolCall, args }, innerSignal) => {
						const result = await gate.check(
							{
								toolName: toolCall.name,
								args: (args ?? {}) as Record<string, unknown>,
								cwd: "/tmp",
							},
							innerSignal,
						);
						return result.allowed ? undefined : { block: true, reason: result.reason };
					},
				}
			: {}),
	};

	let callIndex = 0;
	const streamFn = () => {
		const stream = new MockAssistantStream();
		queueMicrotask(() => {
			if (callIndex === 0) {
				stream.push({
					type: "done",
					reason: "toolUse",
					message: createAssistantMessage(
						calls.map((c) => ({
							type: "toolCall" as const,
							id: c.id,
							name: c.name,
							arguments: { path: c.path },
						})),
						"toolUse",
					),
				});
			} else {
				stream.push({
					type: "done",
					reason: "stop",
					message: createAssistantMessage([{ type: "text", text: "done" }]),
				});
			}
			callIndex++;
		});
		return stream;
	};

	const results: Array<{ name: string; isError: boolean; text: string }> = [];
	const stream = agentLoop([createUserMessage("go")], context, config, signal, streamFn);
	for await (const event of stream) {
		if (event.type === "tool_execution_end") {
			const content = (event.result?.content ?? []) as Array<{ type: string; text?: string }>;
			results.push({
				name: event.toolName,
				isError: event.isError === true,
				text: content
					.map((c) => c.text ?? "")
					.join("")
					.trim(),
			});
		}
	}

	return { executed, results };
}

/** Wire the recording tools so `runTurn` can observe execution. */
function harness(names: string[]) {
	const executed: string[] = [];
	const tools = names.map((name) => createRecordingTool(name, executed));
	return { executed, tools };
}

function inMemorySettings(): SettingsManager {
	return SettingsManager.fromStorage(new InMemorySettingsStorage());
}

// ---------------------------------------------------------------------------

describe("mutating tool classification", () => {
	it("classifies filesystem, shell, and subagent tools as mutating", () => {
		for (const name of ["edit", "write", "bash", "subagent", "subagent_send"]) {
			expect(isMutatingTool(name)).toBe(true);
		}
	});

	it("leaves read-only tools ungated", () => {
		for (const name of ["read", "grep", "find", "ls", "web_search", "subagent_output"]) {
			expect(isMutatingTool(name)).toBe(false);
			expect(MUTATING_TOOL_NAMES).not.toContain(name);
		}
	});
});

describe("default configuration", () => {
	it("auto-approves with no gate configured: tools run and no approver is consulted", async () => {
		const { executed, tools } = harness(["write"]);
		const { results } = await runTurn([{ id: "t1", name: "write", path: "a.ts" }], tools, undefined);

		expect(executed).toEqual(["write:a.ts"]);
		expect(results[0]?.isError).toBe(false);
	});

	it("auto-approves when a gate exists but is disabled, without touching the approver", async () => {
		const approver = vi.fn<(r: PermissionRequest) => Promise<PermissionDecision>>();
		const gate = new PermissionGate({ enabled: false });
		gate.setApprover(approver);

		const { executed, tools } = harness(["write"]);
		await runTurn([{ id: "t1", name: "write", path: "a.ts" }], tools, gate);

		expect(executed).toEqual(["write:a.ts"]);
		expect(approver).not.toHaveBeenCalled();
	});

	it("defaults to disabled in settings", () => {
		expect(inMemorySettings().getPermissionsEnabled()).toBe(false);
	});

	it("creates a disabled gate so the interactive toggle can enable it", () => {
		const gate = createPermissionGate(inMemorySettings());

		expect(gate.isEnabled()).toBe(false);
		gate.setEnabled(true);
		expect(gate.isEnabled()).toBe(true);
	});
});

describe("enabled gate", () => {
	it("never prompts for read-only tools", async () => {
		const approver = vi.fn(async () => "allow" as const);
		const gate = new PermissionGate({ enabled: true });
		gate.setApprover(approver);

		const { executed, tools } = harness(["read"]);
		await runTurn([{ id: "t1", name: "read", path: "a.ts" }], tools, gate);

		expect(executed).toEqual(["read:a.ts"]);
		expect(approver).not.toHaveBeenCalled();
	});

	it("blocks a denied call and returns a readable is_error tool result", async () => {
		const gate = new PermissionGate({ enabled: true });
		gate.setApprover(async () => "deny");

		const { executed, tools } = harness(["write"]);
		const { results } = await runTurn([{ id: "t1", name: "write", path: "a.ts" }], tools, gate);

		expect(executed).toEqual([]);
		expect(results).toHaveLength(1);
		expect(results[0]?.isError).toBe(true);
		expect(results[0]?.text).toContain("Denied by user");
	});

	it("runs the call when allowed once, and prompts again next time", async () => {
		const approver = vi.fn(async () => "allow" as const);
		const gate = new PermissionGate({ enabled: true });
		gate.setApprover(approver);

		const { executed, tools } = harness(["write"]);
		await runTurn([{ id: "t1", name: "write", path: "a.ts" }], tools, gate);
		await runTurn([{ id: "t2", name: "write", path: "b.ts" }], tools, gate);

		expect(executed).toEqual(["write:a.ts", "write:b.ts"]);
		expect(approver).toHaveBeenCalledTimes(2);
	});
});

describe("always allow", () => {
	it("suppresses the second prompt for that tool and persists the choice", async () => {
		const settings = inMemorySettings();
		const approver = vi.fn(async () => "always" as const);
		const gate = new PermissionGate({
			enabled: true,
			alwaysAllow: settings.getPermissionsAlwaysAllow(),
			onAlwaysAllow: (toolName) => settings.addPermissionsAlwaysAllow(toolName),
		});
		gate.setApprover(approver);

		const { executed, tools } = harness(["write"]);
		await runTurn([{ id: "t1", name: "write", path: "a.ts" }], tools, gate);
		await runTurn([{ id: "t2", name: "write", path: "b.ts" }], tools, gate);

		expect(executed).toEqual(["write:a.ts", "write:b.ts"]);
		expect(approver).toHaveBeenCalledTimes(1);
		expect(settings.getPermissionsAlwaysAllow()).toEqual(["write"]);
	});

	it("does not leak an always-allow decision to a different tool", async () => {
		const approver = vi.fn(async (request: PermissionRequest) =>
			request.toolName === "write" ? ("always" as const) : ("deny" as const),
		);
		const gate = new PermissionGate({ enabled: true });
		gate.setApprover(approver);

		const { executed, tools } = harness(["write", "bash"]);
		await runTurn([{ id: "t1", name: "write", path: "a.ts" }], tools, gate);
		const second = await runTurn([{ id: "t2", name: "bash", path: "x" }], tools, gate);

		expect(executed).toEqual(["write:a.ts"]);
		expect(second.results[0]?.isError).toBe(true);
	});

	it("rehydrates a persisted always-allow entry without prompting", async () => {
		const settings = inMemorySettings();
		settings.addPermissionsAlwaysAllow("write");

		const approver = vi.fn(async () => "deny" as const);
		const gate = new PermissionGate({ enabled: true, alwaysAllow: settings.getPermissionsAlwaysAllow() });
		gate.setApprover(approver);

		const { executed, tools } = harness(["write"]);
		await runTurn([{ id: "t1", name: "write", path: "a.ts" }], tools, gate);

		expect(executed).toEqual(["write:a.ts"]);
		expect(approver).not.toHaveBeenCalled();
	});
});

describe("batched parallel tool calls", () => {
	it("queues prompts one at a time even though the loop preflights the whole batch", async () => {
		let concurrent = 0;
		let maxConcurrent = 0;
		const order: string[] = [];

		const gate = new PermissionGate({ enabled: true });
		gate.setApprover(async (request) => {
			concurrent++;
			maxConcurrent = Math.max(maxConcurrent, concurrent);
			order.push(String(request.args.path));
			await new Promise((resolve) => setTimeout(resolve, 5));
			concurrent--;
			return "allow";
		});

		const { executed, tools } = harness(["write"]);
		await runTurn(
			[
				{ id: "t1", name: "write", path: "a.ts" },
				{ id: "t2", name: "write", path: "b.ts" },
				{ id: "t3", name: "write", path: "c.ts" },
			],
			tools,
			gate,
		);

		expect(maxConcurrent).toBe(1);
		expect(order).toEqual(["a.ts", "b.ts", "c.ts"]);
		expect(executed).toHaveLength(3);
	});

	it("denies only the rejected call; siblings still prompt and can run", async () => {
		const gate = new PermissionGate({ enabled: true });
		gate.setApprover(async (request) => (request.args.path === "b.ts" ? "deny" : "allow"));

		const { executed, tools } = harness(["write"]);
		const { results } = await runTurn(
			[
				{ id: "t1", name: "write", path: "a.ts" },
				{ id: "t2", name: "write", path: "b.ts" },
				{ id: "t3", name: "write", path: "c.ts" },
			],
			tools,
			gate,
		);

		expect(executed).toEqual(["write:a.ts", "write:c.ts"]);
		expect(results.filter((r) => r.isError)).toHaveLength(1);
	});

	it("applies an always-allow mid-batch so later calls stop prompting", async () => {
		const approver = vi.fn(async () => "always" as const);
		const gate = new PermissionGate({ enabled: true });
		gate.setApprover(approver);

		const { executed, tools } = harness(["write"]);
		await runTurn(
			[
				{ id: "t1", name: "write", path: "a.ts" },
				{ id: "t2", name: "write", path: "b.ts" },
				{ id: "t3", name: "write", path: "c.ts" },
			],
			tools,
			gate,
		);

		expect(approver).toHaveBeenCalledTimes(1);
		expect(executed).toHaveLength(3);
	});

	it("keeps serving later requests after one approver throws", async () => {
		let call = 0;
		const gate = new PermissionGate({ enabled: true });
		gate.setApprover(async () => {
			call++;
			if (call === 1) throw new Error("prompt exploded");
			return "allow";
		});

		const { executed, tools } = harness(["write"]);
		const { results } = await runTurn(
			[
				{ id: "t1", name: "write", path: "a.ts" },
				{ id: "t2", name: "write", path: "b.ts" },
			],
			tools,
			gate,
		);

		// Fails closed on the throw, but does not wedge the queue.
		expect(results[0]?.isError).toBe(true);
		expect(executed).toEqual(["write:b.ts"]);
	});
});

describe("cancel and abort", () => {
	it("blocks the call when the user cancels the turn", async () => {
		const gate = new PermissionGate({ enabled: true });
		gate.setApprover(async () => "cancel");

		const { executed, tools } = harness(["write"]);
		const { results } = await runTurn([{ id: "t1", name: "write", path: "a.ts" }], tools, gate);

		expect(executed).toEqual([]);
		expect(results[0]?.isError).toBe(true);
		expect(results[0]?.text).toContain("cancelled");
	});

	it("denies immediately when the signal is already aborted, without prompting", async () => {
		const approver = vi.fn(async () => "allow" as const);
		const gate = new PermissionGate({ enabled: true });
		gate.setApprover(approver);

		const controller = new AbortController();
		controller.abort();

		const result = await gate.check({ toolName: "write", args: { path: "a.ts" }, cwd: "/tmp" }, controller.signal);

		expect(result.allowed).toBe(false);
		expect(approver).not.toHaveBeenCalled();
	});

	it("resolves a pending prompt promptly when the signal aborts mid-prompt", async () => {
		const gate = new PermissionGate({ enabled: true });
		// An approver that never resolves on its own: only the abort race can settle this.
		gate.setApprover(() => new Promise<PermissionDecision>(() => {}));

		const controller = new AbortController();
		const pending = gate.check({ toolName: "write", args: { path: "a.ts" }, cwd: "/tmp" }, controller.signal);
		setTimeout(() => controller.abort(), 5);

		const result = await pending;
		expect(result.allowed).toBe(false);
		expect(result.reason).toContain("cancelled");
	});
});

describe("subagent policy (no TTY of its own)", () => {
	it("escalates a child's request to the shared parent gate rather than hanging", async () => {
		const seen: PermissionRequest[] = [];
		const gate = new PermissionGate({ enabled: true });
		gate.setApprover(async (request) => {
			seen.push(request);
			return "allow";
		});

		// A child session shares the parent's gate and tags itself via `origin`.
		const result = await gate.check({
			toolName: "write",
			args: { path: "child.ts" },
			cwd: "/tmp",
			origin: "subagent",
		});

		expect(result.allowed).toBe(true);
		expect(seen[0]?.origin).toBe("subagent");
	});

	it("denies rather than deadlocks when no approver is attached", async () => {
		const gate = new PermissionGate({ enabled: true });
		expect(gate.hasApprover()).toBe(false);

		const { executed, tools } = harness(["write"]);
		const { results } = await runTurn([{ id: "t1", name: "write", path: "a.ts" }], tools, gate);

		expect(executed).toEqual([]);
		expect(results[0]?.isError).toBe(true);
		expect(results[0]?.text).toContain("no interactive approver");
	});

	it("resolves the no-approver case promptly instead of waiting on a prompt", async () => {
		const gate = new PermissionGate({ enabled: true });
		const decided = await Promise.race([
			gate.check({ toolName: "bash", args: { command: "rm -rf /" }, cwd: "/tmp", origin: "subagent" }),
			new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 250)),
		]);

		expect(decided).not.toBe("timeout");
		expect((decided as { allowed: boolean }).allowed).toBe(false);
	});
});

describe("fail-closed behaviour", () => {
	it("denies when the approver returns an unrecognised decision", async () => {
		const gate = new PermissionGate({ enabled: true });
		gate.setApprover(async () => "maybe" as unknown as PermissionDecision);

		const result = await gate.check({ toolName: "write", args: { path: "a.ts" }, cwd: "/tmp" });
		expect(result.allowed).toBe(false);
	});

	it("denies when the approver rejects", async () => {
		const gate = new PermissionGate({ enabled: true });
		gate.setApprover(async () => {
			throw new Error("boom");
		});

		const result = await gate.check({ toolName: "bash", args: { command: "ls" }, cwd: "/tmp" });
		expect(result.allowed).toBe(false);
	});
});

describe("settings persistence", () => {
	it("round-trips the enabled flag", () => {
		const settings = inMemorySettings();
		settings.setPermissionsEnabled(true);
		expect(settings.getPermissionsEnabled()).toBe(true);
		settings.setPermissionsEnabled(false);
		expect(settings.getPermissionsEnabled()).toBe(false);
	});

	it("does not duplicate always-allow entries", () => {
		const settings = inMemorySettings();
		settings.addPermissionsAlwaysAllow("write");
		settings.addPermissionsAlwaysAllow("write");
		expect(settings.getPermissionsAlwaysAllow()).toEqual(["write"]);
	});

	it("clears always-allow entries", () => {
		const settings = inMemorySettings();
		settings.addPermissionsAlwaysAllow("bash");
		settings.clearPermissionsAlwaysAllow();
		expect(settings.getPermissionsAlwaysAllow()).toEqual([]);
	});
});
