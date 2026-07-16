import type { Event, Provider, RunConfig } from "../types.js";

export interface MockScript {
	events?: readonly Event[];
	delayMs?: number;
	delay?: number;
	startError?: Error | string;
	canResume?: boolean;
	resumable?: boolean;
}

/** A deterministic Provider for tests and credential-free demonstrations. */
export class MockProvider implements Provider {
	readonly name = "mock";
	readonly type = "mock" as const;
	readonly resumable: boolean;
	private readonly script: Required<Pick<MockScript, "events">> & MockScript;
	private readonly startedConfigs: RunConfig[] = [];

	constructor(script: MockScript = {}) {
		this.script = { ...script, events: [...(script.events ?? [])] };
		this.resumable = script.resumable ?? script.canResume ?? false;
	}

	getCalls(): readonly RunConfig[] {
		return this.startedConfigs.map((config) => ({
			...config,
			extraArgs: config.extraArgs === undefined ? undefined : [...config.extraArgs],
			env: config.env === undefined ? undefined : [...config.env],
			envDenyList: config.envDenyList === undefined ? undefined : [...config.envDenyList],
		}));
	}

	calls(): readonly RunConfig[] {
		return this.getCalls();
	}

	start(config: RunConfig, signal?: AbortSignal): AsyncIterable<Event> {
		if (this.script.startError !== undefined) {
			throw this.script.startError instanceof Error ? this.script.startError : new Error(this.script.startError);
		}
		this.startedConfigs.push({
			...config,
			extraArgs: config.extraArgs === undefined ? undefined : [...config.extraArgs],
			env: config.env === undefined ? undefined : [...config.env],
			envDenyList: config.envDenyList === undefined ? undefined : [...config.envDenyList],
		});
		return this.events(signal);
	}

	private async *events(signal?: AbortSignal): AsyncIterable<Event> {
		const delayMs = this.script.delayMs ?? this.script.delay ?? 0;
		for (const event of this.script.events) {
			if (signal?.aborted) return;
			if (delayMs > 0) {
				await wait(delayMs, signal);
				if (signal?.aborted) return;
			}
			const replayedEvent: Event = { ...event };
			if (event.usage !== undefined) {
				replayedEvent.usage = { ...event.usage };
			}
			yield replayedEvent;
		}
	}
}

export function createMockProvider(script: MockScript = {}): MockProvider {
	return new MockProvider(script);
}

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, milliseconds);
		if (signal === undefined) return;
		const abort = (): void => {
			clearTimeout(timer);
			resolve();
		};
		if (signal.aborted) abort();
		else signal.addEventListener("abort", abort, { once: true });
	});
}
