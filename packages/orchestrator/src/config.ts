import type {
	AuthMode,
	ConfigError,
	ConfigParseResult,
	Effort,
	OrchestratorConfig,
	ProviderConfig,
	ProviderType,
} from "./types.js";

const CLAUDE_MODELS = ["claude-fable-5", "claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5"] as const;

const AUTH_MODES = new Set<AuthMode>(["", "auto", "subscription", "api"]);
const EFFORTS = new Set<Effort>(["default", "low", "medium", "high"]);
const PROVIDER_TYPES = new Set<ProviderType>(["claude", "codex", "generic", "mock"]);
const PROVIDER_FIELDS = new Set([
	"type",
	"command",
	"args",
	"model",
	"modelFlag",
	"effort",
	"effortFlag",
	"models",
	"extraArgs",
	"env",
	"auth",
]);

const CONFIG_FIELDS = new Set(["defaultProvider", "providers"]);

export function defaultConfig(): OrchestratorConfig {
	return {
		defaultProvider: "claude",
		providers: {
			claude: { type: "claude", models: [...CLAUDE_MODELS] },
			codex: { type: "codex" },
			pi: {
				type: "generic",
				command: "pi",
				args: ["-p", "{{prompt}}"],
				modelFlag: "--model",
				effortFlag: "--thinking",
			},
			opencode: {
				type: "generic",
				command: "opencode",
				args: ["run", "{{prompt}}"],
				modelFlag: "-m",
				effortFlag: "--variant",
			},
		},
	};
}

export const DEFAULT_CONFIG = defaultConfig();

export function parseConfigJson(json: string): ConfigParseResult {
	let value: unknown;
	try {
		value = JSON.parse(json) as unknown;
	} catch (error) {
		const message = error instanceof Error ? error.message : "invalid JSON";
		return { ok: false, errors: [{ path: "$", code: "invalid-json", message }] };
	}
	return parseConfig(value);
}

/** Parse the `orchestrator` object, returning no config when any error exists. */
export function parseConfig(value: unknown): ConfigParseResult {
	const errors: ConfigError[] = [];
	if (!isRecord(value)) {
		return failure("$", "invalid-type", "expected an object");
	}

	for (const key of Object.keys(value)) {
		if (!CONFIG_FIELDS.has(key)) {
			errors.push({ path: `$.${key}`, code: "unknown-field", message: `unknown configuration field ${key}` });
		}
	}

	const defaultProvider = readString(value, "defaultProvider", "$.defaultProvider", errors);
	const providersValue = value.providers;
	if (providersValue === undefined) {
		errors.push({ path: "$.providers", code: "missing", message: "providers is required" });
	}
	if (!isRecord(providersValue)) {
		if (providersValue !== undefined) {
			errors.push({ path: "$.providers", code: "invalid-type", message: "providers must be an object" });
		}
	} else if (Object.keys(providersValue).length === 0) {
		errors.push({ path: "$.providers", code: "invalid-value", message: "providers must not be empty" });
	}

	const providers: Record<string, ProviderConfig> = {};
	if (isRecord(providersValue)) {
		for (const [name, rawProvider] of Object.entries(providersValue)) {
			const provider = parseProvider(name, rawProvider, errors);
			if (provider !== undefined) {
				providers[name] = provider;
			}
		}
	}

	if (defaultProvider !== undefined && isRecord(providersValue) && !(defaultProvider in providersValue)) {
		errors.push({
			path: "$.defaultProvider",
			code: "invalid-value",
			message: `defaultProvider ${JSON.stringify(defaultProvider)} is not defined in providers`,
		});
	}

	if (errors.length > 0 || defaultProvider === undefined) {
		return { ok: false, errors };
	}
	return { ok: true, config: { defaultProvider, providers }, errors: [] };
}

/** Parse a settings document containing an optional `orchestrator` member. */
export function parseSettings(value: unknown): ConfigParseResult {
	if (!isRecord(value)) {
		return failure("$", "invalid-type", "expected a settings object");
	}
	return value.orchestrator === undefined
		? { ok: true, config: defaultConfig(), errors: [] }
		: parseConfig(value.orchestrator);
}

export function validateConfig(config: OrchestratorConfig): readonly ConfigError[] {
	const result = parseConfig(config);
	return result.ok ? [] : result.errors;
}

