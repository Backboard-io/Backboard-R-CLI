/**
 * Curated command patterns that keep prompting in auto mode. The mirror image
 * of `safeCommands.ts`: auto allows everything except these, so the list names
 * what is irreversible or outward-facing — grow it from real usage, not
 * speculation. Matching is heuristic; deny rules and checkpoints remain the
 * backstops.
 */

import { homedir } from "node:os";
import { resolve } from "node:path";
import { pathsInsideCwd } from "./pathsInside.ts";
import { UNSAFE_FIND_FLAGS, UNSAFE_RG_FLAGS } from "./safeCommands.ts";

/** Binaries dangerous regardless of arguments. Keyed by normalized head. */
const DANGEROUS_BINARIES = new Map<string, string>([
	["sudo", "escalates privileges"],
	["doas", "escalates privileges"],
	["su", "escalates privileges"],
	["pkexec", "escalates privileges"],
	["dd", "writes raw disk data"],
	["shutdown", "controls system power"],
	["reboot", "controls system power"],
	["halt", "controls system power"],
	["poweroff", "controls system power"],
	["stop-computer", "controls system power"],
	["restart-computer", "controls system power"],
	["pkill", "kills processes"],
	["killall", "kills processes"],
	["tskill", "kills processes"],
	["launchctl", "controls system services"],
	["systemctl", "controls system services"],
	["stop-service", "controls system services"],
	["restart-service", "controls system services"],
	["set-service", "controls system services"],
	["format", "formats a filesystem"],
	["regedit", "edits the registry"],
]);

/** git subcommands dangerous on their own, no flag inspection needed. */
const DANGEROUS_GIT_SUBCOMMANDS = new Map<string, string>([
	["push", "publishes to a remote"],
	["clean", "deletes untracked files"],
	["restore", "discards local changes"],
]);

/** git global options that consume the following token before the subcommand. */
const GIT_OPTIONS_WITH_VALUE = new Set([
	"-C",
	"-c",
	"--git-dir",
	"--work-tree",
	"--namespace",
	"--exec-path",
	"--config-env",
]);

/**
 * git config keys whose value git executes as a command, so a `-c KEY=CMD`
 * override is an inline command-execution vector (matched case-insensitively;
 * `pager.`/`filter.` are prefix families).
 */
const GIT_EXEC_CONFIG_KEYS = new Set([
	"core.pager",
	"core.editor",
	"core.sshcommand",
	"core.fsmonitor",
	"core.hookspath",
	"sequence.editor",
	"diff.external",
	"gpg.program",
	"credential.helper",
	"init.templatedir",
]);

/** Prefix commands that run another command; the danger check looks past them. */
const WRAPPER_BINARIES = new Set([
	"xargs",
	"env",
	"nohup",
	"time",
	"timeout",
	"stdbuf",
	"nice",
	"ionice",
	"setsid",
	"command",
	"exec",
	"builtin",
	"watch",
]);

/**
 * Wrapper options that consume the following token as their value. Skipping the
 * flag without its value would leave the value as the apparent command, hiding
 * the real nested command (`env -u FOO sudo id`, `xargs -I X rm -rf X`). `=`-joined
 * forms carry their own value in one token and never reach this set.
 */
const WRAPPER_VALUE_OPTIONS = new Map<string, Set<string>>([
	["env", new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"])],
	[
		"xargs",
		new Set([
			"-I",
			"-i",
			"--replace",
			"-E",
			"-e",
			"--eof",
			"-L",
			"--max-lines",
			"-n",
			"--max-args",
			"-P",
			"--max-procs",
			"-s",
			"--max-chars",
			"-a",
			"--arg-file",
			"-d",
			"--delimiter",
		]),
	],
	["nice", new Set(["-n", "--adjustment"])],
	["ionice", new Set(["-c", "--class", "-n", "--classdata", "-p", "--pid"])],
	["stdbuf", new Set(["-i", "--input", "-o", "--output", "-e", "--error"])],
	["watch", new Set(["-n", "--interval"])],
	["timeout", new Set(["-s", "--signal", "-k", "--kill-after"])],
]);

const SHELL_BINARIES = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);

/**
 * Shell reserved words that can lead a segment before the real command
 * (`then rm -rf /`, `do sudo reboot`). Stripped from the head so the command
 * they introduce is still classified. Case-sensitive, as the shell treats them.
 */
