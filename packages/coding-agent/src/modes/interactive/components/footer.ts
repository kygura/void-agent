import type { ThinkingLevel } from "@void/agent";
import { type Component, truncateToWidth, visibleWidth } from "@void/tui";
import { VERSION } from "../../../config.js";
import type { AgentSession } from "../../../core/agent-session.js";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.js";
import { styleModel, styleProvider } from "../theme/provider-palette.js";
import { theme } from "../theme/theme.js";
import { buildReasoningGauge } from "./reasoning-bar.js";
import { buildStatusLineItems, formatTokens, type StatusLineData, sanitizeStatusText } from "./status-line.js";

/**
 * Footer component that shows pwd, token stats, and context usage.
 * Computes token/context stats from session, gets git branch and extension statuses from provider.
 */
export class FooterComponent implements Component {
	private autoCompactEnabled = true;

	constructor(
		private session: AgentSession,
		private footerData: ReadonlyFooterDataProvider,
	) {}

	setSession(session: AgentSession): void {
		this.session = session;
	}

	setAutoCompactEnabled(enabled: boolean): void {
		this.autoCompactEnabled = enabled;
	}

	/**
	 * No-op: git branch caching now handled by provider.
	 * Kept for compatibility with existing call sites in interactive-mode.
	 */
	invalidate(): void {
		// No-op: git branch is cached/invalidated by provider
	}

	/**
	 * Clean up resources.
	 * Git watcher cleanup now handled by provider.
	 */
	dispose(): void {
		// Git watcher cleanup handled by provider
	}

