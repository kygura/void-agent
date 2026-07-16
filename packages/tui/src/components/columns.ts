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
	const clipped = visibleWidth(line) > width ? truncateToWidth(line, width) : line;
	const padding = Math.max(0, width - visibleWidth(clipped));
	return clipped + " ".repeat(padding);
}

/**
 * Lays out N components side by side. Each column renders at its computed width; every
 * line is truncated/padded (ANSI-aware) to exactly that width before joining. Columns
 * shorter than the tallest column are padded with blank lines.
 */
export class Columns implements Component {
	private readonly columns: ColumnSpec[];
	private readonly gap: number;

	constructor(columns: ColumnSpec[], options?: ColumnsOptions) {
		this.columns = columns;
		this.gap = options?.gap ?? 1;
	}

	invalidate(): void {
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

		const renderedColumns = this.columns.map((col, i) => {
			const colWidth = widths[i]!;
			if (colWidth <= 0) return [];
			return col.component.render(colWidth).map((line) => padLineToWidth(line, colWidth));
		});

		const maxLines = renderedColumns.reduce((max, lines) => Math.max(max, lines.length), 0);
		const gapStr = " ".repeat(this.gap);
		const result: string[] = [];
		for (let row = 0; row < maxLines; row++) {
			const parts = renderedColumns.map((lines, i) => lines[row] ?? " ".repeat(widths[i]!));
			result.push(parts.join(gapStr));
		}
		return result;
	}
}
