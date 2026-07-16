import { appendFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { HarnessSessionStore } from "../src/core/harness/runs.js";
import type { HarnessEvent } from "../src/core/harness/types.js";

describe("HarnessSessionStore", () => {
	let dir: string;

	beforeEach(() => {
		dir = join(tmpdir(), `void-test-harness-store-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	});

	afterEach(() => {
		if (existsSync(dir)) rmSync(dir, { recursive: true });
	});

	test("writes meta, prompt, and events, and reloads them", () => {
		const store = new HarnessSessionStore(dir);
		const event: HarnessEvent = { kind: "text", timestamp: "t1", text: "hello" };

		store.appendMeta({ sessionId: "sess-1", harnessId: "claude", createdAt: "2026-01-01T00:00:00.000Z" });
		store.appendPrompt("sess-1", "run-1", "do the thing");
		store.appendEvent("sess-1", "run-1", event);

		const loaded = store.load("sess-1");
		expect(loaded).toBeDefined();
		expect(loaded?.meta).toMatchObject({ sessionId: "sess-1", harnessId: "claude" });
		expect(loaded?.prompts.get("run-1")).toBe("do the thing");
		expect(loaded?.events).toEqual([{ runId: "run-1", event }]);
	});

	test("last meta line wins", () => {
		const store = new HarnessSessionStore(dir);
		store.appendMeta({ sessionId: "sess-1", harnessId: "claude", createdAt: "2026-01-01T00:00:00.000Z" });
		store.appendMeta({
			sessionId: "sess-1",
			harnessId: "claude",
			createdAt: "2026-01-01T00:00:00.000Z",
			providerSessionId: "psid-2",
			name: "renamed",
		});

		const loaded = store.load("sess-1");
		expect(loaded?.meta.providerSessionId).toBe("psid-2");
		expect(loaded?.meta.name).toBe("renamed");
	});

	test("tolerates a corrupt trailing line", () => {
		const store = new HarnessSessionStore(dir);
		store.appendMeta({ sessionId: "sess-1", harnessId: "claude", createdAt: "2026-01-01T00:00:00.000Z" });
		store.appendPrompt("sess-1", "run-1", "prompt text");
		// Simulate a crash mid-write: an incomplete trailing JSON line.
		appendFileSync(join(dir, "sess-1.jsonl"), '{"type":"event","runId":"run-1","event":{"kind":"text","tim');

		const loaded = store.load("sess-1");
		expect(loaded).toBeDefined();
		expect(loaded?.prompts.get("run-1")).toBe("prompt text");
		expect(loaded?.events).toEqual([]);
	});

	test("list returns every persisted session id", () => {
		const store = new HarnessSessionStore(dir);
		store.appendMeta({ sessionId: "sess-a", harnessId: "claude", createdAt: "t" });
		store.appendMeta({ sessionId: "sess-b", harnessId: "codex", createdAt: "t" });

		expect(store.list().sort()).toEqual(["sess-a", "sess-b"]);
	});

	test("delete is idempotent and removes the file", () => {
		const store = new HarnessSessionStore(dir);
		store.appendMeta({ sessionId: "sess-1", harnessId: "claude", createdAt: "t" });
		expect(existsSync(join(dir, "sess-1.jsonl"))).toBe(true);

		store.delete("sess-1");
		expect(existsSync(join(dir, "sess-1.jsonl"))).toBe(false);
		expect(() => store.delete("sess-1")).not.toThrow();
	});

	test("load returns undefined for a session with no meta record", () => {
		mkdirSync(dir, { recursive: true });
		const store = new HarnessSessionStore(dir);
		expect(store.load("does-not-exist")).toBeUndefined();
	});
});
