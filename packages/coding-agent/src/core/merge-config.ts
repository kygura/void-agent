/**
 * Generic deep-merge for plain JSON-like config objects, used to layer
 * settings sources (global, profile, project, CLI overrides).
 *
 * - Nested plain objects merge recursively (overlay wins per key).
 * - Arrays and scalars in overlay replace the base value entirely.
 * - `null` in overlay deletes the corresponding key from the result.
 * - `undefined` in overlay is ignored (base value kept).
 */
export function mergeConfig<T extends Record<string, unknown> = Record<string, unknown>>(
	base: T,
	overlay: Record<string, unknown>,
): T {
	const result: Record<string, unknown> = { ...base };

	for (const key of Object.keys(overlay)) {
		const overlayValue = overlay[key];

		if (overlayValue === undefined) {
			continue;
		}
		if (overlayValue === null) {
			delete result[key];
			continue;
		}

		const baseValue = result[key];
		if (isPlainObject(overlayValue) && isPlainObject(baseValue)) {
			result[key] = mergeConfig(baseValue, overlayValue);
		} else {
			result[key] = overlayValue;
		}
	}

	return result as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Set a dotted-path value into a nested object, creating intermediate objects as needed. */
export function setDottedPath(target: Record<string, unknown>, path: string, value: unknown): void {
	const keys = path.split(".");
	let cursor: Record<string, unknown> = target;
	for (let i = 0; i < keys.length - 1; i++) {
		const key = keys[i];
		const existing = cursor[key];
		if (!isPlainObject(existing)) {
			cursor[key] = {};
		}
		cursor = cursor[key] as Record<string, unknown>;
	}
	cursor[keys[keys.length - 1]] = value;
}

/** Parse a CLI override value: JSON if it parses cleanly, otherwise the raw string. */
export function parseConfigValue(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return raw;
	}
}

/** Build a nested overrides object from repeated `key.path=value` CLI entries (`--config`/`-c`). */
export function buildConfigOverrides(entries: Array<{ path: string; raw: string }>): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const { path, raw } of entries) {
		setDottedPath(result, path, parseConfigValue(raw));
	}
	return result;
}
