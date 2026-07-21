import type { Event } from "@void/orchestrator";
import type { AutocompleteItem } from "@void/tui";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionFactory } from "../extensions/index.js";
import { parseCommandArgs } from "../prompt-templates.js";
import type { ClaudeAgentPreset } from "./claude-agent-presets.js";
import type { ProcessLifetimeOrchestrationHost } from "./host.js";
import {
	isVoidSpawnMessageDetails,
	isVoidSpawnState,
	VOID_SPAWN_CUSTOM_TYPE,
	VOID_SPAWN_STATE_CUSTOM_TYPE,
} from "./messages.js";
import { createVoidSpawnRenderer } from "./spawn-entry.js";
import { getOrchestrationUiController, setActiveOrchestrationHost } from "./ui-bridge.js";

const EFFORTS = ["default", "low", "medium", "high"] as const;

export interface OrchestrationExtensionOptions {
	cwd?: string;
}

export function createOrchestrationExtension(
	host: ProcessLifetimeOrchestrationHost,
	options: OrchestrationExtensionOptions = {},
): ExtensionFactory {
	setActiveOrchestrationHost(host);
	return (pi: ExtensionAPI): void => {
		let uiSubscription: { unsubscribe(): void } | undefined;
		const pendingProviders = new Map<string, string>();
		pi.registerMessageRenderer(VOID_SPAWN_CUSTOM_TYPE, createVoidSpawnRenderer(host));

		pi.on("session_start", async (_event, ctx) => {
			uiSubscription?.unsubscribe();
			const entries = ctx.sessionManager.getEntries();
			await host.attachParent(ctx.sessionManager.getSessionId(), {
				childSessionIds: entries.flatMap((entry) =>
					entry.type === "custom_message" &&
					entry.customType === VOID_SPAWN_CUSTOM_TYPE &&
					isVoidSpawnMessageDetails(entry.details)
						? [entry.details.childSessionId]
						: [],
				),
				states: entries.flatMap((entry) =>
					entry.type === "custom" &&
					entry.customType === VOID_SPAWN_STATE_CUSTOM_TYPE &&
					isVoidSpawnState(entry.data)
						? [entry.data]
						: [],
				),
				sendSpawn: (childSessionId) => {
					pi.sendMessage(
						{
							customType: VOID_SPAWN_CUSTOM_TYPE,
							content: childSessionId,
							display: true,
							details: { childSessionId },
						},
						{ triggerTurn: false },
					);
				},
				appendState: (state) => pi.appendEntry(VOID_SPAWN_STATE_CUSTOM_TYPE, state),
			});
			uiSubscription = host.subscribe((event) => {
				getOrchestrationUiController()?.requestRender();
				if (
					event.lifecycle !== true ||
					(event.state !== "done" && event.state !== "failed" && event.state !== "cancelled")
				) {
					return;
				}
				const run = host.snapshot().runs.find((item) => item.id === event.runId);
				if (run === undefined || run.id === getOrchestrationUiController()?.focusedRunId()) return;
				const child =
					run.sessionId === undefined
						? undefined
						: host.snapshot().sessions.find((item) => item.id === run.sessionId);
				const name = child?.name ?? run.name ?? run.provider;
				const elapsed = Math.max(0, Date.parse(run.endedAt ?? run.startedAt) - Date.parse(run.startedAt));
				const seconds = Math.max(0, Math.floor(elapsed / 1000));
				if (event.state === "done") ctx.ui.notify(`✓ ${name} finished · ${seconds}s`, "info");
				else if (event.state === "failed") {
					const detail = notificationDetail(host.runEvents(run.id));
					ctx.ui.notify(
						`✗ ${name} failed${detail === undefined ? "" : ` · ${detail}`} · /agents to view`,
						"error",
					);
				} else ctx.ui.notify(`⊘ ${name} cancelled · ${seconds}s`, "info");
			});
		});

		pi.on("session_shutdown", () => {
			uiSubscription?.unsubscribe();
			uiSubscription = undefined;
		});

		pi.registerCommand("spawn", {
			description: "Spawn one or more child Sessions",
			getArgumentCompletions: (prefix) => spawnCompletions(host, options.cwd, prefix),
			handler: async (args, ctx) => {
				const parsed = parseSpawnArguments(args);
				if (!parsed.ok) return reportError(ctx, parsed.error);
				await runCommand(ctx, () => {
					const preset =
						parsed.value.preset === undefined ? undefined : findPreset(host, ctx.cwd, parsed.value.preset);
					host.spawn({
						parentSessionId: ctx.sessionManager.getSessionId(),
						provider: parsed.value.provider,
						prompt: parsed.value.prompt,
						workdir: ctx.cwd,
						count: parsed.value.count,
						...(preset === undefined ? {} : { preset }),
					});
					const parentId = ctx.sessionManager.getSessionId();
					const committed = pendingProviders.get(parentId);
					if (committed !== undefined) {
						pendingProviders.delete(parentId);
						ctx.ui.notify(`provider → ${committed} · next run starts fresh`, "info");
					}
				});
			},
		});

		pi.registerCommand("run", {
			description: "Start process-lifetime background work",
			getArgumentCompletions: (prefix) => firstArgumentCompletions(host.providerNames(), prefix),
			handler: async (args, ctx) => {
				const parsed = parsePromptCommand(args, "usage: /run <provider> <prompt>");
				if (!parsed.ok) return reportError(ctx, parsed.error);
				await runCommand(ctx, () =>
					host.startTask(ctx.sessionManager.getSessionId(), parsed.value.first, parsed.value.prompt, ctx.cwd),
				);
			},
		});

		pi.registerCommand("agent-resume", {
			description: "Resume a child Session",
			getArgumentCompletions: (prefix) => firstArgumentCompletions(host.childSessionIds(), prefix),
			handler: async (args, ctx) => {
				const parsed = parsePromptCommand(args, "usage: /agent-resume <session-id> <prompt>");
				if (!parsed.ok) return reportError(ctx, parsed.error);
				await runCommand(ctx, () =>
					host.resume(ctx.sessionManager.getSessionId(), parsed.value.first, parsed.value.prompt),
				);
			},
		});

		pi.registerCommand("provider", {
			description: "Show or select the child Provider",
			getArgumentCompletions: (prefix) => firstArgumentCompletions(host.providerNames(), prefix),
			handler: async (args, ctx) => {
				const parsed = parseOptionalArgument(args, "usage: /provider [name]");
				if (!parsed.ok) return reportError(ctx, parsed.error);
				let provider = parsed.value;
				if (provider === undefined) provider = await ctx.ui.select("provider", [...host.providerNames()]);
				if (provider === undefined) return;
				await runCommand(ctx, () => {
					host.selectProvider(ctx.sessionManager.getSessionId(), provider!, ctx.cwd);
					pendingProviders.set(ctx.sessionManager.getSessionId(), provider!);
				});
			},
		});

		pi.registerCommand("agents", {
			description: "Show child Sessions, TaskRuns, and direct agent runs",
			handler: async (args, ctx) => {
				if (args.trim() !== "") return reportError(ctx, "usage: /agents");
				const controller = getOrchestrationUiController();
				if (controller === undefined) return reportError(ctx, "agents view is available only in interactive mode");
				controller.openAgents();
			},
		});

		pi.registerCommand("cancel", {
			description: "Cancel a live child Run",
			getArgumentCompletions: (prefix) => firstArgumentCompletions(host.cancellableIds(), prefix),
			handler: async (args, ctx) => {
				const parsed = parseRequiredArgument(args, "usage: /cancel <run-id-or-session-id>");
				if (!parsed.ok) return reportError(ctx, parsed.error);
				await runCommand(ctx, () => {
					if (!host.cancel(parsed.value)) throw new Error(`no live Run matches ${JSON.stringify(parsed.value)}`);
				});
			},
		});

		pi.registerCommand("login", {
			description: "Inspect or start child CLI login",
			getArgumentCompletions: (prefix) => firstArgumentCompletions(host.providerNames(), prefix),
			handler: async (args, ctx) => {
				const parsed = parseOptionalArgument(args, "usage: /login [provider]");
				if (!parsed.ok) return reportError(ctx, parsed.error);
				await runCommand(ctx, async () => {
					const provider = parsed.value ?? host.defaultProvider(ctx.sessionManager.getSessionId());
					const result = await host.login(provider);
					const message = result.status.loggedIn
						? `${provider}: logged in${result.status.authMethod ? ` via ${result.status.authMethod}` : ""}`
						: result.login?.started
							? `${provider}: login started`
							: `${provider}: ${result.login?.message ?? "not logged in"}`;
					ctx.ui.notify(message, result.status.loggedIn || result.login?.started ? "info" : "error");
				});
			},
		});

		pi.registerCommand("agent-model", {
			description: "Show or arm a model for the next child Run",
			getArgumentCompletions: (prefix) => modelCompletions(host, prefix),
			handler: async (args, ctx) => {
				const parsed = parseUpToTwoArguments(args, "usage: /agent-model [provider] [model]");
				if (!parsed.ok) return reportError(ctx, parsed.error);
				await runCommand(ctx, async () => {
					const parentId = ctx.sessionManager.getSessionId();
					const provider = parsed.value.first ?? host.defaultProvider(parentId);
					if (parsed.value.second === undefined) {
						const armed = host.armedModel(parentId, provider);
						const models = await host.availableModels(provider);
						ctx.ui.notify(
							armed === undefined
								? `${provider} models: ${models.join(", ") || "none discovered"}`
								: `${provider} next model: ${armed}`,
							"info",
						);
						return;
					}
					host.armModel(parentId, provider, parsed.value.second);
				});
			},
		});

		pi.registerCommand("agent-effort", {
			description: "Show or arm effort for the next child Run",
			getArgumentCompletions: (prefix) => firstArgumentCompletions(EFFORTS, prefix),
			handler: async (args, ctx) => {
				const parsed = parseOptionalArgument(args, "usage: /agent-effort [default|low|medium|high]");
				if (!parsed.ok) return reportError(ctx, parsed.error);
				const parentId = ctx.sessionManager.getSessionId();
				if (parsed.value === undefined) {
					ctx.ui.notify(`next child effort: ${host.armedEffort(parentId) ?? "default"}`, "info");
					return;
				}
				if (!isEffort(parsed.value)) {
					return reportError(ctx, "effort must be default, low, medium, or high");
				}
				host.armEffort(parentId, parsed.value === "default" ? undefined : parsed.value);
			},
		});
	};
}

