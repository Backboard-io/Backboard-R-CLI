import type { AskUserFn } from "../tools/ToolContext.ts";

export const ALLOW_ONCE = "Yes, allow once";
// Prefix of the "always" option; the full label appends the exact rule to be
// persisted so the user sees the scope of the grant.
export const ALLOW_ALWAYS = "Yes, always allow";
export const DENY = "No, deny";

/**
 * Commands persisted exact, never as a `:*` prefix (destructive/exfil).
 * Best-effort, not exhaustive — the disclosed rule in the prompt is the real
 * safety net, so a missed command generalizing is visible, not silent.
 */
const NEVER_GENERALIZE = new Set([
	"rm",
	"rmdir",
	"dd",
	"mkfs",
	"mv",
	"ln",
	"chmod",
	"chown",
	"chgrp",
	"curl",
	"wget",
	"kill",
	"killall",
	"pkill",
	"sudo",
	"su",
	"git",
	"docker",
	"ssh",
	"scp",
	"rsync",
	"bash",
	"sh",
	"zsh",
	"fish",
	"dash",
	"ksh",
	"python",
	"python3",
	"node",
	"bun",
	"deno",
	"npx",
	"bunx",
	"pnpx",
	"perl",
	"ruby",
	"php",
	"eval",
	"exec",
	"env",
	"xargs",
	"make",
	"awk",
	"find",
]);

/**
 * Rule persisted on "always allow", scoped to the approval: file paths → exact
 * path, destructive commands → exact command, else a two-token prefix.
 *
 * `contentIsPaths` comes from the tool, not from the shape of the string: an
 * extensionless path like `README` is indistinguishable from a command token,
 * and guessing wrong turns a path list into a `:*` prefix that a later call can
 * extend with paths the user never approved.
 */
export function suggestRule(
	toolName: string,
	content: string | undefined,
	contentIsPaths = false,
): string {
	const name = toolName.toLowerCase();
	if (!content) return name;
	const trimmed = content.trim();
	// `=` marks literal content. Path names may contain matcher metacharacters
	// such as `*` or end in `:*`; without an explicit literal mode those become
	// glob/prefix grants rather than the exact paths the user approved.
	if (contentIsPaths) return `${name}(=${trimmed})`;
	const tokens = trimmed.split(/\s+/);
	// Path-like single token (file tools) → scope to that exact path.
	if (tokens.length === 1 && /[/\\.]/.test(trimmed)) {
		return `${name}(${trimmed})`;
	}
	// Destructive commands → persist the exact invocation, no generalization.
	if (NEVER_GENERALIZE.has(tokens[0] ?? "")) {
		return `${name}(${trimmed})`;
	}
	const prefix = tokens.slice(0, 2).join(" ");
	return `${name}(${prefix}:*)`;
}

/** The "always allow" option label, disclosing the exact rule to be saved. */
export function alwaysAllowLabel(rule: string): string {
	return `${ALLOW_ALWAYS} (${rule})`;
}

export async function promptForPermission(
	question: string,
	rule: string,
	askUser: AskUserFn,
	signal?: AbortSignal,
): Promise<"once" | "always" | "deny"> {
	const answer = await askUser(
		question,
		[ALLOW_ONCE, alwaysAllowLabel(rule), DENY],
		signal,
	);
	if (answer === ALLOW_ONCE) return "once";
	// startsWith so callers/tests can answer with the bare ALLOW_ALWAYS prefix.
	if (answer.startsWith(ALLOW_ALWAYS)) return "always";
	return "deny";
}
