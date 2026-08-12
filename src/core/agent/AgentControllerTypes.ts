import type { TurnStatus } from "../bus/events.ts";

export interface QueuedSubmit {
	text: string;
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
}

export interface CancelOptions {
	clearQueue?: boolean;
}
