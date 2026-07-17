import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@void/ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { HarnessRunManager } from "../src/core/harness/index.js";
import type { Harness, HarnessEvent, HarnessRunConfig } from "../src/core/harness/types.js";
import { nowIso } from "../src/core/harness/types.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { createAgentSession } from "../src/core/sdk.js";
import { codingTools, readOnlyTools } from "../src/core/tools/index.js";
import { resolveAgentTools } from "../src/core/tools/subagent.js";

function writeAgentFile(dir: string, fileName: string, content: string): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, fileName), content);
}

async function setupFauxSession(options: { cwd: string; agentDir: string; harnessRunManager?: HarnessRunManager }) {
	const faux = registerFauxProvider({});
	faux.setResponses([]);
	const model = faux.getModel();
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey(model.provider, "faux-key");
	const modelRegistry = ModelRegistry.inMemory(authStorage);
	modelRegistry.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		apiKey: "faux-key",
		api: faux.api,
		models: faux.models.map((m) => ({
			id: m.id,
			name: m.name,
			api: m.api,
			reasoning: m.reasoning,
			input: m.input,
			cost: m.cost,
			contextWindow: m.contextWindow,
			maxTokens: m.maxTokens,
			baseUrl: m.baseUrl,
		})),
	});

	const { session } = await createAgentSession({
		cwd: options.cwd,
		agentDir: options.agentDir,
		authStorage,
		modelRegistry,
		model,
		harnessRunManager: options.harnessRunManager,
	});

	return { session, faux };
}

function getToolResultText(session: Awaited<ReturnType<typeof setupFauxSession>>["session"], toolName: string): string {
	const toolResult = session.state.messages.find((m) => m.role === "toolResult" && m.toolName === toolName) as
		| { content: Array<{ type: string; text?: string }> }
		| undefined;
	if (!toolResult) throw new Error(`no toolResult message for tool "${toolName}"`);
	return toolResult.content
		.filter((c) => c.type === "text")
		.map((c) => c.text ?? "")
		.join("\n");
}

/** A gated mock external harness: yields started/text immediately, then blocks on `gate` before result/exit. */
class GatedMockHarness implements Harness {
	readonly id = "mock";
	readonly resumable = false;
	public gate: Promise<void>;
	private release!: () => void;
	public startedPrompts: string[] = [];

	constructor() {
		this.gate = new Promise((resolve) => {
			this.release = resolve;
		});
	}

	releaseNow(): void {
		this.release();
	}

	async *start(cfg: HarnessRunConfig, _signal: AbortSignal): AsyncGenerator<HarnessEvent> {
		this.startedPrompts.push(cfg.prompt);
		yield { kind: "started", timestamp: nowIso(), providerSessionId: "mock-session" };
		yield { kind: "text", timestamp: nowIso(), text: "working..." };
		await this.gate;
		yield { kind: "result", timestamp: nowIso(), text: `mock result for: ${cfg.prompt}` };
		yield { kind: "exit", timestamp: nowIso(), exitCode: 0 };
	}
}

/** An immediate (non-gated) mock external harness, for straightforward foreground tests. */
class ImmediateMockHarness implements Harness {
	readonly id = "mock";
	readonly resumable = false;

	async *start(cfg: HarnessRunConfig, _signal: AbortSignal): AsyncGenerator<HarnessEvent> {
		yield { kind: "started", timestamp: nowIso(), providerSessionId: "mock-session" };
		yield { kind: "result", timestamp: nowIso(), text: `mock result for: ${cfg.prompt}` };
		yield { kind: "exit", timestamp: nowIso(), exitCode: 0 };
	}
}

