export const MARKDOWN_INLINE_PATTERN =
	/(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\[[^\]]+\]\([^)]+\)|\*[^*]+\*|_[^_]+_)/g;

export const MARKDOWN_UNORDERED_LIST_PATTERN = /^\s*[-*+]\s+(.+)$/;
export const MARKDOWN_ORDERED_LIST_PATTERN = /^\s*(\d+)[.)]\s+(.+)$/;
export const MARKDOWN_HEADING_PATTERN = /^(#{1,6})\s+(.+)$/;
export const MARKDOWN_RULE_PATTERN = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
export const MARKDOWN_QUOTE_PATTERN = /^\s*>\s?(.*)$/;