const SHELL_KEYWORDS = new Set([
	"if",
	"then",
	"elif",
	"else",
	"fi",
	"do",
	"done",
	"while",
	"until",
	"for",
	"select",
	"case",
	"esac",
	"in",
	"function",
	"!",
	"{",
	"}",
]);

const PUBLISH_RUNNERS = new Set(["npm", "pnpm", "yarn", "bun"]);

const RECURSIVE_OR_FORCE_FLAG =
	/^(-[A-Za-z]*[rRfF][A-Za-z]*|--force|--recursive)$/;

const RECURSIVE_FLAG = /^(-[A-Za-z]*[rR][A-Za-z]*|--recursive)$/;

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

const SHELL_COMMAND_FLAG = /^-[A-Za-z]*c$/;

const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/;

/** Env vars that expand to a temp location — writes there stay harmless. */
const TEMP_ENV_VARS = new Set(["TMPDIR", "TMP", "TEMP"]);

/** Redirect or path targets that stay harmless outside the workspace. */
const TEMP_PATH_PREFIXES = [
	"/dev/",
	"/tmp/",
	"/private/tmp/",
	"/var/tmp/",
	"/private/var/tmp/",
	"/var/folders/",
	"/private/var/folders/",
];

const MAX_SCAN_DEPTH = 4;

/** Bash ANSI-C (`$'...'`) backslash escapes that matter for command splitting. */
const ANSI_C_ESCAPES: Record<string, string> = {
	n: "\n",
	t: "\t",
	r: "\r",
	"\\": "\\",
	"'": "'",
	'"': '"',
	"0": "\0",
};

interface CommandSegment {
	tokens: string[];
	redirects: string[];
	viaPipe: boolean;
}

/**
 * Split a command line into segments of quote-stripped tokens, recording
 * output-redirect targets and whether a segment is fed by a pipe. Quoted
 * delimiters stay literal; `$(` and backticks split even inside double quotes
 * because real shells substitute there.
 */
function parseSegments(command: string): CommandSegment[] {
	const segments: CommandSegment[] = [];
	let tokens: string[] = [];
	let redirects: string[] = [];
	let viaPipe = false;
	let token = "";
	let hasToken = false;
	let inSingle = false;
	let inDouble = false;

	const endToken = () => {
		if (hasToken) tokens.push(token);
		token = "";
		hasToken = false;
	};
	const endSegment = (nextViaPipe: boolean) => {
		endToken();
		segments.push({ tokens, redirects, viaPipe });
		tokens = [];
		redirects = [];
		viaPipe = nextViaPipe;
	};
	const append = (ch: string) => {
		token += ch;
		hasToken = true;
	};

	let i = 0;
	while (i < command.length) {
		const ch = command[i] as string;
		const next = command[i + 1];
		if (inSingle) {
			if (ch === "'") inSingle = false;
			else append(ch);
			i += 1;
			continue;
		}
		if (
			inDouble &&
			ch === "\\" &&
			(next === '"' || next === "$" || next === "`" || next === "\\")
		) {
			append(next);
			i += 2;
			continue;
		}
		if (ch === "$" && next === "(") {
			endSegment(false);
			inDouble = false;
			i += 2;
			continue;
		}
		if (!inDouble && ch === "$" && next === "'") {
			hasToken = true;
			i += 2;
			while (i < command.length && command[i] !== "'") {
				const c = command[i] as string;
				if (c === "\\" && i + 1 < command.length) {
					const escaped = command[i + 1] as string;
					append(ANSI_C_ESCAPES[escaped] ?? escaped);
					i += 2;
				} else {
					append(c);
					i += 1;
				}
			}
			i += 1;
			continue;
		}
		if (!inDouble && ch === "$" && next === '"') {
			i += 1;
			continue;
		}
		if (ch === "`") {
			endSegment(false);
			inDouble = false;
			i += 1;
			continue;
		}
		if (inDouble) {
			if (ch === '"') inDouble = false;
			else append(ch);
			i += 1;
			continue;
		}
		if (ch === "\\") {
			if (next !== undefined && " \t\n'\"$`\\|&;<>()".includes(next)) {
				append(next);
				i += 2;
			} else {
				append(ch);
				i += 1;
			}
			continue;
		}
		if (ch === "'") {
			inSingle = true;
			hasToken = true;
			i += 1;
			continue;
		}
		if (ch === '"') {
			inDouble = true;
			hasToken = true;
			i += 1;
			continue;
		}
		if (ch === "&" && next === "&") {
			endSegment(false);
			i += 2;
			continue;
		}
		if (ch === "|" && next === "|") {
			endSegment(false);
			i += 2;
			continue;
		}
		if (ch === "|") {
			endSegment(true);
			i += next === "&" ? 2 : 1;
			continue;
		}
		if (ch === ";" || ch === "&" || ch === "\n" || ch === "(" || ch === ")") {
			endSegment(false);
			i += 1;
			continue;
		}
		if (ch === ">") {
			if (hasToken && /^\d+$/.test(token)) {
				token = "";
				hasToken = false;
			} else {
				endToken();
			}
			i += next === ">" ? 2 : 1;
			if (command[i] === "|") i += 1;
			if (command[i] === "&") {
				i += 1;
				while (i < command.length && /\d/.test(command[i] as string)) i += 1;
				continue;
			}
			while (command[i] === " " || command[i] === "\t") i += 1;
			let target = "";
			while (i < command.length) {
				const c = command[i] as string;
				if (c === "'" || c === '"') {
					i += 1;
					while (i < command.length && command[i] !== c) {
						target += command[i];
						i += 1;
					}
					i += 1;
					continue;
				}
				if (" \t\n;|&()<>`".includes(c)) break;
				target += c;
				i += 1;
			}
			if (target) redirects.push(target);
			continue;
		}
		if (ch === "<") {
			endToken();
			i += 1;
			continue;
		}
		if (ch === " " || ch === "\t" || ch === "\r") {
			endToken();
			i += 1;
			continue;
		}
		append(ch);
		i += 1;
	}
	endSegment(false);
	return segments;
}

