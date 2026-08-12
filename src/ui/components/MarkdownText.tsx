import { Box, Text } from "ink";
import type React from "react";
import { useMemo } from "react";
import {
	isTableStart,
	parseTableAlignment,
	splitTableRow,
} from "../../utils/markdownTable.ts";
import { theme } from "../theme/theme.ts";
import { MarkdownTableView } from "./MarkdownTable.tsx";
import {
	MARKDOWN_HEADING_PATTERN,
	MARKDOWN_INLINE_PATTERN,
	MARKDOWN_ORDERED_LIST_PATTERN,
	MARKDOWN_QUOTE_PATTERN,
	MARKDOWN_RULE_PATTERN,
	MARKDOWN_UNORDERED_LIST_PATTERN,
} from "./MarkdownText.constants.ts";
import type {
	MarkdownBlock,
	MarkdownCodeLine,
	MarkdownInline,
	MarkdownListItem,
	MarkdownTableRow,
} from "./MarkdownText.types.ts";

export function MarkdownText({ text }: { text: string }): React.ReactElement {
	const blocks = useMemo(() => parseMarkdownBlocks(text), [text]);
	return (
		<Box flexDirection="column">
			{blocks.map((block, index) => (
				<Box key={block.id} marginTop={index > 0 ? 1 : 0}>
					<MarkdownBlockView block={block} isFirst={index === 0} />
				</Box>
			))}
		</Box>
	);
}

