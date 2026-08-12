type CacheState<T> =
	| { status: "empty" }
	| { status: "pending"; promise: Promise<T> }
	| { status: "ready"; value: T };

export interface AsyncCache<T> {
	get(load: () => Promise<T>): Promise<T>;
	clear(): void;
}

export function createAsyncCache<T>(): AsyncCache<T> {
	let state: CacheState<T> = { status: "empty" };

	return {
		get(load) {
			if (state.status === "ready") return Promise.resolve(state.value);
			if (state.status === "pending") return state.promise;

			const promise = load().then(
				(value) => {
					state = { status: "ready", value };
					return value;
				},
				(err: unknown) => {
					state = { status: "empty" };
					throw err;
				},
			);
			state = { status: "pending", promise };
			return promise;
		},
		clear() {
			state = { status: "empty" };
		},
	};
}
