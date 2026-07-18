import { theme } from "./theme.js";

export interface ProviderPalette {
	base: string;
	strong: string;
}

const PALETTES = {
	anthropic: { base: "#C2410C", strong: "#FDBA74" },
	emerald: { base: "#34D399", strong: "#A7F3D0" },
	cyan: { base: "#22D3EE", strong: "#A5F3FC" },
	amber: { base: "#F59E0B", strong: "#FDE68A" },
	blue: { base: "#60A5FA", strong: "#BFDBFE" },
	rose: { base: "#FB7185", strong: "#FECDD3" },
	orange: { base: "#FB923C", strong: "#FED7AA" },
	magenta: { base: "#E879F9", strong: "#F5D0FE" },
} as const satisfies Record<string, ProviderPalette>;

const PROVIDER_PALETTE_RULES: Array<{ match: RegExp; palette: keyof typeof PALETTES }> = [
	{ match: /anthropic|claude/i, palette: "anthropic" },
	{ match: /openai|codex/i, palette: "emerald" },
	{ match: /google|gemini/i, palette: "cyan" },
	{ match: /^(?:void|pi)(?:-|$)/i, palette: "amber" },
	{ match: /github|copilot/i, palette: "blue" },
	{ match: /openrouter/i, palette: "rose" },
	{ match: /amazon|bedrock/i, palette: "orange" },
	{ match: /mistral/i, palette: "magenta" },
];

const FALLBACK_PALETTES = Object.values(PALETTES);

function providerFamily(provider: string): keyof typeof PALETTES | undefined {
	return PROVIDER_PALETTE_RULES.find((rule) => rule.match.test(provider))?.palette;
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
