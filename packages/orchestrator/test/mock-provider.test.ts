import { describe, expect, test } from "bun:test";
import { MockProvider } from "../src/providers/mock.js";
import type { Event } from "../src/types.js";

describe("MockProvider", () => {
	test("replays events, records configs, and reports resume capability", async () => {
		const events: Event[] = [
			{ kind: "started", providerSessionId: "mock-session" },
			{ kind: "text", text: "hello" },
			{ kind: "result", text: "done" },
			{ kind: "exit", exitCode: 0 },
		];
		const provider = new MockProvider({ events, canResume: true });
		const config = { provider: "mock", prompt: "hello", providerSessionId: "old-session" };
		const received = [] as Event[];
		for await (const event of provider.start(config)) received.push(event);
		expect(received).toEqual(events);
		expect(provider.resumable).toBe(true);
		expect(provider.getCalls()).toEqual([config]);
	});

	test("stops promptly when cancelled during a delay", async () => {
		const controller = new AbortController();
		const provider = new MockProvider({ events: [{ kind: "text", text: "late" }], delayMs: 100 });
		const received: Event[] = [];
		const stream = provider.start({ provider: "mock", prompt: "hello" }, controller.signal);
		const pending = (async (): Promise<void> => {
			for await (const event of stream) received.push(event);
		})();
		controller.abort();
		await pending;
		expect(received).toEqual([]);
	});
});
