import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import {
	ALLOWED_ATTACHMENT_EXTENSIONS,
	MAX_ATTACHMENT_BYTES,
} from "./constants.ts";

export interface CandidateFile {
	filePath: string;
	fileName: string;
	sizeBytes: number;
}

export interface RejectedFile {
	filePath: string;
	reason: string;
}

export type AttachmentPasteResult =
	| { kind: "text" }
	| {
			kind: "attachments";
			accepted: CandidateFile[];
			rejected: RejectedFile[];
			/** Original text with the accepted path tokens removed. */
			remainingText: string;
	  };

export interface AttachmentPathDeps {
	existsSync: (path: string) => boolean;
	statSync: (path: string) => { isDirectory(): boolean; size: number };
	readdirSync: (path: string) => string[];
	homedir: () => string;
}

interface SpanToken {
	value: string;
	start: number;
	end: number;
}

/** Cap on how many whitespace-separated tokens a single path may span. */
const MAX_PATH_TOKENS = 24;

const MAX_PASTE_TOKENS = 32;

/** Splits pasted text into shell-style tokens, each carrying its source span. */
function tokenizePastedPathsWithSpans(text: string): SpanToken[] {
	const tokens: SpanToken[] = [];
	let current = "";
	let started = false;
	let tokenStart = 0;
	let quote: "'" | '"' | null = null;
	let i = 0;
	const begin = () => {
		if (!started) {
			started = true;
			tokenStart = i;
		}
	};
	while (i < text.length) {
		const ch = text[i] as string;
		if (quote) {
			if (ch === quote) quote = null;
			else current += ch;
			i++;
			continue;
		}
		if (ch === "'" || ch === '"') {
			begin();
			quote = ch;
			i++;
			continue;
		}
		if (ch === "\\" && i + 1 < text.length) {
			begin();
			current += text[i + 1];
			i += 2;
			continue;
		}
		if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
			if (started && current.length > 0)
				tokens.push({ value: current, start: tokenStart, end: i });
			current = "";
			started = false;
			i++;
			continue;
		}
		begin();
		current += ch;
		i++;
	}
	if (started && current.length > 0)
		tokens.push({ value: current, start: tokenStart, end: text.length });
	return tokens;
}

export function tokenizePastedPaths(text: string): string[] {
	return tokenizePastedPathsWithSpans(text).map((token) => token.value);
}

/** Turns literal unicode escapes like `\u{202f}` into the real character. */
function decodeUnicodeEscapes(value: string): string {
	if (!value.includes("\\u")) return value;
	const fromHex = (original: string, hex: string): string => {
		const code = Number.parseInt(hex, 16);
		if (!Number.isFinite(code) || code > 0x10ffff) return original;
		try {
			return String.fromCodePoint(code);
		} catch {
			return original;
		}
	};
	return value
		.replace(/\\u\{([0-9a-fA-F]{1,6})\}/g, (m, hex) => fromHex(m, hex))
		.replace(/\\u([0-9a-fA-F]{4})/g, (m, hex) => fromHex(m, hex));
}

/** Resolves file:// URLs and ~ prefixes to a plain absolute path candidate. */
export function expandAttachmentPath(token: string, homedir: string): string {
	let path = decodeUnicodeEscapes(token);
	if (path.startsWith("file://")) {
		path = path.slice("file://".length);
		if (path.startsWith("localhost/")) path = path.slice("localhost".length);
		try {
			path = decodeURIComponent(path);
		} catch {
			// Malformed escapes: keep the raw form; existence check will reject it.
		}
	}
	if (path === "~") return homedir;
	if (path.startsWith("~/")) return homedir + path.slice(1);
	return path;
}

/** Collapses every Unicode whitespace run to a single ASCII space. */
function normalizeWhitespace(value: string): string {
	return value.replace(/\s+/g, " ");
}