type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

interface SpawnArguments {
	provider: string;
	prompt: string;
	count: number;
	preset?: string;
}

function parseSpawnArguments(input: string): ParseResult<SpawnArguments> {
	const tokenized = validatedArguments(input);
	if (!tokenized.ok) return tokenized;
	const tokens = tokenized.value;
	let provider: string | undefined;
	let count = 1;
	let preset: string | undefined;
	let countSeen = false;
	let presetSeen = false;
	let index = 0;
	for (; index < tokens.length; index++) {
		const token = tokens[index];
		if (token === "--") {
			index++;
			break;
		}
		if (token === "--count") {
			if (countSeen || tokens[index + 1] === undefined) return { ok: false, error: "--count requires one value" };
			countSeen = true;
			const raw = tokens[++index];
			if (!/^[1-8]$/.test(raw)) return { ok: false, error: "count must be an integer from 1 through 8" };
			count = Number(raw);
			continue;
		}
		if (token === "--preset") {
			if (presetSeen || tokens[index + 1] === undefined) return { ok: false, error: "--preset requires one value" };
			presetSeen = true;
			preset = tokens[++index];
			continue;
		}
		if (token.startsWith("--")) return { ok: false, error: `unknown option ${JSON.stringify(token)}` };
		if (provider === undefined) {
			provider = token;
			continue;
		}
		break;
	}
	const prompt = tokens.slice(index).join(" ").trim();
	if (provider === undefined || prompt === "") {
		return { ok: false, error: "usage: /spawn [--preset name] [--count 1-8] <provider> <prompt>" };
	}
	return { ok: true, value: { provider, prompt, count, ...(preset === undefined ? {} : { preset }) } };
}

