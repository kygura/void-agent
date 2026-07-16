import { failedRun, runProcessAdapter } from "../adapter.js";
import type { ProcessSpec } from "../process.js";
import { environmentFromEntries, isRecord, numberValue, stringValue } from "../provider-utils.js";
import type { Adapter, Event, Provider, RunConfig, Usage } from "../types.js";

export interface ClaudeProviderOptions {
	readonly command?: string;
}

export class ClaudeAdapter implements Adapter {
	public parseLine(line: string): readonly Event[] {
		return parseClaudeLine(line);
	}

	public finish(_exitCode: number): readonly Event[] {
		return [];
	}
}

export class ClaudeProvider implements Provider {
	public readonly name = "claude";
	public readonly type = "claude" as const;
	public readonly resumable = true;
	private readonly command: string;

	public constructor(options: ClaudeProviderOptions = {}) {
		this.command = options.command ?? "claude";
	}

	public start(config: RunConfig, signal?: AbortSignal): AsyncIterable<Event> {
		return this.startRun(config, signal);
	}

	private async *startRun(config: RunConfig, signal?: AbortSignal): AsyncIterable<Event> {
		try {
			yield* runProcessAdapter(
				{
					spec: buildClaudeProcessSpec(config, this.command),
					adapter: new ClaudeAdapter(),
				},
				signal,
			);
		} catch (error) {
			yield* failedRun(error instanceof Error ? error.message : String(error));
		}
	}
}

export function createClaudeProvider(options: ClaudeProviderOptions = {}): ClaudeProvider {
	return new ClaudeProvider(options);
}

export function buildClaudeArgv(config: RunConfig, command = "claude"): readonly string[] {
	const argv = [
		command,
		"-p",
		config.prompt,
		"--output-format",
		"stream-json",
		"--verbose",
		"--include-partial-messages",
	];
	if (config.model !== undefined && config.model !== "") argv.push("--model", config.model);
	if (config.effort !== undefined && config.effort !== "") argv.push("--effort", config.effort);
	if (config.providerSessionId !== undefined && config.providerSessionId !== "") {
		argv.push("--resume", config.providerSessionId);
	}
	if (config.extraArgs !== undefined) argv.push(...config.extraArgs);
	return argv;
}

export function buildClaudeProcessSpec(config: RunConfig, command = "claude"): ProcessSpec {
	return {
		argv: buildClaudeArgv(config, command),
		cwd: config.workdir,
		env: environmentFromEntries(config.env, process.env, config.envDenyList),
	};
}

export function parseClaudeLine(line: string): readonly Event[] {
	if (line === "") return [];
	let value: unknown;
	try {
		value = JSON.parse(line) as unknown;
	} catch {
		return [{ kind: "text", text: `${line}\n` }];
	}
	if (!isRecord(value)) return [];
	const type = stringValue(value, "type");
	switch (type) {
		case "system":
			return stringValue(value, "subtype") === "init"
				? [{ kind: "started", providerSessionId: stringValue(value, "session_id") ?? "" }]
				: [];
		case "stream_event":
			return parseStreamEvent(value.event);
		case "assistant":
			return parseAssistantMessage(value.message);
		case "result":
			return [parseResult(value)];
		default:
			return [];
	}
}

function parseStreamEvent(value: unknown): readonly Event[] {
	if (!isRecord(value) || stringValue(value, "type") !== "content_block_delta" || !isRecord(value.delta)) return [];
	const delta = value.delta;
	switch (stringValue(delta, "type")) {
		case "text_delta":
			return [{ kind: "text", text: stringValue(delta, "text") ?? "" }];
		case "thinking_delta":
			return [{ kind: "thinking", text: stringValue(delta, "thinking") ?? "" }];
		default:
			return [];
	}
}

function parseAssistantMessage(value: unknown): readonly Event[] {
	if (!isRecord(value) || !Array.isArray(value.content)) return [];
	const events: Event[] = [];
	for (const block of value.content) {
		if (!isRecord(block) || stringValue(block, "type") !== "tool_use") continue;
		events.push({
			kind: "tool",
			tool: stringValue(block, "name") ?? "",
			detail: JSON.stringify(block.input ?? null),
		});
	}
	return events;
}

function parseResult(value: Record<string, unknown>): Event {
	const rawUsage = isRecord(value.usage) ? value.usage : {};
	const usage: Usage = {
		inputTokens: numberValue(rawUsage, "input_tokens") ?? 0,
		outputTokens: numberValue(rawUsage, "output_tokens") ?? 0,
		costUsd: numberValue(value, "total_cost_usd") ?? 0,
	};
	return {
		kind: "result",
		text: stringValue(value, "result") ?? "",
		isError: value.is_error === true,
		usage,
	};
}
