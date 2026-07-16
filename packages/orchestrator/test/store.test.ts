import { describe, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionStore, type SessionStore } from "../src/store.js";

const CREATED = "2026-07-15T12:34:56.123456789Z";

async function withStore(run: (store: SessionStore, directory: string) => Promise<void>): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "void-orchestrator-store-"));
	const directory = join(root, "sessions");
	try {
		const store = await createSessionStore(directory);
		await run(store, directory);
	} finally {
		await rm(root, { force: true, recursive: true });
	}
}

function eventText(index: number): string {
	return `event-${index.toString().padStart(4, "0")}-payload-abcdefghijklmnopqrstuvwxyz`;
}

async function expectRejection(operation: Promise<unknown>, message?: string): Promise<void> {
	let rejection: unknown;
	try {
		await operation;
	} catch (error) {
		rejection = error;
	}
	assert(rejection instanceof Error);
	if (message !== undefined) assert(String(rejection).includes(message));
}

describe("session append store", () => {
	test("writes the recorded Go JSONL bytes despite the .json filename", async () => {
		await withStore(async (store, directory) => {
			await store.appendMeta({ id: "session-fixture", provider: "mock", created: CREATED });
			await store.appendPrompt("session-fixture", "run-1", "inspect the store");
			await store.appendEvent("session-fixture", "run-1", {
				kind: "tool",
				providerSessionId: "provider-42",
				text: "complete",
				tool: "read",
				detail: "store.ts",
				done: true,
				isError: true,
				usage: { inputTokens: 7, outputTokens: 11, costUsd: 0.125 },
				exitCode: 2,
				childSessionId: "child-1",
				childName: "worker",
				state: "done",
				elapsed: 1_500_000_001,
			});
			await store.appendEvent("session-fixture", "run-2", {
				kind: "exit",
				providerSessionId: "",
				text: "",
				tool: "",
				detail: "",
				done: false,
				isError: false,
				usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
				exitCode: 0,
				childSessionId: "",
				childName: "",
				elapsed: 0,
			});
			await store.appendMeta({
				id: "session-fixture",
				provider: "mock",
				providerSessionId: "provider-42",
				name: "fixture",
				parentSessionId: "parent-1",
				created: CREATED,
			});

			const actual = await readFile(join(directory, "session-fixture.json"));
			const expected = await readFile(new URL("./fixtures/store/go-wire.json", import.meta.url));
			expect(actual.equals(expected)).toBe(true);

			const loaded = await store.load("session-fixture");
			expect(loaded.warning).toBeUndefined();
			expect(loaded.meta.name).toBe("fixture");
			expect(loaded.meta.parentSessionId).toBe("parent-1");
			expect(loaded.prompts.get("run-1")).toBe("inspect the store");
			expect(loaded.records.length).toBe(2);
			expect(await store.list()).toEqual(["session-fixture"]);
		});
	});

	test("creates owner-only directories and files on POSIX", async () => {
		if (process.platform === "win32") return;
		await withStore(async (store, directory) => {
			await store.appendMeta({ id: "permissions", provider: "mock", created: CREATED });
			expect((await stat(directory)).mode & 0o777).toBe(0o700);
			expect((await stat(join(directory, "permissions.json"))).mode & 0o777).toBe(0o600);
		});
	});

	test("rejects session ids that escape the storage directory", async () => {
		await withStore(async (store, directory) => {
			await expectRejection(
				store.appendMeta({ id: "../outside", provider: "mock", created: CREATED }),
				"store: invalid session id",
			);
			await expectRejection(store.load("..\\outside"), "store: invalid session id");
			await expectRejection(readFile(join(directory, "..", "outside.json")));
		});
	});

	test("returns valid records and a warning for a truncated tail", async () => {
		await withStore(async (store, directory) => {
			await store.appendMeta({ id: "truncated", provider: "mock", created: CREATED });
			await store.appendPrompt("truncated", "run-1", "first prompt");
			await store.appendEvent("truncated", "run-1", { kind: "text", text: "survives" });
			await appendFile(join(directory, "truncated.json"), '{"runId":"run-2","event":{"kind":"text"', "utf8");

			const loaded = await store.load("truncated");
			expect(loaded.warning).toBe("store: session truncated: skipped 1 corrupt line(s)");
			expect(loaded.meta.id).toBe("truncated");
			expect(loaded.prompts.get("run-1")).toBe("first prompt");
			expect(loaded.records).toEqual([{ runId: "run-1", event: { kind: "text", text: "survives" } }]);
		});
	});

	test("preserves the next append after a torn tail without a newline", async () => {
		await withStore(async (store, directory) => {
			await store.appendMeta({ id: "torn-append", provider: "mock", created: CREATED });
			await appendFile(join(directory, "torn-append.json"), '{"runId":"torn","event":', "utf8");
			await store.appendEvent("torn-append", "run-good", { kind: "text", text: "survives" });

			const loaded = await store.load("torn-append");
			expect(loaded.warning).toBe("store: session torn-append: skipped 1 corrupt line(s)");
			expect(loaded.records).toEqual([{ runId: "run-good", event: { kind: "text", text: "survives" } }]);
		});
	});

	test("serializes 300 concurrent appends and loads per session", async () => {
		await withStore(async (store) => {
			await store.appendMeta({ id: "race", provider: "mock", created: CREATED });
			const iterations = 300;

			const append = async (): Promise<void> => {
				for (let index = 0; index < iterations; index++) {
					await store.appendEvent("race", "run-1", { kind: "text", text: eventText(index) });
				}
			};
			const load = async (): Promise<void> => {
				for (let iteration = 0; iteration < iterations; iteration++) {
					const loaded = await store.load("race");
					expect(loaded.warning).toBeUndefined();
					for (const [index, record] of loaded.records.entries()) {
						expect(record.runId).toBe("run-1");
						expect(record.event.text).toBe(eventText(index));
					}
				}
			};

			await Promise.all([append(), load()]);
			const loaded = await store.load("race");
			expect(loaded.warning).toBeUndefined();
			expect(loaded.records.length).toBe(iterations);
			expect(loaded.records.map(({ event }) => event.text)).toEqual(
				Array.from({ length: iterations }, (_, index) => eventText(index)),
			);
		});
	});
});
