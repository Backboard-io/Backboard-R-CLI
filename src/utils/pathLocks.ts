const lockTails = new Map<string, Promise<void>>();

export async function withPathLocks<T>(
	paths: readonly string[],
	fn: () => Promise<T>,
): Promise<T> {
	const releases: Array<() => void> = [];
	const uniquePaths = [...new Set(paths)].sort();
	try {
		for (const path of uniquePaths) {
			releases.push(await acquirePathLock(path));
		}
		return await fn();
	} finally {
		for (const release of releases.reverse()) release();
	}
}

async function acquirePathLock(path: string): Promise<() => void> {
	const previous = lockTails.get(path) ?? Promise.resolve();
	let releaseGate: () => void = () => {};
	const gate = new Promise<void>((resolve) => {
		releaseGate = resolve;
	});
	const current = previous.then(() => gate);
	lockTails.set(path, current);
	await previous;
	return () => {
		releaseGate();
		void current.finally(() => {
			if (lockTails.get(path) === current) lockTails.delete(path);
		});
	};
}
