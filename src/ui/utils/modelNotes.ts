/**
 * Composition of a prompt submission when out-of-band notes for the model are
 * pending (e.g. "files were reverted by /undo"). The note-prefixed text goes
 * to the model while the transcript shows only the user's own words:
 * `emitTranscriptText` tells the caller to emit the clean `user:message`
 * itself, and `emitUserMessage: false` stops the controller from emitting a
 * second (note-polluted) one.
 */
export interface ComposedSubmission {
	/** What the model receives. */
	modelText: string;
	/** Pass to SubmitOptions.emitUserMessage. */
	emitUserMessage: boolean;
	/** When set, the caller emits this as the visible user message. */
	emitTranscriptText: string | null;
	/** True when the pending notes were consumed by this submission. */
	consumedNotes: boolean;
}

export function composeSubmissionWithNotes(
	text: string,
	notes: readonly string[],
	opts: { steer: boolean },
): ComposedSubmission {
	// Steering joins a live turn; notes wait for the next full submission.
	if (notes.length === 0 || opts.steer) {
		return {
			modelText: text,
			emitUserMessage: true,
			emitTranscriptText: null,
			consumedNotes: false,
		};
	}
	return {
		modelText: `${notes.join("\n\n")}\n\n${text}`,
		emitUserMessage: false,
		emitTranscriptText: text,
		consumedNotes: true,
	};
}
