import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@void/ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HarnessEvent } from "../src/core/harness/types.js";
import { createAgentSession } from "../src/core/sdk.js";
import { getDefaultSessionDir, SessionManager } from "../src/core/session-manager.js";

/**
 * Integration coverage for Part 3 (SPEC-void-orchestration-gaps.md): a void child whose
 * providerSessionId is missing from VoidHarness's in-memory `children` Map (evicted, or this
 * process restarted since it spawned) must respawn from its persisted session file instead of
 * failing immediately - and the respawned session must carry the prior transcript, not start blank.
 *
 * This exercises the real sdk.ts `spawnVoidChild` (via createAgentSession's internally-registered
 * VoidHarness), not a fake - harness-void.test.ts covers VoidHarness's own orchestration logic with
 * fakes; this file proves the session-file path resolution and SessionManager.open() wiring actually
 * work end to end.
 */
describe("void child resume via session file", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;
	const model = getModel("anthropic", "claude-sonnet-4-5")!;

	beforeEach(() => {
		tempDir = join(tmpdir(), `void-resume-session-file-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	async function collect(iterable: AsyncIterable<HarnessEvent>): Promise<HarnessEvent[]> {
		const events: HarnessEvent[] = [];
		for await (const event of iterable) events.push(event);
		return events;
	}

	it("respawns an evicted/never-registered providerSessionId from its session file, preserving the prior transcript", async () => {
		// Seed a "prior" child session file directly, simulating a child that ran in an earlier
		// process (or was LRU-evicted from VoidHarness's this.children) - nothing in this test process
		// has this session registered anywhere yet.
		const sessionDir = getDefaultSessionDir(cwd, agentDir);
		const priorSession = SessionManager.create(cwd, sessionDir);
		priorSession.appendMessage({ role: "user", content: "hello from before", timestamp: 1 });
		priorSession.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "hi there" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		});
		const priorSessionId = priorSession.getSessionId();

		// A fresh top-level session, wired with a real VoidHarness (real spawnVoidChild) pointed at
		// the same cwd/agentDir - this is the "current process", which has never seen priorSessionId.
		const { harnessRunManager } = await createAgentSession({ cwd, agentDir, model });
		const voidHarness = harnessRunManager?.getHarness("void");
		expect(voidHarness).toBeDefined();

		// Abort synchronously right after start(): resolveSession (and thus the respawn + session-file
		// read) still runs to completion before the abort check, but session.prompt() - a real model
		// call - never fires. This is the same "abort during spawn" race harness-void.test.ts already
		// exercises with fakes, used here to keep this test hermetic (no network).
		const controller = new AbortController();
		const eventsPromise = collect(
			voidHarness!.start({ prompt: "resume please", providerSessionId: priorSessionId }, controller.signal),
		);
		controller.abort();
		const events = await eventsPromise;

		// The "started" event's providerSessionId must equal the requested id: proof SessionManager.open()
		// found and reopened the same session file rather than sdk.ts falling back to a fresh
		// SessionManager.create() (which would mint a different random id).
		expect(events[0]).toMatchObject({ kind: "started", providerSessionId: priorSessionId });
		expect(events[1]).toMatchObject({ kind: "result", isError: true, text: "Run cancelled" });
		expect(events[2]).toMatchObject({ kind: "exit", exitCode: 130 });

		// Re-open the same file directly and confirm the prior transcript is still there, untouched -
		// proof this was a genuine resume (SessionManager.open's happy path), not corrupt-file
		// tolerance quietly resetting it to a blank new session.
		const fileName = readdirSync(sessionDir).find((f) => f.endsWith(`_${priorSessionId}.jsonl`));
		expect(fileName).toBeDefined();
		const reopened = SessionManager.open(join(sessionDir, fileName!), sessionDir, cwd);
		expect(reopened.getSessionId()).toBe(priorSessionId);
		const context = reopened.buildSessionContext();
		expect(context.messages).toHaveLength(2);
	});

	it("fails as data (not a thrown exception) when resuming an id whose session file never existed", async () => {
		const { harnessRunManager } = await createAgentSession({ cwd, agentDir, model });
		const voidHarness = harnessRunManager?.getHarness("void");
		expect(voidHarness).toBeDefined();

		const events = await collect(
			voidHarness!.start(
				{ prompt: "resume please", providerSessionId: "never-existed" },
				new AbortController().signal,
			),
		);

		expect(events).toEqual([
			expect.objectContaining({
				kind: "result",
				isError: true,
				text: 'void: unknown or dead child session "never-existed"',
			}),
			expect.objectContaining({ kind: "exit", exitCode: 1 }),
		]);
	});
});
