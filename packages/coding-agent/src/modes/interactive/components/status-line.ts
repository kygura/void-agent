import { basename } from "path";
import { styleModel } from "../theme/provider-palette.js";

/**
 * Data needed to render configurable statusline items (Settings.statusLine).
 * Pure/testable independent of TUI rendering or theme.
 */
export interface StatusLineData {
	modelProvider?: string;
	modelId?: string;
	modelSupportsThinking: boolean;
	thinkingLevel: string;
	cwd: string;
	gitBranch: string | null;
	gitDirty: boolean | null;
	gitRoot: string | null;
	contextPercent: number | null;
	usedTokens: number;
	costUsd: number | undefined;
	usingSubscription: boolean;
	sessionName: string | undefined;
	version: string;
	extensionStatuses: ReadonlyMap<string, string>;
}

/**
 * Sanitize text for display in a single-line status.
 * Removes newlines, tabs, carriage returns, and other control characters.
 */
export function sanitizeStatusText(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

/** Format token counts (compact form, e.g. 12.3k) */
export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function renderCurrentDir(cwd: string): string {
	const home = process.env.HOME || process.env.USERPROFILE;
	if (home && cwd === home) return "~";
	return basename(cwd) || cwd;
}

function renderExtensionStatuses(extensionStatuses: ReadonlyMap<string, string>): string {
	if (extensionStatuses.size === 0) return "";
	return Array.from(extensionStatuses.entries())
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([, text]) => sanitizeStatusText(text))
		.join(" ");
}

function renderStatusItem(id: string, data: StatusLineData): string {
	switch (id) {
		case "model":
			return data.modelId && data.modelProvider
				? styleModel(data.modelProvider, data.modelId)
				: (data.modelId ?? "");
		case "thinking-level":
			return data.modelSupportsThinking ? data.thinkingLevel : "";
		case "current-dir":
			return renderCurrentDir(data.cwd);
		case "project-root":
			return data.gitRoot ? basename(data.gitRoot) : "";
		case "git-branch":
			if (!data.gitBranch) return "";
			return data.gitDirty ? `${data.gitBranch}*` : data.gitBranch;
		case "context-remaining": {
			if (data.contextPercent === null) return "";
			const remaining = Math.max(0, Math.min(100, 100 - data.contextPercent));
			return `${remaining.toFixed(0)}% left`;
		}
		case "used-tokens":
			return data.usedTokens > 0 ? formatTokens(data.usedTokens) : "";
		case "cost":
			return data.costUsd !== undefined
				? `$${data.costUsd.toFixed(3)}${data.usingSubscription ? " (sub)" : ""}`
				: "";
		case "session-name":
			return data.sessionName ?? "";
		case "version":
			return data.version;
		case "status":
			return renderExtensionStatuses(data.extensionStatuses);
		default:
			// Unknown ids render as literal text, allowing user separators/labels (e.g. "|", "void:")
			return id;
	}
}

/** Build rendered statusline items for the given ordered ids. Empty items are dropped. */
export function buildStatusLineItems(data: StatusLineData, ids: string[]): string[] {
	return ids.map((id) => renderStatusItem(id, data)).filter((text) => text.length > 0);
}
