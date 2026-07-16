import type { ConfigError, OrchestratorConfig, Provider } from "@void/orchestrator";
import { createConfiguredProviders, createMockProvider, Orchestrator, parseSettings } from "@void/orchestrator";

export interface OrchestratorSettingsSource {
	readonly orchestrator?: unknown;
}

export interface OrchestratorConfigDiagnostic {
	readonly path: string;
	readonly code: ConfigError["code"];
	readonly message: string;
}

export interface OrchestratorResolutionSuccess {
	readonly ok: true;
	readonly config: OrchestratorConfig;
	readonly providers: Readonly<Record<string, Provider>>;
	readonly orchestrator: Orchestrator;
	readonly diagnostics: readonly [];
}

export interface OrchestratorResolutionFailure {
	readonly ok: false;
	readonly diagnostics: readonly OrchestratorConfigDiagnostic[];
}

export type OrchestratorResolution = OrchestratorResolutionSuccess | OrchestratorResolutionFailure;

/** Validate child Provider settings and construct the process-lifetime orchestration seam. */
export function resolveOrchestratorSettings(settings: OrchestratorSettingsSource): OrchestratorResolution {
	const parsed = parseSettings(settings);
	if (!parsed.ok) {
		return { ok: false, diagnostics: parsed.errors.map(configDiagnostic) };
	}
	const environmentDiagnostics = validateEnvironmentEntries(parsed.config);
	if (environmentDiagnostics.length > 0) {
		return { ok: false, diagnostics: environmentDiagnostics };
	}

	try {
		const providers: Record<string, Provider> = { ...createConfiguredProviders(parsed.config) };
		for (const [name, providerConfig] of Object.entries(parsed.config.providers)) {
			if (providerConfig.type === "mock") providers[name] = createMockProvider();
		}
		const orchestrator = new Orchestrator((name) => providers[name], {
			defaultProvider: parsed.config.defaultProvider,
		});
		return { ok: true, config: parsed.config, providers, orchestrator, diagnostics: [] };
	} catch (error) {
		return {
			ok: false,
			diagnostics: [
				{
					path: "$.orchestrator.providers",
					code: "invalid-value",
					message: redactEnvironmentValues(errorMessage(error), parsed.config),
				},
			],
		};
	}
}

function validateEnvironmentEntries(config: OrchestratorConfig): readonly OrchestratorConfigDiagnostic[] {
	const diagnostics: OrchestratorConfigDiagnostic[] = [];
	for (const [name, provider] of Object.entries(config.providers)) {
		for (const [index, entry] of (provider.env ?? []).entries()) {
			if (!entry.includes("\0")) continue;
			diagnostics.push({
				path: `$.orchestrator.providers.${name}.env[${index}]`,
				code: "invalid-value",
				message: "environment entries must not contain NUL",
			});
		}
	}
	return diagnostics;
}

function configDiagnostic(error: ConfigError): OrchestratorConfigDiagnostic {
	const suffix = error.path === "$" ? "" : error.path.slice(1);
	return {
		path: `$.orchestrator${suffix}`,
		code: error.code,
		message: error.message,
	};
}

function redactEnvironmentValues(message: string, config: OrchestratorConfig): string {
	let redacted = message;
	for (const provider of Object.values(config.providers)) {
		for (const entry of provider.env ?? []) {
			const separator = entry.indexOf("=");
			const value = separator < 0 ? "" : entry.slice(separator + 1);
			if (value !== "") redacted = redacted.replaceAll(value, "[redacted]");
		}
	}
	return redacted;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
