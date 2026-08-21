export async function startNewSession(options: {
	/**
	 * Stops work bound to the outgoing session BEFORE its storage rotates.
	 * A background run finishing inside `activate` would otherwise report into
	 * — and run tools against — the replacement session.
	 */
	detach: () => void;
	activate: () => Promise<void>;
	resetThread: () => void;
}): Promise<void> {
	options.detach();
	await options.activate();
	options.resetThread();
}