function normalizeBinary(token: string): string {
	return token
		.replace(/^.*[\\/]/, "")
		.toLowerCase()
		.replace(/\.(exe|cmd|bat|com)$/, "");
}

/** Skip env assignments and wrapper commands to reach the command they run. */
function effectiveTokens(tokens: string[]): string[] {
	let rest = tokens;
	while (rest.length > 0) {
		const first = rest[0] as string;
		if (SHELL_KEYWORDS.has(first)) {
			rest = rest.slice(1);
			continue;
		}
		if (ENV_ASSIGNMENT.test(first)) {
			rest = rest.slice(1);
			continue;
		}
		const name = normalizeBinary(first);
		if (!WRAPPER_BINARIES.has(name)) break;
		const valueOptions = WRAPPER_VALUE_OPTIONS.get(name);
		rest = rest.slice(1);
		while (rest.length > 0) {
			const token = rest[0] as string;
			if (token.startsWith("-")) {
				const consumesValue = valueOptions?.has(token) && !token.includes("=");
				rest = rest.slice(consumesValue ? 2 : 1);
				continue;
			}
			if (/^\d+[smhd]?$/.test(token) || token === "{}") {
				rest = rest.slice(1);
				continue;
			}
			break;
		}
	}
	return rest;
}

/** The temp root containing a resolved path, if its lexical path is temporary. */
function tempRootFor(resolved: string): string | undefined {
	const prefix = TEMP_PATH_PREFIXES.find(
		(candidate) =>
			resolved === candidate.slice(0, -1) || resolved.startsWith(candidate),
	);
	return prefix?.slice(0, -1);
}

/**
 * Expand the leading `~`, `$HOME`/`${HOME}`, and `$PWD` of a path so the
 * outside-workspace check sees the real target. Temp vars collapse to a temp
 * path; any other unresolved `$VAR` is left intact so the caller can treat it
 * conservatively as external.
 */
function expandLeadingVar(target: string, cwd: string | undefined): string {
	if (target === "~" || target.startsWith("~/")) {
		return homedir() + target.slice(1);
	}
	const match = target.match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?(.*)$/s);
	if (!match) return target;
	const name = match[1] as string;
	const rest = match[2] as string;
	if (name === "HOME") return homedir() + rest;
	if (name === "PWD" && cwd) return cwd + rest;
	if (TEMP_ENV_VARS.has(name)) return `/tmp${rest}`;
	return target;
}

