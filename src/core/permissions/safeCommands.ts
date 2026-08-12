/**
 * Curated read-only command prefixes that auto-approve without prompting.
 * Deliberately small (claude-code's equivalent is ~2,000 lines) — grow this
 * from real usage, not speculation. Keys are the first one or two tokens.
 *
 * "git branch" is intentionally absent: it needs its own validator (see
 * `isSafeGitBranchSegment`) because most non-flag arguments mutate branches.
 */
const SAFE_PREFIXES = new Set([
	"git status",
	"git diff",
	"git log",
	"git show",
	"ls",
	"pwd",
	"cat",
	"head",
	"tail",
	"wc",
	"which",
	"echo",
	"grep",
	"rg",
	"find",
]);

/** Flags that keep `git branch` read-only; anything else (including a bare branch name) mutates. */
const GIT_BRANCH_SAFE_FLAGS = new Set([
	"-a",
	"-r",
	"-v",
	"-vv",
	"-av",
	"-avv",
	"-rv",
	"--list",
	"--show-current",
	"--all",
	"--remotes",
	"--verbose",
]);

/** Segments that make a command unsafe regardless of its prefix. */
const UNSAFE_PATTERN = /\$\(|`|>|</;

/**
 * find flags that execute (`-exec` family) or write files (`-fprint` family).
 * `-fprintf`/`-fprint`/`-fprint0`/`-fls` write find's output to an arbitrary
 * path — an argument-injection write primitive on an otherwise read-only find.
 */
export const UNSAFE_FIND_FLAGS =
	/(^|\s)-(exec|execdir|ok|okdir|delete|fprint|fprintf|fprint0|fls)(\s|$)/;

/**
 * ripgrep flags that run an external command. `--pre`/`--hostname-bin` invoke a
 * COMMAND per file/host (arbitrary code exec); `--search-zip`/`-z` shell out to
 * a decompressor. `rg` is otherwise read-only, so these are the exec vectors.
 */
export const UNSAFE_RG_FLAGS =
	/(^|\s)(--pre|--pre-glob|--hostname-bin|--search-zip)(=|\s|$)|(^|\s)-z(\s|$)/;

/** git flags that write a file or run a command named in repository config. */
const UNSAFE_GIT_FLAGS = /(^|\s)(--output|--ext-diff|--textconv)(=|\s|$)/;

/**
 * Config-override flags (`git -c pager.log=sh`, stuck-value `git -ccore.pager=sh`,
 * `git --config-env`) only take effect before the subcommand, so anchor there —
 * a post-subcommand `-c` is a different, read-only flag (`git log -c`).
 * Belt and braces: SAFE_PREFIXES has no bare "git", so a pre-subcommand flag
 * already fails the prefix match; this only becomes load-bearing if a bare
 * "git" entry is ever added.
 */
const UNSAFE_GIT_CONFIG_OVERRIDE = /^git\s+(-c|--config-env(=|\s))/;

/** Strip quote characters so quoted flags (`'-delete'`, `-"exec"`) can't dodge the guard regexes. */
function stripQuotes(text: string): string {
	return text.replaceAll(/["']/g, "");
}

/** `git branch` is safe only if every token after it is a read-only flag — no branch name, no other flags. */
function isSafeGitBranchSegment(tokens: string[]): boolean {
	return tokens.slice(2).every((token) => GIT_BRANCH_SAFE_FLAGS.has(token));
}

function segmentIsSafe(segment: string): boolean {
	const trimmed = segment.trim();
	if (!trimmed) return false;
	const tokens = trimmed.split(/\s+/);
	const strippedTrimmed = stripQuotes(trimmed);

	if (tokens[0] === "git" && tokens[1] === "branch") {
		return isSafeGitBranchSegment(tokens);
	}

	// Prefixes in the list are 1-2 tokens long ("ls", "git status") — try the
	// longest candidate first.
	const matched = [2, 1].some((length) =>
		SAFE_PREFIXES.has(tokens.slice(0, length).join(" ")),
	);
	if (!matched) return false;
	if (tokens[0] === "find" && UNSAFE_FIND_FLAGS.test(strippedTrimmed))
		return false;
	if (tokens[0] === "rg" && UNSAFE_RG_FLAGS.test(strippedTrimmed)) return false;
	if (
		tokens[0] === "git" &&
		(UNSAFE_GIT_FLAGS.test(strippedTrimmed) ||
			UNSAFE_GIT_CONFIG_OVERRIDE.test(strippedTrimmed))
	)
		return false;
	return true;
}

export function isSafeCommand(command: string): boolean {
	const trimmed = command.trim();
	if (!trimmed) return false;
	if (UNSAFE_PATTERN.test(trimmed)) return false;
	// Try the two-char operators (`&&`, `||`) first, then fall back to any
	// single `;`, `|`, `&`, or newline — this catches a lone `&` (background
	// operator) without breaking `&&` into two empty segments.
	const segments = trimmed.split(/&&|\|\||[;|&\n]/);
	return segments.every(segmentIsSafe);
}
