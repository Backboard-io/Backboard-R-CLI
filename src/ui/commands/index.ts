import { APP_DISPLAY_NAME } from "../../config/branding.ts";

export type Command =
	| { type: "message"; text: string }
	| { type: "help" }
	| { type: "new" }
	| { type: "quit" }
	| { type: "login" }
	| { type: "logout" }
	| { type: "model" }
	| { type: "memory" }
	| { type: "settings" }
	| { type: "cua" }
	| { type: "browser" }
	| { type: "lsp" }
	| { type: "mcp" }
	| { type: "keys" }
	| { type: "context" }
	| { type: "compress" }
	| { type: "discover" }
	| { type: "hooks" }
	| { type: "skills" }
	| { type: "sessions"; id?: string }
	| { type: "notify" }
	| { type: "verbose" }
	| { type: "update" }
	| { type: "undo" }
	| { type: "redo" }
	| { type: "rewind" }
	| { type: "unknown"; name: string };

/** A command offered in slash suggestions: built-in or loaded skill. */
export interface SuggestibleSlashCommand {
	name: string;
	type: Command["type"];
	description: string;
	aliases?: readonly string[];
}

/** Built-in commands always resolve to a concrete command type. */
export interface SlashCommandDefinition extends SuggestibleSlashCommand {
	type: Exclude<Command["type"], "message" | "unknown">;
}

export interface SlashCommandSuggestion {
	command: string;
	type: Command["type"];
	description: string;
}

export const SLASH_COMMANDS: readonly SlashCommandDefinition[] = [
	{
		name: "model",
		type: "model",
		description: "Pick a model and thinking mode from Backboard",
	},
	{
		name: "settings",
		type: "settings",
		description: "Adjust session preferences",
		aliases: ["config"],
	},
	{
		name: "memory",
		type: "memory",
		description: "Set persistent memory mode",
	},
	{
		name: "cua",
		type: "cua",
		description: "Enable local computer use for this session",
	},
	{
		name: "browser",
		type: "browser",
		description: "Enable the Browser tool for this session",
	},
	{
		name: "lsp",
		type: "lsp",
		description: "Toggle language-server diagnostics for this session",
	},
	{ name: "mcp", type: "mcp", description: "Manage MCP servers" },
	{
		name: "context",
		type: "context",
		description: "Show what is filling the context window",
	},
	{
		name: "compress",
		type: "compress",
		description: "Compress the conversation to free context",
		aliases: ["compact"],
	},
	{
		name: "keys",
		type: "keys",
		description: "Manage provider API keys (BYOK)",
		aliases: ["apikeys"],
	},
	{
		name: "discover",
		type: "discover",
		description: "Toggle the skill & MCP discovery tools for this session",
	},
	{ name: "hooks", type: "hooks", description: "Manage hooks" },
	{
		name: "new",
		type: "new",
		description: "Start a new thread",
		aliases: ["clear", "reset"],
	},
	{
		name: "sessions",
		type: "sessions",
		description: "Resume a session",
		aliases: ["session", "resume", "continue"],
	},
	{ name: "login", type: "login", description: "Sign in with Backboard" },
	{
		name: "logout",
		type: "logout",
		description: "Sign out and end this session",
	},
	{ name: "help", type: "help", description: "Show this help" },
	{
		name: "quit",
		type: "quit",
		description: `Quit ${APP_DISPLAY_NAME} (or press Ctrl+C twice)`,
		aliases: ["exit"],
	},
	{ name: "skills", type: "skills", description: "Open the skill picker" },
	{
		name: "notify",
		type: "notify",
		description: "Toggle a ring when a prompt finishes",
	},
	{
		name: "verbose",
		type: "verbose",
		description: "Toggle detailed tool-call output",
	},
	{
		name: "update",
		type: "update",
		description: "Check for a newer CLI version",
	},
	{
		name: "undo",
		type: "undo",
		description: "Revert files changed by the last turn",
	},
	{
		name: "redo",
		type: "redo",
		description: "Reapply the last undone file changes",
	},
	{
		name: "rewind",
		type: "rewind",
		description: "Restore files to an earlier checkpoint",
		aliases: ["checkpoints"],
	},
];

const SLASH_SUGGESTION_LIMIT = 6;

const COMMAND_NAME_WIDTH = Math.max(
	...SLASH_COMMANDS.map((command) => command.name.length),
);

export const HELP_TEXT = [
	"Commands:",
	...SLASH_COMMANDS.map((command) => {
		const aliases = command.aliases?.length
			? ` (aliases: ${command.aliases.map((alias) => `/${alias}`).join(", ")})`
			: "";
		return `  /${command.name.padEnd(COMMAND_NAME_WIDTH)} ${command.description}${aliases}`;
	}),
	"",
	"Shortcuts:",
	"  Ctrl+V      Attach an image from the clipboard (some terminals capture Ctrl+V for text paste, so it may not reach the app)",
].join("\n");

