import { realpathSync } from "node:fs";
import path from "node:path";

/** realpath of the nearest existing ancestor (target may not exist yet). */
function nearestRealpath(target: string): string | undefined {
	let dir = target;
	while (true) {
		try {
			return realpathSync(dir);
		} catch {
			const parent = path.dirname(dir);
			if (parent === dir) return undefined;
			dir = parent;
		}
	}
}

/**
 * True when every path stays inside cwd — lexical `..` check plus a symlink
 * check (a path lexically inside cwd but traversing a symlink out is rejected).
 * Falls back to lexical-only for non-existent roots (test fixtures).
 */
export function pathsInsideCwd(paths: string[], cwd: string): boolean {
	const root = path.resolve(cwd);
	const rootReal = nearestRealpath(root);
	return paths.every((candidate) => {
		const abs = path.resolve(root, candidate);
		if (abs !== root && !abs.startsWith(root + path.sep)) return false;
		if (rootReal === undefined) return true;
		const absReal = nearestRealpath(abs);
		if (absReal === undefined) return true;
		return absReal === rootReal || absReal.startsWith(rootReal + path.sep);
	});
}