/**
 * The workspace boundary (`root`) plus the effective directory relative paths
 * resolve against (`dir`), which a preceding `cd` can move. `dir === undefined`
 * with a known `root` means a `cd` left the tree or could not be resolved, so
 * relative paths are treated conservatively as external.
 */
interface DirContext {
	dir: string | undefined;
	root: string | undefined;
}

/**
 * Whether a path argument or redirect target lands outside the workspace.
 * Relative paths resolve against `dir` and are tested against `root`. Without a
 * root every absolute, `~`, or parent-relative path counts as outside; temp and
 * null-device paths never do. An unresolved `$VAR` that is not a known temp/PWD
 * var is treated as external — the shell may expand it anywhere, so auto mode
 * should still prompt.
 */
function pathOutside(
	target: string,
	dir: string | undefined,
	root: string | undefined,
): boolean {
	const candidate = expandLeadingVar(target, dir);
	if (WINDOWS_ABSOLUTE.test(candidate)) {
		if (!root || !WINDOWS_ABSOLUTE.test(root)) return true;
		const norm = (value: string) =>
			value.replaceAll("\\", "/").toLowerCase().replace(/\/+$/, "");
		return !(
			norm(candidate) === norm(root) ||
			norm(candidate).startsWith(`${norm(root)}/`)
		);
	}
	const lower = candidate.toLowerCase();
	if (lower === "nul" || lower === "/dev/null") return false;
	if (candidate.startsWith("$")) return true;
	if (candidate.startsWith("/")) {
		// Normalize before exempting temp prefixes so `/tmp/../../etc/hosts`
		// is judged by where it actually lands, not its literal prefix.
		const resolved = resolve(candidate);
		const tempRoot = tempRootFor(resolved);
		if (tempRoot && pathsInsideCwd([resolved], tempRoot)) return false;
		if (!root) return true;
		return !pathsInsideCwd([resolved], resolve(root));
	}
	if (dir === undefined) {
		if (!root) {
			return (
				candidate === ".." ||
				candidate.startsWith("../") ||
				candidate.startsWith("..\\")
			);
		}
		return true;
	}
	const boundary = resolve(root ?? dir);
	return !pathsInsideCwd([resolve(dir, candidate)], boundary);
}

function outsidePathArg(rest: string[], ctx: DirContext): boolean {
	return rest.some(
		(t) => !t.startsWith("-") && pathOutside(t, ctx.dir, ctx.root),
	);
}

/**
 * The directory a `cd` moves to, or undefined when it leaves the workspace root
 * or cannot be resolved statically (home, a variable, a glob, or a relative
 * target from an already-unknown directory). Kept as a concrete path only while
 * we stay provably inside the root.
 */
function nextDir(
	dir: string | undefined,
	args: string[],
	root: string,
): string | undefined {
	const target = args.find((a) => !a.startsWith("-"));
	if (target === undefined) return undefined;
	if (target === "-" || target.startsWith("~") || target.startsWith("$")) {
		return undefined;
	}
	if (/[*?]/.test(target)) return undefined;
	let resolved: string;
	if (target.startsWith("/") || WINDOWS_ABSOLUTE.test(target)) {
		resolved = resolve(target);
	} else if (dir === undefined) {
		return undefined;
	} else {
		resolved = resolve(dir, target);
	}
	const boundary = resolve(root);
	return pathsInsideCwd([resolved], boundary) ? resolved : undefined;
}

