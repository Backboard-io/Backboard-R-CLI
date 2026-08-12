import { spawn } from "node:child_process";
import { createAsyncCache } from "../../utils/asyncCache.ts";
import { stripAnsi } from "../../utils/terminalSafe.ts";

const BASE_URL = "https://skills.sh";
const MAX_OUTPUT_LENGTH = 4000;
const MAX_ERROR_DETAIL_LENGTH = 600;
const MAX_AVAILABLE_SKILLS = 20;
const NOISE_LINE_PATTERN =
	/(^Tip:|^Source:|Cloning repositor|Repository cloned|^Found \d+ skills)/i;
const NO_MATCHING_SKILLS_PATTERN = /No matching skills found/i;
const DEFAULT_LIST_TIMEOUT_MS = 10_000;
const DEFAULT_IMPORT_TIMEOUT_MS = 120_000;
const KILL_GRACE_MS = 2_000;
const PUBLIC_LISTING_PATHS = ["/", "/trending", "/hot", "/official"] as const;

export interface SkillsShListItem {
	id: string;
	slug: string;
	name: string;
	source: string;
	installs?: string;
	url: string;
}

export interface SkillsShClientOptions {
	listTimeoutMs?: number;
	importTimeoutMs?: number;
}

export class SkillsShClient {
	private readonly directoryCache = createAsyncCache<SkillsShListItem[]>();

	constructor(private readonly options: SkillsShClientOptions = {}) {}

	async listDirectory(signal?: AbortSignal): Promise<SkillsShListItem[]> {
		return this.directoryCache.get(() => this.fetchDirectory(signal));
	}

	async refreshDirectory(signal?: AbortSignal): Promise<SkillsShListItem[]> {
		this.directoryCache.clear();
		return this.listDirectory(signal);
	}

	async importSkill(
		id: string,
		cwd: string,
		signal?: AbortSignal,
	): Promise<void> {
		const { source, slug } = splitSkillsShId(id);
		try {
			await runSkillsCommand(
				[
					"-y",
					"skills",
					"add",
					source,
					"--skill",
					slug,
					"-a",
					"universal",
					"-y",
				],
				cwd,
				{
					signal,
					timeoutMs: this.options.importTimeoutMs ?? DEFAULT_IMPORT_TIMEOUT_MS,
				},
			);
		} catch (err) {
			throw this.describeImportError(err, source, slug);
		}
	}

	private describeImportError(
		err: unknown,
		source: string,
		slug: string,
	): unknown {
		if (!(err instanceof SkillsCliError)) return err;
		if (!NO_MATCHING_SKILLS_PATTERN.test(err.output)) return err;
		this.directoryCache.clear();
		const available = availableSkillsFromOutput(err.output);
		const listing =
			available.length > 0
				? ` Skills available in that source: ${available.join(", ")}.`
				: "";
		return new Error(
			`Skill "${slug}" was not found in ${source} — the skills.sh listing may be out of date.${listing}`,
			{ cause: err },
		);
	}

	private async fetchDirectory(
		signal?: AbortSignal,
	): Promise<SkillsShListItem[]> {
		const pages = await Promise.all(
			PUBLIC_LISTING_PATHS.map(async (path) => {
				const html = await fetchSkillsPage(
					path,
					signal,
					this.options.listTimeoutMs ?? DEFAULT_LIST_TIMEOUT_MS,
				);
				return parseSkillsShHtml(html);
			}),
		);

		return dedupeItems(pages.flat());
	}
}

export class SkillsCliError extends Error {
	constructor(
		message: string,
		readonly output: string,
	) {
		super(message);
		this.name = "SkillsCliError";
	}
}

export function condenseSkillsCliOutput(output: string): string {
	const lines = stripAnsi(output)
		.split(/\r?\n|\r/)
		.map((line) => line.trim())
		.filter(isMeaningfulLine);
	return lines.join("\n").slice(-MAX_ERROR_DETAIL_LENGTH).trim();
}