	render(width: number): string[] {
		const state = this.session.state;

		// Calculate cumulative usage from ALL session entries (not just post-compaction messages)
		let totalInput = 0;
		let totalOutput = 0;
		let totalCacheRead = 0;
		let totalCacheWrite = 0;
		let totalCost = 0;

		for (const entry of this.session.sessionManager.getEntries()) {
			if (entry.type === "message" && entry.message.role === "assistant") {
				totalInput += entry.message.usage.input;
				totalOutput += entry.message.usage.output;
				totalCacheRead += entry.message.usage.cacheRead;
				totalCacheWrite += entry.message.usage.cacheWrite;
				totalCost += entry.message.usage.cost.total;
			}
		}

		// Calculate context usage from session (handles compaction correctly).
		// After compaction, tokens are unknown until the next LLM response.
		const contextUsage = this.session.getContextUsage();
		const contextWindow = contextUsage?.contextWindow ?? state.model?.contextWindow ?? 0;
		const contextPercentValue = contextUsage?.percent ?? 0;
		const contextPercent = contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";

		// Show cost with "(sub)" indicator if using OAuth subscription
		const usingSubscription = state.model ? this.session.modelRegistry.isUsingOAuth(state.model) : false;

		// Configurable statusline: when settings.statusLine is set, it replaces the entire default
		// footer with a single themed line built from the ordered item ids. Unset (the default)
		// falls through to the legacy multi-line footer below, unchanged.
		const settingsManager = this.session.settingsManager;
		const statusLineIds = settingsManager?.getStatusLine();
		if (statusLineIds && statusLineIds.length > 0) {
			return this.renderStatusLine(width, statusLineIds, settingsManager!.getStatusLineSeparator(), {
				totalInput,
				totalOutput,
				totalCacheRead,
				totalCacheWrite,
				totalCost,
				usingSubscription,
				contextPercent: contextUsage?.percent ?? null,
			});
		}

		// Replace home directory with ~
		let pwd = this.session.sessionManager.getCwd();
		const home = process.env.HOME || process.env.USERPROFILE;
		if (home && pwd.startsWith(home)) {
			pwd = `~${pwd.slice(home.length)}`;
		}

		// Add git branch if available
		const branch = this.footerData.getGitBranch();
		if (branch) {
			pwd = `${pwd} (${branch})`;
		}

		// Add session name if set
		const sessionName = this.session.sessionManager.getSessionName();
		if (sessionName) {
			pwd = `${pwd} • ${sessionName}`;
		}

		// Build stats line
		const statsParts = [];
		if (totalInput) statsParts.push(`↑${formatTokens(totalInput)}`);
		if (totalOutput) statsParts.push(`↓${formatTokens(totalOutput)}`);
		if (totalCacheRead) statsParts.push(`R${formatTokens(totalCacheRead)}`);
		if (totalCacheWrite) statsParts.push(`W${formatTokens(totalCacheWrite)}`);

		if (totalCost || usingSubscription) {
			const costStr = `$${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`;
			statsParts.push(costStr);
		}

		// Colorize context percentage based on usage
		let contextPercentStr: string;
		const autoIndicator = this.autoCompactEnabled ? " (auto)" : "";
		const contextPercentDisplay =
			contextPercent === "?"
				? `?/${formatTokens(contextWindow)}${autoIndicator}`
				: `${contextPercent}%/${formatTokens(contextWindow)}${autoIndicator}`;
		if (contextPercentValue > 90) {
			contextPercentStr = theme.fg("error", contextPercentDisplay);
		} else if (contextPercentValue > 70) {
			contextPercentStr = theme.fg("warning", contextPercentDisplay);
		} else {
			contextPercentStr = contextPercentDisplay;
		}
		statsParts.push(contextPercentStr);

		let statsLeft = statsParts.join(" ");

		// Add model name on the right side, plus a compact reasoning gauge when supported.
		const modelName = state.model?.id || "no-model";
		const fallbackThinkingLevels: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
		const reasoningGauge = state.model?.reasoning
			? buildReasoningGauge(
					{
						modelSupportsThinking: true,
						thinkingLevel: state.thinkingLevel || "off",
						availableLevels: this.session.getAvailableThinkingLevels?.() ?? fallbackThinkingLevels,
					},
					width,
				)
			: "";
		const rightSideWithoutProvider = reasoningGauge ? `${modelName} ${reasoningGauge}` : modelName;

		let statsLeftWidth = visibleWidth(statsLeft);

		// If statsLeft is too wide, truncate it
		if (statsLeftWidth > width) {
			statsLeft = truncateToWidth(statsLeft, width, "...");
			statsLeftWidth = visibleWidth(statsLeft);
		}

		// Calculate available space for padding (minimum 2 spaces between stats and model)
		const minPadding = 2;

		// Prepend the provider in parentheses if there are multiple providers and there's enough room
		let rightSide = rightSideWithoutProvider;
		let showProvider = false;
		if (this.footerData.getAvailableProviderCount() > 1 && state.model) {
			rightSide = `(${state.model.provider}) ${rightSideWithoutProvider}`;
			if (statsLeftWidth + minPadding + visibleWidth(rightSide) > width) {
				// Too wide, fall back
				rightSide = rightSideWithoutProvider;
			} else {
				showProvider = true;
			}
		}

		const rightSideWidth = visibleWidth(rightSide);
		const totalNeeded = statsLeftWidth + minPadding + rightSideWidth;

		let padding = "";
		let displayedRight = "";
		if (totalNeeded <= width) {
			// Both fit - add padding to right-align model
			padding = " ".repeat(width - statsLeftWidth - rightSideWidth);
			displayedRight = rightSide;
		} else {
			// Need to truncate right side
			const availableForRight = width - statsLeftWidth - minPadding;
			if (availableForRight > 0) {
				displayedRight = truncateToWidth(rightSide, availableForRight, "");
				padding = " ".repeat(Math.max(0, width - statsLeftWidth - visibleWidth(displayedRight)));
			}
		}

		// Apply dim to each part separately. statsLeft may contain color codes (for context %),
		// while provider/model colors end with resets that would clear an outer dim wrapper.
		const dimStatsLeft = theme.fg("dim", statsLeft);
		const dimPadding = theme.fg("dim", padding);
		let styledRight = theme.fg("dim", displayedRight);
		if (state.model && displayedRight) {
			const styledGauge = reasoningGauge ? ` ${reasoningGauge}` : "";
			const styledFullRight = showProvider
				? `${theme.fg("dim", "(")}${styleProvider(state.model.provider)}${theme.fg("dim", ") ")}${styleModel(state.model.provider, modelName)}${styledGauge}`
				: `${styleModel(state.model.provider, modelName)}${styledGauge}`;
			styledRight = truncateToWidth(styledFullRight, visibleWidth(displayedRight), "");
		}

		const pwdLine = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));
		const lines = [pwdLine, dimStatsLeft + dimPadding + styledRight];

		// Add extension statuses on a single line, sorted by key alphabetically
		const extensionStatuses = this.footerData.getExtensionStatuses();
		if (extensionStatuses.size > 0) {
			const sortedStatuses = Array.from(extensionStatuses.entries())
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([, text]) => sanitizeStatusText(text));
			const statusLine = sortedStatuses.join(" ");
			// Truncate to terminal width with dim ellipsis for consistency with footer style
			lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
		}

		return lines;
	}

	/** Render the configurable statusline (settings.statusLine) as a single themed line. */
	private renderStatusLine(
		width: number,
		ids: string[],
		separator: string,
		usage: {
			totalInput: number;
			totalOutput: number;
			totalCacheRead: number;
			totalCacheWrite: number;
			totalCost: number;
			usingSubscription: boolean;
			contextPercent: number | null;
		},
	): string[] {
		const state = this.session.state;
		const data: StatusLineData = {
			modelProvider: state.model?.provider,
			modelId: state.model?.id,
			modelSupportsThinking: !!state.model?.reasoning,
			thinkingLevel: state.thinkingLevel || "off",
			cwd: this.session.sessionManager.getCwd(),
			gitBranch: this.footerData.getGitBranch(),
			gitDirty: this.footerData.getGitDirty(),
			gitRoot: this.footerData.getGitRoot(),
			contextPercent: usage.contextPercent,
			usedTokens: usage.totalInput + usage.totalOutput + usage.totalCacheRead + usage.totalCacheWrite,
			costUsd: usage.totalCost || usage.usingSubscription ? usage.totalCost : undefined,
			usingSubscription: usage.usingSubscription,
			sessionName: this.session.sessionManager.getSessionName(),
			version: VERSION,
			extensionStatuses: this.footerData.getExtensionStatuses(),
		};

		const items = buildStatusLineItems(data, ids);
		const line = items.join(theme.fg("dim", separator));
		return [truncateToWidth(line, width, theme.fg("dim", "..."))];
	}
}
