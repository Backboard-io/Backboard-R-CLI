import type { Config } from "../../config/Config.ts";
import { errorMessage } from "../../utils/errors.ts";
import type { Command } from "./index.ts";

export async function handleTimerCommand(
	command: Extract<Command, { type: "timer" }>,
	config: Config,
	notice: (text: string, level?: "info" | "warning" | "error") => void,
): Promise<void> {
	if (command.error) {
		notice(command.error, "error");
		return;
	}
	const next = command.seconds ?? undefined;
	config.setTimerSeconds(next);
	const save = config.saveTimerPreference();
	notice(
		next === undefined
			? "Time budget cleared for subsequent turns."
			: `Time budget set to ${next}s per turn, starting with the next turn.`,
	);
	try {
		await save;
	} catch (err) {
		notice(`Failed to save timer preference: ${errorMessage(err)}`, "error");
	}
}
