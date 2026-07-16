import { basename } from "node:path";
import type { CommandRunner } from "./auth.js";
import { runCapturedCommand } from "./auth.js";
import { isRecord, stringValue } from "./provider-utils.js";
import type { ProviderConfig } from "./types.js";

const DISCOVERY_TIMEOUT_MS = 20_000;
const DEFAULT_MRU_LIMIT = 5;

export interface ModelDiscoveryOptions {
	readonly run?: CommandRunner;
	readonly timeoutMs?: number;
}

export async function discoverModels(
	provider: ProviderConfig,
	options: ModelDiscoveryOptions = {},
	signal?: AbortSignal,
): Promise<readonly string[]> {
	const invocation = discoveryInvocation(provider);
	if (invocation === undefined) return [...(provider.models ?? [])];
	const controller = new AbortController();
	const abort = () => controller.abort(signal?.reason);
	if (signal?.aborted === true) abort();
	else signal?.addEventListener("abort", abort, { once: true });
	const timer = setTimeout(
		() => controller.abort(new Error("model discovery timed out")),
		options.timeoutMs ?? DISCOVERY_TIMEOUT_MS,
	);
	try {
		const output = await (options.run ?? runCapturedCommand)(invocation.argv, controller.signal);
		const discovered = invocation.stream === "stderr" ? output.stderr : output.stdout;
		return mergeModels(provider.models ?? [], invocation.parse(discovered));
	} catch {
		return [...(provider.models ?? [])];
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", abort);
	}
}

export function parseCodexModels(data: string): readonly string[] {
	let value: unknown;
	try {
		value = JSON.parse(data) as unknown;
	} catch {
		return [];
	}
	if (!isRecord(value) || !Array.isArray(value.models)) return [];
	const models: string[] = [];
	for (const entry of value.models) {
		if (!isRecord(entry) || stringValue(entry, "visibility") !== "list") continue;
		const slug = stringValue(entry, "slug");
		if (slug !== undefined && slug !== "") models.push(slug);
	}
	return models;
}

export function parseOpencodeModels(data: string): readonly string[] {
	return data
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line !== "" && line.includes("/") && !/[\t ]/.test(line));
}

export function parsePiModels(data: string): readonly string[] {
	const models: string[] = [];
	for (const line of data.split(/\r?\n/)) {
		const fields = line.trim().split(/\s+/);
		if (fields.length < 2 || fields[0] === "provider" || line.startsWith("Error")) continue;
		models.push(`${fields[0]}/${fields[1]}`);
	}
	return models;
}

export function mergeModels(configured: readonly string[], discovered: readonly string[]): readonly string[] {
	const models: string[] = [];
	const seen = new Set<string>();
	for (const model of [...configured, ...discovered]) {
		if (model === "" || seen.has(model)) continue;
		seen.add(model);
		models.push(model);
	}
	return models;
}

/** Bounded most-recent-first model state, independently capped per Provider. */
export class ProviderModelMRU {
	private readonly values = new Map<string, string[]>();

	public constructor(private readonly limit = DEFAULT_MRU_LIMIT) {
		if (!Number.isInteger(limit) || limit < 1) throw new Error("MRU limit must be a positive integer");
	}

	public remember(provider: string, model: string): void {
		if (provider === "" || model === "") return;
		const previous = this.values.get(provider) ?? [];
		this.values.set(provider, [model, ...previous.filter((entry) => entry !== model)].slice(0, this.limit));
	}

	public list(provider: string): readonly string[] {
		return [...(this.values.get(provider) ?? [])];
	}

	public clear(provider?: string): void {
		if (provider === undefined) this.values.clear();
		else this.values.delete(provider);
	}
}

interface DiscoveryInvocation {
	readonly argv: readonly string[];
	readonly stream: "stdout" | "stderr";
	readonly parse: (data: string) => readonly string[];
}

function discoveryInvocation(provider: ProviderConfig): DiscoveryInvocation | undefined {
	if (provider.type === "codex") {
		return { argv: ["codex", "debug", "models"], stream: "stdout", parse: parseCodexModels };
	}
	if (provider.type !== "generic" || provider.command === undefined) return undefined;
	switch (basename(provider.command)) {
		case "opencode":
			return { argv: [provider.command, "models"], stream: "stdout", parse: parseOpencodeModels };
		case "pi":
			return {
				argv: [provider.command, "--no-extensions", "--list-models"],
				stream: "stderr",
				parse: parsePiModels,
			};
		default:
			return undefined;
	}
}