/** Parses raw input into a command. Non-slash input becomes a message. */
export function parseCommand(input: string): Command {
	const trimmed = input.trim();
	if (!trimmed.startsWith("/")) {
		return { type: "message", text: trimmed };
	}

	const withoutSlash = trimmed.slice(1);
	const [rawName = "", ...rawArgs] = withoutSlash.split(/\s+/);
	const name = rawName.toLowerCase();
	const definition = findSlashCommand(name);
	if (definition) {
		if (definition.type === "sessions") {
			const id = rawArgs.join(" ").trim();
			return id ? { type: "sessions", id } : { type: "sessions" };
		}
		return { type: definition.type };
	}
	// Filepath-like input (e.g. /a/b/c) is not a command; send it as a
	// message instead of failing with "unknown command".
	if (name.includes("/")) {
		return { type: "message", text: trimmed };
	}
	return { type: "unknown", name };
}

/** Resolves a built-in command by canonical name or alias. */
export function findSlashCommand(
	name: string,
): SlashCommandDefinition | undefined {
	const normalized = name.toLowerCase();
	return SLASH_COMMANDS.find(
		(command) =>
			command.name === normalized || command.aliases?.includes(normalized),
	);
}

export function canRunCommandAfterSessionEnd(
	command: Command["type"],
): boolean {
	return (
		command === "help" ||
		command === "new" ||
		command === "quit" ||
		command === "login" ||
		command === "logout" ||
		command === "memory" ||
		command === "keys" ||
		command === "context" ||
		command === "settings" ||
		command === "cua" ||
		command === "browser" ||
		command === "discover" ||
		command === "lsp" ||
		command === "notify" ||
		command === "verbose" ||
		command === "update" ||
		command === "undo" ||
		command === "redo" ||
		command === "rewind"
	);
}

export function slashCommandSuggestions(
	input: string,
	options: {
		allowCommand?: (type: Command["type"]) => boolean;
		limit?: number;
	} = {},
): SlashCommandSuggestion[] {
	const query = slashCommandQuery(input);
	if (query === null) return [];

	const commands = availableSlashCommands().filter(
		(command) => options.allowCommand?.(command.type) ?? true,
	);
	const limit = options.limit ?? SLASH_SUGGESTION_LIMIT;
	return commands
		.map((command, index) => ({
			command,
			index,
			score: slashCommandScore(command, query),
		}))
		.sort((left, right) => left.score - right.score || left.index - right.index)
		.slice(0, limit)
		.map(({ command }) => ({
			command: `/${command.name}`,
			type: command.type,
			description: command.description,
		}));
}

export function completeSlashCommandInput(
	input: string,
	suggestion: SlashCommandSuggestion | undefined,
): string {
	return suggestion && slashCommandQuery(input) !== null
		? `${suggestion.command} `
		: input;
}

function slashCommandQuery(input: string): string | null {
	if (!input.startsWith("/")) return null;
	if (/\s/.test(input.trimStart())) return null;
	const query = input.slice(1);
	// Filepath-like input (e.g. /a/b/c) is not a slash command query.
	if (query.includes("/")) return null;
	return query.toLowerCase();
}

function availableSlashCommands(): SuggestibleSlashCommand[] {
	return [...SLASH_COMMANDS];
}

function slashCommandScore(
	command: SuggestibleSlashCommand,
	query: string,
): number {
	if (!query) return 0;

	const name = command.name.toLowerCase();
	const aliases = command.aliases?.map((alias) => alias.toLowerCase()) ?? [];
	const description = command.description.toLowerCase();
	if (name === query) return 0;
	if (name.startsWith(query)) return 10 + name.length;
	if (aliases.some((alias) => alias === query)) return 20;
	const prefixedAlias = aliases.find((alias) => alias.startsWith(query));
	if (prefixedAlias) return 30 + prefixedAlias.length;
	if (name.includes(query)) return 50 + name.indexOf(query);
	if (description.includes(query)) return 100 + description.indexOf(query);

	const nameSubsequence = subsequenceScore(name, query);
	if (nameSubsequence !== null) return 200 + nameSubsequence;
	const textSubsequence = subsequenceScore(`${name} ${description}`, query);
	if (textSubsequence !== null) return 300 + textSubsequence;
	return 1000 + editDistancePrefix(name, query);
}

function subsequenceScore(text: string, query: string): number | null {
	let position = 0;
	let score = 0;
	for (const char of query) {
		const next = text.indexOf(char, position);
		if (next === -1) return null;
		score += next - position;
		position = next + 1;
	}
	return score + text.length;
}

function editDistancePrefix(text: string, query: string): number {
	const target = text.slice(0, Math.max(query.length, 1));
	const previous = Array.from(
		{ length: target.length + 1 },
		(_, index) => index,
	);
	for (let row = 1; row <= query.length; row += 1) {
		let diagonal = previous[0] ?? 0;
		previous[0] = row;
		for (let column = 1; column <= target.length; column += 1) {
			const above = previous[column] ?? 0;
			const cost = query[row - 1] === target[column - 1] ? 0 : 1;
			previous[column] = Math.min(
				(previous[column] ?? 0) + 1,
				(previous[column - 1] ?? 0) + 1,
				diagonal + cost,
			);
			diagonal = above;
		}
	}
	return (previous[target.length] ?? query.length) + text.length;
}
