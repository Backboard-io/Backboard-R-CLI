import { Box, Text } from "ink";
import type React from "react";
import type { TableAlign } from "../../utils/markdownTable.ts";
import { useTerminalSize } from "../hooks/TerminalSizeContext.tsx";
import { theme } from "../theme/theme.ts";
import { InlineText } from "./MarkdownText.tsx";
import type { MarkdownInline, MarkdownTableRow } from "./MarkdownText.types.ts";

const CELL_PADDING = 2; // one space either side of the cell content
const MIN_COLUMN_WIDTH = 3;
const MAX_TABLE_WIDTH = 120;

export function MarkdownTableView({
	align,
	header,
	rows,
}: {
	align: TableAlign[];
	header: MarkdownInline[][];
	rows: MarkdownTableRow[];
}): React.ReactElement {
	const { columns } = useTerminalSize();
	const maxWidth = Math.min(
		MAX_TABLE_WIDTH,
		typeof columns === "number" && columns > 0 ? columns : 80,
	);
	const columnWidths = computeColumnWidths(header, rows, maxWidth);

	return (
		<Box flexDirection="column">
			<TableRow cells={header} align={align} widths={columnWidths} bold />
			<Text color={theme.subtle}>{separatorLine(columnWidths)}</Text>
			{rows.map((row) => (
				<TableRow
					key={row.id}
					cells={row.cells}
					align={align}
					widths={columnWidths}
				/>
			))}
		</Box>
	);
}

function TableRow({
	cells,
	align,
	widths,
	bold = false,
}: {
	cells: MarkdownInline[][];
	align: TableAlign[];
	widths: number[];
	bold?: boolean;
}): React.ReactElement {
	return (
		<Box flexDirection="row">
			{widths.map((width, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: column count/order is fixed for this table block's lifetime
				<Box key={`col-${index}`}>
					{index > 0 ? <Text color={theme.subtle}>│</Text> : null}
					<Box
						// Ink's Box width is border-box (includes padding), so the
						// box must be sized to content width + padding, matching
						// separatorLine's segment length.
						width={width + CELL_PADDING}
						paddingX={1}
						justifyContent={justifyForAlign(align[index])}
					>
						<Text
							color={bold ? theme.accentBright : theme.text}
							bold={bold}
							wrap="wrap"
						>
							{cells[index] ? <InlineText inlines={cells[index] ?? []} /> : " "}
						</Text>
					</Box>
				</Box>
			))}
		</Box>
	);
}

function justifyForAlign(
	align: TableAlign | undefined,
): "flex-start" | "center" | "flex-end" {
	if (align === "center") return "center";
	if (align === "right") return "flex-end";
	return "flex-start";
}

function separatorLine(widths: number[]): string {
	return widths.map((width) => "─".repeat(width + CELL_PADDING)).join("┼");
}

function computeColumnWidths(
	header: MarkdownInline[][],
	rows: MarkdownTableRow[],
	maxWidth: number,
): number[] {
	const columnCount = header.length;
	const natural = Array.from({ length: columnCount }, (_, index) => {
		const headerWidth = cellWidth(header[index]);
		const bodyWidth = Math.max(
			0,
			...rows.map((row) => cellWidth(row.cells[index])),
		);
		return Math.max(MIN_COLUMN_WIDTH, headerWidth, bodyWidth);
	});

	const separators = Math.max(0, columnCount - 1);
	const totalNatural =
		natural.reduce((sum, width) => sum + width + CELL_PADDING, 0) + separators;
	if (totalNatural <= maxWidth) return natural;

	const budget = Math.max(
		columnCount * MIN_COLUMN_WIDTH,
		maxWidth - separators - columnCount * CELL_PADDING,
	);
	return distributeWidth(natural, budget);
}

/**
 * Gives every column its natural width if the shared budget allows it;
 * columns that fit are locked in first so a single verbose column (e.g. a
 * "notes" cell) only eats the width nobody else needed, instead of
 * shrinking every column down to the minimum.
 */
function distributeWidth(natural: number[], budget: number): number[] {
	const widths = new Array(natural.length).fill(0);
	const settled = new Array(natural.length).fill(false);
	let remainingBudget = budget;
	let remainingColumns = natural.length;

	let settledAny = true;
	while (settledAny && remainingColumns > 0) {
		settledAny = false;
		const fairShare = remainingBudget / remainingColumns;
		for (let index = 0; index < natural.length; index++) {
			if (settled[index]) continue;
			if ((natural[index] ?? 0) <= fairShare) {
				widths[index] = natural[index] ?? 0;
				settled[index] = true;
				remainingBudget -= widths[index];
				remainingColumns -= 1;
				settledAny = true;
			}
		}
	}

	if (remainingColumns > 0) {
		const share = Math.max(
			MIN_COLUMN_WIDTH,
			Math.floor(remainingBudget / remainingColumns),
		);
		for (let index = 0; index < natural.length; index++) {
			if (!settled[index]) widths[index] = share;
		}
	}

	return widths;
}

function cellWidth(cell: MarkdownInline[] | undefined): number {
	if (!cell) return 0;
	return cell.reduce((sum, inline) => sum + inline.text.length, 0);
}
