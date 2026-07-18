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
import { SettingsManager } from "../src/core/settings-manager.js";
import { createSubagentSendToolDefinition, SubagentRegistry } from "../src/core/tools/subagent.js";

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
	// Latest toolResult wins: subagent_send may be called more than once in a test.
	const results = session.state.messages.filter((m) => m.role === "toolResult" && m.toolName === toolName) as Array<{
		content: Array<{ type: string; text?: string }>;
	}>;
	const last = results.at(-1);
	if (!last) throw new Error(`no toolResult message for tool "${toolName}"`);
	return last.content
		.filter((c) => c.type === "text")
		.map((c) => c.text ?? "")
		.join("\n");
}

function countCompletionNotifications(session: Awaited<ReturnType<typeof setupFauxSession>>["session"]): number {
	return session.state.messages.filter(
		(m) =>
			m.role === "user" &&
			Array.isArray(m.content) &&
			m.content.some((c) => c.type === "text" && c.text.includes("[subagent background run complete]")),
	).length;
}

/**
 * A resumable external mock harness whose runs are individually gated. Records the config of every
 * call (including the providerSessionId a resume carries) so tests can assert conversation
 * continuity. Its providerSessionId is stable ("psid-mock") so a resume of the same session
 * threads the same id back in.
 */
class SendableMockHarness implements Harness {
	readonly id = "mock";
	readonly resumable = true;
	readonly calls: HarnessRunConfig[] = [];
	private readonly released: boolean[] = [];
	private readonly releasers: Array<() => void> = [];

	releaseCall(index: number): void {
		this.released[index] = true;
		this.releasers[index]?.();
	}

	async *start(cfg: HarnessRunConfig, _signal: AbortSignal): AsyncGenerator<HarnessEvent> {
		const index = this.calls.length;
		this.calls.push(cfg);
		yield { kind: "started", timestamp: nowIso(), providerSessionId: cfg.providerSessionId ?? "psid-mock" };
		await new Promise<void>((resolve) => {
			if (this.released[index]) {
				resolve();
				return;
			}
			this.releasers[index] = resolve;
		});
		yield { kind: "result", timestamp: nowIso(), text: `mock result ${index}: ${cfg.prompt}` };
		yield { kind: "exit", timestamp: nowIso(), exitCode: 0 };
	}
}

/** A non-resumable external mock (mirrors a generic provider). Completes immediately. */
class NonResumableMockHarness implements Harness {
	readonly id = "mock";
	readonly resumable = false;

	async *start(cfg: HarnessRunConfig, _signal: AbortSignal): AsyncGenerator<HarnessEvent> {
		yield { kind: "started", timestamp: nowIso(), providerSessionId: "mock-session" };
		yield { kind: "result", timestamp: nowIso(), text: `mock result: ${cfg.prompt}` };
		yield { kind: "exit", timestamp: nowIso(), exitCode: 0 };
	}
}

const MOCK_AGENT = [
	"---",
	"name: mock-worker",
	"description: Uses the mock harness.",
	"harness: mock",
	"---",
	"Mock body.",
].join("\n");