function isDirectory(path: string, deps: AttachmentPathDeps): boolean {
	try {
		return deps.statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/** Real on-disk path for a candidate (whitespace-insensitive fallback), or null. */
function resolveExistingPath(
	path: string,
	deps: AttachmentPathDeps,
): string | null {
	if (!path.startsWith("/")) return null;
	if (deps.existsSync(path)) return path;

	const dir = dirname(path);
	const base = basename(path);
	if (base.length === 0 || !deps.existsSync(dir)) return null;

	const target = normalizeWhitespace(base);
	let entries: string[];
	try {
		entries = deps.readdirSync(dir);
	} catch {
		return null;
	}
	for (const entry of entries) {
		if (normalizeWhitespace(entry) === target) return join(dir, entry);
	}
	return null;
}

interface FileMatch {
	filePath: string;
	endIndex: number;
}

function hasAllowedExtension(value: string): boolean {
	return ALLOWED_ATTACHMENT_EXTENSIONS.has(extname(value).toLowerCase());
}

/** Finds the real file a path token points at, rejoining space-split bare paths. */
function matchPathAt(
	tokens: SpanToken[],
	i: number,
	home: string,
	deps: AttachmentPathDeps,
): FileMatch | null {
	const first = expandAttachmentPath((tokens[i] as SpanToken).value, home);
	if (!first.startsWith("/")) return null;

	if (hasAllowedExtension(first)) {
		const single = resolveExistingPath(first, deps);
		if (single && !isDirectory(single, deps))
			return { filePath: single, endIndex: i };
	}

	// Greedy: rejoin following bare tokens until they name a real file.
	const dir = dirname(first);
	let byNormalized: Map<string, string> | null = null;
	let base = basename(first);
	const limit = Math.min(i + MAX_PATH_TOKENS, tokens.length - 1);
	for (let j = i + 1; j <= limit; j++) {
		base += ` ${(tokens[j] as SpanToken).value}`;
		if (!hasAllowedExtension(base)) continue;
		if (byNormalized === null) {
			if (!deps.existsSync(dir)) return null;
			let entries: string[];
			try {
				entries = deps.readdirSync(dir);
			} catch {
				return null;
			}
			byNormalized = new Map<string, string>();
			for (const entry of entries) {
				const key = normalizeWhitespace(entry);
				if (!byNormalized.has(key)) byNormalized.set(key, entry);
			}
		}
		const hit = byNormalized.get(normalizeWhitespace(base));
		if (hit) {
			const full = join(dir, hit);
			if (!isDirectory(full, deps)) return { filePath: full, endIndex: j };
		}
	}
	return null;
}

/** Removes the given source spans from text and tidies leftover whitespace. */
function stripSpans(
	text: string,
	spans: readonly { start: number; end: number }[],
): string {
	if (spans.length === 0) return text;
	const sorted = [...spans].sort((a, b) => a.start - b.start);
	let result = "";
	let last = 0;
	for (const span of sorted) {
		if (span.start < last) continue;
		result += text.slice(last, span.start);
		last = span.end;
	}
	result += text.slice(last);
	return result.replace(/[ \t]{2,}/g, " ").trim();
}

const defaultDeps: AttachmentPathDeps = {
	existsSync,
	statSync,
	readdirSync,
	homedir,
};

/** Pulls existing file paths out of pasted text; prose stays in remainingText. */
export function detectAttachmentPaste(
	text: string,
	deps: AttachmentPathDeps = defaultDeps,
): AttachmentPasteResult {
	if (/[\r\n]/.test(text.trim())) return { kind: "text" };
	const tokens = tokenizePastedPathsWithSpans(text);
	if (tokens.length === 0 || tokens.length > MAX_PASTE_TOKENS)
		return { kind: "text" };

	const home = deps.homedir();
	const accepted: CandidateFile[] = [];
	const rejected: RejectedFile[] = [];
	const acceptedSpans: { start: number; end: number }[] = [];

	let i = 0;
	while (i < tokens.length) {
		const token = tokens[i] as SpanToken;
		const match = matchPathAt(tokens, i, home, deps);
		if (match) {
			const { filePath, endIndex } = match;
			const sizeBytes = deps.statSync(filePath).size;
			if (sizeBytes > MAX_ATTACHMENT_BYTES) {
				rejected.push({
					filePath,
					reason: `file exceeds the ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB limit`,
				});
			} else {
				accepted.push({
					filePath,
					fileName: basename(filePath),
					sizeBytes,
				});
				acceptedSpans.push({
					start: token.start,
					end: (tokens[endIndex] as SpanToken).end,
				});
			}
			i = endIndex + 1;
			continue;
		}
		i++;
	}

	if (accepted.length === 0 && rejected.length === 0) return { kind: "text" };
	return {
		kind: "attachments",
		accepted,
		rejected,
		remainingText: stripSpans(text, acceptedSpans),
	};
}