describe("subagent tool", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `void-subagent-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	describe("resolveAgentTools", () => {
		it("returns all coding tools when tool names are omitted", () => {
			const tools = resolveAgentTools(cwd, undefined);
			expect(tools.map((t) => t.name).sort()).toEqual(codingTools.map((t) => t.name).sort());
		});

		it("restricts to the named tools, ignoring unknown names", () => {
			const tools = resolveAgentTools(cwd, ["read", "grep", "not-a-real-tool"]);
			expect(tools.map((t) => t.name)).toEqual(["read", "grep"]);
		});

		it("maps Claude Code agent-file tool names to void registry names", () => {
			const tools = resolveAgentTools(cwd, ["Read", "Grep", "Glob", "Bash", "Edit", "Write", "LS"]);
			expect(tools.map((t) => t.name)).toEqual(["read", "grep", "find", "bash", "edit", "write", "ls"]);
		});

		it("matches tool names case-insensitively", () => {
			const tools = resolveAgentTools(cwd, ["rEaD", "GREP"]);
			expect(tools.map((t) => t.name)).toEqual(["read", "grep"]);
		});

		it("drops unknown tool names and warns instead of throwing", () => {
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			const tools = resolveAgentTools(cwd, ["read", "WebFetch", "WebSearch", "Task"]);
			expect(tools.map((t) => t.name)).toEqual(["read"]);
			expect(errorSpy).toHaveBeenCalledTimes(3);
			errorSpy.mockRestore();
		});

		it("falls back to read-only tools when nothing resolves", () => {
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			const tools = resolveAgentTools(cwd, ["WebFetch", "WebSearch"]);
			expect(tools.map((t) => t.name).sort()).toEqual(readOnlyTools.map((t) => t.name).sort());
			errorSpy.mockRestore();
		});
	});

	describe("void harness (in-process child)", () => {
		it("runs a default general-purpose child in the foreground and returns its final text", async () => {
			const { session, faux } = await setupFauxSession({ cwd, agentDir });

			faux.setResponses([
				fauxAssistantMessage([fauxToolCall("subagent", { prompt: "say hi" })]),
				fauxAssistantMessage("Hello from child"),
				fauxAssistantMessage("Child said: Hello from child"),
			]);

			await session.prompt("spawn a subagent to say hi");

			const resultText = getToolResultText(session, "subagent");
			expect(resultText).toContain("Hello from child");
			expect(resultText).toMatch(/agent=general/);
			expect(session.getLastAssistantText()).toBe("Child said: Hello from child");
		});

		it("restricts the child's tools to the agent definition's tool list", async () => {
			writeAgentFile(
				join(cwd, ".void", "agents"),
				"readonly-worker.md",
				[
					"---",
					"name: readonly-worker",
					"description: A read-only worker.",
					"tools: read",
					"---",
					"Read-only body.",
				].join("\n"),
			);
			const { session, faux } = await setupFauxSession({ cwd, agentDir });

			faux.setResponses([
				fauxAssistantMessage([fauxToolCall("subagent", { agent: "readonly-worker", prompt: "look around" })]),
				fauxAssistantMessage("Looked around, found nothing to edit."),
				fauxAssistantMessage("Worker reported nothing to edit."),
			]);

			await session.prompt("spawn the readonly worker");

			const resultText = getToolResultText(session, "subagent");
			expect(resultText).toContain("Looked around, found nothing to edit.");
			expect(resultText).toMatch(/agent=readonly-worker/);
		});

		it("runs a background child and later notifies the parent session on completion", async () => {
			const { session, faux } = await setupFauxSession({ cwd, agentDir });

			// The background child spawns its own AgentSession concurrently with the parent's own
			// continuation turn, both drawing from the same faux response queue (they share the
			// parent's model by default) - queue two interchangeable responses so neither call races
			// the other into "no more faux responses queued".
			faux.setResponses([
				fauxAssistantMessage([fauxToolCall("subagent", { prompt: "do a slow thing", run_in_background: true })]),
				fauxAssistantMessage("turn text A"),
				fauxAssistantMessage("turn text B"),
			]);

			await session.prompt("spawn a background subagent");

			// Foreground turn returns immediately without waiting for the child.
			const kickoffText = getToolResultText(session, "subagent");
			expect(kickoffText).toContain("Started background subagent run");
			expect(session.getLastAssistantText()).toBeTruthy();

			// The notification-triggered turn is strictly sequential (fires only after the
			// background child has fully finished), so this is the only consumer left.
			faux.appendResponses([fauxAssistantMessage("Acknowledged: child done.")]);

			await vi.waitFor(
				() => {
					const hasNotification = session.state.messages.some(
						(m) =>
							m.role === "user" &&
							Array.isArray(m.content) &&
							m.content.some((c) => c.type === "text" && c.text.includes("[subagent background run complete]")),
					);
					expect(hasNotification).toBe(true);
				},
				{ timeout: 2000, interval: 20 },
			);

			expect(session.getLastAssistantText()).toBe("Acknowledged: child done.");
		});
	});

	describe("external harness (mocked)", () => {
		function withMockHarness(harness: Harness) {
			const manager = new HarnessRunManager(join(agentDir, "harness-sessions"));
			manager.registerHarness(harness);
			return manager;
		}

		it("runs an external-harness agent in the foreground and returns the harness result", async () => {
			const harness = new ImmediateMockHarness();
			writeAgentFile(
				join(cwd, ".void", "agents"),
				"mock-worker.md",
				[
					"---",
					"name: mock-worker",
					"description: Uses the mock harness.",
					"harness: mock",
					"---",
					"Mock body.",
				].join("\n"),
			);
			const { session, faux } = await setupFauxSession({
				cwd,
				agentDir,
				harnessRunManager: withMockHarness(harness),
			});

			faux.setResponses([
				fauxAssistantMessage([fauxToolCall("subagent", { agent: "mock-worker", prompt: "do the task" })]),
				fauxAssistantMessage("Mock worker finished."),
			]);

			await session.prompt("spawn the mock worker");

			const resultText = getToolResultText(session, "subagent");
			expect(resultText).toContain("mock result for: Mock body.\n\ndo the task");
		});

		it("runs a background external-harness agent and notifies the parent, and subagent_output reports it", async () => {
			const harness = new GatedMockHarness();
			writeAgentFile(
				join(cwd, ".void", "agents"),
				"mock-worker.md",
				[
					"---",
					"name: mock-worker",
					"description: Uses the mock harness.",
					"harness: mock",
					"---",
					"Mock body.",
				].join("\n"),
			);
			const { session, faux } = await setupFauxSession({
				cwd,
				agentDir,
				harnessRunManager: withMockHarness(harness),
			});

			faux.setResponses([
				fauxAssistantMessage([
					fauxToolCall("subagent", { agent: "mock-worker", prompt: "slow task", run_in_background: true }),
				]),
				fauxAssistantMessage("Kicked off the mock worker in the background."),
			]);

			await session.prompt("spawn the mock worker in the background");

			const kickoffText = getToolResultText(session, "subagent");
			expect(kickoffText).toContain("Started background subagent run");
			const runId = /run "([^"]+)"/.exec(kickoffText)?.[1];
			expect(runId).toBeTruthy();

			// subagent_output should report "running" while the harness is gated.
			faux.appendResponses([
				fauxAssistantMessage([fauxToolCall("subagent_output", { id: runId })]),
				fauxAssistantMessage("Still running."),
			]);
			await session.prompt(`check on run ${runId}`);
			const pollText = getToolResultText(session, "subagent_output");
			expect(pollText).toContain("state: running");

			// Release the harness and expect the completion notification plus its triggered turn.
			faux.appendResponses([fauxAssistantMessage("Acknowledged: mock worker done.")]);
			harness.releaseNow();

			await vi.waitFor(
				() => {
					const hasNotification = session.state.messages.some(
						(m) =>
							m.role === "user" &&
							Array.isArray(m.content) &&
							m.content.some(
								(c) =>
									c.type === "text" &&
									c.text.includes("[subagent background run complete]") &&
									c.text.includes("state: done"),
							),
					);
					expect(hasNotification).toBe(true);
				},
				{ timeout: 2000, interval: 20 },
			);
			expect(session.getLastAssistantText()).toBe("Acknowledged: mock worker done.");
		});
	});
});
