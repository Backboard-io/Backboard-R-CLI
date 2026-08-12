export interface CompactionRequestInput {
	transcript: string;
	/** Verbatim tail replayed after the summary; named so the model does not re-summarize it. */
	verbatimTurns: number;
	/** Carried through untouched so in-flight work survives compression. */
	todos: string;
}
