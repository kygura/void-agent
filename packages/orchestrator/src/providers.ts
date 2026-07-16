import { failedRun } from "./adapter.js";
import type { ChildAuthAdapterOptions } from "./auth.js";
import { AuthCache, createChildAuthAdapter, effectiveAuthMode } from "./auth.js";
import { DEFAULT_CONFIG } from "./config.js";
import { ClaudeProvider } from "./providers/claude.js";
import { CodexProvider } from "./providers/codex.js";
import type { GenericTemplate } from "./providers/generic.js";
import { GenericProvider } from "./providers/generic.js";
import type { AuthAdapter, Event, OrchestratorConfig, Provider, ProviderConfig, RunConfig } from "./types.js";

export interface ProviderFactoryOptions {
	readonly authCache?: AuthCache;
	readonly claudeAuth?: ChildAuthAdapterOptions;
	readonly codexAuth?: ChildAuthAdapterOptions;
}

export interface ChildProvider extends Provider {
	readonly authAdapter?: AuthAdapter;
	readonly config: ProviderConfig;
}

export class ConfiguredProvider implements ChildProvider {
	public readonly name: string;
	public readonly type: ProviderConfig["type"];
	public readonly resumable: boolean;
	public readonly authAdapter?: AuthAdapter;
	public readonly config: ProviderConfig;

	public constructor(
		name: string,
		config: ProviderConfig,
		private readonly base: Provider,
		private readonly authCache: AuthCache,
		authAdapter?: AuthAdapter,
	) {
		this.name = name;
		this.type = config.type;
		this.resumable = base.resumable === true;
		this.config = copyProviderConfig(config);
		this.authAdapter = authAdapter;
	}

	public start(config: RunConfig, signal?: AbortSignal): AsyncIterable<Event> {
		return this.startRun(config, signal);
	}

	public mergedRunConfig(config: RunConfig): RunConfig {
		const defaults = this.config;
		const defaultEffort =
			defaults.effort === undefined || defaults.effort === "default" ? undefined : defaults.effort;
		const subscription = effectiveAuthMode(defaults.auth, this.authCache.getOr(this.name)) === "subscription";
		const envDenyList = subscription
			? [...new Set([...(config.envDenyList ?? []), ...apiKeyVariables(defaults.type)])]
			: config.envDenyList;
		return {
			...config,
			model: config.model === undefined || config.model === "" ? defaults.model : config.model,
			effort: config.effort === undefined || config.effort === "" ? defaultEffort : config.effort,
			extraArgs: [...(defaults.extraArgs ?? []), ...(config.extraArgs ?? [])],
			env: config.env ?? defaults.env,
			envDenyList,
		};
	}

	private async *startRun(config: RunConfig, signal?: AbortSignal): AsyncIterable<Event> {
		try {
			yield* this.base.start(this.mergedRunConfig(config), signal);
		} catch (error) {
			yield* failedRun(error instanceof Error ? error.message : String(error));
		}
	}
}

export function createProvider(
	name: string,
	config: ProviderConfig,
	options: ProviderFactoryOptions = {},
): ChildProvider {
	const cache = options.authCache ?? new AuthCache();
	let base: Provider;
	let authAdapter: AuthAdapter | undefined;
	switch (config.type) {
		case "claude":
			base = new ClaudeProvider();
			authAdapter = createChildAuthAdapter("claude", options.claudeAuth);
			break;
		case "codex":
			base = new CodexProvider();
			authAdapter = createChildAuthAdapter("codex", options.codexAuth);
			break;
		case "generic":
			base = new GenericProvider(genericTemplate(name, config));
			break;
		case "mock":
			throw new Error(
				"mock Providers require an explicit script and are not created by the process Provider factory",
			);
	}
	return new ConfiguredProvider(name, config, base, cache, authAdapter);
}

export function createDefaultProviders(options: ProviderFactoryOptions = {}): Readonly<Record<string, ChildProvider>> {
	return createConfiguredProviders(DEFAULT_CONFIG, options);
}

export function createConfiguredProviders(
	config: OrchestratorConfig,
	options: ProviderFactoryOptions = {},
): Readonly<Record<string, ChildProvider>> {
	const authCache = options.authCache ?? new AuthCache();
	const providers: Record<string, ChildProvider> = {};
	for (const [name, providerConfig] of Object.entries(config.providers)) {
		if (providerConfig.type === "mock") continue;
		providers[name] = createProvider(name, providerConfig, { ...options, authCache });
	}
	return providers;
}

function genericTemplate(name: string, config: ProviderConfig): GenericTemplate {
	return {
		name,
		command: config.command ?? "",
		args: config.args ?? [],
		...(config.modelFlag === undefined ? {} : { modelFlag: config.modelFlag }),
		...(config.effortFlag === undefined ? {} : { effortFlag: config.effortFlag }),
		...(config.models === undefined ? {} : { models: config.models }),
		...(config.auth === undefined ? {} : { auth: config.auth }),
	};
}

function apiKeyVariables(type: ProviderConfig["type"]): readonly string[] {
	if (type === "claude") return ["ANTHROPIC_API_KEY"];
	if (type === "codex") return ["OPENAI_API_KEY"];
	return [];
}

function copyProviderConfig(config: ProviderConfig): ProviderConfig {
	return {
		...config,
		...(config.args === undefined ? {} : { args: [...config.args] }),
		...(config.models === undefined ? {} : { models: [...config.models] }),
		...(config.extraArgs === undefined ? {} : { extraArgs: [...config.extraArgs] }),
		...(config.env === undefined ? {} : { env: [...config.env] }),
	};
}