export function availableSkillsFromOutput(output: string): string[] {
	const names: string[] = [];
	for (const line of stripAnsi(output).split(/\r?\n|\r/)) {
		const match = /^\s*-\s+([A-Za-z0-9._-]+)\s*$/.exec(line);
		if (match?.[1]) names.push(match[1]);
	}
	if (names.length <= MAX_AVAILABLE_SKILLS) return names;
	return [
		...names.slice(0, MAX_AVAILABLE_SKILLS),
		`… (+${names.length - MAX_AVAILABLE_SKILLS} more)`,
	];
}

function isMeaningfulLine(line: string): boolean {
	if (!line) return false;
	if (NOISE_LINE_PATTERN.test(line)) return false;
	const informative = line.match(/[A-Za-z0-9]/g)?.length ?? 0;
	return informative / line.length >= 0.4;
}

export function parseSkillsShHtml(html: string): SkillsShListItem[] {
	const items: SkillsShListItem[] = [];
	const seen = new Set<string>();
	const anchorPattern =
		/<a\b[^>]*href=["']\/([^"'?#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;

	for (const match of html.matchAll(anchorPattern)) {
		const rawPath = match[1];
		if (!rawPath) continue;

		const parts = rawPath.split("/").filter(Boolean);
		if (parts.length < 2) continue;

		const slug = decodeURIComponent(parts[parts.length - 1] ?? "");
		const source = parts.slice(0, -1).map(decodeURIComponent).join("/");
		if (!slug || !source) continue;
		if (!isValidSkillsShSource(source) || !isValidSkillsShSlug(slug)) continue;

		const text = stripTags(match[2] ?? "");
		const installs = installCount(text);
		if (!installs) continue;

		const id = `${source}/${slug}`;
		if (seen.has(id)) continue;
		seen.add(id);

		items.push({
			id,
			slug,
			name: displayName(text, slug),
			source,
			installs,
			url: `${BASE_URL}/${id}`,
		});
	}

	return items;
}

export function splitSkillsShId(id: string): { source: string; slug: string } {
	const parts = id.split("/").filter(Boolean);
	if (parts.length < 2) throw new Error(`Invalid skills.sh skill id: ${id}`);
	const slug = parts[parts.length - 1];
	const source = parts.slice(0, -1).join("/");
	if (!slug || !source) throw new Error(`Invalid skills.sh skill id: ${id}`);
	if (!isValidSkillsShSource(source) || !isValidSkillsShSlug(slug)) {
		throw new Error(`Invalid skills.sh skill id: ${id}`);
	}
	return { source, slug };
}

function displayName(text: string, fallback: string): string {
	const compact = text.replace(/\s+/g, " ").trim();
	if (!compact) return fallback;
	const withoutRank = compact.replace(/^\d+\s+/, "");
	const first = withoutRank.split(/\s+/)[0];
	return first && !looksLikeCount(first) ? first : fallback;
}

function installCount(text: string): string | undefined {
	const compact = text.replace(/\s+/g, " ").trim();
	const match = /(\d+(?:\.\d+)?[KMB]?)$/.exec(compact);
	return match?.[1];
}

function looksLikeCount(value: string): boolean {
	return /^\d+(?:\.\d+)?[KMB]?$/.test(value);
}

function dedupeItems(items: readonly SkillsShListItem[]): SkillsShListItem[] {
	const seen = new Set<string>();
	const deduped: SkillsShListItem[] = [];
	for (const item of items) {
		if (seen.has(item.id)) continue;
		seen.add(item.id);
		deduped.push(item);
	}
	return deduped;
}

function stripTags(value: string): string {
	return value
		.replace(/<script\b[\s\S]*?<\/script>/gi, "")
		.replace(/<style\b[\s\S]*?<\/style>/gi, "")
		.replace(/<[^>]+>/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'");
}

async function fetchSkillsPage(
	path: string,
	signal: AbortSignal | undefined,
	timeoutMs: number,
): Promise<string> {
	const controller = new AbortController();
	let timedOut = false;
	const abort = (): void => controller.abort();
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);

	if (signal?.aborted) controller.abort();
	else signal?.addEventListener("abort", abort, { once: true });

	try {
		const response = await fetch(`${BASE_URL}${path}`, {
			signal: controller.signal,
		});
		if (!response.ok) {
			throw new Error(
				`skills.sh request failed for ${path}: HTTP ${response.status}`,
			);
		}
		return response.text();
	} catch (err) {
		if (timedOut) throw new Error(`skills.sh request timed out for ${path}`);
		throw err;
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", abort);
	}
}

function runSkillsCommand(
	args: string[],
	cwd: string,
	options: { signal?: AbortSignal; timeoutMs: number },
): Promise<void> {
	return new Promise((resolve, reject) => {
		if (options.signal?.aborted) {
			reject(abortError("skills import cancelled"));
			return;
		}

		const command = npxCommand(args);
		const child = spawn(command.file, command.args, {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		let settled = false;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		let killTimeout: ReturnType<typeof setTimeout> | undefined;

		const append = (chunk: Buffer): void => {
			output = `${output}${chunk.toString("utf8")}`.slice(-MAX_OUTPUT_LENGTH);
		};
		const detail = (): string => condenseSkillsCliOutput(output);
		const cleanup = (clearKillTimeout = true): void => {
			if (timeout) clearTimeout(timeout);
			if (clearKillTimeout && killTimeout) clearTimeout(killTimeout);
			options.signal?.removeEventListener("abort", abort);
		};
		const finish = (err?: Error, keepKillTimeout = false): void => {
			if (settled) return;
			settled = true;
			cleanup(!keepKillTimeout);
			if (err) reject(err);
			else resolve();
		};
		const stopChild = (): void => {
			child.kill("SIGTERM");
			killTimeout = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
		};
		const abort = (): void => {
			stopChild();
			finish(abortError("skills import cancelled"), true);
		};

		timeout = setTimeout(() => {
			stopChild();
			const extra = detail();
			finish(
				new Error(
					`skills import timed out after ${Math.round(
						options.timeoutMs / 1000,
					)}s${extra ? `: ${extra}` : ""}`,
				),
				true,
			);
		}, options.timeoutMs);
		options.signal?.addEventListener("abort", abort, { once: true });

		child.stdout.on("data", append);
		child.stderr.on("data", append);
		child.on("error", (err) => {
			finish(new Error(`Failed to run npx skills: ${err.message}`));
		});
		child.on("close", (code) => {
			if (settled) {
				if (killTimeout) clearTimeout(killTimeout);
				return;
			}
			if (code === 0) {
				finish();
				return;
			}
			finish(
				new SkillsCliError(
					`skills import failed: ${detail() || `exit code ${code}`}`,
					output,
				),
			);
		});
	});
}

function abortError(message: string): Error {
	const err = new Error(message);
	err.name = "AbortError";
	return err;
}

export function npxCommand(
	args: string[],
	platform: NodeJS.Platform = process.platform,
): { file: string; args: string[] } {
	if (platform !== "win32") return { file: "npx", args };
	return {
		file: "cmd.exe",
		args: ["/d", "/c", ["npx.cmd", ...args.map(cmdSafeArg)].join(" ")],
	};
}

function isValidSkillsShSource(source: string): boolean {
	return (
		/^[A-Za-z0-9._/-]+$/.test(source) &&
		source.split("/").every(isSafeSkillsShSegment)
	);
}

function isValidSkillsShSlug(slug: string): boolean {
	return /^[A-Za-z0-9._-]+$/.test(slug) && isSafeSkillsShSegment(slug);
}

function isSafeSkillsShSegment(segment: string): boolean {
	return segment !== "." && segment !== ".." && !segment.startsWith("-");
}

function cmdSafeArg(value: string): string {
	if (!/^[A-Za-z0-9._/=-]+$/.test(value)) {
		throw new Error(`Unsafe npx argument for cmd.exe: ${value}`);
	}
	return value;
}