function parseProvider(name: string, value: unknown, errors: ConfigError[]): ProviderConfig | undefined {
	const path = `$.providers.${name}`;
	if (!isRecord(value)) {
		errors.push({ path, code: "invalid-type", message: "provider must be an object" });
		return undefined;
	}
	for (const key of Object.keys(value)) {
		if (!PROVIDER_FIELDS.has(key)) {
			errors.push({ path: `${path}.${key}`, code: "unknown-field", message: `unknown provider field ${key}` });
		}
	}

	const type = readString(value, "type", `${path}.type`, errors) as ProviderType | undefined;
	if (type !== undefined && !PROVIDER_TYPES.has(type)) {
		errors.push({
			path: `${path}.type`,
			code: "invalid-value",
			message: `unknown provider type ${JSON.stringify(type)}`,
		});
	}

	const provider: ProviderConfig = { type: type ?? "generic" };
	readOptionalString(value, "command", path, provider, errors);
	readOptionalString(value, "model", path, provider, errors);
	readOptionalString(value, "modelFlag", path, provider, errors);
	readOptionalString(value, "effortFlag", path, provider, errors);
	readOptionalStringArray(value, "args", path, provider, errors);
	readOptionalStringArray(value, "models", path, provider, errors);
	readOptionalStringArray(value, "extraArgs", path, provider, errors);
	readOptionalStringArray(value, "env", path, provider, errors);

	const effort = readOptionalStringValue(value, "effort", path, errors);
	if (effort !== undefined) {
		if (!EFFORTS.has(effort as Effort)) {
			errors.push({
				path: `${path}.effort`,
				code: "invalid-value",
				message: `unknown effort ${JSON.stringify(effort)}`,
			});
		} else {
			provider.effort = effort as Effort;
		}
	}
	const auth = readOptionalStringValue(value, "auth", path, errors);
	if (auth !== undefined) {
		if (!AUTH_MODES.has(auth as AuthMode)) {
			errors.push({
				path: `${path}.auth`,
				code: "invalid-value",
				message: `unknown auth mode ${JSON.stringify(auth)}`,
			});
		} else {
			provider.auth = auth as AuthMode;
		}
	}

	if (type === "generic") {
		if (provider.command === undefined || provider.command.length === 0) {
			errors.push({
				path: `${path}.command`,
				code: "invalid-value",
				message: "generic provider requires a command",
			});
		}
		const args = provider.args;
		const placeholders = args?.filter((arg) => arg === "{{prompt}}").length ?? 0;
		if (placeholders !== 1) {
			errors.push({
				path: `${path}.args`,
				code: "invalid-value",
				message: "generic provider args must contain exactly one {{prompt}} element",
			});
		}
	}
	if (provider.env !== undefined) {
		for (const [index, entry] of provider.env.entries()) {
			if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(entry)) {
				errors.push({
					path: `${path}.env[${index}]`,
					code: "invalid-value",
					message: "environment entries must use KEY=VALUE",
				});
			}
		}
	}
	return provider;
}

function readString(
	value: Record<string, unknown>,
	key: string,
	path: string,
	errors: ConfigError[],
): string | undefined {
	if (!(key in value)) {
		errors.push({ path, code: "missing", message: `${key} is required` });
		return undefined;
	}
	const entry = value[key];
	if (typeof entry !== "string") {
		errors.push({ path, code: "invalid-type", message: `${key} must be a string` });
		return undefined;
	}
	if (entry.length === 0) {
		errors.push({ path, code: "invalid-value", message: `${key} must not be empty` });
		return undefined;
	}
	return entry;
}

function readOptionalStringValue(
	value: Record<string, unknown>,
	key: string,
	path: string,
	errors: ConfigError[],
): string | undefined {
	if (!(key in value)) return undefined;
	const entry = value[key];
	if (typeof entry !== "string") {
		errors.push({ path: `${path}.${key}`, code: "invalid-type", message: `${key} must be a string` });
		return undefined;
	}
	return entry;
}

function readOptionalString(
	value: Record<string, unknown>,
	key: string,
	path: string,
	provider: ProviderConfig,
	errors: ConfigError[],
): void {
	const entry = readOptionalStringValue(value, key, path, errors);
	if (entry !== undefined) provider[key as "command" | "model" | "modelFlag" | "effortFlag"] = entry;
}

function readOptionalStringArray(
	value: Record<string, unknown>,
	key: string,
	path: string,
	provider: ProviderConfig,
	errors: ConfigError[],
): void {
	if (!(key in value)) return;
	const entry = value[key];
	if (!Array.isArray(entry) || entry.some((item) => typeof item !== "string")) {
		errors.push({ path: `${path}.${key}`, code: "invalid-type", message: `${key} must be an array of strings` });
		return;
	}
	provider[key as "args" | "models" | "extraArgs" | "env"] = [...entry];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failure(path: string, code: ConfigError["code"], message: string): ConfigParseResult {
	return { ok: false, errors: [{ path, code, message }] };
}
