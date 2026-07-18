import { describe, expect, it } from "vitest";
import { resolveAgentTools } from "../src/core/tools/subagent.js";
import { createWebSearchTool, type WebSearchOperations } from "../src/core/tools/web-search.js";

function getTextOutput(result: any): string {
	return (
		result.content
			?.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("\n") || ""
	);
}

describe("web_search tool", () => {
	it("resolves by name (WebSearch and web_search, case-insensitive)", () => {
		const tools = resolveAgentTools(process.cwd(), ["WebSearch", "web_search", "WEBSEARCH"]);
		expect(tools.map((t) => t.name)).toEqual(["web_search", "web_search", "web_search"]);
	});

	it("returns a clean result when the search finds nothing, instead of throwing", async () => {
		const operations: WebSearchOperations = {
			search: async () => [],
		};
		const tool = createWebSearchTool(process.cwd(), { operations });

		const result = await tool.execute("call-1", { query: "something that does not exist" });

		expect(getTextOutput(result)).toContain("No results found");
		expect(result.details).toBeUndefined();
	});

	it("degrades to a clean rejection on network failure, instead of an unhandled throw", async () => {
		const operations: WebSearchOperations = {
			search: async () => {
				throw new Error("Web search request failed: fetch failed");
			},
		};
		const tool = createWebSearchTool(process.cwd(), { operations });

		await expect(tool.execute("call-2", { query: "anything" })).rejects.toThrow(/Web search request failed/);
	});

	it("formats successful results with title and url", async () => {
		const operations: WebSearchOperations = {
			search: async () => [{ title: "Example Domain", url: "https://example.com" }],
		};
		const tool = createWebSearchTool(process.cwd(), { operations });

		const result = await tool.execute("call-3", { query: "example" });
		const output = getTextOutput(result);

		expect(output).toContain("Example Domain");
		expect(output).toContain("https://example.com");
		expect(result.details).toEqual({ resultCount: 1 });
	});
});
