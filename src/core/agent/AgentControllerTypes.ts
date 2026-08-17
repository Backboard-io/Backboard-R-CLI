import type { TurnStatus } from "../bus/events.ts";

/**
 * Drain order for queued submissions. `now` preempts (steering), `next` is
 * ordinary user input, and `later` is for machine-generated work such as
 * background sub-agent reports — filed last so system messages can never
 * starve the human.
 */
export type SubmitPriority = "now" | "next" | "later";

export const SUBMIT_PRIORITY_ORDER: Record<SubmitPriority, number> = {
	now: 0,
	next: 1,
	later: 2,
};

export interface QueuedSubmit {
	text: string;
	priority: SubmitPriority;
	emitUserMessage: boolean;
	onStart?: () => void;
	attachmentFilePaths?: string[];
	displayContent?: string;
	resolve: (status: TurnStatus) => void;
	reject: (err: unknown) => void;
}

export interface SubmitOptions {
	emitUserMessage?: boolean;
	onStart?: () => void;
	attachmentFilePaths?: string[];
	displayContent?: string;
	/** Defaults to "next"; background reports pass "later". */
	priority?: SubmitPriority;
}

export interface CancelOptions {
	clearQueue?: boolean;
}
