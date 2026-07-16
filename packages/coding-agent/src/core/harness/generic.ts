/**
 * Template harness: a user/config-defined generic provider — a command plus
 * an argv template with a "{{prompt}}" placeholder — for any CLI void has no
 * first-class adapter for. Callers construct one GenericHarnessConfig per
 * configured generic harness.
 */

import { buildGenericArgv, GenericAdapter, GenericProvider, type GenericTemplate } from "@void/orchestrator";
import type { ProcResult } from "./proc.js";
import {
	fromOrchestratorEvent,
	fromOrchestratorEvents,
	type Harness,
	type HarnessEvent,
	type HarnessRunConfig,
	nowIso,
	toOrchestratorRunConfig,
} from "./types.js";

/** Config for one generic harness instance. */
export interface GenericHarnessConfig {
	id: string;
	/** Executable, looked up on PATH if not absolute. */
	command: string;
	/** argv template; an element exactly equal to "{{prompt}}" is replaced as a whole element. */
	args: string[];
	/** Flag that carries HarnessRunConfig.model, e.g. "--model" (undefined = model unsupported, silently dropped). */
	modelFlag?: string;
	/** Flag that carries a supported reasoning effort value. */
	effortFlag?: string;
	/** Extra argv appended after model/effort flags. */
	extraArgs?: string[];
	/** Default working directory (undefined = inherit); HarnessRunConfig.cwd overrides. */
	cwd?: string;
}

/**
 * Substitutes "{{prompt}}" as a whole argv element (never a substring inside
 * a larger argument, and never shell-interpolated) and appends the model
 * flag when both the config supports one and the run sets a model. Pure
 * function so tests can assert the exact array without spawning a process.
 */
export function genericArgs(config: GenericHarnessConfig, cfg: HarnessRunConfig): string[] {
	return [...buildGenericArgv(toGenericTemplate(config), toOrchestratorRunConfig(config.id, cfg))].slice(1);
}

/** Treats every line as plain text output — generic CLIs have no structured output contract. */
export function parseGenericLine(line: string): HarnessEvent[] {
	return new GenericAdapter().parseLine(line).flatMap((event) => {
		const converted = fromOrchestratorEvent(event);
		return converted === undefined ? [] : [converted];
	});
}

/**
 * Always emits a result (unlike the structured adapters, plain text never
 * contains its own result event): isError reflects the exit code alone
 * since there's no structured success/failure signal to parse.
 */
export function finalizeGeneric(result: ProcResult): HarnessEvent {
	return { kind: "result", timestamp: nowIso(), isError: result.exitCode !== 0 || !!result.error };
}

/**
 * A Harness built from a GenericHarnessConfig. It has no structured output
 * contract: every stdout line becomes a plain "text" event, and it is not
 * resumable — no generic CLI's resume semantics are known.
 */
export class GenericHarness implements Harness {
	readonly id: string;
	readonly resumable = false;
	private readonly provider: GenericProvider;

	constructor(config: GenericHarnessConfig) {
		this.id = config.id;
		this.provider = new GenericProvider(toGenericTemplate(config));
	}

	start(cfg: HarnessRunConfig, signal: AbortSignal): AsyncIterable<HarnessEvent> {
		return fromOrchestratorEvents(this.provider.start(toOrchestratorRunConfig(this.id, cfg), signal));
	}
}

function toGenericTemplate(config: GenericHarnessConfig): GenericTemplate {
	return {
		name: config.id,
		command: config.command,
		args: config.args,
		...(config.modelFlag === undefined ? {} : { modelFlag: config.modelFlag }),
		...(config.effortFlag === undefined ? {} : { effortFlag: config.effortFlag }),
		...(config.extraArgs === undefined ? {} : { extraArgs: config.extraArgs }),
		...(config.cwd === undefined ? {} : { workdir: config.cwd }),
	};
}