export function parseMarkdownBlocks(text: string): MarkdownBlock[] {
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	const blocks: MarkdownBlock[] = [];
	let cursor = 0;

	while (cursor < lines.length) {
		const rawLine = lines[cursor] ?? "";
		const line = rawLine.trimEnd();
		if (!line.trim()) {
			cursor += 1;
			continue;
		}

		if (line.trimStart().startsWith("```")) {
			const start = cursor;
			const language = line.trim().slice(3).trim() || undefined;
			cursor += 1;
			const codeLines: MarkdownCodeLine[] = [];
			while (cursor < lines.length) {
				const codeLine = lines[cursor] ?? "";
				if (codeLine.trimStart().startsWith("```")) {
					cursor += 1;
					break;
				}
				codeLines.push({
					id: `code-line-${cursor}`,
					text: codeLine,
				});
				cursor += 1;
			}
			if (codeLines.some((codeLine) => codeLine.text.trim().length > 0)) {
				blocks.push({
					id: `code-${start}`,
					kind: "code",
					language,
					lines: codeLines,
				});
			}
			continue;
		}

		const heading = MARKDOWN_HEADING_PATTERN.exec(line);
		if (heading) {
			const hashes = heading[1] ?? "#";
			const content = heading[2] ?? "";
			blocks.push({
				id: `heading-${cursor}`,
				kind: "heading",
				level: hashes.length,
				inlines: parseMarkdownInlines(content, `heading-${cursor}`),
			});
			cursor += 1;
			continue;
		}

		if (MARKDOWN_RULE_PATTERN.test(line)) {
			blocks.push({ id: `rule-${cursor}`, kind: "rule" });
			cursor += 1;
			continue;
		}

		const quote = MARKDOWN_QUOTE_PATTERN.exec(line);
		if (quote) {
			const start = cursor;
			const quoteLines: MarkdownCodeLine[] = [];
			while (cursor < lines.length) {
				const quoteLine = MARKDOWN_QUOTE_PATTERN.exec(lines[cursor] ?? "");
				if (!quoteLine) break;
				quoteLines.push({
					id: `quote-line-${cursor}`,
					text: quoteLine[1] ?? "",
				});
				cursor += 1;
			}
			blocks.push({ id: `quote-${start}`, kind: "quote", lines: quoteLines });
			continue;
		}

		const nextLine = lines[cursor + 1] ?? "";
		if (isTableStart(line, nextLine)) {
			const start = cursor;
			const headerCells = splitTableRow(line);
			const align = parseTableAlignment(splitTableRow(nextLine));
			const header = headerCells.map((cell, index) =>
				parseMarkdownInlines(cell, `table-header-${start}-${index}`),
			);
			cursor += 2;
			const rows: MarkdownTableRow[] = [];
			while (cursor < lines.length) {
				const rowLine = lines[cursor] ?? "";
				const cells = splitTableRow(rowLine);
				if (!rowLine.trim() || cells.length === 0) break;
				// Streaming can hand us a ragged final row (cut off mid-cell
				// before the rest arrives) — pad/truncate to the header's
				// column count so layout never breaks.
				const normalized = Array.from(
					{ length: headerCells.length },
					(_, index) => cells[index] ?? "",
				);
				rows.push({
					id: `table-row-${cursor}`,
					cells: normalized.map((cell, index) =>
						parseMarkdownInlines(cell, `table-row-${cursor}-${index}`),
					),
				});
				cursor += 1;
			}
			blocks.push({ id: `table-${start}`, kind: "table", align, header, rows });
			continue;
		}

		const unordered = MARKDOWN_UNORDERED_LIST_PATTERN.exec(line);
		const ordered = MARKDOWN_ORDERED_LIST_PATTERN.exec(line);
		if (unordered || ordered) {
			const orderedList = Boolean(ordered);
			const start = cursor;
			const items: MarkdownListItem[] = [];
			while (cursor < lines.length) {
				const itemLine = lines[cursor] ?? "";
				const unorderedItem = MARKDOWN_UNORDERED_LIST_PATTERN.exec(itemLine);
				const orderedItem = MARKDOWN_ORDERED_LIST_PATTERN.exec(itemLine);
				if (orderedList ? !orderedItem : !unorderedItem) break;
				const prefix = orderedList
					? `${orderedItem?.[1] ?? items.length + 1}.`
					: "•";
				const content = orderedList
					? (orderedItem?.[2] ?? "")
					: (unorderedItem?.[1] ?? "");
				items.push({
					id: `list-item-${cursor}`,
					prefix,
					inlines: parseMarkdownInlines(content, `list-item-${cursor}`),
				});
				cursor += 1;
			}
			blocks.push({
				id: `list-${start}`,
				kind: orderedList ? "orderedList" : "unorderedList",
				items,
			});
			continue;
		}

		const start = cursor;
		const paragraphLines: string[] = [];
		while (cursor < lines.length) {
			const paragraphLine = lines[cursor] ?? "";
			const paragraphNextLine = lines[cursor + 1] ?? "";
			if (
				!paragraphLine.trim() ||
				isBlockStart(paragraphLine) ||
				isTableStart(paragraphLine, paragraphNextLine)
			) {
				break;
			}
			paragraphLines.push(paragraphLine.trim());
			cursor += 1;
		}
		const paragraph = paragraphLines.join(" ");
		blocks.push({
			id: `paragraph-${start}`,
			kind: "paragraph",
			inlines: parseMarkdownInlines(paragraph, `paragraph-${start}`),
		});
	}

	return blocks;
}

export function parseMarkdownInlines(
	text: string,
	idPrefix = "inline",
): MarkdownInline[] {
	const inlines: MarkdownInline[] = [];
	let offset = 0;
	let tokenNumber = 0;

	for (const match of text.matchAll(MARKDOWN_INLINE_PATTERN)) {
		const token = match[0];
		const index = match.index ?? 0;
		if (index > offset) {
			inlines.push({
				id: `${idPrefix}-text-${tokenNumber}`,
				kind: "text",
				text: text.slice(offset, index),
			});
			tokenNumber += 1;
		}
		inlines.push(parseInlineToken(token, `${idPrefix}-token-${tokenNumber}`));
		tokenNumber += 1;
		offset = index + token.length;
	}

	if (offset < text.length || inlines.length === 0) {
		inlines.push({
			id: `${idPrefix}-text-${tokenNumber}`,
			kind: "text",
			text: text.slice(offset),
		});
	}

	return inlines;
}

