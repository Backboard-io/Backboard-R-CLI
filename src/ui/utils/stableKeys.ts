// Stable React keys for lists that may contain duplicate values.
export function withStableKeys<T>(
	items: readonly T[],
	keyOf: (item: T) => string,
): Array<{ key: string; item: T }> {
	const seen = new Map<string, number>();
	return items.map((item) => {
		const base = keyOf(item);
		const count = seen.get(base) ?? 0;
		seen.set(base, count + 1);
		return { key: `${base}:${count}`, item };
	});
}
