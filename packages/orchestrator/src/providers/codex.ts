import { failedRun, runProcessAdapter } from "../adapter.js";
import type { ProcessSpec } from "../process.js";
import { environmentFromEntries, isRecord, numberValue, stringValue } from "../provider-utils.js";
import type { Adapter, Event, Provider, RunConfig } from "../types.js";

export interface CodexProviderOptions {
	readonly command?: string;
}

export class CodexAdapter implements Adapter {
	public parseLine(line: string): readonly Event[] {
		return parseCodexLine(line);
	}

	public finish(_exitCode: number): readonly Event[] {
		return [];
	}
}

export class CodexProvider implements Provider {
	public readonly name = "codex";
	public readonly type = "codex" as const;
	public readonly resumable = true;
	private readonly command: string;

	public constructor(options: CodexProviderOptions = {}) {
		this.command = options.command ?? "codex";
	}

	public start(config: RunConfig, signal?: AbortSignal): AsyncIterable<Event> {
		return this.startRun(config, signal);
	}

	private async *startRun(config: RunConfig, signal?: AbortSignal): AsyncIterable<Event> {
		try {
			yield* runProcessAdapter(
				{
					spec: buildCodexProcessSpec(config, this.command),
					adapter: new CodexAdapter(),
				},
				signal,
			);
		} catch (error) {
			yield* failedRun(error instanceof Error ? error.message : String(error));
		}
	}
}

export function createCodexProvider(options: CodexProviderOptions = {}): CodexProvider {
	return new CodexProvider(options);
}

export function buildCodexArgv(config: RunConfig, command = "codex"): readonly string[] {
	const argv = [command, "exec"];
	if (config.providerSessionId !== undefined && config.providerSessionId !== "") {
		argv.push("resume", config.providerSessionId, config.prompt);
	} else {
		argv.push(config.prompt);
	}
	argv.push("--json");
	if (config.model !== undefined && config.model !== "") argv.push("-m", config.model);
	if (config.effort !== undefined && config.effort !== "") {
		argv.push("-c", `model_reasoning_effort=${JSON.stringify(config.effort)}`);
	}
	if (config.workdir !== undefined && config.workdir !== "") argv.push("-C", config.workdir);
	if (config.extraArgs !== undefined) argv.push(...config.extraArgs);
	return argv;
}

export function buildCodexProcessSpec(config: RunConfig, command = "codex"): ProcessSpec {
	return {
		argv: buildCodexArgv(config, command),
		env: environmentFromEntries(config.env, process.env, config.envDenyList),
	};
}

export function parseCodexLine(line: string): readonly Event[] {
	if (line === "") return [];
	let value: unknown;
	try {
		value = JSON.parse(line) as unknown;
	} catch {
		return [{ kind: "text", text: `${line}\n` }];
	}
	if (!isRecord(value)) return [];
	switch (stringValue(value, "type")) {
		case "SessionConfigured":
			return [{ kind: "started", providerSessionId: stringValue(value, "session_id") ?? "" }];
		case "AgentMessage":
			return [{ kind: "text", text: stringValue(value, "message") ?? "" }];
		case "AgentReasoning":
			return [{ kind: "thinking", text: stringValue(value, "text") ?? "" }];
		case "TaskComplete":
			return [{ kind: "result", text: stringValue(value, "last_agent_message") ?? "" }];
		case "ExecCommandBegin":
			return [{ kind: "tool", tool: "exec", detail: stringValue(value, "command") ?? "" }];
		case "ExecCommandEnd":
			return [{ kind: "tool", tool: "exec", detail: `exit ${numberValue(value, "exit_code") ?? 0}`, done: true }];
		case "Error":
			return [{ kind: "result", text: stringValue(value, "message") ?? "", isError: true }];
		default:
			return [];
	}
}
