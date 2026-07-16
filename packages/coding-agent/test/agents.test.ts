import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";
import { discoverAgents } from "../src/core/agents.js";

function writeAgentFile(dir: string, fileName: string, content: string): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, fileName), content);
}

describe("discoverAgents", () => {
	let tempDir: string;
	let homeDir: string;
	let agentDir: string;
	let cwd: string;
	let originalAgentDir: string | undefined;
	let originalHome: string | undefined;
	let warnSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		tempDir = join(tmpdir(), `void-agents-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		homeDir = join(tempDir, "home");
		agentDir = join(tempDir, "void-agent-dir");
		cwd = join(tempDir, "project");
		mkdirSync(homeDir, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });

		originalAgentDir = process.env[ENV_AGENT_DIR];
		originalHome = process.env.HOME;
		process.env[ENV_AGENT_DIR] = agentDir;
		process.env.HOME = homeDir;

		warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		if (originalAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = originalAgentDir;
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		warnSpy.mockRestore();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("returns an empty list when no agent directories exist", () => {
		expect(discoverAgents(cwd)).toEqual([]);
	});

	it("loads a well-formed agent definition", () => {
		writeAgentFile(
			join(cwd, ".claude", "agents"),
			"reviewer.md",
			[
				"---",
				"name: reviewer",
				"description: Reviews code for correctness.",
				"tools: read, grep",
				"model: claude-opus-4-6",
				"harness: claude",
				"---",
				"You are a careful code reviewer.",
			].join("\n"),
		);

		const defs = discoverAgents(cwd);
		expect(defs).toHaveLength(1);
		expect(defs[0]).toMatchObject({
			name: "reviewer",
			description: "Reviews code for correctness.",
			tools: ["read", "grep"],
			model: "claude-opus-4-6",
			harness: "claude",
			systemPrompt: "You are a careful code reviewer.",
		});
	});

	it("defaults harness to 'void' and tools to undefined when absent", () => {
		writeAgentFile(
			join(cwd, ".claude", "agents"),
			"general.md",
			["---", "name: general", "description: A general helper.", "---", "Be helpful."].join("\n"),
		);

		const [def] = discoverAgents(cwd);
		expect(def.harness).toBe("void");
		expect(def.tools).toBeUndefined();
	});

	it("parses a tools array as well as a comma-separated string", () => {
		writeAgentFile(
			join(cwd, ".claude", "agents"),
			"array-tools.md",
			[
				"---",
				"name: array-tools",
				"description: uses array tools",
				"tools: [read, bash, edit]",
				"---",
				"Body.",
			].join("\n"),
		);

		const [def] = discoverAgents(cwd);
		expect(def.tools).toEqual(["read", "bash", "edit"]);
	});

	it("skips and warns on a file missing required frontmatter", () => {
		writeAgentFile(
			join(cwd, ".claude", "agents"),
			"broken.md",
			["---", "description: missing a name", "---", "Body."].join("\n"),
		);

		expect(discoverAgents(cwd)).toEqual([]);
		expect(warnSpy).toHaveBeenCalled();
	});

	it("skips and warns on invalid YAML frontmatter", () => {
		writeAgentFile(
			join(cwd, ".claude", "agents"),
			"invalid.md",
			["---", "name: [unterminated", "---", "Body."].join("\n"),
		);

		expect(discoverAgents(cwd)).toEqual([]);
		expect(warnSpy).toHaveBeenCalled();
	});

	it("applies later-wins precedence across the four discovery tiers", () => {
		writeAgentFile(
			join(homeDir, ".claude", "agents"),
			"shared.md",
			["---", "name: shared", "description: from ~/.claude", "---", "tier1"].join("\n"),
		);
		writeAgentFile(
			join(agentDir, "agents"),
			"shared.md",
			["---", "name: shared", "description: from ~/.void/agents", "---", "tier2"].join("\n"),
		);
		writeAgentFile(
			join(cwd, ".claude", "agents"),
			"shared.md",
			["---", "name: shared", "description: from cwd/.claude/agents", "---", "tier3"].join("\n"),
		);
		writeAgentFile(
			join(cwd, ".void", "agents"),
			"shared.md",
			["---", "name: shared", "description: from cwd/.void/agents", "---", "tier4"].join("\n"),
		);

		const defs = discoverAgents(cwd);
		expect(defs).toHaveLength(1);
		expect(defs[0].description).toBe("from cwd/.void/agents");
		expect(defs[0].systemPrompt).toBe("tier4");
	});

	it("keeps distinct names from different tiers", () => {
		writeAgentFile(
			join(homeDir, ".claude", "agents"),
			"a.md",
			["---", "name: a", "description: from home", "---", "body"].join("\n"),
		);
		writeAgentFile(
			join(cwd, ".void", "agents"),
			"b.md",
			["---", "name: b", "description: from project", "---", "body"].join("\n"),
		);

		const names = discoverAgents(cwd)
			.map((d) => d.name)
			.sort();
		expect(names).toEqual(["a", "b"]);
	});
});