function parsePromptCommand(input: string, usage: string): ParseResult<{ first: string; prompt: string }> {
	const tokenized = validatedArguments(input);
	if (!tokenized.ok) return tokenized;
	const [first, ...rest] = tokenized.value;
	const prompt = rest.join(" ").trim();
	return first === undefined || prompt === "" ? { ok: false, error: usage } : { ok: true, value: { first, prompt } };
}

function parseRequiredArgument(input: string, usage: string): ParseResult<string> {
	const tokenized = validatedArguments(input);
	if (!tokenized.ok) return tokenized;
	const tokens = tokenized.value;
	return tokens.length === 1 ? { ok: true, value: tokens[0] } : { ok: false, error: usage };
}

function parseOptionalArgument(input: string, usage: string): ParseResult<string | undefined> {
	const tokenized = validatedArguments(input);
	if (!tokenized.ok) return tokenized;
	const tokens = tokenized.value;
	return tokens.length <= 1 ? { ok: true, value: tokens[0] } : { ok: false, error: usage };
}

function parseUpToTwoArguments(input: string, usage: string): ParseResult<{ first?: string; second?: string }> {
	const tokenized = validatedArguments(input);
	if (!tokenized.ok) return tokenized;
	const tokens = tokenized.value;
	return tokens.length <= 2
		? {
				ok: true,
				value: {
					...(tokens[0] === undefined ? {} : { first: tokens[0] }),
					...(tokens[1] === undefined ? {} : { second: tokens[1] }),
				},
			}
		: { ok: false, error: usage };
}

