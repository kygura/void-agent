import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { runProcessAdapter } from "../src/adapter.js";
import {
	AuthCache,
	ChildAuthAdapter,
	effectiveAuthMode,
	JsonKeychainStore,
	parseClaudeAuthStatus,
	parseCodexAuthStatus,
} from "../src/auth.js";
import {
	discoverModels,
	mergeModels,
	ProviderModelMRU,
	parseCodexModels,
	parseOpencodeModels,
	parsePiModels,
} from "../src/models.js";
import { buildClaudeArgv, buildClaudeProcessSpec, ClaudeProvider, parseClaudeLine } from "../src/providers/claude.js";
import { buildCodexArgv, buildCodexProcessSpec, CodexProvider, parseCodexLine } from "../src/providers/codex.js";
import type { GenericTemplate } from "../src/providers/generic.js";
import {
	buildGenericArgv,
	GenericProvider,
	OPENCODE_TEMPLATE,
	PI_TEMPLATE,
	validateGenericTemplate,
} from "../src/providers/generic.js";
import { ConfiguredProvider, createDefaultProviders } from "../src/providers.js";
import type { Adapter, AuthMode, Event, ProviderConfig } from "../src/types.js";

const fixtureDirectory = new URL("./fixtures/adapters/", import.meta.url);

function fixture(name: string): string {
	return fileURLToPath(new URL(name, fixtureDirectory));
}

async function fixtureLines(name: string): Promise<readonly string[]> {
	return (await readFile(fixture(name), "utf8")).trimEnd().split("\n");
}

