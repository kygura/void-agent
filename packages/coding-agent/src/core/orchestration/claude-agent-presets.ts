import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseFrontmatter } from "../../utils/frontmatter.js";

export interface ClaudeAgentPreset {
	name: string;
	description?: string;
	model?: string;
	systemPrompt: string;
}

interface ClaudeAgentFrontmatter extends Record<string, unknown> {
	name?: unknown;
	description?: unknown;
	model?: unknown;
	"user-invocable"?: unknown;
}

/** Discover user presets first, then replace same-name entries with project presets. */
export function discoverClaudeAgentPresets(homeDir: string, workdir: string): readonly ClaudeAgentPreset[] {
	const byName = new Map<string, ClaudeAgentPreset>();
	for (const root of [homeDir, workdir]) {
		if (root === "") continue;
		for (const preset of scanPresetDirectory(join(root, ".claude", "agents"))) byName.set(preset.name, preset);
	}
	return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function scanPresetDirectory(directory: string): readonly ClaudeAgentPreset[] {
	if (!existsSync(directory)) return [];
	try {
		return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
			if (entry.isDirectory() || !entry.name.endsWith(".md")) return [];
			const preset = readPreset(join(directory, entry.name), basename(entry.name, ".md"));
			return preset === undefined ? [] : [preset];
		});
	} catch {
		return [];
	}
}

function readPreset(path: string, fallbackName: string): ClaudeAgentPreset | undefined {
	try {
		const { frontmatter, body } = parseFrontmatter<ClaudeAgentFrontmatter>(readFileSync(path, "utf8"));
		if (frontmatter["user-invocable"] === false || frontmatter["user-invocable"] === "false") return undefined;
		const name = stringField(frontmatter.name) ?? fallbackName;
		if (name === "" || name.startsWith("_")) return undefined;
		const description = stringField(frontmatter.description);
		const model = stringField(frontmatter.model);
		return {
			name,
			...(description === undefined ? {} : { description }),
			...(model === undefined ? {} : { model }),
			systemPrompt: body.trim(),
		};
	} catch {
		return undefined;
	}
}

function stringField(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed === "" ? undefined : trimmed;
}