function MarkdownBlockView({
	block,
	isFirst = false,
}: {
	block: MarkdownBlock;
	isFirst?: boolean;
}): React.ReactElement {
	switch (block.kind) {
		case "heading":
			return (
				<Box marginTop={!isFirst && block.level <= 2 ? 1 : 0}>
					<Text color={theme.accentBright} bold>
						<InlineText inlines={block.inlines} />
					</Text>
				</Box>
			);
		case "paragraph":
			return (
				<Text color={theme.text} wrap="wrap">
					<InlineText inlines={block.inlines} />
				</Text>
			);
		case "unorderedList":
		case "orderedList":
			return (
				<Box flexDirection="column">
					{block.items.map((item) => (
						<Box key={item.id}>
							<Text color={theme.accentBright}>{item.prefix} </Text>
							<Box flexGrow={1} flexShrink={1}>
								<Text color={theme.text} wrap="wrap">
									<InlineText inlines={item.inlines} />
								</Text>
							</Box>
						</Box>
					))}
				</Box>
			);
		case "code":
			return (
				<Box flexDirection="column" paddingLeft={1}>
					{block.lines.map((line) => (
						<Text key={line.id} color={theme.subtle}>
							{line.text || " "}
						</Text>
					))}
				</Box>
			);
		case "quote":
			return (
				<Box flexDirection="column">
					{block.lines.map((line) => (
						<Text key={line.id} color={theme.subtle}>
							│ {line.text}
						</Text>
					))}
				</Box>
			);
		case "rule":
			return <Text color={theme.subtle}>{"─".repeat(32)}</Text>;
		case "table":
			return (
				<MarkdownTableView
					align={block.align}
					header={block.header}
					rows={block.rows}
				/>
			);
	}
}

export function InlineText({
	inlines,
}: {
	inlines: readonly MarkdownInline[];
}): React.ReactElement {
	return (
		<>
			{inlines.map((inline) => (
				<InlineToken key={inline.id} inline={inline} />
			))}
		</>
	);
}

function InlineToken({
	inline,
}: {
	inline: MarkdownInline;
}): React.ReactElement {
	if (inline.kind === "strong") {
		return <Text bold>{inline.text}</Text>;
	}
	if (inline.kind === "emphasis") {
		return <Text italic>{inline.text}</Text>;
	}
	if (inline.kind === "code") {
		return <Text color={theme.accentBright}>{inline.text}</Text>;
	}
	if (inline.kind === "link") {
		return (
			<Text color={theme.accentBright}>
				{inline.text}
				{inline.href && inline.href !== inline.text ? ` (${inline.href})` : ""}
			</Text>
		);
	}
	return <Text>{inline.text}</Text>;
}

function parseInlineToken(token: string, id: string): MarkdownInline {
	if (token.startsWith("`") && token.endsWith("`")) {
		return { id, kind: "code", text: token.slice(1, -1) };
	}
	if (
		(token.startsWith("**") && token.endsWith("**")) ||
		(token.startsWith("__") && token.endsWith("__"))
	) {
		return { id, kind: "strong", text: token.slice(2, -2) };
	}
	if (
		(token.startsWith("*") && token.endsWith("*")) ||
		(token.startsWith("_") && token.endsWith("_"))
	) {
		return { id, kind: "emphasis", text: token.slice(1, -1) };
	}
	if (token.startsWith("[") && token.includes("](") && token.endsWith(")")) {
		const closeLabel = token.indexOf("](");
		const label = token.slice(1, closeLabel);
		const href = token.slice(closeLabel + 2, -1);
		return { id, kind: "link", text: label, href };
	}
	return { id, kind: "text", text: token };
}

function isBlockStart(line: string): boolean {
	const trimmed = line.trimStart();
	return (
		trimmed.startsWith("```") ||
		MARKDOWN_HEADING_PATTERN.test(line.trimEnd()) ||
		MARKDOWN_RULE_PATTERN.test(line) ||
		MARKDOWN_QUOTE_PATTERN.test(line) ||
		MARKDOWN_UNORDERED_LIST_PATTERN.test(line) ||
		MARKDOWN_ORDERED_LIST_PATTERN.test(line)
	);
}
