import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { HarnessRunManager } from "../src/core/harness/runs.js";
import type { Harness, HarnessEvent, HarnessRunConfig } from "../src/core/harness/types.js";

/**
 * An in-process mock harness: no child process. Each call to start() waits
 * on an externally-releasable gate (or the abort signal) before finishing,
 * so tests can control exactly when a run completes.
 */
class ControllableHarness implements Harness {
	readonly id: string;
	readonly resumable: boolean;
	readonly calls: HarnessRunConfig[] = [];
	// Persistent per-index flags, set by releaseCall(). A release can arrive
	// before the generator reaches its gate (start() suspends on its first
	// yield before the gate is even set up), so the flag must survive until
	// the generator checks it — mirroring how AbortSignal.aborted persists
	// regardless of when abort() was called relative to listener registration.
	private readonly released: boolean[] = [];
	private readonly releasers: Array<() => void> = [];

	constructor(id = "mock", resumable = true) {
		this.id = id;
		this.resumable = resumable;
	}

	/** Lets the call at `index` proceed past its gate to result+exit. */
	releaseCall(index: number): void {
		this.released[index] = true;
		this.releasers[index]?.();
	}

	async *start(cfg: HarnessRunConfig, signal: AbortSignal): AsyncGenerator<HarnessEvent> {
		const index = this.calls.length;
		this.calls.push(cfg);
		const providerSessionId = cfg.providerSessionId ?? `psid-${index}`;
		yield { kind: "started", timestamp: "t", providerSessionId };

		let aborted = false;
		await new Promise<void>((resolve) => {
			if (this.released[index]) {
				resolve();
				return;
			}
			const onAbort = () => {
				aborted = true;
				resolve();
			};
			if (signal.aborted) {
				onAbort();
				return;
			}
			signal.addEventListener("abort", onAbort, { once: true });
			this.releasers[index] = () => {
				signal.removeEventListener("abort", onAbort);
				resolve();
			};
		});

		if (aborted) {
			yield { kind: "exit", timestamp: "t", exitCode: -1 };
			return;
		}
		yield { kind: "result", timestamp: "t", text: `result-${index}` };
		yield { kind: "exit", timestamp: "t", exitCode: 0 };
	}
}

class ThrowingHarness implements Harness {
	readonly id = "throwing";
	readonly resumable = false;

	start(_cfg: HarnessRunConfig, _signal: AbortSignal): AsyncIterable<HarnessEvent> {
		return {
			[Symbol.asyncIterator]: () => ({
				next: () => Promise.reject(new Error("provider exploded")),
			}),
		};
	}
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

describe("HarnessRunManager", () => {
	let dir: string;

	beforeEach(() => {
		dir = join(tmpdir(), `void-test-harness-runs-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	});

	afterEach(() => {
		if (existsSync(dir)) rmSync(dir, { recursive: true });
	});

	test("session resume carries providerSessionId learned from the first run", async () => {
		const harness = new ControllableHarness();
		const manager = new HarnessRunManager(dir);
		manager.registerHarness(harness);
		const sessionId = manager.newSession(harness.id);

		const first = manager.submitPrompt(sessionId, "first");
		expect(first.queued).toBe(false);
		expect(first.runId).toBeDefined();
		harness.releaseCall(0);
		await waitFor(() => manager.run(first.runId!)?.state === "done");

		expect(manager.session(sessionId)?.providerSessionId).toBe("psid-0");

		const second = manager.submitPrompt(sessionId, "second");
		expect(second.queued).toBe(false);
		await waitFor(() => harness.calls.length === 2);
		expect(harness.calls[1]?.providerSessionId).toBe("psid-0");

		harness.releaseCall(1);
		await waitFor(() => manager.run(second.runId!)?.state === "done");
	});

	test("a prompt submitted while a run is live is queued, then auto-launched when it finishes", async () => {
		const harness = new ControllableHarness();
		const manager = new HarnessRunManager(dir);
		manager.registerHarness(harness);
		const sessionId = manager.newSession(harness.id);

		const first = manager.submitPrompt(sessionId, "first");
		await waitFor(() => manager.run(first.runId!)?.state === "running");

		const second = manager.submitPrompt(sessionId, "second");
		expect(second.queued).toBe(true);
		expect(second.runId).toBeUndefined();
		expect(manager.session(sessionId)?.queued).toEqual(["second"]);

		harness.releaseCall(0);
		await waitFor(() => manager.run(first.runId!)?.state === "done");

		// Auto-dequeue: the queued prompt launches on its own, no explicit submitPrompt call.
		await waitFor(() => manager.session(sessionId)?.queued.length === 0);
		await waitFor(() => manager.runs().length === 2);

		const secondRun = manager.runs().find((r) => r.prompt === "second");
		expect(secondRun).toBeDefined();
		harness.releaseCall(1);
		await waitFor(() => manager.run(secondRun!.id)?.state === "done");
	});

	test("cancel marks a live run cancelled", async () => {
		const harness = new ControllableHarness();
		const manager = new HarnessRunManager(dir);
		manager.registerHarness(harness);

		const runId = manager.startRun(harness.id, { prompt: "hang around" });
		await waitFor(() => manager.run(runId)?.state === "running");

		manager.cancel(runId);
		await waitFor(() => manager.run(runId)?.state === "cancelled");

		expect(manager.run(runId)?.state).toBe("cancelled");
	});

	test("cancelling an already-terminal run is a no-op", async () => {
		const harness = new ControllableHarness();
		const manager = new HarnessRunManager(dir);
		manager.registerHarness(harness);

		const runId = manager.startRun(harness.id, { prompt: "quick" });
		harness.releaseCall(0);
		await waitFor(() => manager.run(runId)?.state === "done");

		expect(() => manager.cancel(runId)).not.toThrow();
		expect(manager.run(runId)?.state).toBe("done");
	});

	test("subscribe fans in every event across every run", async () => {
		const harness = new ControllableHarness();
		const manager = new HarnessRunManager(dir);
		manager.registerHarness(harness);

		const received: string[] = [];
		const unsubscribe = manager.subscribe((e) => received.push(e.event.kind));

		const runId = manager.startRun(harness.id, { prompt: "hi" });
		harness.releaseCall(0);
		await waitFor(() => manager.run(runId)?.state === "done");
		unsubscribe();

		expect(received).toEqual(["started", "result", "exit"]);
	});

	test("normalizes a harness failure into terminal events and a failed run", async () => {
		const manager = new HarnessRunManager(dir);
		manager.registerHarness(new ThrowingHarness());

		const runId = manager.startRun("throwing", { prompt: "fail safely" });
		await waitFor(() => manager.run(runId)?.state === "failed");

		expect(manager.runEvents(runId)).toMatchObject([
			{ kind: "result", isError: true, text: "provider exploded" },
			{ kind: "exit", exitCode: 1 },
		]);
	});
});
