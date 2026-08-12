export interface CliFlags {
	model?: string;
	format?: string;
	thinking?: string;
	memory?: string;
	memoryProfile?: string;
	excludedTools: string[];
	profile?: string;
	cwd?: string;
	print?: string;
	permissionMode?: string;
	finalVerification?: boolean;
	lsp?: boolean;
	fresh?: boolean;
	login: boolean;
	logout: boolean;
	help: boolean;
	version: boolean;
}

/**
 * Minimal, dependency-free flag parser. Supports `--flag value`, `--flag=value`,
 * and boolean `--flag`. Unknown flags are ignored so the shell stays forgiving.
 */
export function parseFlags(argv: string[]): CliFlags {
	const flags: CliFlags = {
		excludedTools: [],
		login: false,
		logout: false,
		help: false,
		version: false,
	};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "login") {
			flags.login = true;
			continue;
		}
		if (arg === "logout") {
			flags.logout = true;
			continue;
		}
		if (!arg?.startsWith("--")) continue;

		const eq = arg.indexOf("=");
		const key = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
		const inlineValue = eq === -1 ? undefined : arg.slice(eq + 1);

		const readValue = (): string | undefined => {
			if (inlineValue !== undefined) return inlineValue;
			const next = argv[i + 1];
			if (next && !next.startsWith("--")) {
				i++;
				return next;
			}
			return undefined;
		};

		const readBooleanValue = (): string | undefined => {
			const next = argv[i + 1];
			if (next && /^(true|false|1|0)$/i.test(next)) {
				i++;
				return next;
			}
			return undefined;
		};

		switch (key) {
			case "model":
				flags.model = readValue();
				break;
			case "format":
				flags.format = readValue();
				break;
			case "thinking":
				flags.thinking = readValue();
				break;
			case "memory":
				flags.memory = readValue();
				break;
			case "memory-profile":
			case "memory_profile":
				flags.memoryProfile = readValue();
				break;
			case "excluded-tools":
			case "excluded_tools": {
				const value = readValue();
				if (value !== undefined) flags.excludedTools.push(value);
				break;
			}
			case "profile":
				flags.profile = readValue();
				break;
			case "cwd":
				flags.cwd = readValue();
				break;
			case "print":
				flags.print = readValue() ?? "";
				break;
			case "permission-mode":
				flags.permissionMode = readValue();
				break;
			case "final-verification":
			case "final_verification": {
				const value = inlineValue ?? readBooleanValue();
				flags.finalVerification =
					value === undefined
						? true
						: parseBooleanFlag(value, "final-verification");
				break;
			}
			case "no-final-verification":
				flags.finalVerification = false;
				break;
			case "lsp": {
				const value = inlineValue ?? readBooleanValue();
				flags.lsp = value === undefined ? true : parseBooleanFlag(value, "lsp");
				break;
			}
			case "no-lsp":
				flags.lsp = false;
				break;
			case "fresh": {
				const value = inlineValue ?? readBooleanValue();
				flags.fresh =
					value === undefined ? true : parseBooleanFlag(value, "fresh");
				break;
			}
			case "no-fresh":
				flags.fresh = false;
				break;
			case "login":
				flags.login = true;
				break;
			case "logout":
				flags.logout = true;
				break;
			case "help":
				flags.help = true;
				break;
			case "version":
				flags.version = true;
				break;
			default:
				break;
		}
	}

	return flags;
}

function parseBooleanFlag(value: string, name: string): boolean {
	const normalized = value.trim().toLowerCase();
	switch (normalized) {
		case "true":
		case "1":
			return true;
		case "false":
		case "0":
			return false;
		default:
			throw new Error(`${name} must be true or false`);
	}
}
