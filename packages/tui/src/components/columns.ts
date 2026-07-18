import type { Component } from "../tui.js";
import { truncateToWidth, visibleWidth } from "../utils.js";

/** One column's layout spec: either a fixed width or a flex weight (mutually exclusive). */
export interface ColumnSpec {
	component: Component;
	/** Fixed width in columns. Takes precedence over flex if both are set. */
	width?: number;
	/** Flex weight; remaining width (after fixed columns and gaps) is distributed proportionally among flex columns. */
	flex?: number;
}

export interface ColumnsOptions {
	/** Columns of blank space between adjacent columns. Default: 1. */
	gap?: number;
}

function padLineToWidth(line: string, width: number): string {
	const lineWidth = visibleWidth(line);
	if (lineWidth > width) {
		return truncateToWidth(line, width, "...", true);
	}
	return line + " ".repeat(width - lineWidth);
}

type RenderCache = {
	width: number;
	columnWidths: number[];
	sourceLines: string[][];
	lines: string[];
};

/**
 * Lays out N components side by side. Each column renders at its computed width; every
 * line is truncated/padded (ANSI-aware) to exactly that width before joining. Columns
 * shorter than the tallest column are padded with blank lines.
 */
export class Columns implements Component {
	private readonly columns: ColumnSpec[];
	private readonly gap: number;
	private cache?: RenderCache;

	constructor(columns: ColumnSpec[], options?: ColumnsOptions) {
		this.columns = columns;
		this.gap = options?.gap ?? 1;
	}

	invalidate(): void {
		this.cache = undefined;
		for (const col of this.columns) col.component.invalidate?.();
	}

	render(width: number): string[] {
		if (this.columns.length === 0) return [];

		const gapTotal = this.gap * Math.max(0, this.columns.length - 1);
		const fixedTotal = this.columns.reduce((sum, c) => sum + (c.width !== undefined ? Math.max(0, c.width) : 0), 0);
		const flexTotal = this.columns.reduce((sum, c) => sum + (c.width === undefined ? (c.flex ?? 0) : 0), 0);
		const remaining = Math.max(0, width - gapTotal - fixedTotal);

		const flexCount = this.columns.filter((c) => c.width === undefined && (c.flex ?? 0) > 0).length;
		let flexAssigned = 0;
		let flexSeen = 0;
		const widths = this.columns.map((col) => {
			if (col.width !== undefined) return Math.max(0, col.width);
			const flex = col.flex ?? 0;
			if (flex <= 0 || flexTotal <= 0) return 0;
			flexSeen++;
			const isLast = flexSeen === flexCount;
			const share = isLast ? remaining - flexAssigned : Math.floor((remaining * flex) / flexTotal);
			flexAssigned += share;
			return Math.max(0, share);
		});

		const sourceLines = this.columns.map((col, i) => {
			const colWidth = widths[i]!;
			return colWidth > 0 ? col.component.render(colWidth) : [];
		});
		const cache = this.cache;
		const cacheMatches =
			cache !== undefined &&
			cache.width === width &&
			cache.columnWidths.length === widths.length &&
			cache.sourceLines.length === sourceLines.length &&
			cache.columnWidths.every((columnWidth, i) => columnWidth === widths[i]) &&
			cache.sourceLines.every(
				(lines, columnIndex) =>
					lines.length === sourceLines[columnIndex]!.length &&
					lines.every((line, lineIndex) => line === sourceLines[columnIndex]![lineIndex]),
			);
		if (cacheMatches) {
			return cache.lines;
		}

		const renderedColumns = sourceLines.map((lines, i) => {
			const colWidth = widths[i]!;
			return lines.map((line) => padLineToWidth(line, colWidth));
		});

		const maxLines = renderedColumns.reduce((max, lines) => Math.max(max, lines.length), 0);
		const gapStr = " ".repeat(this.gap);
		const result: string[] = [];
		for (let row = 0; row < maxLines; row++) {
			const parts = renderedColumns.map((lines, i) => lines[row] ?? " ".repeat(widths[i]!));
			result.push(parts.join(gapStr));
		}
		this.cache = {
			width,
			columnWidths: widths,
			sourceLines: sourceLines.map((lines) => [...lines]),
			lines: result,
		};
		return result;
	}
}
