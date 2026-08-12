export function assert(condition: unknown, message: string): asserts condition {
	if (!condition) {
		throw new Error(`Assertion failed: ${message}`);
	}
}

export function assertNever(value: never, message?: string): never {
	throw new Error(message ?? `Unexpected value: ${JSON.stringify(value)}`);
}
