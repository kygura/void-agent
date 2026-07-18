import { theme } from "./theme.js";

export interface ProviderPalette {
	base: string;
	strong: string;
}

const PALETTES = {
	violet: { base: "#A78BFA", strong: "#E9D5FF" },
	emerald: { base: "#34D399", strong: "#A7F3D0" },
	cyan: { base: "#22D3EE", strong: "#A5F3FC" },
	amber: { base: "#F59E0B", strong: "#FDE68A" },
	blue: { base: "#60A5FA", strong: "#BFDBFE" },
	rose: { base: "#FB7185", strong: "#FECDD3" },
	orange: { base: "#FB923C", strong: "#FED7AA" },
	magenta: { base: "#E879F9", strong: "#F5D0FE" },
} as const satisfies Record<string, ProviderPalette>;

const FALLBACK_PALETTES = Object.values(PALETTES);

function providerFamily(provider: string): keyof typeof PALETTES | undefined {
	const normalized = provider.toLowerCase();
	if (normalized.includes("anthropic") || normalized.includes("claude")) return "violet";
	if (normalized.includes("openai") || normalized.includes("codex")) return "emerald";
	if (normalized.includes("google") || normalized.includes("gemini")) return "cyan";
	if (normalized === "void" || normalized === "pi" || normalized.startsWith("pi-")) return "amber";
	if (normalized.includes("github") || normalized.includes("copilot")) return "blue";
	if (normalized.includes("openrouter")) return "rose";
	if (normalized.includes("amazon") || normalized.includes("bedrock")) return "orange";
	if (normalized.includes("mistral")) return "magenta";
	return undefined;
}

function stableHash(value: string): number {
	let hash = 2166136261;
	for (let index = 0; index < value.length; index++) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return hash >>> 0;
}

export function getProviderPalette(provider: string): ProviderPalette {
	const family = providerFamily(provider);
	if (family !== undefined) return PALETTES[family];
	return FALLBACK_PALETTES[stableHash(provider.toLowerCase()) % FALLBACK_PALETTES.length]!;
}

export function isFrontierModel(model: string | undefined): boolean {
	return model !== undefined && /(?:^|[/_.:\-\s])(fable|sol)(?:$|[/_.:\-\s])/i.test(model);
}

export function styleProvider(provider: string, text: string = provider): string {
	return theme.fgHex(getProviderPalette(provider).base, text);
}

export function styleModel(provider: string, model: string, text: string = model): string {
	const palette = getProviderPalette(provider);
	return isFrontierModel(model) ? theme.bold(theme.fgHex(palette.strong, text)) : theme.fgHex(palette.base, text);
}
