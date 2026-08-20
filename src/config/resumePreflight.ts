import { isByokThreadId, isSessionId } from "../utils/id.ts";
import { CliUserError } from "./CliUserError.ts";
import type { OutputFormat } from "./defaults.ts";
import type { CliFlags } from "./flags.ts";

export function parseRequestedResume(value: string): string;
export function parseRequestedResume(value: undefined): undefined;
export function parseRequestedResume(
	value: string | undefined,
): string | undefined;
export function parseRequestedResume(
	value: string | undefined,
): string | undefined {
	if (value === undefined) return undefined;
	const normalized = value.trim();
	if (!normalized) throw new CliUserError("--resume requires a session ID.");
	if (
		/^(?:byok|sess)_/i.test(normalized) &&
		!isByokThreadId(normalized) &&
		!isSessionId(normalized)
	) {
		throw new CliUserError(
			"Local session IDs must use lowercase sess_ or byok_ followed by 8 hexadecimal characters.",
		);
	}
	return normalized;
}

export function isHeadlessInvocation(
	flags: Pick<CliFlags, "print">,
	format: OutputFormat,
	io: { stdinIsTTY: boolean; stdoutIsTTY: boolean } = {
		stdinIsTTY: Boolean(process.stdin.isTTY),
		stdoutIsTTY: Boolean(process.stdout.isTTY),
	},
): boolean {
	return (
		flags.print !== undefined ||
		format === "json" ||
		!io.stdinIsTTY ||
		!io.stdoutIsTTY
	);
}

export function canPromptForPermissions(
	flags: Pick<CliFlags, "print">,
	format: OutputFormat,
	io: { stdinIsTTY: boolean } = {
		stdinIsTTY: Boolean(process.stdin.isTTY),
	},
): boolean {
	return flags.print === undefined && format !== "json" && io.stdinIsTTY;
}
