import type { AttachmentItem } from "../../core/attachments/AttachmentTypes.ts";
import type { CandidateFile } from "../../core/attachments/attachmentPaths.ts";
import type { Command } from "../commands/index.ts";
import type {
	PromptHistoryState,
	PromptSubmitIntent,
	QueuedPromptItem,
} from "../input/types.ts";

export type {
	PromptHistoryState,
	PromptInputCursorPosition,
	PromptInputEdit,
	PromptSubmitIntent,
	QueuedPromptItem,
} from "../input/types.ts";

export interface PromptInputProps {
	disabled?: boolean;
	busy?: boolean;
	queuedPrompts?: readonly QueuedPromptItem[];
	allowCommand?: (type: Command["type"]) => boolean;
	promptHistory?: PromptHistoryState;
	onPromptHistoryChange?: (history: PromptHistoryState) => void;
	onSubmit: (
		value: string,
		intent: PromptSubmitIntent,
		attachmentIds?: string[],
	) => void;
	onAttachFiles?: (files: CandidateFile[]) => AttachmentItem[];
	onRemoveAttachment?: (id: string) => void;
	onNotice?: (text: string, level?: "info" | "error") => void;
}
