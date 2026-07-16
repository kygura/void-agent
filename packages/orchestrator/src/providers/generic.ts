import { failedRun, runProcessAdapter } from "../adapter.js";
import type { ProcessSpec } from "../process.js";
import {
	environmentFromEntries,
	validateArgs,
	validateAuthMode,
	validateExecutable,
	validateFlag,
} from "../provider-utils.js";
import type { Adapter, AuthMode, Effort, Event, Provider, RunConfig } from "../types.js";

export interface GenericTemplate {
	readonly name: string;
	readonly command: string;
	readonly args: readonly string[];
	readonly model?: string;
	readonly modelFlag?: string;
	readonly effort?: Effort;
	readonly effortFlag?: string;
	readonly models?: readonly string[];
	readonly extraArgs?: readonly string[];
	readonly env?: readonly string[];
	readonly auth?: AuthMode;
	readonly workdir?: string;
}

export const PI_TEMPLATE: GenericTemplate = {
	name: "pi",
	command: "pi",
	args: ["-p", "{{prompt}}"],
	modelFlag: "--model",
	effortFlag: "--thinking",
};

export const OPENCODE_TEMPLATE: GenericTemplate = {
	name: "opencode",
	command: "opencode",
	args: ["run", "{{prompt}}"],
	modelFlag: "-m",
	effortFlag: "--variant",
};

export class GenericAdapter implements Adapter {
	public parseLine(line: string): readonly Event[] {
		return [{ kind: "text", text: `${line}\n` }];
	}

	public finish(_exitCode: number): readonly Event[] {
		return [];
	}
}

export class GenericProvider implements Provider {
	public readonly type = "generic" as const;
	public readonly resumable = false;
	public readonly name: string;
	public readonly models: readonly string[];
	public readonly auth: AuthMode;
	private readonly template: GenericTemplate;

	public constructor(template: GenericTemplate) {
		validateGenericTemplate(template);
		this.template = copyTemplate(template);
		this.name = template.name;
		this.models = [...(template.models ?? [])];
		this.auth = template.auth ?? "";
	}

	public start(config: RunConfig, signal?: AbortSignal): AsyncIterable<Event> {
		if (config.providerSessionId !== undefined && config.providerSessionId !== "") {
			return failedRun(`provider ${JSON.stringify(this.name)} does not support resume`);
		}
		return this.startRun(config, signal);
	}

	public buildArgv(config: RunConfig): readonly string[] {
		return buildGenericArgv(this.template, withDefaults(this.template, config));
	}

	public buildProcessSpec(config: RunConfig): ProcessSpec {
		const merged = withDefaults(this.template, config);
		return {
			argv: buildGenericArgv(this.template, merged),
			cwd: merged.workdir ?? this.template.workdir,
			env: environmentFromEntries(merged.env ?? this.template.env, process.env, merged.envDenyList),
		};
	}

	private async *startRun(config: RunConfig, signal?: AbortSignal): AsyncIterable<Event> {
		try {
			yield* runProcessAdapter(
				{
					spec: this.buildProcessSpec(config),
					adapter: new GenericAdapter(),
					resultPolicy: "plain",
				},
				signal,
			);
		} catch (error) {
			yield* failedRun(error instanceof Error ? error.message : String(error));
		}
	}
}

export function createGenericProvider(template: GenericTemplate): GenericProvider {
	return new GenericProvider(template);
}

export function validateGenericTemplate(template: GenericTemplate): void {
	if (template.name.trim() === "") throw new Error("generic provider name must not be empty");
	validateExecutable(template.command);
	validateArgs(template.args, "generic args");
	validateArgs(template.extraArgs ?? [], "generic extraArgs");
	validateFlag(template.modelFlag, "modelFlag");
	validateFlag(template.effortFlag, "effortFlag");
	validateAuthMode(template.auth);
	const placeholders = template.args.filter((arg) => arg === "{{prompt}}").length;
	if (placeholders !== 1) throw new Error("generic args must contain exactly one {{prompt}} element");
	for (const arg of template.args) {
		if (arg !== "{{prompt}}" && arg.includes("{{prompt}}")) {
			throw new Error("{{prompt}} substitution is only allowed as an exact argv element");
		}
	}
	environmentFromEntries(template.env);
}

export function buildGenericArgv(template: GenericTemplate, config: RunConfig): readonly string[] {
	const argv = [template.command];
	for (const arg of template.args) argv.push(arg === "{{prompt}}" ? config.prompt : arg);
	if (config.model !== undefined && config.model !== "" && template.modelFlag !== undefined) {
		argv.push(template.modelFlag, config.model);
	}
	if (config.effort !== undefined && config.effort !== "" && template.effortFlag !== undefined) {
		argv.push(template.effortFlag, config.effort);
	}
	if (template.extraArgs !== undefined) argv.push(...template.extraArgs);
	if (config.extraArgs !== undefined) argv.push(...config.extraArgs);
	return argv;
}

function withDefaults(template: GenericTemplate, config: RunConfig): RunConfig {
	return {
		...config,
		model: config.model === undefined || config.model === "" ? template.model : config.model,
		effort:
			config.effort === undefined || config.effort === ""
				? template.effort === undefined || template.effort === "default"
					? undefined
					: template.effort
				: config.effort,
	};
}

function copyTemplate(template: GenericTemplate): GenericTemplate {
	return {
		...template,
		args: [...template.args],
		...(template.models === undefined ? {} : { models: [...template.models] }),
		...(template.extraArgs === undefined ? {} : { extraArgs: [...template.extraArgs] }),
		...(template.env === undefined ? {} : { env: [...template.env] }),
	};
}
