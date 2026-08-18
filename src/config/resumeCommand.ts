import { quotePowerShellString } from "../utils/shell.ts";
import { APP_COMMAND_NAME } from "./branding.ts";

const SAFE_POSIX_ARG = /^[A-Za-z0-9_./:@%+=,-]+$/;

export function buildResumeCommand(
	argv: readonly string[],
	sessionId: string,
	options: {
		platform?: NodeJS.Platform;
	},
): string {
	const args = withoutResumeFlag(argv);
	args.push("--resume", sessionId);
	return [APP_COMMAND_NAME, ...args]
		.map((arg) => quoteShellArg(arg, options.platform))
		.join(" ");
}

export function withoutResumeFlag(argv: readonly string[]): string[] {
	return withoutFlags(argv, new Set(["resume"]));
}

function withoutFlags(
	argv: readonly string[],
	names: ReadonlySet<string>,
): string[] {
	const result: string[] = [];
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		const separatedName = arg?.startsWith("--") ? arg.slice(2) : "";
		if (names.has(separatedName)) {
			if (argv[index + 1] && !argv[index + 1]?.startsWith("--")) index += 1;
			continue;
		}
		const inlineName = arg?.match(/^--([^=]+)=/)?.[1];
		if (inlineName && names.has(inlineName)) continue;
		if (arg !== undefined) result.push(arg);
	}
	return result;
}

export function quoteShellArg(
	value: string,
	platform: NodeJS.Platform = process.platform,
): string {
	if (value.length > 0 && SAFE_POSIX_ARG.test(value)) return value;
	if (platform === "win32") {
		return quotePowerShellString(value);
	}
	return `'${value.replaceAll("'", "'\"'\"'")}'`;
}
