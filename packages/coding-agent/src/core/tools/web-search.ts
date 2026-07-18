import { type Static, Type } from "@sinclair/typebox";
import type { AgentTool } from "@void/agent";
import { getEnvApiKey } from "@void/ai";
import { Text } from "@void/tui";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.js";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.js";
import { getTextOutput, invalidArgText, str } from "./render-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult, truncateHead } from "./truncate.js";

const webSearchSchema = Type.Object({
	query: Type.String({ description: "The search query" }),
});

export type WebSearchToolInput = Static<typeof webSearchSchema>;

export interface WebSearchToolDetails {
	resultCount?: number;
	truncation?: TruncationResult;
}

export interface WebSearchResult {
	title: string;
	url: string;
}

/**
 * Pluggable search operation for the web_search tool.
 * Override this to delegate to a different search backend, or to mock the network in tests.
 */
export interface WebSearchOperations {
	/** Perform the search. Resolves to an empty array for no results, throws on failure. */
	search: (query: string, signal?: AbortSignal) => Promise<WebSearchResult[]>;
}

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const SEARCH_MODEL = "claude-haiku-4-5";

/** Default search backend: routes through Anthropic's hosted web_search server tool. */
async function anthropicWebSearch(query: string, signal?: AbortSignal): Promise<WebSearchResult[]> {
	const apiKey = getEnvApiKey("anthropic");
	if (!apiKey) {
		throw new Error("Web search requires an Anthropic API key. Set ANTHROPIC_API_KEY or log in.");
	}

	let response: Response;
	try {
		response = await fetch(ANTHROPIC_MESSAGES_URL, {
			method: "POST",
			headers: {
				"x-api-key": apiKey,
				"anthropic-version": ANTHROPIC_VERSION,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				model: SEARCH_MODEL,
				max_tokens: 1024,
				tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 1 }],
				tool_choice: { type: "tool", name: "web_search" },
				messages: [{ role: "user", content: query }],
			}),
			signal,
		});
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") {
			throw new Error("Operation aborted");
		}
		throw new Error(`Web search request failed: ${error instanceof Error ? error.message : String(error)}`);
	}

	if (response.status === 429) {
		throw new Error("Web search was rate limited. Try again later.");
	}
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(`Web search failed with status ${response.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
	}

	const data = (await response.json()) as { content?: Array<Record<string, any>> };
	const resultBlock = data.content?.find((block) => block?.type === "web_search_tool_result");
	if (!resultBlock) return [];

	const blockContent = resultBlock.content;
	if (!Array.isArray(blockContent)) {
		// Server tool declined with an error object, e.g. { error_code: "max_uses_exceeded" }.
		const errorCode = blockContent?.error_code ?? "unknown_error";
		throw new Error(`Web search failed: ${errorCode}`);
	}

	return blockContent.map((r: any) => ({
		title: typeof r.title === "string" ? r.title : "",
		url: typeof r.url === "string" ? r.url : "",
	}));
}

const defaultWebSearchOperations: WebSearchOperations = { search: anthropicWebSearch };

export interface WebSearchToolOptions {
	/** Custom search operations. Default: Anthropic's hosted web_search server tool. */
	operations?: WebSearchOperations;
}

function formatWebSearchCall(
	args: { query?: string } | undefined,
	theme: typeof import("../../modes/interactive/theme/theme.js").theme,
): string {
	const query = str(args?.query);
	const invalidArg = invalidArgText(theme);
	return `${theme.fg("toolTitle", theme.bold("web_search"))} ${query === null ? invalidArg : theme.fg("accent", query || "")}`;
}

function formatWebSearchResult(
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: WebSearchToolDetails;
	},
	options: ToolRenderResultOptions,
	theme: typeof import("../../modes/interactive/theme/theme.js").theme,
	showImages: boolean,
): string {
	const output = getTextOutput(result, showImages).trim();
	let text = "";
	if (output) {
		const lines = output.split("\n");
		const maxLines = options.expanded ? lines.length : 15;
		const displayLines = lines.slice(0, maxLines);
		const remaining = lines.length - maxLines;
		text += `\n${displayLines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
		if (remaining > 0) {
			text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")})`;
		}
	}

	if (result.details?.truncation?.truncated) {
		text += `\n${theme.fg("warning", `[Truncated: ${formatSize(DEFAULT_MAX_BYTES)} limit]`)}`;
	}
	return text;
}

export function createWebSearchToolDefinition(
	_cwd: string,
	options?: WebSearchToolOptions,
): ToolDefinition<typeof webSearchSchema, WebSearchToolDetails | undefined> {
	const ops = options?.operations ?? defaultWebSearchOperations;
	return {
		name: "web_search",
		label: "web search",
		description: `Search the web for current information. Returns matching pages with titles and URLs. Use this for questions about current events, recent releases, or anything outside your training data. Output is truncated to ${DEFAULT_MAX_BYTES / 1024}KB.`,
		promptSnippet: "Search the web for current information",
		parameters: webSearchSchema,
		async execute(_toolCallId, { query }: { query: string }, signal?: AbortSignal, _onUpdate?, _ctx?) {
			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}

			const results = await ops.search(query, signal);
			if (results.length === 0) {
				return {
					content: [{ type: "text" as const, text: `No results found for query: ${query}` }],
					details: undefined,
				};
			}

			const rawOutput = results.map((r, i) => `${i + 1}. ${r.title || "(untitled)"}\n   ${r.url}`).join("\n\n");
			const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
			let outputText = truncation.content;
			const details: WebSearchToolDetails = { resultCount: results.length };
			if (truncation.truncated) {
				outputText += `\n\n[${formatSize(DEFAULT_MAX_BYTES)} limit reached]`;
				details.truncation = truncation;
			}
			return { content: [{ type: "text" as const, text: outputText }], details };
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatWebSearchCall(args, theme));
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatWebSearchResult(result as any, options, theme, context.showImages));
			return text;
		},
	};
}

export function createWebSearchTool(cwd: string, options?: WebSearchToolOptions): AgentTool<typeof webSearchSchema> {
	return wrapToolDefinition(createWebSearchToolDefinition(cwd, options));
}

/** Default web_search tool using process.cwd() for backwards compatibility. */
export const webSearchToolDefinition = createWebSearchToolDefinition(process.cwd());
export const webSearchTool = createWebSearchTool(process.cwd());
