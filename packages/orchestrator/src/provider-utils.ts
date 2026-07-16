import type { AuthMode } from "./types.js";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const AUTH_MODES = new Set<AuthMode>(["", "auto", "subscription", "api"]);

export function validateExecutable(command: string): void {
	if (command.trim() === "") throw new Error("provider command must not be empty");
	validateArg(command, "provider command");
}

export function validateArg(value: string, label: string): void {
	if (value.includes("\0")) throw new Error(`${label} must not contain NUL`);
}

export function validateArgs(values: readonly string[], label: string): void {
	for (const [index, value] of values.entries()) validateArg(value, `${label}[${index}]`);
}

export function validateFlag(flag: string | undefined, label: string): void {
	if (flag === undefined) return;
	validateArg(flag, label);
	if (!/^-[^-\s]|^--[^-\s]/.test(flag) || /\s/.test(flag)) {
		throw new Error(`${label} must be one discrete argv flag`);
	}
}

export function validateAuthMode(mode: AuthMode | undefined): void {
	if (mode !== undefined && !AUTH_MODES.has(mode)) throw new Error(`unknown auth mode ${JSON.stringify(mode)}`);
}

/** Validate KEY=VALUE entries, overlay them on the parent environment, then remove denied keys. */
export function environmentFromEntries(
	entries: readonly string[] | undefined,
	parent: Readonly<Record<string, string | undefined>> = process.env,
	denyList: readonly string[] = [],
): Readonly<Record<string, string | undefined>> | undefined {
	if (entries === undefined && denyList.length === 0) return undefined;
	const environment: Record<string, string | undefined> = { ...parent };
	for (const [index, entry] of (entries ?? []).entries()) {
		validateArg(entry, `env[${index}]`);
		const separator = entry.indexOf("=");
		const key = separator < 0 ? "" : entry.slice(0, separator);
		if (!ENV_NAME.test(key)) throw new Error(`env[${index}] must use KEY=VALUE`);
		environment[key] = entry.slice(separator + 1);
	}
	for (const key of denyList) delete environment[key];
	return environment;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringValue(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" ? value : undefined;
}

export function booleanValue(record: Record<string, unknown>, key: string): boolean | undefined {
	const value = record[key];
	return typeof value === "boolean" ? value : undefined;
}

export function numberValue(record: Record<string, unknown>, key: string): number | undefined {
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
