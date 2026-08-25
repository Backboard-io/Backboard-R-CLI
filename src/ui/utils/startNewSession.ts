export async function startNewSession(options: {
	/**
	 * Stops work bound to the outgoing session BEFORE its storage rotates, and
	 * resolves once that work has unwound. A background run finishing inside
	 * `activate` would otherwise report into — and run tools against — the
	 * replacement session.
	 */
	detach: () => Promise<void>;
	activate: () => Promise<void>;
	resetThread: () => void;
}): Promise<void> {
	await options.detach();
	await options.activate();
	options.resetThread();
}