describe("subagent_send tool", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `void-subagent-send-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function withMockHarness(harness: Harness): HarnessRunManager {
		const manager = new HarnessRunManager(join(agentDir, "harness-sessions"));
		manager.registerHarness(harness);
		return manager;
	}

	function extractRunId(kickoffText: string): string {
		const runId = /run "([^"]+)"/.exec(kickoffText)?.[1];
		if (!runId) throw new Error(`could not extract run id from: ${kickoffText}`);
		return runId;
	}

	it("queues a follow-up while the child is still running, then delivers it on the same conversation", async () => {
		const harness = new SendableMockHarness();
		writeAgentFile(join(cwd, ".void", "agents"), "mock-worker.md", MOCK_AGENT);
		const { session, faux } = await setupFauxSession({ cwd, agentDir, harnessRunManager: withMockHarness(harness) });

		faux.setResponses([
			fauxAssistantMessage([
				fauxToolCall("subagent", { agent: "mock-worker", prompt: "task1", run_in_background: true }),
			]),
			fauxAssistantMessage("kicked off"),
		]);
		await session.prompt("spawn bg");
		const runId = extractRunId(getToolResultText(session, "subagent"));

		// Child run1 is live (gated). A follow-up must queue, not start a second concurrent run.
		faux.appendResponses([
			fauxAssistantMessage([fauxToolCall("subagent_send", { id: runId, message: "second turn" })]),
			fauxAssistantMessage("sent"),
		]);
		await session.prompt("send follow up");

		expect(getToolResultText(session, "subagent_send")).toContain("Queued follow-up");
		expect(harness.calls).toHaveLength(1); // still only run1

		// Release run1; the queued follow-up auto-launches as run2, resuming the same conversation.
		faux.appendResponses([fauxAssistantMessage("ack turn1"), fauxAssistantMessage("ack turn2")]);
		harness.releaseCall(0);
		await vi.waitFor(() => expect(harness.calls).toHaveLength(2), { timeout: 2000, interval: 10 });
		expect(harness.calls[1]?.prompt).toBe("second turn"); // raw follow-up, no system-prompt re-prepend
		expect(harness.calls[1]?.providerSessionId).toBe("psid-mock"); // continued, not a fresh blank session
		harness.releaseCall(1);
	});

	it("resumes an idle child and continues its own conversation", async () => {
		const harness = new SendableMockHarness();
		writeAgentFile(join(cwd, ".void", "agents"), "mock-worker.md", MOCK_AGENT);
		const { session, faux } = await setupFauxSession({ cwd, agentDir, harnessRunManager: withMockHarness(harness) });

		faux.setResponses([
			fauxAssistantMessage([
				fauxToolCall("subagent", { agent: "mock-worker", prompt: "task1", run_in_background: true }),
			]),
			fauxAssistantMessage("kicked off"),
		]);
		await session.prompt("spawn bg");
		const runId = extractRunId(getToolResultText(session, "subagent"));

		// Let run1 finish so the child is idle before the follow-up.
		faux.appendResponses([fauxAssistantMessage("ack turn1")]);
		harness.releaseCall(0);
		await vi.waitFor(() => expect(countCompletionNotifications(session)).toBe(1), { timeout: 2000, interval: 10 });

		faux.appendResponses([
			fauxAssistantMessage([fauxToolCall("subagent_send", { id: runId, message: "second turn" })]),
			fauxAssistantMessage("sent"),
			fauxAssistantMessage("ack turn2"),
		]);
		await session.prompt("send follow up");

		expect(getToolResultText(session, "subagent_send")).toContain("Resumed");
		await vi.waitFor(() => expect(harness.calls).toHaveLength(2), { timeout: 2000, interval: 10 });
		expect(harness.calls[1]?.prompt).toBe("second turn");
		expect(harness.calls[1]?.providerSessionId).toBe("psid-mock"); // same conversation continued
		harness.releaseCall(1);
	});

	it("rejects a follow-up to a non-resumable (generic) harness as a tool error", async () => {
		const harness = new NonResumableMockHarness();
		writeAgentFile(join(cwd, ".void", "agents"), "mock-worker.md", MOCK_AGENT);
		const { session, faux } = await setupFauxSession({ cwd, agentDir, harnessRunManager: withMockHarness(harness) });

		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("subagent", { agent: "mock-worker", prompt: "task1" })]),
			fauxAssistantMessage("done"),
		]);
		await session.prompt("spawn fg");
		// Foreground result carries the run id in its stats line: [subagent <id> | ...].
		const runId = /\[subagent (\S+) \|/.exec(getToolResultText(session, "subagent"))?.[1];
		expect(runId).toBeTruthy();

		faux.appendResponses([
			fauxAssistantMessage([fauxToolCall("subagent_send", { id: runId, message: "second turn" })]),
			fauxAssistantMessage("noted the rejection"),
		]);
		await session.prompt("send follow up");

		// The error is returned to the model as a tool result, not thrown out of the turn.
		expect(getToolResultText(session, "subagent_send")).toContain("not resumable");
		expect(harness).toBeInstanceOf(NonResumableMockHarness);
	});

	it("notifies the parent exactly once per completed turn across a queued follow-up (no dup, no drop)", async () => {
		const harness = new SendableMockHarness();
		writeAgentFile(join(cwd, ".void", "agents"), "mock-worker.md", MOCK_AGENT);
		const { session, faux } = await setupFauxSession({ cwd, agentDir, harnessRunManager: withMockHarness(harness) });

		faux.setResponses([
			fauxAssistantMessage([
				fauxToolCall("subagent", { agent: "mock-worker", prompt: "task1", run_in_background: true }),
			]),
			fauxAssistantMessage("kicked off"),
		]);
		await session.prompt("spawn bg");
		const runId = extractRunId(getToolResultText(session, "subagent"));

		faux.appendResponses([
			fauxAssistantMessage([fauxToolCall("subagent_send", { id: runId, message: "second turn" })]),
			fauxAssistantMessage("sent"),
		]);
		await session.prompt("send follow up");

		// Plenty of headroom for the two completion-triggered parent turns.
		faux.appendResponses([
			fauxAssistantMessage("ack a"),
			fauxAssistantMessage("ack b"),
			fauxAssistantMessage("ack c"),
			fauxAssistantMessage("ack d"),
		]);

		// Complete run1, then the auto-dequeued run2.
		harness.releaseCall(0);
		await vi.waitFor(() => expect(harness.calls).toHaveLength(2), { timeout: 2000, interval: 10 });
		harness.releaseCall(1);

		// Exactly two completion notifications: one for run1, one for the follow-up run2. Not one
		// per queued message (which would fire at send time), not zero for the auto-dequeued run.
		await vi.waitFor(() => expect(countCompletionNotifications(session)).toBe(2), { timeout: 2000, interval: 10 });
		// Settle window: assert it does not climb past 2 (no duplicate for either run).
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(countCompletionNotifications(session)).toBe(2);
	});

	describe("guard (unit)", () => {
		it("rejects an unknown run id", async () => {
			const registry = new SubagentRegistry();
			const tool = createSubagentSendToolDefinition({
				cwd,
				agentDir,
				harnessRunManager: withMockHarness(new SendableMockHarness()),
				registry,
				parentSessionRef: {},
				settingsManager: SettingsManager.inMemory(),
			});
			await expect(
				tool.execute("call-1", { id: "nope", message: "hi" }, undefined, undefined, {} as never),
			).rejects.toThrow(/unknown run/);
		});

		it("rejects a run that has no session id", async () => {
			const registry = new SubagentRegistry();
			// A record without a sessionId (the sessionless/fire-and-forget shape) cannot be followed up.
			registry.start({ id: "run-x", agent: "general", harness: "mock", background: true, harnessRunId: "hr-1" });
			const tool = createSubagentSendToolDefinition({
				cwd,
				agentDir,
				harnessRunManager: withMockHarness(new SendableMockHarness()),
				registry,
				parentSessionRef: {},
				settingsManager: SettingsManager.inMemory(),
			});
			await expect(
				tool.execute("call-1", { id: "run-x", message: "hi" }, undefined, undefined, {} as never),
			).rejects.toThrow(/cannot receive follow-up messages/);
		});
	});
});