function firstArgumentCompletions(values: readonly string[], prefix: string): AutocompleteItem[] | null {
	const tokens = prefix.trimStart().split(/\s+/);
	if (tokens.length > 1) return null;
	const partial = tokens[0] ?? "";
	const matches = values.filter((value) => value.startsWith(partial)).map(completion);
	return matches.length === 0 ? null : matches;
}

function validatedArguments(input: string): ParseResult<string[]> {
	if (input.includes("\0")) return { ok: false, error: "arguments must not contain NUL" };
	let quote: "'" | '"' | undefined;
	for (const character of input) {
		if (quote === undefined && (character === "'" || character === '"')) quote = character;
		else if (character === quote) quote = undefined;
	}
	if (quote !== undefined) return { ok: false, error: "unterminated quoted argument" };
	return { ok: true, value: parseCommandArgs(input) };
}

function spawnCompletions(
	host: ProcessLifetimeOrchestrationHost,
	cwd: string | undefined,
	prefix: string,
): AutocompleteItem[] | null {
	const trimmed = prefix.trimStart();
	const tokens = trimmed === "" ? [""] : trimmed.split(/\s+/);
	const partial = prefix.endsWith(" ") ? "" : (tokens.pop() ?? "");
	if (tokens.at(-1) === "--preset") {
		const matches = host.presets(cwd ?? process.cwd()).filter((preset) => preset.name.startsWith(partial));
		return matches.length === 0
			? null
			: matches.map((preset) => ({ value: preset.name, label: preset.name, description: preset.description }));
	}
	if (tokens.length === 0 && !partial.startsWith("--")) return firstArgumentCompletions(host.providerNames(), partial);
	const values = ["--count", "--preset"].filter((value) => value.startsWith(partial));
	return values.length === 0 ? null : values.map(completion);
}

function modelCompletions(host: ProcessLifetimeOrchestrationHost, prefix: string): AutocompleteItem[] | null {
	const tokens = prefix.trimStart().split(/\s+/);
	if (tokens.length <= 1 && !prefix.endsWith(" "))
		return firstArgumentCompletions(host.providerNames(), tokens[0] ?? "");
	const provider = tokens[0];
	if (provider === undefined || host.providerConfig(provider) === undefined) return null;
	const partial = prefix.endsWith(" ") ? "" : (tokens[1] ?? "");
	const matches = host.configuredModels(provider).filter((model) => model.startsWith(partial));
	return matches.length === 0 ? null : matches.map(completion);
}

function completion(value: string): AutocompleteItem {
	return { value, label: value };
}

function isEffort(value: string): value is (typeof EFFORTS)[number] {
	return EFFORTS.some((effort) => effort === value);
}

function notificationDetail(events: readonly Event[]): string | undefined {
	const event = [...events].reverse().find((item) => item.kind !== "exit" && item.kind !== "started");
	if (event === undefined) return undefined;
	if (event.kind === "tool") return event.detail ?? event.tool;
	return event.text;
}

function findPreset(host: ProcessLifetimeOrchestrationHost, cwd: string, name: string): ClaudeAgentPreset {
	const preset = host.presets(cwd).find((candidate) => candidate.name === name);
	if (preset === undefined) throw new Error(`unknown Claude agent preset ${JSON.stringify(name)}`);
	return preset;
}

async function runCommand(ctx: ExtensionCommandContext, action: () => unknown | Promise<unknown>): Promise<void> {
	try {
		await action();
	} catch (error) {
		reportError(ctx, error instanceof Error ? error.message : String(error));
	}
}

function reportError(ctx: ExtensionCommandContext, message: string): void {
	ctx.ui.notify(message, "error");
}
