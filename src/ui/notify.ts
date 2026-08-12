import { spawn } from "node:child_process";

const COMPLETION_TONE = "\u0007";
const MACOS_NOTIFICATION_SOUND = "/System/Library/Sounds/Glass.aiff";

export type TerminalWriter = (value: string) => void;

interface NotificationOptions {
	platform?: NodeJS.Platform;
	spawnSound?: (command: string, args: string[]) => void;
}

export function playCompletionNotification(
	write: TerminalWriter,
	options: NotificationOptions = {},
): void {
	const platform = options.platform ?? process.platform;
	if (platform === "darwin") {
		(options.spawnSound ?? playSound)("afplay", [MACOS_NOTIFICATION_SOUND]);
		return;
	}

	write(COMPLETION_TONE);
}

function playSound(command: string, args: string[]): void {
	const child = spawn(command, args, {
		detached: true,
		stdio: "ignore",
	});
	child.unref();
}
