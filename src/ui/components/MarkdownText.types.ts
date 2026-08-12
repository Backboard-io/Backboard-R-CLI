import type { TableAlign } from "../../utils/markdownTable.ts";

export type MarkdownInlineKind =
	| "text"
	| "strong"
	| "emphasis"
	| "code"
	| "link";

export interface MarkdownInline {
	id: string;
	kind: MarkdownInlineKind;
	text: string;
	href?: string;
}

export interface MarkdownListItem {
	id: string;
	prefix: string;
	inlines: MarkdownInline[];
}

export interface MarkdownCodeLine {
	id: string;
	text: string;
}

export interface MarkdownTableRow {
	id: string;
	cells: MarkdownInline[][];
}

export type MarkdownBlock =
	| {
			id: string;
			kind: "paragraph";
			inlines: MarkdownInline[];
	  }
	| {
			id: string;
			kind: "heading";
			level: number;
			inlines: MarkdownInline[];
	  }
	| {
			id: string;
			kind: "unorderedList" | "orderedList";
			items: MarkdownListItem[];
	  }
	| {
			id: string;
			kind: "code";
			language?: string;
			lines: MarkdownCodeLine[];
	  }
	| {
			id: string;
			kind: "quote";
			lines: MarkdownCodeLine[];
	  }
	| {
			id: string;
			kind: "rule";
	  }
	| {
			id: string;
			kind: "table";
			align: TableAlign[];
			header: MarkdownInline[][];
			rows: MarkdownTableRow[];
	  };