async function collect(stream: AsyncIterable<Event>): Promise<readonly Event[]> {
	const events: Event[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

function captureError(callback: () => void): string {
	try {
		callback();
		return "";
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

describe("Provider argv builders", () => {
	test("builds exact Claude argv for new, resumed, model, effort, workdir, and hostile prompts", () => {
		const prompt = `hello"; rm -rf / $(whoami)`;
		expect(buildClaudeArgv({ provider: "claude", prompt })).toEqual([
			"claude",
			"-p",
			prompt,
			"--output-format",
			"stream-json",
			"--verbose",
			"--include-partial-messages",
		]);
		const config = {
			provider: "claude",
			prompt,
			model: "claude-opus-4",
			effort: "high" as const,
			providerSessionId: "sess-abc",
			workdir: "fixture-workdir",
			extraArgs: ["--permission-mode", "acceptEdits"],
		};
		expect(buildClaudeArgv(config)).toEqual([
			"claude",
			"-p",
			prompt,
			"--output-format",
			"stream-json",
			"--verbose",
			"--include-partial-messages",
			"--model",
			"claude-opus-4",
			"--effort",
			"high",
			"--resume",
			"sess-abc",
			"--permission-mode",
			"acceptEdits",
		]);
		expect(buildClaudeProcessSpec(config).cwd).toBe("fixture-workdir");
	});

	test("builds exact Codex argv for new, resumed, model, effort, and workdir runs", () => {
		const prompt = `literal ; && $(touch never)`;
		expect(buildCodexArgv({ provider: "codex", prompt })).toEqual(["codex", "exec", prompt, "--json"]);
		const config = {
			provider: "codex",
			prompt,
			model: "gpt-5-codex",
			effort: "medium" as const,
			providerSessionId: "codex-sess-1",
			workdir: "fixture-workdir",
			extraArgs: ["-s", "workspace-write"],
		};
		expect(buildCodexArgv(config)).toEqual([
			"codex",
			"exec",
			"resume",
			"codex-sess-1",
			prompt,
			"--json",
			"-m",
			"gpt-5-codex",
			"-c",
			'model_reasoning_effort="medium"',
			"-C",
			"fixture-workdir",
			"-s",
			"workspace-write",
		]);
		expect(buildCodexProcessSpec(config).cwd).toBeUndefined();
	});

	test("keeps generic prompts discrete and applies configured model, effort, workdir, and defaults", () => {
		const prompt = `hello"; printf injected`;
		const template: GenericTemplate = {
			name: "local",
			command: "local-agent",
			args: ["run", "{{prompt}}"],
			model: "default-model",
			modelFlag: "--model",
			effort: "low",
			effortFlag: "--effort",
			extraArgs: ["--safe"],
			workdir: "template-workdir",
		};
		const provider = new GenericProvider(template);
		expect(provider.buildArgv({ provider: "local", prompt })).toEqual([
			"local-agent",
			"run",
			prompt,
			"--model",
			"default-model",
			"--effort",
			"low",
			"--safe",
		]);
		expect(provider.buildProcessSpec({ provider: "local", prompt }).cwd).toBe("template-workdir");
		expect(
			buildGenericArgv(template, {
				provider: "local",
				prompt,
				model: "override-model",
				effort: "high",
				extraArgs: ["--run-extra"],
			}),
		).toEqual([
			"local-agent",
			"run",
			prompt,
			"--model",
			"override-model",
			"--effort",
			"high",
			"--safe",
			"--run-extra",
		]);
	});

	test("ships the exact pi and opencode generic defaults", () => {
		expect(PI_TEMPLATE).toMatchObject({
			command: "pi",
			args: ["-p", "{{prompt}}"],
			modelFlag: "--model",
			effortFlag: "--thinking",
		});
		expect(OPENCODE_TEMPLATE).toMatchObject({
			command: "opencode",
			args: ["run", "{{prompt}}"],
			modelFlag: "-m",
			effortFlag: "--variant",
		});
		expect(Object.keys(createDefaultProviders())).toEqual(["claude", "codex", "pi", "opencode"]);
	});

	test("applies configured generic extra args once before per-Run args", () => {
		const base = new GenericProvider({
			name: "local",
			command: "local",
			args: ["{{prompt}}"],
		});
		const provider = new ConfiguredProvider(
			"local",
			{ type: "generic", extraArgs: ["--configured"] },
			base,
			new AuthCache(),
		);
		const merged = provider.mergedRunConfig({
			provider: "local",
			prompt: "hello",
			extraArgs: ["--run"],
		});
		expect(base.buildArgv(merged)).toEqual(["local", "hello", "--configured", "--run"]);
	});
});

describe("structured stream Adapters", () => {
	test("normalizes the recorded Claude fixture without duplicating full assistant text", async () => {
		const events = (await fixtureLines("claude_stream.jsonl")).flatMap(parseClaudeLine);
		expect(events).toEqual([
			{ kind: "started", providerSessionId: "sess-abc" },
			{ kind: "text", text: "Hello" },
			{ kind: "text", text: " world" },
			{ kind: "text", text: "this is not json at all\n" },
			{ kind: "tool", tool: "bash", detail: '{"command":"ls"}' },
			{
				kind: "result",
				text: "Hello world",
				isError: false,
				usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.002 },
			},
		]);
		expect(events.filter((event) => event.kind === "text" && event.text === "Hello world")).toEqual([]);
	});

	test("normalizes the recorded Codex fixture", async () => {
		const events = (await fixtureLines("codex_stream.jsonl")).flatMap(parseCodexLine);
		expect(events).toEqual([
			{ kind: "started", providerSessionId: "codex-sess-1" },
			{ kind: "thinking", text: "thinking about it" },
			{ kind: "tool", tool: "exec", detail: "ls -la" },
			{ kind: "tool", tool: "exec", detail: "exit 0", done: true },
			{ kind: "text", text: "Here is the result" },
			{ kind: "text", text: "totally not json either\n" },
			{ kind: "result", text: "Here is the result" },
		]);
	});

	test("skips unknown events and degrades malformed lines to raw text", () => {
		expect(parseClaudeLine('{"type":"future-event"}')).toEqual([]);
		expect(parseCodexLine('{"type":"future-event"}')).toEqual([]);
		expect(parseClaudeLine("malformed")).toEqual([{ kind: "text", text: "malformed\n" }]);
		expect(parseCodexLine("malformed")).toEqual([{ kind: "text", text: "malformed\n" }]);
	});
});

describe("Adapter terminal invariants", () => {
	const adapter: Adapter = {
		parseLine: (line) => {
			let value: unknown;
			try {
				value = JSON.parse(line) as unknown;
			} catch {
				return [{ kind: "text", text: `${line}\n` }];
			}
			if (typeof value === "object" && value !== null && "result" in value && typeof value.result === "string") {
				return [{ kind: "result", text: value.result }];
			}
			return [];
		},
		finish: () => [],
	};

	for (const mode of ["clean-result", "duplicate-result", "resultless", "error"] as const) {
		test(`emits exactly one result and exit for ${mode}`, async () => {
			const events = await collect(
				runProcessAdapter({ spec: { argv: [process.execPath, fixture("process-provider.ts"), mode] }, adapter }),
			);
			expect(events.filter((event) => event.kind === "result").length).toBe(1);
			expect(events.filter((event) => event.kind === "exit").length).toBe(1);
			expect(events[events.length - 1]?.kind).toBe("exit");
			if (mode === "error") {
				expect(events.find((event) => event.kind === "result")?.isError).toBe(true);
				expect(events.find((event) => event.kind === "exit")?.exitCode).toBe(7);
			}
			if (mode === "duplicate-result") {
				expect(events.find((event) => event.kind === "result")?.text).toBe("first");
			}
		});
	}

	test("turns launch and parser failures into terminal Events", async () => {
		const missing = await collect(runProcessAdapter({ spec: { argv: ["/fixture/missing-provider"] }, adapter }));
		expect(missing.filter((event) => event.kind === "result").length).toBe(1);
		expect(missing.find((event) => event.kind === "result")?.isError).toBe(true);
		expect(missing[missing.length - 1]).toEqual({ kind: "exit", exitCode: -1 });

		const parserFailure = await collect(
			runProcessAdapter({
				spec: { argv: [process.execPath, fixture("process-provider.ts"), "resultless"] },
				adapter: {
					parseLine: () => {
						throw new Error("fake parser failure");
					},
					finish: () => [],
				},
			}),
		);
		expect(parserFailure.filter((event) => event.kind === "result").length).toBe(1);
		expect(parserFailure.find((event) => event.kind === "result")?.text).toBe(
			"adapter parser failed: fake parser failure",
		);
		expect(parserFailure[parserFailure.length - 1]?.kind).toBe("exit");
	});

	test("turns unsupported generic resume into a failed Run", async () => {
		const provider = new GenericProvider({ name: "local", command: "local", args: ["{{prompt}}"] });
		const events = await collect(
			provider.start({ provider: "local", prompt: "continue", providerSessionId: "prior-session" }),
		);
		expect(events).toEqual([
			{ kind: "result", text: 'provider "local" does not support resume', isError: true },
			{ kind: "exit", exitCode: -1 },
		]);
	});
});

describe("generic Provider trust boundary", () => {
	test("rejects missing, duplicate, and substring placeholders plus malformed flags, auth, and env", () => {
		const base = { name: "local", command: "local", args: ["{{prompt}}"] };
		expect(captureError(() => validateGenericTemplate({ ...base, args: ["fixed"] })).includes("exactly one")).toBe(
			true,
		);
		expect(
			captureError(() => validateGenericTemplate({ ...base, args: ["{{prompt}}", "{{prompt}}"] })).includes(
				"exactly one",
			),
		).toBe(true);
		expect(
			captureError(() => validateGenericTemplate({ ...base, args: ["--prompt={{prompt}}", "{{prompt}}"] })).includes(
				"exact argv",
			),
		).toBe(true);
		expect(
			captureError(() => validateGenericTemplate({ ...base, modelFlag: "--model value" })).includes("argv flag"),
		).toBe(true);
		expect(
			captureError(() => validateGenericTemplate({ ...base, env: ["NOT_AN_ENTRY"] })).includes("KEY=VALUE"),
		).toBe(true);
		const invalidAuth = "credential" as AuthMode;
		expect(captureError(() => validateGenericTemplate({ ...base, auth: invalidAuth })).includes("auth mode")).toBe(
			true,
		);
	});

	test("does not invoke a shell or log configured secrets", async () => {
		const calls: string[] = [];
		const originalLog = console.log;
		const originalError = console.error;
		console.log = (...values: readonly unknown[]) => calls.push(values.map(String).join(" "));
		console.error = (...values: readonly unknown[]) => calls.push(values.map(String).join(" "));
		try {
			const provider = new GenericProvider({
				name: "fake",
				command: process.execPath,
				args: [fixture("process-provider.ts"), "resultless", "{{prompt}}"],
				env: ["FIXTURE_SECRET=never-print-this"],
			});
			const events = await collect(provider.start({ provider: "fake", prompt: `$(echo never) ; "quoted"` }));
			expect(events.filter((event) => event.kind === "result").length).toBe(1);
		} finally {
			console.log = originalLog;
			console.error = originalError;
		}
		expect(calls).toEqual([]);
	});
});

describe("child authentication", () => {
	test("subscription mode removes inherited API keys from final child environments", () => {
		const previousAnthropic = process.env.ANTHROPIC_API_KEY;
		const previousOpenAi = process.env.OPENAI_API_KEY;
		process.env.ANTHROPIC_API_KEY = "fake-inherited-anthropic-key";
		process.env.OPENAI_API_KEY = "fake-inherited-openai-key";
		try {
			const cache = new AuthCache();
			const claude = new ConfiguredProvider(
				"claude",
				{ type: "claude", auth: "subscription" },
				new ClaudeProvider(),
				cache,
			);
			const codex = new ConfiguredProvider(
				"codex",
				{ type: "codex", auth: "subscription" },
				new CodexProvider(),
				cache,
			);

			expect(
				buildClaudeProcessSpec(claude.mergedRunConfig({ provider: "claude", prompt: "safe" })).env
					?.ANTHROPIC_API_KEY,
			).toBeUndefined();
			expect(
				buildCodexProcessSpec(codex.mergedRunConfig({ provider: "codex", prompt: "safe" })).env?.OPENAI_API_KEY,
			).toBeUndefined();
		} finally {
			if (previousAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
			else process.env.ANTHROPIC_API_KEY = previousAnthropic;
			if (previousOpenAi === undefined) delete process.env.OPENAI_API_KEY;
			else process.env.OPENAI_API_KEY = previousOpenAi;
		}
	});

	test("parses Claude JSON and Codex line-scoped status with negative precedence", () => {
		expect(parseClaudeAuthStatus('{"loggedIn":true,"authMethod":"claude.ai"}')).toEqual({
			loggedIn: true,
			authMethod: "claude.ai",
			subscribed: true,
		});
		expect(parseClaudeAuthStatus("not-json")).toEqual({ loggedIn: false });
		expect(parseCodexAuthStatus("update at chatgpt.com\nLogged in using API key")).toEqual({
			loggedIn: true,
			authMethod: "apikey",
			subscribed: false,
		});
		expect(parseCodexAuthStatus("Logged in using ChatGPT\nYou are not logged in with ChatGPT")).toEqual({
			loggedIn: false,
		});
	});

	test("captures Codex status from stderr and uses fake-only login argv", async () => {
		const calls: readonly string[][] = [];
		const mutableCalls = calls as string[][];
		const adapter = new ChildAuthAdapter("codex", {
			run: async (argv) => {
				mutableCalls.push([...argv]);
				return { stdout: "", stderr: "Logged in using ChatGPT", exitCode: 0 };
			},
			startLogin: async (kind, argv) => {
				mutableCalls.push([kind, ...argv]);
				return { started: true, message: "fake flow" };
			},
		});
		expect(await adapter.status()).toEqual({ loggedIn: true, authMethod: "chatgpt", subscribed: true });
		expect(await adapter.login()).toEqual({ started: true, message: "fake flow" });
		expect(calls).toEqual([
			["codex", "login", "status"],
			["codex", "codex", "login", "--device-auth"],
		]);
	});

	test("caches by Provider alias and resolves explicit/automatic auth modes", () => {
		const cache = new AuthCache();
		expect(cache.get("alias")).toBeUndefined();
		cache.set("alias", { loggedIn: true, subscribed: true });
		expect(cache.getOr("alias")).toEqual({ loggedIn: true, subscribed: true });
		expect(effectiveAuthMode("auto", cache.getOr("alias"))).toBe("subscription");
		expect(effectiveAuthMode("api", cache.getOr("alias"))).toBe("api");
	});

	test("updates fake keychain JSON without truncating or exposing credentials", async () => {
		let stored = JSON.stringify({ preserved: true, token: "fake-existing" });
		const store = new JsonKeychainStore(
			{
				read: async () => stored,
				write: async (_service, _account, value) => {
					stored = value;
				},
				delete: async () => {
					stored = "";
				},
			},
			"Fixture Service",
			"fixture-account",
		);
		await store.update((current) => ({ ...current, token: "x".repeat(12_000) }));
		const parsed = JSON.parse(stored) as Record<string, unknown>;
		expect(parsed.preserved).toBe(true);
		expect(typeof parsed.token === "string" ? parsed.token.length : 0).toBe(12_000);
	});
});

describe("model discovery and bounded per-Provider MRU", () => {
	test("parses each CLI format and merges deterministically", () => {
		expect(
			parseCodexModels(
				'{"models":[{"slug":"b","visibility":"list"},{"slug":"hidden","visibility":"hide"},{"slug":"a","visibility":"list"}]}',
			),
		).toEqual(["b", "a"]);
		expect(parseOpencodeModels("openai/gpt\nwarning line\nanthropic/claude\n")).toEqual([
			"openai/gpt",
			"anthropic/claude",
		]);
		expect(
			parsePiModels("provider model context\nanthropic claude 200K\nError: ignored\ngoogle gemini 1M\n"),
		).toEqual(["anthropic/claude", "google/gemini"]);
		expect(mergeModels(["configured", "shared"], ["shared", "discovered"])).toEqual([
			"configured",
			"shared",
			"discovered",
		]);
	});

	test("uses exact discovery argv and the correct output stream", async () => {
		const calls: string[][] = [];
		const run = async (argv: readonly string[]) => {
			calls.push([...argv]);
			if (argv[0] === "codex") {
				return { stdout: '{"models":[{"slug":"codex-model","visibility":"list"}]}', stderr: "", exitCode: 0 };
			}
			if (argv[0] === "pi") return { stdout: "", stderr: "provider model\nanthropic claude\n", exitCode: 0 };
			return { stdout: "openai/gpt\n", stderr: "", exitCode: 0 };
		};
		const codex: ProviderConfig = { type: "codex", models: ["configured"] };
		const pi: ProviderConfig = { type: "generic", command: "pi", args: ["{{prompt}}"] };
		const opencode: ProviderConfig = { type: "generic", command: "opencode", args: ["{{prompt}}"] };
		expect(await discoverModels(codex, { run })).toEqual(["configured", "codex-model"]);
		expect(await discoverModels(pi, { run })).toEqual(["anthropic/claude"]);
		expect(await discoverModels(opencode, { run })).toEqual(["openai/gpt"]);
		expect(calls).toEqual([
			["codex", "debug", "models"],
			["pi", "--no-extensions", "--list-models"],
			["opencode", "models"],
		]);
	});

	test("deduplicates and caps each Provider independently", () => {
		const recent = new ProviderModelMRU(2);
		recent.remember("claude", "a");
		recent.remember("claude", "b");
		recent.remember("claude", "a");
		recent.remember("claude", "c");
		recent.remember("codex", "x");
		expect(recent.list("claude")).toEqual(["c", "a"]);
		expect(recent.list("codex")).toEqual(["x"]);
	});
});
