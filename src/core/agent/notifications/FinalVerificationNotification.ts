import { FINAL_VERIFICATION_NUDGE } from "../../../prompts/finalVerification.ts";
import type { SystemNotification } from "./SystemNotification.ts";

export const FINAL_VERIFICATION_MIN_TOOL_CALLS = 17; // min number of individual tool calls before verification nudge fires.

/**
 * The verification nudge: after a substantial user turn (at least one tool
 * round and FINAL_VERIFICATION_MIN_TOOL_CALLS calls), ask the model to review
 * the work against the request before finalizing. Supersedes the pre-nudge
 * final answer so only the verified summary is shown.
 */
export function finalVerificationNotification(
	enabled: boolean,
): SystemNotification {
	return {
		id: "final-verification",
		supersedesFinalAnswer: true,
		hidesResponse: false,
		shouldFire: (context) =>
			enabled &&
			context.requestKind === "user" &&
			context.executedRounds > 0 &&
			context.executedToolCalls >= FINAL_VERIFICATION_MIN_TOOL_CALLS,
		content: () => FINAL_VERIFICATION_NUDGE,
	};
}