function isLocalHttpUrl(token: string): boolean {
	const match = token.match(/^https?:\/\/([^/:?#]+)/i);
	if (!match) return false;
	const host = (match[1] as string).toLowerCase();
	return (
		host === "localhost" ||
		host.endsWith(".localhost") ||
		host === "127.0.0.1" ||
		host === "::1" ||
		host === "0.0.0.0"
	);
}

/**
 * A curl/wget invocation that writes to remote state: an explicit non-GET/HEAD
 * method or a request body/upload. Plain reads (downloads) stay unflagged; the
 * pipe-into-shell case is handled separately. Requests aimed only at localhost
 * are left alone so local dev-server calls don't prompt.
 */
function mutatingHttpReason(head: string, rest: string[]): string | undefined {
	if (head !== "curl" && head !== "wget") return undefined;
	const urls: string[] = [];
	for (let index = 0; index < rest.length; index++) {
		const token = rest[index] as string;
		if (/^https?:\/\//i.test(token)) {
			urls.push(token);
			continue;
		}
		if (token === "--url") {
			const value = rest[index + 1];
			if (value && /^https?:\/\//i.test(value)) urls.push(value);
			index++;
			continue;
		}
		const assigned = token.match(/^--url=(https?:\/\/.+)$/i);
		if (assigned?.[1]) urls.push(assigned[1]);
	}
	if (urls.length === 0 || urls.every(isLocalHttpUrl)) return undefined;

	const methodIndex = rest.findIndex((t) => t === "-X" || t === "--request");
	const method = (
		methodIndex >= 0
			? rest[methodIndex + 1]
			: (rest.find((t) => /^-X./.test(t))?.slice(2) ??
				rest.find((t) => /^--request=/.test(t))?.slice("--request=".length) ??
				rest.find((t) => /^--method=/i.test(t))?.split("=")[1])
	)?.toUpperCase();
	const mutatingMethod =
		method !== undefined && method !== "GET" && method !== "HEAD";

	const hasBody = rest.some(
		(t) =>
			/^-[dFT]$/.test(t) ||
			/^-[dFT]./.test(t) ||
			/^--(data|form|upload-file|json|post-data|post-file|body-data|body-file)/.test(
				t,
			),
	);
	return mutatingMethod || hasBody
		? "sends a mutating network request"
		: undefined;
}

/**
 * The write destination of a cp/mv: an explicit `-t DIR` /
 * `--target-directory=DIR` when present, otherwise the final operand.
 */
function copyMoveDest(rest: string[]): string | undefined {
	const flagIndex = rest.findIndex(
		(t) => t === "-t" || t === "--target-directory",
	);
	if (flagIndex >= 0) return rest[flagIndex + 1];
	const stuck = rest.find(
		(t) => t.startsWith("--target-directory=") || /^-t.+/.test(t),
	);
	if (stuck) {
		return stuck.startsWith("--target-directory=")
			? stuck.slice("--target-directory=".length)
			: stuck.slice(2);
	}
	return [...rest].reverse().find((t) => !t.startsWith("-"));
}

/**
 * Why a `git -c KEY=VALUE` / `--config-env` override is dangerous: it installs
 * a shell alias (`alias.x=!cmd`) or points a command-executing key at a command.
 * The embedded command is scanned so benign overrides (`core.pager=less`) pass.
 */
function gitConfigReason(
	value: string,
	ctx: DirContext,
	depth: number,
): string | undefined {
	const eq = value.indexOf("=");
	if (eq < 0) return undefined;
	const key = value.slice(0, eq).toLowerCase();
	const val = value.slice(eq + 1);
	if (key.startsWith("alias.")) {
		return val.startsWith("!")
			? "runs a shell command via git config"
			: commandReason(`git ${val}`, ctx, depth + 1);
	}
	if (
		GIT_EXEC_CONFIG_KEYS.has(key) ||
		key.startsWith("pager.") ||
		(key.startsWith("filter.") &&
			(key.endsWith(".clean") ||
				key.endsWith(".smudge") ||
				key.endsWith(".process")))
	) {
		return commandReason(val, ctx, depth + 1);
	}
	return undefined;
}

function gitReason(
	rest: string[],
	ctx: DirContext,
	depth: number,
): string | undefined {
	let index = 0;
	while (index < rest.length && (rest[index] as string).startsWith("-")) {
		const opt = rest[index] as string;
		let configValue: string | undefined;
		if (opt === "-c" || opt === "--config-env") {
			configValue = rest[index + 1];
			index += 2;
		} else if (opt.startsWith("-c") && opt.length > 2) {
			configValue = opt.slice(2);
			index += 1;
		} else if (opt.startsWith("--config-env=")) {
			configValue = opt.slice("--config-env=".length);
			index += 1;
		} else {
			index += GIT_OPTIONS_WITH_VALUE.has(opt) ? 2 : 1;
		}
		if (configValue !== undefined) {
			const reason = gitConfigReason(configValue, ctx, depth);
			if (reason) return reason;
		}
	}
	const subcommand = rest[index];
	if (subcommand === undefined) return undefined;
	const flat = DANGEROUS_GIT_SUBCOMMANDS.get(subcommand);
	if (flat) return flat;
	const args = rest.slice(index + 1);
	if (subcommand === "reset" && args.includes("--hard")) {
		return "discards local changes";
	}
	if (subcommand === "checkout") {
		if (args.includes("-b") || args.includes("-B")) return undefined;
		if (args.includes("-f") || args.includes("--force")) {
			return "discards local changes";
		}
		if (
			args.includes("--") ||
			args.some((t) => !t.startsWith("-") && t.includes("."))
		) {
			return "discards local changes";
		}
	}
	if (
		subcommand === "switch" &&
		(args.includes("-f") ||
			args.includes("--force") ||
			args.includes("--discard-changes"))
	) {
		return "discards local changes";
	}
	if (subcommand === "branch") {
		if (
			args.includes("-D") ||
			args.includes("-M") ||
			args.includes("-C") ||
			args.includes("-f") ||
			args.includes("--force")
		) {
			return "deletes or overwrites a branch";
		}
		if (
			(args.includes("-d") || args.includes("--delete")) &&
			(args.includes("-f") || args.includes("--force"))
		) {
			return "deletes or overwrites a branch";
		}
	}
	if (subcommand === "stash") {
		const op = args.find((t) => !t.startsWith("-"));
		if (op === "clear" || op === "drop") return "discards stashed changes";
	}
	if (
		subcommand === "tag" &&
		(args.includes("-d") ||
			args.includes("--delete") ||
			args.includes("-f") ||
			args.includes("--force"))
	) {
		return "deletes or overwrites a tag";
	}
	return undefined;
}

function segmentReason(
	segment: CommandSegment,
	ctx: DirContext,
	depth: number,
): string | undefined {
	if (segment.redirects.some((t) => pathOutside(t, ctx.dir, ctx.root))) {
		return "writes outside the working directory";
	}
	const tokens = effectiveTokens(segment.tokens);
	const head = normalizeBinary(tokens[0] ?? "");
	if (!head) return undefined;

	const flat = DANGEROUS_BINARIES.get(head);
	if (flat) return flat;
	if (head.startsWith("mkfs")) return "formats a filesystem";

	const rest = tokens.slice(1);
	const restText = rest.join(" ");

	if (head === "eval") return commandReason(restText, ctx, depth + 1);
	if (SHELL_BINARIES.has(head)) {
		const flagIndex = rest.findIndex((t) => SHELL_COMMAND_FLAG.test(t));
		const payload = flagIndex >= 0 ? rest[flagIndex + 1] : undefined;
		return payload ? commandReason(payload, ctx, depth + 1) : undefined;
	}
	if (head === "powershell" || head === "pwsh") {
		const flagIndex = rest.findIndex((t) => /^-c(ommand)?$/i.test(t));
		const payload = (flagIndex >= 0 ? rest.slice(flagIndex + 1) : rest).join(
			" ",
		);
		return payload ? commandReason(payload, ctx, depth + 1) : undefined;
	}
	if (head === "cmd") {
		const flagIndex = rest.findIndex((t) => /^\/[ck]$/i.test(t));
		const payload = flagIndex >= 0 ? rest.slice(flagIndex + 1).join(" ") : "";
		return payload ? commandReason(payload, ctx, depth + 1) : undefined;
	}

	if (head === "rm") {
		if (rest.some((t) => RECURSIVE_OR_FORCE_FLAG.test(t))) {
			return "recursive or forced delete";
		}
		if (outsidePathArg(rest, ctx)) {
			return "deletes files outside the working directory";
		}
		return undefined;
	}
	if (head === "remove-item" || head === "ri") {
		if (rest.some((t) => /^-(recurse|force)/i.test(t))) {
			return "recursive or forced delete";
		}
		if (outsidePathArg(rest, ctx)) {
			return "deletes files outside the working directory";
		}
		return undefined;
	}
	if (head === "del" || head === "erase") {
		if (rest.some((t) => /^\/[sfq]$/i.test(t))) {
			return "recursive or forced delete";
		}
		if (outsidePathArg(rest, ctx)) {
			return "deletes files outside the working directory";
		}
		return undefined;
	}
	if (head === "rd" || head === "rmdir") {
		if (rest.some((t) => /^\/s$/i.test(t))) {
			return "recursive or forced delete";
		}
		return undefined;
	}
	if (head === "mv" || head === "cp") {
		const dest = copyMoveDest(rest);
		if (dest !== undefined && pathOutside(dest, ctx.dir, ctx.root)) {
			return "writes outside the working directory";
		}
		return undefined;
	}
	if (head === "kill") {
		// Drop a single leading signal spec (-9, -KILL, -s TERM, --signal=TERM);
		// every remaining target must be a plain positive PID. A negative target
		// (-1 = all processes the user can signal, -PGID = a whole group) or a
		// %job / name spec is a broad kill that must still prompt.
		let targets = rest;
		const first = targets[0];
		if (first === "-s" || first === "--signal") {
			targets = targets.slice(2);
		} else if (
			first !== undefined &&
			/^(-\d+|-[A-Za-z][A-Za-z0-9]*|--signal=.+)$/.test(first)
		) {
			targets = targets.slice(1);
		}
		const safeTargets =
			targets.length > 0 && targets.every((t) => /^\d+$/.test(t));
		return safeTargets ? undefined : "kills processes";
	}
	if (head === "taskkill") {
		const byName = rest.some(
			(t) => t.toLowerCase() === "/im" || t.toLowerCase() === "/fi",
		);
		return byName ? "kills processes" : undefined;
	}
	if (head === "stop-process") {
		return rest.some((t) => /^-name/i.test(t)) ? "kills processes" : undefined;
	}
	if (
		(head === "chmod" || head === "chown" || head === "chgrp") &&
		rest.some((t) => RECURSIVE_FLAG.test(t))
	) {
		return "recursive permission change";
	}
	if (head === "curl" || head === "wget") {
		return mutatingHttpReason(head, rest);
	}
	if (head === "git") return gitReason(rest, ctx, depth);
	if (PUBLISH_RUNNERS.has(head) && rest.includes("publish")) {
		return "publishes a package";
	}
	if (head === "cargo" && rest[0] === "publish") return "publishes a package";
	if (head === "twine" && rest[0] === "upload") return "publishes a package";
	if (head === "find" && UNSAFE_FIND_FLAGS.test(restText)) {
		return "deletes files or runs commands via find";
	}
	if (head === "rg" && UNSAFE_RG_FLAGS.test(restText)) {
		return "runs commands via rg";
	}
	const sub = rest[0]?.toLowerCase();
	if (
		head === "reg" &&
		(sub === "delete" || sub === "add" || sub === "import")
	) {
		return "edits the registry";
	}
	if (
		head === "sc" &&
		(sub === "stop" ||
			sub === "delete" ||
			sub === "config" ||
			sub === "failure")
	) {
		return "controls system services";
	}
	if (head === "net" && sub === "stop") return "controls system services";
	return undefined;
}

function commandReason(
	command: string,
	ctx: DirContext,
	depth: number,
): string | undefined {
	if (depth > MAX_SCAN_DEPTH) return undefined;
	const segments = parseSegments(command);
	let downloadInChain = false;
	let dir = ctx.dir;
	for (const segment of segments) {
		if (!segment.viaPipe) downloadInChain = false;
		const tokens = effectiveTokens(segment.tokens);
		const head = normalizeBinary(tokens[0] ?? "");
		if (downloadInChain && SHELL_BINARIES.has(head)) {
			return "pipes a download into a shell";
		}
		if (head === "curl" || head === "wget") downloadInChain = true;
		const reason = segmentReason(segment, { dir, root: ctx.root }, depth);
		if (reason) return reason;
		// A `cd` reached without a pipe (its own subshell) persists to the
		// following sequential commands, moving where their relative paths land.
		if (head === "cd" && !segment.viaPipe && ctx.root !== undefined) {
			dir = nextDir(dir, tokens.slice(1), ctx.root);
		}
	}
	return undefined;
}

/**
 * Returns why a command should still prompt in auto mode, or undefined when
 * auto may run it. Substitution and subshell delimiters count as segment
 * breaks so `echo $(rm -rf /)` is scanned as its inner command too. With a
 * cwd, absolute paths inside it count as workspace-local; without one they
 * count as outside.
 */
export function isDangerousCommand(
	command: string,
	cwd?: string,
): string | undefined {
	return commandReason(command, { dir: cwd, root: cwd }, 0);
}
