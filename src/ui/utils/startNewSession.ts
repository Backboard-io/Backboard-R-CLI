export async function startNewSession(options: {
	activate: () => Promise<void>;
	resetThread: () => void;
}): Promise<void> {
	await options.activate();
	options.resetThread();
}
