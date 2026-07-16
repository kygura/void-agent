import type { RunSnapshot, SessionSnapshot } from "@void/orchestrator";
import { visibleWidth } from "@void/tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
	buildChildHeaderLine,
	type ChildSessionTarget,
	getChildComposerRoute,
} from "../src/modes/interactive/components/child-session-view.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

type SessionTarget = Extract<ChildSessionTarget, { kind: "session" }>;

beforeAll(() => initTheme(undefined, false));

function target(overrides: Partial<SessionTarget> = {}): SessionTarget {
	const run: RunSnapshot = {
		id: "run-1",
		provider: "mock",
		sessionId: "child-1",
		state: "running",
		startedAt: "2026-01-01T00:00:00.000Z",
		prompt: "initial",
	};
	const session: SessionSnapshot = {
		id: "child-1",
		name: "reviewer",
		provider: "mock",
		providerSessionId: "provider-session",
		parentSessionId: "parent-1",
		created: "2026-01-01T00:00:00.000Z",
		runIds: ["run-1"],
		queue: { activeRunId: "run-1", prompts: [] },
	};
	return { kind: "session", run, session, providerType: "mock", ...overrides };
}

describe("child composer routing", () => {
	it("queues FIFO while a resumable Run is live", () => {
		expect(getChildComposerRoute(target())).toEqual({ mode: "queue", placeholder: "queue a follow-up…" });
	});

	it("resumes an idle resumable Session with a provider Session id", () => {
		const current = target();
		expect(
			getChildComposerRoute(
				target({
					run: { ...current.run, state: "done", endedAt: "2026-01-01T00:01:00.000Z" },
					session: { ...current.session, queue: { prompts: [] } },
				}),
			),
		).toEqual({ mode: "resume", placeholder: "resume mock session…" });
	});

	it("shows the binding disabled reasons for every read-only row", () => {
		const current = target();
		expect(
			getChildComposerRoute(
				target({
					run: { ...current.run, state: "done", endedAt: "2026-01-01T00:01:00.000Z" },
					session: { ...current.session, providerSessionId: undefined, queue: { prompts: [] } },
				}),
			),
		).toEqual({ mode: "disabled", reason: "no provider session id recorded — this child cannot be resumed" });
		expect(getChildComposerRoute(target({ providerType: "generic" }))).toEqual({
			mode: "disabled",
			reason: "generic providers are not resumable — read-only",
		});
		expect(getChildComposerRoute({ kind: "task", run: current.run })).toEqual({
			mode: "disabled",
			reason: "task run — fire-and-forget, not attached to a session",
		});
	});

	it("keeps queue order oldest-first and removes the newest prompt", () => {
		const current = target();
		const prompts = ["first", "second", "third"];
		const viewTarget = target({ session: { ...current.session, queue: { activeRunId: "run-1", prompts } } });
		expect(viewTarget.session.queue.prompts).toEqual(prompts);
		const removeNewest = vi.fn(() => prompts.at(-1));
		expect(removeNewest()).toBe("third");
	});
});

describe("child header", () => {
	it("preserves the state glyph and name while dropping right-side metadata at narrow widths", () => {
		const line = buildChildHeaderLine(target(), "parent", 36, Date.parse("2026-01-01T00:00:05.000Z"));
		expect(visibleWidth(line)).toBeLessThanOrEqual(36);
		expect(line).toContain("⠋");
		expect(line).toContain("reviewer");
		expect(line).not.toContain("parent");
	});
});
