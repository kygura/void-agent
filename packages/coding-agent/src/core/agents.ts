/**
 * Subagent definitions: markdown files with YAML frontmatter whose body is
 * used verbatim as the child agent's system prompt (Claude Code agent file
 * compatible).
 */

import { type Dirent, existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentsDir } from "../config.js";
import { parseFrontmatter } from "../utils/frontmatter.js";

export interface AgentDefinition {
	/** Spawn key (kebab-case), from frontmatter "name". */
	name: string;
	/** When to use this agent, shown to the orchestrating model. */
	description: string;
	/** Built-in tool names to allow. Undefined = all coding tools. */
	tools?: string[];
	/** Model id for the child. Undefined = parent's model. */
	model?: string;
	/** Harness id: "void" (default, in-process) | "claude" | "codex" | a registered generic harness id. */
	harness: string;
	/** Markdown body, used verbatim as the child's system prompt. */
	systemPrompt: string;
	/** Source file this definition was loaded from. */
	filePath: string;
}

interface AgentFrontmatter {
	name?: string;
	description?: string;
	tools?: string | string[];
	model?: string;
	harness?: string;
	[key: string]: unknown;
}

function parseToolsField(tools: string | string[] | undefined): string[] | undefined {
	if (tools === undefined) return undefined;
	const list = Array.isArray(tools) ? tools : tools.split(",");
	const names = list.map((t) => String(t).trim()).filter(Boolean);
	return names.length > 0 ? names : undefined;
}

function loadAgentsFromDir(dir: string): AgentDefinition[] {
	if (!existsSync(dir)) return [];

	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}

	const defs: AgentDefinition[] = [];
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
		const filePath = join(dir, entry.name);
		try {
			const raw = readFileSync(filePath, "utf-8");
			const { frontmatter, body } = parseFrontmatter<AgentFrontmatter>(raw);
			if (!frontmatter.name || !frontmatter.description) {
				console.warn(`agent: skipping "${filePath}": frontmatter requires "name" and "description"`);
				continue;
			}
			defs.push({
				name: frontmatter.name,
				description: frontmatter.description,
				tools: parseToolsField(frontmatter.tools),
				model: frontmatter.model,
				harness: frontmatter.harness || "void",
				systemPrompt: body.trim(),
				filePath,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : "failed to parse agent file";
			console.warn(`agent: skipping "${filePath}": ${message}`);
		}
	}
	return defs;
}

/**
 * Discover agent definitions from the four standard locations. Later
 * locations win on name collision:
 * 1. ~/.claude/agents/*.md (compat with existing Claude Code agent files)
 * 2. ~/.void/agents/*.md
 * 3. <cwd>/.claude/agents/*.md
 * 4. <cwd>/.void/agents/*.md
 */
export function discoverAgents(cwd: string = process.cwd()): AgentDefinition[] {
	const dirs = [
		join(homedir(), ".claude", "agents"),
		getAgentsDir(),
		join(cwd, ".claude", "agents"),
		join(cwd, CONFIG_DIR_NAME, "agents"),
	];

	const byName = new Map<string, AgentDefinition>();
	for (const dir of dirs) {
		for (const def of loadAgentsFromDir(dir)) {
			byName.set(def.name, def); // later source wins
		}
	}
	return Array.from(byName.values());
}
